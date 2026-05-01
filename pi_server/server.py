#!/usr/bin/env python3
"""
Revidyne Pi Server - Complete Web + Serial Bridge
Hosts the website AND handles serial communication to devices.

Usage:
    python3 server.py

Then open: http://<pi-ip>:5000
"""

from flask import Flask, jsonify, request, send_from_directory, session, g
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import serial
import serial.tools.list_ports
import threading
import time
import os
import sqlite3
import secrets
import hashlib
from functools import wraps

app = Flask(__name__, static_folder='static', static_url_path='')

# IMPORTANT: set a strong secret in production. You can override with env var.
app.secret_key = os.environ.get('REVIDYNE_SECRET_KEY', 'dev-change-me-please')

# Fix Cross-Origin Cookies for GitHub Pages to Ngrok/LHR tunnel
app.config.update(
    SESSION_COOKIE_SAMESITE="None",
    SESSION_COOKIE_SECURE=True
)

# CORS isn't strictly needed when serving the web app from the same origin,
# but we keep it for compatibility with Pi Gateway remote usage.
CORS(app, supports_credentials=True)

# ============ Configuration ============
BAUD_RATE = 115200
SERIAL_TIMEOUT = 2.0
READ_TIMEOUT = 0.5

# Auth / DB
DB_PATH = os.environ.get('REVIDYNE_DB_PATH', os.path.join(os.path.dirname(__file__), 'revidyne.db'))
BOOTSTRAP_ADMIN_USER = os.environ.get('REVIDYNE_ADMIN_USER', 'admin')
BOOTSTRAP_ADMIN_PASS = os.environ.get('REVIDYNE_ADMIN_PASS', 'admin_password')

# Device mapping: name -> port path
# Will be auto-detected or manually configured
DEVICES = {}
DEVICE_COMMANDS = {}  # name -> list of commands
SERIAL_CONNECTIONS = {}
SERIAL_LOCKS = {}


# ============ Auth / SQLite ============

def db_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True) if os.path.dirname(DB_PATH) else None
    conn = db_connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'operator',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_permissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                device TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, device)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_used_at TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def get_user_by_username(username: str):
    conn = db_connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def create_user(username: str, password: str, role: str = 'operator'):
    if not username or not password:
        raise ValueError('username and password are required')

    role = role if role in ('admin', 'operator', 'viewer') else 'operator'
    pw_hash = generate_password_hash(password)
    conn = db_connect()
    try:
        conn.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            (username, pw_hash, role),
        )
        conn.commit()
    finally:
        conn.close()


def set_user_permissions(username: str, devices: list):
    """Set which devices a user can control. Replaces existing permissions."""
    user = get_user_by_username(username)
    if not user:
        raise ValueError(f'User {username} not found')

    conn = db_connect()
    try:
        conn.execute("DELETE FROM user_permissions WHERE user_id = ?", (user['id'],))
        for device in devices:
            conn.execute(
                "INSERT INTO user_permissions (user_id, device) VALUES (?, ?)",
                (user['id'], device.lower()),
            )
        conn.commit()
    finally:
        conn.close()


def get_user_permissions(user_id: int):
    """Get list of device names this user can control."""
    conn = db_connect()
    try:
        rows = conn.execute(
            "SELECT device FROM user_permissions WHERE user_id = ?", (user_id,)
        ).fetchall()
        return [r['device'] for r in rows]
    finally:
        conn.close()


def check_device_permission(user, device_name: str):
    """Check if user has permission to control this device.
       admin → always allowed. operator → check permissions table. viewer → never."""
    if not user:
        return False
    if user.get('role') == 'admin':
        return True
    if user.get('role') == 'viewer':
        return False
    # operator: check permissions
    allowed = get_user_permissions(user['id'])
    return device_name.lower() in allowed


def ensure_admin_exists():
    conn = db_connect()
    try:
        admin = conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        if admin:
            conn.execute(
                "UPDATE users SET username = ?, password_hash = ? WHERE id = ?",
                (BOOTSTRAP_ADMIN_USER, generate_password_hash(BOOTSTRAP_ADMIN_PASS), admin['id'])
            )
            conn.commit()
            return

        create_user(BOOTSTRAP_ADMIN_USER, BOOTSTRAP_ADMIN_PASS, role='admin')
        conn.commit()
    finally:
        conn.close()


