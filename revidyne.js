// Revidyne 设备库 - 从 Python 转换为 JavaScript
// 使用 Web Serial API 进行串口通信

// ============== 工具 ==============
function removeTrailingNumber(s) {
    return s.replace(/\d+$/, '');
}

function parseCommand(cmdName) {
    const match = cmdName.match(/^([a-zA-Z_]+)(?:>(\d+))?(?:<(\d+))?/);
    if (match) {
        return {
            command: match[1],
            numOfOutput: match[2] ? parseInt(match[2]) : 0,
            numOfInput: match[3] ? parseInt(match[3]) : 0
        };
    }
    return { command: cmdName, numOfOutput: 0, numOfInput: 0 };
}

// ============== 串口 ==============
class SerialCommander {
    constructor(baudRate = 115200) {
        this.port = null;
        this.baudRate = baudRate;
        this.reader = null;
        this.writer = null;
        this.readBuffer = '';
    }

    async connect(existingPort = null) {
        try {
            if (existingPort) {
                this.port = existingPort;
            } else {
                this.port = await navigator.serial.requestPort();
            }
            
            await this.port.open({ 
                baudRate: this.baudRate,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none'
            });
            
            this.writer = this.port.writable.getWriter();
            this.reader = this.port.readable.getReader();
            
            console.log(`已连接，波特率: ${this.baudRate}`);
            await this.sleep(100);
            return true;
        } catch (err) {
            console.error('连接错误:', err);
            return false;
        }
    }

    async disconnect() {
        try {
            if (this.reader) {
                await this.reader.cancel();
                this.reader.releaseLock();
            }
            if (this.writer) {
                await this.writer.close();
            }
            if (this.port) {
                await this.port.close();
            }
            console.log('已断开连接');
        } catch (err) {
            console.error('断开连接错误:', err);
        }
    }

    async sendCommand(command) {
        if (!this.writer) return;
        try {
            const encoder = new TextEncoder();
            await this.writer.write(encoder.encode(command + '\n'));
        } catch (err) {
            console.error('发送命令错误:', err);
        }
    }

    async readResponse(timeout = 2000) {
        if (!this.reader) return '';
        
        const decoder = new TextDecoder();
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            try {
                const { value, done } = await Promise.race([
                    this.reader.read(),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('timeout')), timeout)
                    )
                ]);
                
                if (done) break;
                
                this.readBuffer += decoder.decode(value);
                const lines = this.readBuffer.split('\n');
                
                if (lines.length > 1) {
                    const response = lines[0].trim();
                    this.readBuffer = lines.slice(1).join('\n');
                    return response;
                }
            } catch (err) {
                if (err.message === 'timeout') break;
                console.error('读取响应错误:', err);
                break;
            }
        }
        return '';
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}


// ============== 基础设备类 ==============
class BaseDevice extends SerialCommander {
    constructor(baudRate = 115200) {
        super(baudRate);
        this.cmds = {};
        this.deviceType = 'unknown';
        this.deviceName = '';
        this.inPrompts = {};
        this.observers = {};
    }

    async getCommands({ timeoutMs = 20000, maxCommands = 128 } = {}) {
        // ECHO-LOOP PROTOCOL (matches Python House.set_up_cmds):
        //   1) send("getCommands")
        //   2) read() → first command
        //   3) while cmdName != "eoc":
        //        send(cmdName)   ← echo back to get next
        //        read() → next command
        //
        // Arduino expects this acknowledgment handshake.
        await this.sendCommand('getCommands');

        const lines = [];
        const start = Date.now();
        let blankStreak = 0;
        const maxBlankStreak = 50; // Very high tolerance for Arduino delays

        // First read
        await this.sleep(300); // Give Arduino time to process
        let cmdName = await this.readResponse(3000);
        console.log('[getCommands] first read:', cmdName);

        while (Date.now() - start < timeoutMs && lines.length < maxCommands) {
            if (!cmdName) {
                blankStreak++;
                console.log('[getCommands] blank read #' + blankStreak);
                if (blankStreak >= maxBlankStreak) {
                    console.log('[getCommands] too many blanks, stopping');
                    break;
                }
                await this.sleep(250); // Longer wait
                cmdName = await this.readResponse(2000);
                continue;
            }
            blankStreak = 0;

            if (cmdName === 'eoc') {
                console.log('[getCommands] reached eoc');
                break;
            }

            lines.push(cmdName);
            console.log('[getCommands] collected:', cmdName);

            // Echo-back: send the command name we just received
            await this.sendCommand(cmdName);
            await this.sleep(100); // Give Arduino time after echo

            // Read the next command
            cmdName = await this.readResponse(2000);
        }

        console.log('[getCommands] total commands:', lines.length);
        return lines;
    }

    async setupCommands() {
        const raw = await this.getCommands();
        for (const cmdName of raw) {
            if (!cmdName || cmdName === 'eoc') continue;
            const { command, numOfInput, numOfOutput } = parseCommand(cmdName);
            this.cmds[command] = new Cmd(command, numOfInput, numOfOutput);
        }
        console.log('setupCommands 完成，命令数:', Object.keys(this.cmds).length);
    }

    async call(cmdName, returnValue = false) {
        if (!this.cmds[cmdName]) {
            console.error(`错误: '${cmdName}' 不在命令菜单中`);
            return null;
        }

        const cmd = this.cmds[cmdName];

        if (cmd.inArg === 0 && cmd.outArg === 0) {
            await this.sendCommand(cmdName);
            return null;
        } else if (cmd.inArg !== 0 || cmd.outArg !== 0) {
            return await this.readCmdMessage(cmdName, returnValue || cmd.outArg !== 0);
        }
        return null;
    }

    async readCmdMessage(cmdName, returnValue = false) {
        if (!this.cmds[cmdName]) {
            console.error(`错误: '${cmdName}' 不在命令菜单中`);
            return null;
        }

        const count = this.cmds[cmdName].inArg + this.cmds[cmdName].outArg;
        await this.sendCommand(cmdName);
        await this.sleep(100);

        const data = [];
        const prompts = this.inPrompts[cmdName] || [];

        for (let i = 0; i < count; i++) {
            const response = await this.readResponse();
            if (!returnValue && prompts[i]) {
                console.log(prompts[i], response);
            }
            data.push(response);
        }
        return data;
    }

    listCmds() {
        return Object.keys(this.cmds);
    }

    // 观察者模式 - 模拟 Python traitlets
    observe(property, callback) {
        if (!this.observers[property]) {
            this.observers[property] = [];
        }
        this.observers[property].push(callback);
    }

    notifyObservers(property, value) {
        if (this.observers[property]) {
            this.observers[property].forEach(cb => cb(value));
        }
    }
}

class Cmd {
    constructor(name, inArg, outArg) {
        this.name = name;
        this.inArg = inArg;
        this.outArg = outArg;
    }
}

// ============== Generator 发电机 ==============
class Generator extends BaseDevice {
    constructor(baudRate = 115200) {
        super(baudRate);
        this.deviceType = 'provider';
        this.deviceName = 'generator';
        
        this._Kd = 0;
        this._Ki = 0;
        this._Kp = 0;
        this._Mot = 0;
        this._Volts = 0;
        this._load = 0;

        this.inPrompts = {
            'getAll': ["千瓦容量: ", "当前千瓦级别: ", "分配负载: ",
                       "分配与使用千瓦差值: ", "碳值: ", "可再生性: ", "线电压: "],
            'getVolts': ["电路电压: "],
            'getKW': ["千瓦: "],
            'getRes': ["负载电阻(欧姆): "],
            'getDrop': ["电阻压降(欧姆): "],
            'getCurrent': ["电路电流(毫安): "],
            'getBV': ["发电机电压:", "电压差: "],
            'getVal': ["发电厂当前产生电压: "],
            'getCarbon': ["碳排放(吨): "]
        };
    }

    async initialize(port = null) {
        const connected = await this.connect(port);
        if (connected) {
            await this.sleep(2000);
            await this.setupCommands();
            // 添加 getFreq 命令
            this.cmds['getFreq'] = new Cmd('getFreq', 0, 1);
        }
        return connected;
    }