def bootstrap_department_accounts():
    """Create department-based user accounts with device permissions.
       Only runs if these users don't exist yet."""

    DEFAULT_PASS = 'temple0000'

    # (username, role, [allowed devices])
    departments = [
        ('power_gen',    'operator', ['generator']),
        ('solar_dept',   'operator', ['solartracker']),
        ('facilities',   'operator', ['fan', 'houseload']),
        ('engineering',  'operator', ['generator', 'solartracker', 'fan']),
        ('intern',       'viewer',   []),
    ]

    created = []
    for username, role, devices in departments:
        if get_user_by_username(username):
            continue  # already exists
        try:
            create_user(username, DEFAULT_PASS, role=role)
            if devices:
                set_user_permissions(username, devices)
            created.append(username)
        except Exception as e:
            print(f"  ⚠️ Could not create {username}: {e}")

    if created:
        print("\n" + "=" * 60)
        print("🏢 Department accounts bootstrapped (password: temple0000):")
        for username, role, devices in departments:
            if username in created:
                devs = ', '.join(devices) if devices else '(view only)'
                print(f"  {username:16s}  role={role:8s}  devices={devs}")
        print("=" * 60 + "\n")


def current_user():
    api_user = getattr(g, 'api_user', None)
    if api_user:
        return api_user
    if not session.get('user'):
        return None
    return session.get('user')


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode('utf-8')).hexdigest()


def extract_api_key_from_request():
    # Preferred: custom header
    key = (request.headers.get('X-API-Key') or '').strip()
    if key:
        return key

    # Standard bearer fallback
    auth = (request.headers.get('Authorization') or '').strip()
    if auth.lower().startswith('bearer '):
        token = auth[7:].strip()
        if token:
            return token

    # Query param fallback (less secure, but useful for demos)
    key = (request.args.get('api_key') or '').strip()
    return key or None


def resolve_api_key_user(raw_key: str):
    if not raw_key:
        return None
    key_hash = hash_api_key(raw_key)
    conn = db_connect()
    try:
        row = conn.execute(
            """
            SELECT k.id AS key_id, k.user_id, u.username, u.role
            FROM api_keys k
            JOIN users u ON u.id = k.user_id
            WHERE k.key_hash = ? AND k.is_active = 1
            """,
            (key_hash,)
        ).fetchone()
        if not row:
            return None

        conn.execute(
            "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?",
            (row['key_id'],)
        )
        conn.commit()

        return {
            'id': row['user_id'],
            'username': row['username'],
            'role': row['role'],
            'auth_method': 'api_key',
            'key_id': row['key_id'],
        }
    finally:
        conn.close()


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        u = current_user()
        if not u:
            raw_key = extract_api_key_from_request()
            u = resolve_api_key_user(raw_key) if raw_key else None
            if u:
                g.api_user = u
        if not u:
            return jsonify({'success': False, 'error': 'login required (session or api key)'}), 401
        return fn(*args, **kwargs)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        u = current_user()
        if not u:
            raw_key = extract_api_key_from_request()
            u = resolve_api_key_user(raw_key) if raw_key else None
            if u:
                g.api_user = u
        if not u:
            return jsonify({'success': False, 'error': 'login required (session or api key)'}), 401
        if u.get('role') != 'admin':
            return jsonify({'success': False, 'error': 'admin required'}), 403
        return fn(*args, **kwargs)
    return wrapper


@app.route('/api/auth/me')
def api_auth_me():
    u = current_user()
    if not u:
        raw_key = extract_api_key_from_request()
        u = resolve_api_key_user(raw_key) if raw_key else None
        if u:
            g.api_user = u
    perms = get_user_permissions(u['id']) if u and u.get('role') == 'operator' else []
    return jsonify({'success': True, 'user': u, 'permissions': perms, 'authMethod': u.get('auth_method') if u else None})