    // Getter/Setter with observers
    get Kd() { return this._Kd; }
    set Kd(value) {
        this._Kd = value;
        this.sendCommand(`setKd\n${value}`);
        this.notifyObservers('Kd', value);
    }

    get Ki() { return this._Ki; }
    set Ki(value) {
        this._Ki = value;
        this.sendCommand(`setKi\n${value}`);
        this.notifyObservers('Ki', value);
    }

    get Kp() { return this._Kp; }
    set Kp(value) {
        this._Kp = value;
        this.sendCommand(`setKp\n${value}`);
        this.notifyObservers('Kp', value);
    }

    get Mot() { return this._Mot; }
    set Mot(value) {
        this._Mot = value;
        this.sendCommand(`setMot\n${value}`);
        this.notifyObservers('Mot', value);
    }

    get Volts() { return this._Volts; }
    set Volts(value) {
        this._Volts = value;
        this.sendCommand(`setVolts\n${value}`);
        this.notifyObservers('Volts', value);
    }

    get load() { return this._load; }
    set load(value) {
        this._load = value;
        this.sendCommand(`setLoad\n${value}`);
        this.notifyObservers('load', value);
    }

    async setKd(kd) { this.Kd = kd; }
    async setKi(ki) { this.Ki = ki; }
    async setKp(kp) { this.Kp = kp; }
    async setMot(mot) { this.Mot = mot; }
    async setVolts(volts) { this.Volts = volts; }
    async setLoad(ld) { this.load = ld; }
}


// ============== SolarTracker 太阳能追踪器 ==============
class SolarTracker extends BaseDevice {
    constructor(baudRate = 115200) {
        super(baudRate);
        this.deviceType = 'provider';
        this.deviceName = 'solartracker';
        
        this._cdeg = 0;
        this._ccdeg = 0;
        this._load = 0;
        this._step = 0;

        this.inPrompts = {
            'getAll': ["千瓦容量: ", "当前千瓦级别: ", "分配负载: ",
                       "分配与使用千瓦差值: ", "碳值: ", "可再生性: ", "当前功率: "],
            'getKW': ["千瓦: "],
            'getCarbon': ["碳排放(吨): "],
            'getVal': ["太阳能板当前产生电压: "],
            'getmax': ["最大光照位置: "],
            'getPos': ["当前太阳能板位置: "]
        };
    }

    async initialize(port = null) {
        const connected = await this.connect(port);
        if (connected) {
            await this.sleep(2000);
            await this.setupCommands();
        }
        return connected;
    }

    get cdeg() { return this._cdeg; }
    set cdeg(value) {
        this._cdeg = value;
        this.sendCommand(`moveCW\n${value}`);
        this.notifyObservers('cdeg', value);
    }

    get ccdeg() { return this._ccdeg; }
    set ccdeg(value) {
        this._ccdeg = value;
        this.sendCommand(`moveCCW\n${value}`);
        this.notifyObservers('ccdeg', value);
    }

    get load() { return this._load; }
    set load(value) {
        this._load = value;
        this.sendCommand(`setLoad\n${value}`);
        this.notifyObservers('load', value);
    }

    get step() { return this._step; }
    set step(value) {
        this._step = value;
        this.sendCommand(`setSteps\n${value}`);
        this.notifyObservers('step', value);
    }

    async moveCW(deg) { this.cdeg = deg; }
    async moveCCW(deg) { this.ccdeg = deg; }
    async setLoad(ld) { this.load = ld; }
    async setSteps(s) { this.step = s; }
}

// ============== WindTurbine 风力涡轮机 ==============
class WindTurbine extends BaseDevice {
    constructor(baudRate = 115200) {
        super(baudRate);
        this.deviceType = 'provider';
        this.deviceName = 'windturbine';
        
        this._cdeg = 0;
        this._ccdeg = 0;
        this._load = 0;
        this._range = 0;
        this._delay = 0;
        this._step = 0;

        this.inPrompts = {
            'getAll': ["千瓦容量: ", "当前千瓦级别: ", "分配负载: ",
                       "分配与使用千瓦差值: ", "碳值: ", "可再生性: ", "当前功率: "],
            'getKW': ["千瓦: "],
            'getCarbon': ["碳排放(吨): "],
            'getVal': ["风力涡轮机当前产生电压: "],
            'getmax': ["最大风速位置: "],
            'getPos': ["当前风力涡轮机位置: "]
        };
    }

    async initialize(port = null) {
        const connected = await this.connect(port);
        if (connected) {
            await this.sleep(2000);
            await this.setupCommands();
        }
        return connected;
    }

    get cdeg() { return this._cdeg; }
    set cdeg(value) {
        this._cdeg = value;
        this.sendCommand(`moveCW\n${value}`);
        this.notifyObservers('cdeg', value);
    }

    get ccdeg() { return this._ccdeg; }
    set ccdeg(value) {
        this._ccdeg = value;
        this.sendCommand(`moveCCW\n${value}`);
        this.notifyObservers('ccdeg', value);
    }

    get load() { return this._load; }
    set load(value) {
        this._load = value;
        this.sendCommand(`setLoad\n${value}`);
        this.notifyObservers('load', value);
    }

    get step() { return this._step; }
    set step(value) {
        this._step = value;
        this.sendCommand(`setSteps\n${value}`);
        this.notifyObservers('step', value);
    }

    get range() { return this._range; }
    set range(value) {
        this._range = value;
        this.sendCommand(`setRange\n${value}`);
        this.notifyObservers('range', value);
    }

    get delay() { return this._delay; }
    set delay(value) {
        this._delay = value;
        this.sendCommand(`setDelay\n${value}`);
        this.notifyObservers('delay', value);
    }

    async moveCW(deg) { this.cdeg = deg; }
    async moveCCW(deg) { this.ccdeg = deg; }
    async setLoad(ld) { this.load = ld; }
    async setSteps(s) { this.step = s; }
    async setRange(r) { this.range = r; }
    async setDelay(d) { this.delay = d; }
}

// ============== HouseLoad 家庭负载 ==============
class HouseLoad extends BaseDevice {
    constructor(baudRate = 115200) {
        super(baudRate);
        this.deviceType = 'consumer';
        this.deviceName = 'houseload';
        
        this._h1 = 0;
        this._h2 = 0;
        this._h3 = 0;
        this._h4 = 0;

        this.inPrompts = {
            'getAll': ["千瓦容量: ", "当前千瓦级别: ", "分配负载: ",
                       "分配与使用千瓦差值: ", "碳值: ", "可再生性: ", "当前功率: "],
            'getLoads': ["h1负载: ", "h2负载: ", "h3负载: ", "h4负载: "],
            'getLoadVal': ["总负载: "],
            'getKW': ["千瓦: "],
            'getCarbon': ["碳排放(吨): "]
        };

        // Known HouseLoad commands (hardcoded to avoid getCommands protocol issues)
        this.knownCommands = [
            'init', 'autoOn', 'autoOff',
            'lightAll', 'lightsOut', 'light0', 'light1', 'light2', 'light3',
            'blinkHouses', 'chaseOn', 'chaseOff',
            'getKW', 'getCarbon', 'getTemp', 'getHumidity', 'getPressure', 'getLandA',
            'EPw', 'EPr', 'off'
        ];
    }

    async initialize(port = null) {
        const connected = await this.connect(port);
        if (connected) {
            await this.sleep(2000);
            // Use known commands instead of unreliable getCommands protocol
            this.cmds = {};
            for (const cmd of this.knownCommands) {
                this.cmds[cmd] = new Cmd(cmd, 0, 0);
            }
            console.log('HouseLoad: using known commands:', this.listCmds());
        }
        return connected;
    }

    get h1() { return this._h1; }
    set h1(value) { this._h1 = value; this._updateLimits(); }

    get h2() { return this._h2; }
    set h2(value) { this._h2 = value; this._updateLimits(); }

    get h3() { return this._h3; }
    set h3(value) { this._h3 = value; this._updateLimits(); }