@app.route('/api/auth/login', methods=['POST'])
def api_auth_login():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    user = get_user_by_username(username)
    if not user or not check_password_hash(user['password_hash'], password):
        return jsonify({'success': False, 'error': 'invalid credentials'}), 401

    # Minimal session payload (avoid password hash)
    session['user'] = {
        'id': user['id'],
        'username': user['username'],
        'role': user['role'],
    }
    perms = get_user_permissions(user['id']) if user['role'] == 'operator' else []
    return jsonify({'success': True, 'user': session['user'], 'permissions': perms})


@app.route('/api/auth/logout', methods=['POST'])
def api_auth_logout():
    session.pop('user', None)
    return jsonify({'success': True})


@app.route('/api/auth/api-keys', methods=['GET'])
@admin_required
def api_list_keys():
    conn = db_connect()
    try:
        rows = conn.execute(
            """
            SELECT k.id, k.name, k.user_id, u.username, u.role, k.is_active, k.created_at, k.last_used_at
            FROM api_keys k
            JOIN users u ON u.id = k.user_id
            ORDER BY k.id DESC
            """
        ).fetchall()
        keys = [dict(r) for r in rows]
        return jsonify({'success': True, 'keys': keys})
    finally:
        conn.close()


@app.route('/api/auth/api-keys', methods=['POST'])
@admin_required
def api_create_key():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    name = (data.get('name') or 'default').strip()

    if not username:
        return jsonify({'success': False, 'error': 'username is required'}), 400

    user = get_user_by_username(username)
    if not user:
        return jsonify({'success': False, 'error': 'user not found'}), 404

    raw_key = f"rvk_{secrets.token_urlsafe(32)}"
    key_hash = hash_api_key(raw_key)

    conn = db_connect()
    try:
        cur = conn.execute(
            "INSERT INTO api_keys (user_id, name, key_hash, is_active) VALUES (?, ?, ?, 1)",
            (user['id'], name, key_hash)
        )
        conn.commit()
        key_id = cur.lastrowid
    finally:
        conn.close()

    return jsonify({
        'success': True,
        'key': {
            'id': key_id,
            'name': name,
            'username': user['username'],
            'role': user['role'],
            'apiKey': raw_key,
            'note': 'Store this API key now. It cannot be retrieved again.'
        }
    })


@app.route('/api/auth/api-keys/<int:key_id>', methods=['DELETE'])
@admin_required
def api_revoke_key(key_id):
    conn = db_connect()
    try:
        conn.execute("UPDATE api_keys SET is_active = 0 WHERE id = ?", (key_id,))
        conn.commit()
        return jsonify({'success': True, 'revokedKeyId': key_id})
    finally:
        conn.close()


@app.route('/api/users', methods=['GET'])
@admin_required
def api_list_users():
    conn = db_connect()
    try:
        rows = conn.execute("SELECT id, username, role, created_at FROM users ORDER BY id ASC").fetchall()
        users = []
        for r in rows:
            u = dict(r)
            u['permissions'] = get_user_permissions(u['id'])
            users.append(u)
        return jsonify({'success': True, 'users': users})
    finally:
        conn.close()


@app.route('/api/users', methods=['POST'])
@admin_required
def api_create_user():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    role = (data.get('role') or 'operator').strip()
    devices = data.get('devices') or []
    try:
        create_user(username, password, role)
        if devices and role == 'operator':
            set_user_permissions(username, devices)
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'username already exists'}), 400
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    return jsonify({'success': True})


@app.route('/api/users/<int:user_id>/permissions', methods=['GET'])
@admin_required
def api_get_permissions(user_id):
    perms = get_user_permissions(user_id)
    return jsonify({'success': True, 'permissions': perms})


@app.route('/api/users/<int:user_id>/permissions', methods=['PUT'])
@admin_required
def api_set_permissions(user_id):
    data = request.get_json(silent=True) or {}
    devices = data.get('devices') or []
    conn = db_connect()
    try:
        user = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            return jsonify({'success': False, 'error': 'User not found'}), 404
        set_user_permissions(user['username'], devices)
        return jsonify({'success': True, 'permissions': devices})
    finally:
        conn.close()