    get h4() { return this._h4; }
    set h4(value) { this._h4 = value; this._updateLimits(); }

    _updateLimits() {
        this.sendCommand(`setLimits\n${this._h1}\n${this._h2}\n${this._h3}\n${this._h4}`);
        this.notifyObservers('limits', { h1: this._h1, h2: this._h2, h3: this._h3, h4: this._h4 });
    }

    async setLimits(h1, h2, h3, h4) {
        this._h1 = h1;
        this._h2 = h2;
        this._h3 = h3;
        this._h4 = h4;
        this._updateLimits();
    }
}


// ============== Fan 风扇 ==============
class Fan extends BaseDevice {
    constructor(baudRate = 115200) {
        super(baudRate);
        this.deviceType = 'consumer';
        this.deviceName = 'fan';
        
        this._fanspeed = 0;

        this.inPrompts = {
            'getAll': ["千瓦容量: ", "当前千瓦级别: ", "分配负载: ",
                       "分配与使用千瓦差值: ", "碳值: ", "可再生性: ", "当前功率: "],
            'getLoads': ["h1负载: ", "h2负载: ", "h3负载: ", "h4负载: "],
            'getLoadVal': ["总负载: "],
            'getKW': ["千瓦: "],
            'getCarbon': ["碳排放(吨): "]
        };
    }

    async initialize(port = null) {
        const connected = await this.connect(port);
        if (connected) {
            await this.sleep(2000);
            await this.setupCommands();
        }
        return connected;
    }

    get fanspeed() { return this._fanspeed; }
    set fanspeed(value) {
        this._fanspeed = value;
        this.sendCommand(`setSpeed\n${value}`);
        this.notifyObservers('fanspeed', value);
    }

    async setSpeed(spd) { this.fanspeed = spd; }
}

// ============== CVT ==============
class CVT extends BaseDevice {
    constructor(baudRate = 115200) {
        super(baudRate);
        this.deviceType = 'consumer';
        this.deviceName = 'cvt';
        
        this._fanspeed = 0;

        this.inPrompts = {
            'getAll': ["千瓦容量: ", "当前千瓦级别: ", "分配负载: ",
                       "分配与使用千瓦差值: ", "碳值: ", "可再生性: ", "当前功率: "],
            'getLoads': ["h1负载: ", "h2负载: ", "h3负载: ", "h4负载: "],
            'getLoadVal': ["总负载: "],
            'getKW': ["千瓦: "],
            'getCarbon': ["碳排放(吨): "]
        };
    }

    async initialize(port = null) {
        const connected = await this.connect(port);
        if (connected) {
            await this.sleep(2000);
            await this.setupCommands();
        }
        return connected;
    }

    get fanspeed() { return this._fanspeed; }
    set fanspeed(value) {
        this._fanspeed = value;
        this.sendCommand(`setSpeed\n${value}`);
        this.notifyObservers('fanspeed', value);
    }

    async setSpeed(spd) { this.fanspeed = spd; }
}

// ============== AllDevice 设备管理器 ==============
class AllDevice {
    constructor(baudRate = 115200) {
        this.deviceNames = [];
        this.devices = {};
        this.baudRate = baudRate;
        this.deviceClasses = {
            'generator': Generator,
            'solartracker': SolarTracker,
            'windturbine': WindTurbine,
            'houseload': HouseLoad,
            'fan': Fan,
            'cvt': CVT
        };
    }

    async scanPorts() {
        if (!navigator.serial) {
            throw new Error('浏览器不支持 Web Serial API，请使用 Chrome 或 Edge');
        }

        try {
            const port = await navigator.serial.requestPort();
            return await this.identifyDevice(port);
        } catch (err) {
            console.error('扫描端口错误:', err);
            throw err;
        }
    }

    async identifyDevice(port) {
        // 直接使用 BaseDevice 来识别
        const device = new BaseDevice(this.baudRate);
        
        try {
            const connected = await device.connect(port);
            if (!connected) {
                throw new Error('无法连接到串口');
            }
            
            await device.sleep(2000);
            
            // 发送识别命令
            await device.sendCommand('*ID?');
            const response = await device.readResponse();
            
            console.log('设备响应:', response);
            
            // 获取设备类型
            const baseType = removeTrailingNumber(response || 'unknown');
            const DeviceClass = this.deviceClasses[baseType];
            
            let deviceType;
            let deviceName = this.getUniqueDeviceName(response || baseType);
            
            if (DeviceClass) {
                deviceType = new DeviceClass().deviceType;
            } else {
                deviceType = 'consumer';
            }
            
            // For known devices, use hardcoded commands to avoid getCommands protocol issues
            const knownDeviceCommands = {
                'houseload': [
                    'init', 'autoOn', 'autoOff',
                    'lightAll', 'lightsOut', 'light0', 'light1', 'light2', 'light3',
                    'blinkHouses', 'chaseOn', 'chaseOff',
                    'setLimits', 'setLoad', 'setLight0', 'setLight1', 'setLight2', 'setLight3',
                    'getAll', 'getLoads', 'getLoadVal', 'getKW', 'getCarbon',
                    'getTemp', 'getHumidity', 'getPressure', 'getLandA',
                    'EPw', 'EPr', 'off'
                ],
                'generator': [
                    'init', 'off', 'runRange', 'getAll', 'getKW', 'getVolts', 'getRes', 'getDrop',
                    'getCarbon', 'setLoad', 'setVolts', 'setMot', 'setKp', 'setKi', 'setKd'
                ],
                'solartracker': [
                    'init', 'runScan', 'trackOn', 'trackOff', 'runIVScan',
                    'goHome', 'goMax', 'go1Q', 'go2Q', 'go3Q', 'go4Q',
                    'moveCW', 'moveCCW', 'moveCWR', 'moveCCWR', 'lookCCW', 'lookCW', 'runCal',
                    'setSteps', 'setLoad', 'setResis', 'setRange', 'setDelay', 'setSpeed', 'setReads',
                    'getVal', 'getKW', 'getCarbon', 'getMax', 'getAll', 'getIV', 'getIVC',
                    'getPos', 'getBusy', 'getMaxPos',
                    'on', 'off'
                ]
            };

            console.log('开始获取命令列表...');

            if (knownDeviceCommands[baseType]) {
                // Use hardcoded commands
                device.cmds = {};
                for (const cmd of knownDeviceCommands[baseType]) {
                    device.cmds[cmd] = new Cmd(cmd, 0, 0);
                }
                console.log(`${baseType}: 使用已知命令列表:`, device.listCmds());
            } else {
                // Try dynamic discovery for unknown devices
                try {
                    await device.setupCommands();
                    console.log('命令列表获取完成:', device.listCmds());
                } catch (cmdErr) {
                    console.warn('获取命令列表失败，继续:', cmdErr);
                }
            }
            
            this.devices[deviceName] = device;
            this.deviceNames.push(deviceName);
            
            console.log('设备识别完成:', deviceName, deviceType);
            
            return {
                name: deviceName,
                type: deviceType,
                device: device
            };
            
        } catch (err) {
            console.error('识别设备错误:', err);
            try {
                await device.disconnect();
            } catch (e) {}
            throw err;
        }
    }

    getUniqueDeviceName(baseName) {
        // 如果名字不存在，直接使用原名
        if (!this.deviceNames.includes(baseName)) {
            return baseName;
        }
        // 如果已存在，加数字后缀
        let count = 1;
        while (this.deviceNames.includes(baseName + count)) {
            count++;
        }
        return baseName + count;
    }

    getAllDevices() {
        return this.devices;
    }

    getDevice(name) {
        return this.devices[name];
    }

    async disconnectAll() {
        for (const name in this.devices) {
            await this.devices[name].disconnect();
        }
        this.devices = {};
        this.deviceNames = [];
    }
}

// ============== 导出 ==============
window.Revidyne = {
    SerialCommander,
    BaseDevice,
    Generator,
    SolarTracker,
    WindTurbine,
    HouseLoad,
    Fan,
    CVT,
    AllDevice,
    Cmd
};