@app.route('/api/users/<int:user_id>', methods=['DELETE'])
@admin_required
def api_delete_user(user_id):
    u = current_user()
    if u['id'] == user_id:
        return jsonify({'success': False, 'error': 'Cannot delete yourself'}), 400
    conn = db_connect()
    try:
        conn.execute("DELETE FROM user_permissions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        return jsonify({'success': True})
    finally:
        conn.close()

# ============ Serial Management ============

def list_serial_ports():
    """List all available serial ports"""
    ports = []
    for port in serial.tools.list_ports.comports():
        # Skip Pi's internal serial
        if 'ttyAMA' in port.device or 'ttyS0' in port.device:
            continue
        ports.append({
            'device': port.device,
            'description': port.description or port.device,
            'hwid': port.hwid
        })
    return ports

def get_or_open_serial(port_path):
    """Get existing connection or open new one"""
    if port_path in SERIAL_CONNECTIONS:
        ser = SERIAL_CONNECTIONS[port_path]
        if ser.is_open:
            return ser
    
    try:
        ser = serial.Serial(port_path, BAUD_RATE, timeout=SERIAL_TIMEOUT)
        # Arduino resets on serial open — need ~2s for bootloader to finish
        time.sleep(2.0)
        # Drain any bootloader garbage
        ser.reset_input_buffer()
        SERIAL_CONNECTIONS[port_path] = ser
        SERIAL_LOCKS[port_path] = threading.Lock()
        print(f"✅ Opened {port_path}")
        return ser
    except Exception as e:
        print(f"❌ Failed to open {port_path}: {e}")
        return None

def send_command(port_path, cmd):
    """Send command to serial port and read response"""
    ser = get_or_open_serial(port_path)
    if not ser:
        return {'success': False, 'error': f'Cannot open {port_path}'}
    
    lock = SERIAL_LOCKS.get(port_path, threading.Lock())
    
    with lock:
        try:
            # Clear buffers
            ser.reset_input_buffer()
            ser.reset_output_buffer()
            
            # Send command
            cmd_bytes = (cmd.strip() + '\n').encode('utf-8')
            ser.write(cmd_bytes)
            ser.flush()
            
            # Read response
            time.sleep(READ_TIMEOUT)
            response = []
            start = time.time()
            while (time.time() - start) < SERIAL_TIMEOUT:
                if ser.in_waiting:
                    line = ser.readline().decode('utf-8', errors='ignore').strip()
                    if line:
                        response.append(line)
                        if line.upper() == 'EOC':
                            break
                else:
                    time.sleep(0.1)
                    # Only give up after waiting a bit longer with no data
                    if not ser.in_waiting and (time.time() - start) > 1.0:
                        break
            
            return {'success': True, 'response': response, 'port': port_path}
        
        except Exception as e:
            print(f"❌ Error on {port_path}: {e}")
            # Try to reconnect next time
            try:
                ser.close()
            except:
                pass
            if port_path in SERIAL_CONNECTIONS:
                del SERIAL_CONNECTIONS[port_path]
            return {'success': False, 'error': str(e)}

def detect_device_type(port_path):
    """Send 'getCommands' to get command list and identify device type.
       Retries up to 5 times with increasing wait if no commands are received.
       If still unknown, tries probe commands to identify the device."""
    
    commands = []
    
    # Phase 1: Try getCommands with increasing delays
    for attempt in range(5):
        # On later attempts, close and reopen (force Arduino reset)
        if attempt >= 2 and port_path in SERIAL_CONNECTIONS:
            try:
                SERIAL_CONNECTIONS[port_path].close()
            except:
                pass
            del SERIAL_CONNECTIONS[port_path]
            if port_path in SERIAL_LOCKS:
                del SERIAL_LOCKS[port_path]
            time.sleep(1.0)  # Extra wait before reopen
        
        result = send_command(port_path, 'getCommands')
        
        if result['success']:
            commands = [c for c in result.get('response', []) 
                       if c and c.lower() != 'eoc' and c.strip()]
        
        if commands:
            break
        
        wait = 0.5 + attempt * 0.5  # 0.5, 1.0, 1.5, 2.0, 2.5
        print(f"      ⚠️ Attempt {attempt+1}/5: no commands from {port_path}, waiting {wait}s...")
        time.sleep(wait)
    
    commands_text = ' '.join(commands).lower()
    print(f"      Commands ({len(commands)}): {commands_text[:120]}...")
    
    # Identify device type based on unique commands
    device_type = 'unknown'
    
    # Solar tracker (REAL): has runScan, runIVScan, goHome, goMax - these are unique to solar
    if 'runscan' in commands_text or 'runivscan' in commands_text or 'gohome' in commands_text or 'gomax' in commands_text:
        device_type = 'solartracker'
    
    # Generator: has setLoad, setMot, setKp, setKi, runRange (PID control commands)
    elif 'setmot' in commands_text or 'setkp' in commands_text or 'setki' in commands_text:
        device_type = 'generator'
    elif ('setload' in commands_text or 'getkw' in commands_text) and ('getvolts' in commands_text or 'getvoltage' in commands_text):
        device_type = 'generator'
    
    # Houseload: has light commands (lighta, lightb, lightc, etc.)
    elif 'lighta' in commands_text or 'lightb' in commands_text or 'lightsout' in commands_text:
        device_type = 'houseload'
    
    # Fan: has setSpeed
    elif 'setspeed' in commands_text:
        device_type = 'fan'
    
    # Wind turbine
    elif 'wind' in commands_text or 'turbine' in commands_text:
        device_type = 'windturbine'
    
    # CVT
    elif 'cvt' in commands_text:
        device_type = 'cvt'
    
    # Phase 2: If still unknown, try probe commands to identify the device
    if device_type == 'unknown':
        print(f"      🔎 Probing {port_path} with alternative commands...")
        
        # Try 'getPos' — only solartracker has this
        probe = send_command(port_path, 'getPos')
        if probe['success'] and probe.get('response'):
            resp_text = ' '.join(probe['response']).lower()
            # If we get any numeric response (position), it's likely solartracker
            if any(c.replace('.','',1).replace('-','',1).isdigit() for c in probe['response'] if c.lower() != 'eoc'):
                device_type = 'solartracker'
                print(f"      ✅ Probe: getPos responded → solartracker")
        
        if device_type == 'unknown':
            # Try 'getVal' — solartracker has this (voltage from solar panel)
            probe = send_command(port_path, 'getVal')
            if probe['success'] and probe.get('response'):
                resp = [r for r in probe['response'] if r.lower() != 'eoc' and r.strip()]
                if resp:
                    device_type = 'solartracker'
                    print(f"      ✅ Probe: getVal responded → solartracker")
        
        if device_type == 'unknown':
            # Try 'getKW' — solartracker and generator have this
            # but at this point if it responds at all, and other devices
            # were already identified, it's likely solartracker
            probe = send_command(port_path, 'getKW')
            if probe['success'] and probe.get('response'):
                resp = [r for r in probe['response'] if r.lower() != 'eoc' and r.strip()]
                if resp:
                    device_type = 'solartracker'
                    print(f"      ✅ Probe: getKW responded → solartracker (fallback)")
    
    return device_type, commands

def auto_detect_devices():
    """Auto-detect all connected devices"""
    global DEVICES, DEVICE_COMMANDS
    DEVICES = {}
    DEVICE_COMMANDS = {}  # Store commands for each device
    
    ports = list_serial_ports()
    print(f"🔍 Scanning {len(ports)} ports...")
    
    unknown_count = 0
    for port in ports:
        port_path = port['device']
        device_type, commands = detect_device_type(port_path)
        
        # If device type is unknown, give it a unique name
        if device_type == 'unknown':
            unknown_count += 1
            device_name = f"device{unknown_count}"
        else:
            device_name = device_type
            
        # Handle duplicate types by adding a number
        if device_name in DEVICES:
            count = 2
            while f"{device_name}{count}" in DEVICES:
                count += 1
            device_name = f"{device_name}{count}"
        
        DEVICES[device_name] = port_path
        DEVICE_COMMANDS[device_name] = commands
        print(f"   ✅ {port_path} → {device_name} ({len(commands)} commands)")
    
    print(f"📋 Detected devices: {DEVICES}")
    return DEVICES

# ============ API Routes ============

@app.route('/')
def index():
    """Serve main page"""
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    """Serve static files (js, css, etc)"""
    return send_from_directory('static', path)

@app.route('/api/ports')
@login_required
def api_ports():
    """List available serial ports"""
    return jsonify({'ports': list_serial_ports()})

@app.route('/api/devices')
@login_required
def api_devices():
    """List detected devices with their commands"""
    # Build detailed device info
    device_info = {}
    for name, port in DEVICES.items():
        device_info[name] = {
            'port': port,
            'commands': DEVICE_COMMANDS.get(name, [])
        }
    return jsonify({'devices': DEVICES, 'deviceInfo': device_info})

@app.route('/api/scan')
@login_required
def api_scan():
    """Re-scan and detect devices"""
    devices = auto_detect_devices()
    # Build detailed device info
    device_info = {}
    for name, port in DEVICES.items():
        device_info[name] = {
            'port': port,
            'commands': DEVICE_COMMANDS.get(name, [])
        }
    return jsonify({'success': True, 'devices': devices, 'deviceInfo': device_info})

@app.route('/api/send/<cmd>')
@login_required
def api_send_default(cmd):
    """Send command to first available device (backward compatible)"""
    if not DEVICES:
        return jsonify({'success': False, 'error': 'No devices detected. Call /api/scan first.'})
    
    device_name = list(DEVICES.keys())[0]
    u = current_user()
    if not check_device_permission(u, device_name):
        return jsonify({'success': False, 'error': f'No permission to control {device_name}'}), 403

    port_path = DEVICES[device_name]
    result = send_command(port_path, cmd)
    result['device'] = device_name
    return jsonify(result)

@app.route('/api/send/<device>/<cmd>')
@login_required
def api_send_device(device, cmd):
    """Send command to specific device"""
    device = device.lower()
    
    if device not in DEVICES:
        return jsonify({
            'success': False, 
            'error': f'Device "{device}" not found. Available: {list(DEVICES.keys())}'
        })
    
    u = current_user()
    if not check_device_permission(u, device):
        return jsonify({'success': False, 'error': f'No permission to control {device}'}), 403

    port_path = DEVICES[device]
    result = send_command(port_path, cmd)
    result['device'] = device
    return jsonify(result)

@app.route('/api/send/<device>/<cmd>/<args>')
@login_required
def api_send_device_args(device, cmd, args):
    """Send command with arguments to specific device"""
    device = device.lower()
    
    if device not in DEVICES:
        return jsonify({
            'success': False, 
            'error': f'Device "{device}" not found. Available: {list(DEVICES.keys())}'
        })
    
    u = current_user()
    if not check_device_permission(u, device):
        return jsonify({'success': False, 'error': f'No permission to control {device}'}), 403

    port_path = DEVICES[device]
    full_cmd = f"{cmd} {args}"
    result = send_command(port_path, full_cmd)
    result['device'] = device
    return jsonify(result)

@app.route('/api/broadcast/<cmd>')
@login_required
def api_broadcast(cmd):
    """Send command to ALL devices (only sends to devices user has permission for)"""
    u = current_user()
    results = {}
    skipped = []
    for device_name, port_path in DEVICES.items():
        if check_device_permission(u, device_name):
            results[device_name] = send_command(port_path, cmd)
        else:
            skipped.append(device_name)
    return jsonify({'success': True, 'results': results, 'skipped': skipped})

@app.route('/api/config/device', methods=['POST'])
@login_required
def api_config_device():
    """Manually configure device-to-port mapping"""
    data = request.json
    device = data.get('device', '').lower()
    port = data.get('port', '')
    
    if not device or not port:
        return jsonify({'success': False, 'error': 'Need device and port'})
    
    DEVICES[device] = port
    return jsonify({'success': True, 'devices': DEVICES})

# ============ Main ============

if __name__ == '__main__':
    print("🚀 Revidyne Pi Server starting...")
    print(f"📁 Static folder: {os.path.join(os.path.dirname(__file__), 'static')}")

    # Init auth DB + ensure we have at least one admin
    init_db()
    ensure_admin_exists()
    bootstrap_department_accounts()
    
    # Auto-detect devices on startup
    auto_detect_devices()
    
    print("\n" + "="*50)
    print("🌐 Server ready!")
    print("   Local:   http://127.0.0.1:5000")
    print("   Network: http://<your-pi-ip>:5000")
    print("="*50 + "\n")
    
    app.run(host='0.0.0.0', port=5000, debug=True)
