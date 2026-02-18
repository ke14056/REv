// USB - Revidyne device library integration
class USBDeviceManager {
    constructor() {
        this.debug = false;
        this.availableDevices = new Map();
        this.connectedDevices = new Map();
        this.deviceIdCounter = 0;
        this.allDevice = new Revidyne.AllDevice(115200);

        this.lastScanAt = null;
        this.metrics = new Map();
        this.metricsIntervalId = null;
        this.metricsIntervalMs = 5000; // 5 seconds (slower for stability)

        // Metrics filtering: store recent values to detect outliers
        this.metricsHistory = new Map(); // deviceId -> { voltage: [], power: [] }
        this.metricsHistorySize = 5; // keep last 5 readings
        this.metricsMaxChangePercent = 200; // reject if change > 200%
        this.metricsShowRaw = false; // Show raw values in console

        this.commandLog = [];

    // Last sent setLoad per generator (for boards without telemetry)
    // key: deviceId -> { valueKW:number, at:number }
    this.lastSetLoadByDeviceId = new Map();

    // Connections (Provider -> Consumer)
    this.connKey = 'revidyne.connections.v1';
    this.connections = this.loadConnections(); // array of { fromId, toId }
    this.connPendingFrom = null; // provider deviceId selected for a connection

    // Mode 2: Generator fills deficit from the Connections plan
    this.connAutoMode2Key = 'revidyne.connections.mode2.auto.v1';
    this.connAutoMode2Enabled = this.loadConnAutoMode2Enabled();
    this.connAutoMode2IntervalId = null;
    this._connMode2LastApplied = null; // { genId, targetKW, at }
    this._connMode2InFlight = false;

        // Latest estimated totals (kW) from renderMetrics()
        this.latestEstimatedSupplyKW = 0;
        this.latestEstimatedDemandKW = 0;

    // Auto-estimate demand (infer demand from supply/balance; for boards without getLoads/getAll)
    this.autoEstKey = 'revidyne.autoEstimateDemand.v1';
    this.autoEstTuningKey = 'revidyne.autoEstimateDemand.tuning.v1';
    this.autoEstEnabled = this.loadAutoEstimateEnabled();
    this.autoEstLastSupplyKW = null;
    this.autoEstDemandKW = null;
    this.autoEstUpdatedAt = null;
    const tuning = this.loadAutoEstimateTuning();
    this.autoEstAlpha = tuning.alpha;
    this.autoEstMaxStepKW = tuning.maxStepKW;

    // Demo Tour state
    this.demoTourRunning = false;

    // Power estimation (manual, for devices without telemetry)
    // - consumer: rated watts (W) and utilization (0..1)
    // - provider: rated capacity (kW) and availability (0..1)
    this.powerEstKeyPrefix = 'revidyne.powerEst.v1.';

    // Allocation (apply estimated load to generator)
    this.allocKey = 'revidyne.alloc.v1';

    // Live metrics: show/hide helper details
    this.metricsDetailsKey = 'revidyne.metrics.details.v1';
    this.metricsDetailsEnabled = this.loadMetricsDetailsEnabled();

    // Live metrics: prefer manual estimates over telemetry (useful for demos)
    this.preferManualEstimates = this.loadPreferManualEstimatesEnabled();

        this.flowSteps = [];
        this.flowStorageKey = 'revidyne.flow.v1';
        this.flowIsRunning = false;
    this.flowStopRequested = false;

        // Run summary (KPI)
        this.lastRunSummary = null;
    this.runHistoryKey = 'revidyne.runHistory.v1';
    this.runHistoryMax = 50;
    this.runHistoryDefaultN = 10;
    this.runHistory = this.loadRunHistory();

        this.deviceQueues = new Map();
        this.defaultCommandTimeoutMs = 3000;

    // Demo/Safe Mode
    this.safeModeKey = 'revidyne.safeMode.enabled.v1';
    this.safeModeEnabled = this.loadSafeModeEnabled();

        // Onboarding / tutorial
        this.onboardingStorageKey = 'revidyne.onboarding.hidden.v1';
        this.tour = {
            active: false,
            stepIndex: 0,
            toastEl: null,
            steps: []
        };

        // Templates
        this.templates = this.buildTemplates();

        // English command help (tooltips)
        this.commandHelp = this.buildCommandHelpEN();
        
        this.init();
    }

    // ---------------- Firmware command parsing ----------------
    // Some boards report command “signatures” like:
    //   getKW<1
    //   EPw>2
    //   EPr>1<1
    // We want buttons to execute the base command (e.g., getKW / EPw / EPr),
    // but still preserve the signature string for display/tooltips.
    parseFirmwareCommands(rawCommands) {
        const out = {
            commands: [],
            signaturesByCommand: {}
        };

        const lines = (rawCommands || [])
            .map(v => String(v ?? '').trim())
            .filter(Boolean)
            .filter(v => v.toLowerCase() !== 'eoc');

        const seen = new Set();
        for (const line of lines) {
            // Extract the base command name before any signature markers.
            // Keep it strict: allow letters/numbers/_; stop at first non-word.
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
            const base = (m && m[1]) ? m[1] : line;
            if (!base) continue;
            if (!seen.has(base)) {
                out.commands.push(base);
                seen.add(base);
            }

            // Preserve the original line as the preferred display signature.
            // If multiple entries exist for same base, keep the first (stable) one.
            if (!out.signaturesByCommand[base]) out.signaturesByCommand[base] = line;
        }

        return out;
    }

    loadMetricsDetailsEnabled() {
        try {
            return localStorage.getItem(this.metricsDetailsKey) === '1';
        } catch {
            return false;
        }
    }

    setMetricsDetailsEnabled(enabled) {
        this.metricsDetailsEnabled = Boolean(enabled);
        try {
            localStorage.setItem(this.metricsDetailsKey, this.metricsDetailsEnabled ? '1' : '0');
        } catch {}
        this.updateMetricsDetailsUI();
    }

    updateMetricsDetailsUI() {
        const toggle = document.getElementById('metricsShowDetailsToggle');
        if (toggle) toggle.checked = !!this.metricsDetailsEnabled;
        document.documentElement.classList.toggle('metrics-details-on', !!this.metricsDetailsEnabled);
    }

    // ---------------- Metrics: prefer manual estimates ----------------
    loadPreferManualEstimatesEnabled() {
        try {
            return localStorage.getItem('revidyne.metrics.preferManualEstimates.v1') === '1';
        } catch {
            return false;
        }
    }

    setPreferManualEstimatesEnabled(enabled) {
        this.preferManualEstimates = Boolean(enabled);
        try {
            localStorage.setItem('revidyne.metrics.preferManualEstimates.v1', this.preferManualEstimates ? '1' : '0');
        } catch {}
        this.updatePreferManualEstimatesUI();
        this.renderMetrics();
    }

    updatePreferManualEstimatesUI() {
        const t = document.getElementById('preferManualEstimatesToggle');
        if (t) t.checked = !!this.preferManualEstimates;
    }

    // ---------------- Connections: Mode 2 (apply to generator) ----------------
    loadConnAutoMode2Enabled() {
        try {
            return localStorage.getItem(this.connAutoMode2Key) === '1';
        } catch {
            return false;
        }
    }

    setConnAutoMode2Enabled(enabled) {
        this.connAutoMode2Enabled = Boolean(enabled);
        try {
            localStorage.setItem(this.connAutoMode2Key, this.connAutoMode2Enabled ? '1' : '0');
        } catch {}
        this.updateConnAutoMode2Timer();
    }

    updateConnAutoMode2Timer() {
        try {
            if (this.connAutoMode2IntervalId) {
                clearInterval(this.connAutoMode2IntervalId);
                this.connAutoMode2IntervalId = null;
            }

            if (!this.connAutoMode2Enabled) return;

            // Keep it modest: re-apply at ~2s cadence.
            // IMPORTANT: await the run and don't queue overlapping runs.
            this.connAutoMode2IntervalId = setInterval(async () => {
                try {
                    await this.applyConnectionsMode2({ source: 'mode2-auto' });
                } catch {}
            }, 2000);
        } catch {
            // ignore
        }
    }

    getConnectedGeneratorDevices() {
        const gens = [];
        for (const d of this.connectedDevices.values()) {
            const nameLower = String(d?.name || '').toLowerCase();
            const supportsSetLoad = Array.isArray(d?.commands) && d.commands.includes('setLoad');
            if (nameLower.includes('generator') && supportsSetLoad) gens.push(d);
        }
        return gens;
    }

    // Mode 2 computation contract:
    // - demandKW: total planned consumption from edges (sum incoming to consumers == sum edge kw)
    // - otherSupplyKW: supply from non-generator providers (estimated or telemetry) regardless of wiring
    // - targetGenKW = clamp(demandKW - otherSupplyKW, 0..genCapacityKW?)
    computeMode2TargetKW() {
        // Demand: the plan expressed by connections (edge kW labels)
        const demandKW = (this.connections || []).reduce((acc, e) => acc + this.getConnectionKW(e), 0);

        // Identify generators and “other supply” providers
        const all = [
            ...Array.from(this.connectedDevices.values()),
            ...Array.from(this.availableDevices.values())
        ];

        const isGenerator = (dev) => String(dev?.name || '').toLowerCase().includes('generator');

        let otherSupplyKW = 0;
        for (const d of all) {
            if (!d || d.type !== 'provider') continue;
            if (isGenerator(d)) continue;
            const { kw } = this.computeEstimatedKW(d, null);
            if (kw != null && Number.isFinite(kw)) otherSupplyKW += kw;
        }

        const deficitKW = Math.max(0, demandKW - otherSupplyKW);
        return { demandKW, otherSupplyKW, deficitKW };
    }

    async applyConnectionsMode2({ source = 'mode2' } = {}) {
        // Prevent overlapping apply calls (Auto + manual clicks or slow serial round-trips)
        if (this._connMode2InFlight) return;
        this._connMode2InFlight = true;

        try {
        // Require: a connected generator with setLoad.
        const gens = this.getConnectedGeneratorDevices();
        if (gens.length === 0) {
                // If a generator exists in the diagram but isn't connected, call that out.
                let hasDiagramGen = false;
                try {
                    const all = [
                        ...Array.from(this.connectedDevices.values()),
                        ...Array.from(this.availableDevices.values())
                    ];
                    hasDiagramGen = all.some(d => String(d?.name || '').toLowerCase().includes('generator'));
                } catch {}

                const statusEl = document.getElementById('connStatus');
                const msg = hasDiagramGen
                    ? 'Mode 2: generator is in the diagram, but it is not connected. Please connect it (WebSerial) first.'
                    : 'Mode 2: Connect a generator (with setLoad) first.';
                if (statusEl) statusEl.textContent = msg;
                this.showToast(msg, 'warning');
                return;
        }
        if (gens.length > 1) {
            this.showToast('Mode 2: Multiple generators connected; using the first one', 'warning');
        }

        const { demandKW, otherSupplyKW, deficitKW } = this.computeMode2TargetKW();
        const gen = gens[0];

        // Optional cap: if a Capacity estimate exists for the generator provider, clamp to it.
        let maxKW = null;
        try {
            const { kw } = this.computeEstimatedKW(gen, null);
            if (kw != null && Number.isFinite(kw) && kw >= 0) maxKW = kw;
        } catch {}

        const targetKW = (maxKW == null) ? deficitKW : Math.min(deficitKW, maxKW);
        const targetRounded = Math.round(targetKW * 100) / 100;

        // If target hasn't changed, don't spam setLoad.
        // - still update status line so user sees the calculation
        const last = this._connMode2LastApplied;
        const isSameTarget = last && last.genId === gen.id && Math.abs(Number(last.targetKW) - targetRounded) < 0.01;

        const statusEl = document.getElementById('connStatus');
        const msg = `Mode 2 → Demand ${demandKW.toFixed(2)} kW − Other supply ${otherSupplyKW.toFixed(2)} kW = Generator ${targetRounded.toFixed(2)} kW`;
        if (statusEl) statusEl.textContent = msg;

        // Safe mode: show computation and exit (executeCommand already blocks, but we keep UX explicit).
        if (this.safeModeEnabled) {
            this.showToast('Mode 2 computed (Safe mode ON; setLoad blocked).', 'warning');
            return;
        }

        if (isSameTarget) {
            // For auto loop, staying quiet is nicer; for manual clicks we can give a small hint.
            if (source !== 'mode2-auto') this.showToast('Mode 2: target unchanged (no setLoad sent)', 'success');
            return;
        }

        await this.setGeneratorLoad(gen.id, targetRounded);
        this._connMode2LastApplied = { genId: gen.id, targetKW: targetRounded, at: Date.now() };
        this.showToast(`Mode 2 applied: setLoad ${targetRounded.toFixed(2)} kW`, 'success');
        } finally {
            this._connMode2InFlight = false;
        }
    }

    // Build a stable, unique diagram ID for a device across maps.
    // Prefers an existing id; otherwise derives one from a stable portKey.
    getConnDiagramId(device) {
        const portKey = device && (device.portKey || device.path || device.serialNumber || device.name || 'device');
        const base = (device && device.id) ? String(device.id) : String(portKey);
        return base.startsWith('dev:') ? base : `dev:${base}`;
    }

    // Encode a string for safe placement inside a HTML attribute value.
    // This avoids breaking attributes when ids contain quotes/& while keeping the raw id recoverable.
    encodeAttr(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // Decode the few entities we encode for attributes.
    decodeAttr(value) {
        return String(value)
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    }

    // ---------------- Connections (Provider -> Consumer) ----------------
    loadConnections() {
        try {
            const raw = localStorage.getItem(this.connKey);
            if (!raw) return [];
            const v = JSON.parse(raw);
            if (!Array.isArray(v)) return [];
            return v
                .map(e => ({
                    fromId: String(e?.fromId || ''),
                    toId: String(e?.toId || ''),
                    kw: (e && e.kw != null && Number.isFinite(Number(e.kw))) ? Number(e.kw) : null
                }))
                .filter(e => e.fromId && e.toId);
        } catch {
            return [];
        }
    }

    // Connection allocation helpers
    getConnectionKW(edge) {
        const kw = edge && edge.kw != null ? Number(edge.kw) : null;
        return (kw != null && Number.isFinite(kw) && kw >= 0) ? kw : 0;
    }

    getSupplyForDeviceId(deviceId) {
        const id = String(deviceId || '');
        const all = [
            ...Array.from(this.connectedDevices.values()),
            ...Array.from(this.availableDevices.values())
        ];
        const dev = all.find(d => this.getConnDiagramId(d) === id);
        if (!dev) return null;
        const { kw } = this.computeEstimatedKW(dev, null);
        return (kw != null && Number.isFinite(kw)) ? kw : null;
    }

    getDemandForDeviceId(deviceId) {
        const id = String(deviceId || '');
        const all = [
            ...Array.from(this.connectedDevices.values()),
            ...Array.from(this.availableDevices.values())
        ];
        const dev = all.find(d => this.getConnDiagramId(d) === id);
        if (!dev) return null;
        const { kw } = this.computeEstimatedKW(dev, null);
        return (kw != null && Number.isFinite(kw)) ? kw : null;
    }

    computeConnTotals() {
        const giveBy = new Map();
        const getBy = new Map();
        for (const e of (this.connections || [])) {
            const kw = this.getConnectionKW(e);
            giveBy.set(e.fromId, (giveBy.get(e.fromId) || 0) + kw);
            getBy.set(e.toId, (getBy.get(e.toId) || 0) + kw);
        }
        return { giveBy, getBy };
    }

    // Assign a default kW for a newly-created edge (Option A: auto).
    autoAssignConnectionKW(fromId, toId) {
        const from = String(fromId || '');
        const to = String(toId || '');
        if (!from || !to) return 0;

        const supply = this.getSupplyForDeviceId(from);
        const demand = this.getDemandForDeviceId(to);
        if (supply == null || demand == null) return 0;

        const outgoing = (this.connections || []).filter(e => e.fromId === from);
        const totalAssigned = outgoing.reduce((acc, e) => acc + this.getConnectionKW(e), 0);
        const remaining = Math.max(0, supply - totalAssigned);
        return Math.max(0, Math.min(remaining, demand));
    }

    editConnectionKW(fromId, toId) {
        const a = String(fromId || '');
        const b = String(toId || '');
        if (!a || !b) return;

        const edge = (this.connections || []).find(e => e.fromId === a && e.toId === b);
        if (!edge) return;

        const current = this.getConnectionKW(edge);
        const raw = window.prompt('Set power for this connection (kW):', String(current));
        if (raw == null) return;
        const next = Number(raw);
        if (!Number.isFinite(next) || next < 0) {
            this.showToast('Invalid kW value', 'error');
            return;
        }
        edge.kw = Math.round(next * 100) / 100;
        this.saveConnections();
        this.renderConnections();
    }

    saveConnections() {
        try {
            localStorage.setItem(this.connKey, JSON.stringify(this.connections || []));
        } catch {
            // ignore
        }
    }

    normalizeConnections() {
        // Remove duplicates + remove edges referencing devices that are no longer present.
        // IMPORTANT: compare against the same ids used by the diagram (dev:...).
        const existingIds = new Set([
            ...Array.from(this.connectedDevices.values()),
            ...Array.from(this.availableDevices.values())
        ].map(d => this.getConnDiagramId(d)));
        const seen = new Set();
        const out = [];
        for (const e of (this.connections || [])) {
            const fromId = String(e?.fromId || '');
            const toId = String(e?.toId || '');
            if (!fromId || !toId) continue;
            if (!existingIds.has(fromId) || !existingIds.has(toId)) continue;
            const k = `${fromId}=>${toId}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ fromId, toId, kw: (e && e.kw != null && Number.isFinite(Number(e.kw))) ? Number(e.kw) : null });
        }
        this.connections = out;
    }

    initConnectionsUI() {
        const clearBtn = document.getElementById('connClearBtn');
        if (clearBtn && !clearBtn._wired) {
            clearBtn._wired = true;
            clearBtn.addEventListener('click', () => {
                const ok = window.confirm('Clear all connections?');
                if (!ok) return;
                this.connections = [];
                this.connPendingFrom = null;
                this.saveConnections();
                this.renderConnections();
            });
        }

        // Mode 2 apply + auto toggle
        const applyBtn = document.getElementById('connApplyMode2Btn');
        if (applyBtn && !applyBtn._wired) {
            applyBtn._wired = true;
            applyBtn.addEventListener('click', async () => {
                try {
                    await this.applyConnectionsMode2({ source: 'mode2-manual' });
                } catch (e) {
                    console.error(e);
                    this.showToast('Mode 2 apply failed', 'error');
                }
            });
        }

        const autoToggle = document.getElementById('connAutoMode2Toggle');
        if (autoToggle && !autoToggle._wired) {
            autoToggle._wired = true;
            autoToggle.checked = !!this.connAutoMode2Enabled;
            autoToggle.addEventListener('change', () => this.setConnAutoMode2Enabled(autoToggle.checked));

            // Initialize timer once when the toggle first appears.
            this.updateConnAutoMode2Timer();
        }

        // Global event handler (capture) so Consumer clicks always register even if SVG overlays
        // or other layers are involved. We wire once.
        if (!document._connGlobalWired) {
            document._connGlobalWired = true;
            document.addEventListener('pointerdown', (ev) => {
                const block = ev.target?.closest?.('.conn-block');
                if (!block) return;

                const canvas = document.getElementById('connCanvas');
                if (!canvas || !canvas.contains(block)) return;

                const kind = block.getAttribute('data-kind');
                const id = this.decodeAttr(block.getAttribute('data-device-id') || '');
                if (!kind || !id) return;

                // prevent other handlers from interfering with rapid re-renders
                ev.preventDefault();
                ev.stopPropagation();

                const statusEl = document.getElementById('connStatus');
                const buildStamp = 'conn-ui:20260121_1';

                if (kind === 'provider') {
                    this.connPendingFrom = (this.connPendingFrom === id) ? null : id;
                    if (statusEl) statusEl.textContent = `Selected Provider: ${this.connPendingFrom || '(none)'} [${buildStamp}]`;
                    this.renderConnections();
                    return;
                }

                if (kind === 'consumer') {
                    if (!this.connPendingFrom) {
                        this.showToast('Select a Provider first', 'warning');
                        return;
                    }

                    const fromId = this.connPendingFrom;
                    const toId = id;
                    const k = `${fromId}=>${toId}`;
                    const exists = (this.connections || []).some(e => `${e.fromId}=>${e.toId}` === k);
                    if (!exists) {
                        const kw = this.autoAssignConnectionKW(fromId, toId);
                        this.connections.push({ fromId, toId, kw });
                        this.saveConnections();
                        this.showToast('Connected Provider → Consumer');
                        if (statusEl) statusEl.textContent = `Connected: ${fromId} → ${toId} [${buildStamp}]`;
                    }

                    this.renderConnections();
                }
            }, { capture: true });
        }

        // Redraw lines on resize
        if (!window._connResizeWired) {
            window._connResizeWired = true;
            window.addEventListener('resize', () => {
                try { this.drawConnections(); } catch {}
            });
        }

        // Demand Request Mode UI
        this.initDemandRequestUI();
        
        // Surplus Energy Handler UI
        this.initSurplusHandlerUI();
        
        // Metrics Pause/Resume Button
        this.initMetricsPauseBtn();
    }

    // ========== Metrics Pause/Resume ==========
    initMetricsPauseBtn() {
        const pauseBtn = document.getElementById('metricsPauseBtn');
        if (pauseBtn && !pauseBtn._wired) {
            pauseBtn._wired = true;
            this.metricsPaused = false;
            pauseBtn.addEventListener('click', () => this.toggleMetricsPause());
        }
        
        const refreshBtn = document.getElementById('metricsRefreshBtn');
        if (refreshBtn && !refreshBtn._wired) {
            refreshBtn._wired = true;
            refreshBtn.addEventListener('click', () => this.manualRefreshMetrics());
        }
        
        const resetBtn = document.getElementById('metricsResetFilterBtn');
        if (resetBtn && !resetBtn._wired) {
            resetBtn._wired = true;
            resetBtn.addEventListener('click', () => this.resetMetricsFilter());
        }
        
        const rawBtn = document.getElementById('metricsRawBtn');
        if (rawBtn && !rawBtn._wired) {
            rawBtn._wired = true;
            rawBtn.addEventListener('click', () => this.toggleMetricsRaw());
        }
    }

    resetMetricsFilter() {
        this.clearMetricsHistory();
        console.log('[Metrics] Filter history cleared');
        // Visual feedback
        const resetBtn = document.getElementById('metricsResetFilterBtn');
        if (resetBtn) {
            const originalText = resetBtn.textContent;
            resetBtn.textContent = '✅ Cleared';
            setTimeout(() => {
                resetBtn.textContent = originalText;
            }, 1000);
        }
    }

    toggleMetricsRaw() {
        this.metricsShowRaw = !this.metricsShowRaw;
        const rawBtn = document.getElementById('metricsRawBtn');
        if (rawBtn) {
            if (this.metricsShowRaw) {
                rawBtn.textContent = '📊 Raw ON';
                rawBtn.classList.add('active');
                console.log('[Metrics] Raw logging enabled - check console for raw values');
            } else {
                rawBtn.textContent = '📊 Raw';
                rawBtn.classList.remove('active');
                console.log('[Metrics] Raw logging disabled');
            }
        }
    }

    toggleMetricsPause() {
        const pauseBtn = document.getElementById('metricsPauseBtn');
        if (!pauseBtn) return;
        
        if (this.metricsPaused) {
            // Resume
            this.metricsPaused = false;
            this.ensureMetricsPolling();
            pauseBtn.textContent = '⏸️ Pause';
            pauseBtn.classList.remove('paused');
            pauseBtn.title = 'Pause auto-refresh';
            console.log('[Metrics] Resumed auto-refresh');
        } else {
            // Pause
            this.metricsPaused = true;
            this.stopMetricsPolling();
            pauseBtn.textContent = '▶️ Resume';
            pauseBtn.classList.add('paused');
            pauseBtn.title = 'Resume auto-refresh';
            console.log('[Metrics] Paused auto-refresh');
        }
    }

    async manualRefreshMetrics() {
        const refreshBtn = document.getElementById('metricsRefreshBtn');
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.textContent = '⏳ Refreshing...';
        }
        
        try {
            console.log('[Metrics] Manual refresh triggered');
            await this.refreshLiveMetrics();
        } catch (err) {
            console.error('[Metrics] Manual refresh error:', err);
        } finally {
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = '🔄 Refresh';
            }
        }
    }

    // ========== Surplus Energy Handler ==========
    // Routes excess power to CVT or storage devices

    initSurplusHandlerUI() {
        const applyBtn = document.getElementById('surplusApplyBtn');
        if (applyBtn && !applyBtn._wired) {
            applyBtn._wired = true;
            applyBtn.addEventListener('click', () => this.applySurplusToCVT());
        }

        // Update surplus display
        this.updateSurplusDisplay();
        this.updateSurplusTargetSelect();
    }

    updateSurplusDisplay() {
        const supplyEl = document.getElementById('surplusSupply');
        const demandEl = document.getElementById('surplusDemand');
        const surplusEl = document.getElementById('surplusValue');

        const supply = this.latestEstimatedSupplyKW || 0;
        const demand = this.latestEstimatedDemandKW || 0;
        const surplus = Math.max(0, supply - demand);

        if (supplyEl) supplyEl.textContent = `${supply.toFixed(2)} kW`;
        if (demandEl) demandEl.textContent = `${demand.toFixed(2)} kW`;
        if (surplusEl) surplusEl.textContent = `${surplus.toFixed(2)} kW`;
    }

    updateSurplusTargetSelect() {
        const select = document.getElementById('surplusTargetSelect');
        if (!select) return;

        // Find CVT devices or other storage/dump devices
        const all = [
            ...Array.from(this.connectedDevices.values()),
            ...Array.from(this.availableDevices.values())
        ];

        // CVT is typically a consumer that can absorb excess power
        const cvtDevices = all.filter(d => {
            const name = String(d.name || '').toLowerCase();
            return name.includes('cvt') || name.includes('storage') || name.includes('battery');
        });

        select.innerHTML = '<option value="">-- Select CVT/Storage --</option>';
        for (const d of cvtDevices) {
            const id = this.getConnDiagramId(d);
            const icon = this.getDeviceIcon(d.name);
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = `${icon} ${d.name}`;
            select.appendChild(opt);
        }

        // If no CVT found, also show all consumers as potential targets
        if (cvtDevices.length === 0) {
            const consumers = all.filter(d => d.type === 'consumer');
            for (const d of consumers) {
                const id = this.getConnDiagramId(d);
                const icon = this.getDeviceIcon(d.name);
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = `${icon} ${d.name}`;
                select.appendChild(opt);
            }
        }
    }

    async applySurplusToCVT() {
        const select = document.getElementById('surplusTargetSelect');
        const targetId = select?.value;

        if (!targetId) {
            this.showSurplusStatus('Please select a CVT or storage device.', 'warning');
            return;
        }

        const supply = this.latestEstimatedSupplyKW || 0;
        const demand = this.latestEstimatedDemandKW || 0;
        const surplus = Math.max(0, supply - demand);

        if (surplus <= 0) {
            this.showSurplusStatus('No surplus energy to route. Supply ≤ Demand.', 'warning');
            return;
        }

        // Find or create connection from providers to CVT
        const all = [
            ...Array.from(this.connectedDevices.values()),
            ...Array.from(this.availableDevices.values())
        ];

        const providers = all.filter(d => d.type === 'provider');
        if (providers.length === 0) {
            this.showSurplusStatus('No providers connected.', 'warning');
            return;
        }

        // Use generator as the main provider for surplus routing
        const generator = providers.find(p => String(p.name || '').toLowerCase().includes('generator'));
        const provider = generator || providers[0];
        const providerId = this.getConnDiagramId(provider);

        // Check if connection already exists
        const existingEdge = (this.connections || []).find(e => e.fromId === providerId && e.toId === targetId);
        
        if (existingEdge) {
            existingEdge.kw = surplus;
        } else {
            this.connections.push({ fromId: providerId, toId: targetId, kw: surplus });
        }

        this.saveConnections();
        this.renderConnections();

        // Try to send setLoad command to CVT if it supports it
        const targetDevice = all.find(d => this.getConnDiagramId(d) === targetId);
        if (targetDevice && this.connectedDevices.has(targetDevice.id)) {
            const dev = this.connectedDevices.get(targetDevice.id);
            if (dev.revidyneDevice && dev.commands && dev.commands.includes('setLoad')) {
                try {
                    await this.executeCommand(dev.id, 'setLoad', { 
                        args: [String(surplus.toFixed(2))],
                        prompt: null 
                    });
                    this.showSurplusStatus(
                        `✅ Routed ${surplus.toFixed(2)} kW surplus to ${targetDevice.name}. setLoad command sent.`,
                        'success'
                    );
                    return;
                } catch (err) {
                    console.error('Failed to set CVT load:', err);
                }
            }
        }

        this.showSurplusStatus(
            `✅ Routed ${surplus.toFixed(2)} kW surplus to CVT. Connection updated.`,
            'success'
        );
    }

    showSurplusStatus(message, type = '') {
        const statusEl = document.getElementById('surplusStatus');
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.className = 'surplus-status';
        if (type) statusEl.classList.add(type);
    }

    // ========== Demand Request Mode (Multiple Rows) ==========
    // Allows consumers to "request" power, automatically updating connections and generators

    initDemandRequestUI() {
        // Initialize demand requests array
        if (!this.demandRequests) {
            this.demandRequests = [];
        }

        const addBtn = document.getElementById('demandAddBtn');
        if (addBtn && !addBtn._wired) {
            addBtn._wired = true;
            addBtn.addEventListener('click', () => this.addDemandRow());
        }

        const applyAllBtn = document.getElementById('demandApplyAllBtn');
        if (applyAllBtn && !applyAllBtn._wired) {
            applyAllBtn._wired = true;
            applyAllBtn.addEventListener('click', () => this.applyAllDemandRequests());
        }

        const clearAllBtn = document.getElementById('demandClearAllBtn');
        if (clearAllBtn && !clearAllBtn._wired) {
            clearAllBtn._wired = true;
            clearAllBtn.addEventListener('click', () => this.clearAllDemandRequests());
        }

        // Render existing rows
        this.renderDemandRequestList();
    }

    getConsumerOptions() {
        const all = [
            ...Array.from(this.connectedDevices.values()),
            ...Array.from(this.availableDevices.values())
        ];
        return all.filter(d => d.type === 'consumer');
    }

    addDemandRow(consumerId = '', powerKW = '') {
        const rowId = Date.now();
        this.demandRequests.push({ id: rowId, consumerId, powerKW });
        this.renderDemandRequestList();
    }

    removeDemandRow(rowId) {
        this.demandRequests = this.demandRequests.filter(r => r.id !== rowId);
        this.renderDemandRequestList();
    }

    updateDemandRow(rowId, field, value) {
        const row = this.demandRequests.find(r => r.id === rowId);
        if (row) {
            row[field] = value;
        }
        this.updateDemandTotal();
    }

    updateDemandTotal() {
        const totalEl = document.getElementById('demandTotalKW');
        if (!totalEl) return;

        let total = 0;
        for (const r of this.demandRequests) {
            const kw = parseFloat(r.powerKW) || 0;
            if (kw > 0) total += kw;
        }
        totalEl.textContent = `Total: ${total.toFixed(2)} kW`;
    }

    renderDemandRequestList() {
        const listEl = document.getElementById('demandRequestList');
        if (!listEl) return;

        const consumers = this.getConsumerOptions();

        if (this.demandRequests.length === 0) {
            listEl.innerHTML = '<div class="demand-request-empty">No requests yet. Click "+ Add Request" to start.</div>';
            this.updateDemandTotal();
            return;
        }

        listEl.innerHTML = this.demandRequests.map(r => {
            const consumerOptions = consumers.map(c => {
                const id = this.getConnDiagramId(c);
                const icon = this.getDeviceIcon(c.name);
                const selected = id === r.consumerId ? 'selected' : '';
                return `<option value="${this.encodeAttr(id)}" ${selected}>${icon} ${this.escapeHtml(c.name)}</option>`;
            }).join('');

            return `
                <div class="demand-request-row" data-row-id="${r.id}">
                    <select onchange="manager.updateDemandRow(${r.id}, 'consumerId', this.value)">
                        <option value="">-- Select --</option>
                        ${consumerOptions}
                    </select>
                    <input type="number" min="0" step="0.01" placeholder="kW" 
                           value="${r.powerKW}" 
                           onchange="manager.updateDemandRow(${r.id}, 'powerKW', this.value)"
                           oninput="manager.updateDemandRow(${r.id}, 'powerKW', this.value)" />
                    <button class="demand-row-remove" onclick="manager.removeDemandRow(${r.id})">✕</button>
                </div>
            `;
        }).join('');

        this.updateDemandTotal();
    }

    clearAllDemandRequests() {
        this.demandRequests = [];
        this.renderDemandRequestList();
        this.showDemandStatus('All requests cleared.', '');
    }

    async applyAllDemandRequests() {
        if (this.demandRequests.length === 0) {
            this.showDemandStatus('No requests to apply. Add some first!', 'error');
            return;
        }

        const validRequests = this.demandRequests.filter(r => {
            const kw = parseFloat(r.powerKW) || 0;
            return r.consumerId && kw > 0;
        });

        if (validRequests.length === 0) {
            this.showDemandStatus('Please fill in consumer and power for at least one request.', 'error');
            return;
        }

        let successCount = 0;
        let totalKW = 0;

        for (const req of validRequests) {
            const consumerId = req.consumerId;
            const powerKW = parseFloat(req.powerKW) || 0;

            // Find or create connection to this consumer
            const connectedProviders = (this.connections || [])
                .filter(e => e.toId === consumerId)
                .map(e => e.fromId);

            if (connectedProviders.length === 0) {
                this.autoConnectConsumerToProvider(consumerId);
            }

            // Update the connection kW for this consumer
            const edges = (this.connections || []).filter(e => e.toId === consumerId);
            if (edges.length === 1) {
                edges[0].kw = powerKW;
            } else if (edges.length > 1) {
                const perProvider = powerKW / edges.length;
                for (const e of edges) {
                    e.kw = Math.round(perProvider * 100) / 100;
                }
            }

            successCount++;
            totalKW += powerKW;
        }

        this.saveConnections();
        this.renderConnections();

        // Apply Mode 2 to have the generator fill the deficit
        try {
            await this.applyConnectionsMode2({ source: 'demand-request-batch' });
            
            this.showDemandStatus(
                `✅ Applied ${successCount} request(s), total ${totalKW.toFixed(2)} kW. Generator adjusted.`,
                'success'
            );
        } catch (err) {
            console.error('Demand request batch failed:', err);
            this.showDemandStatus('Connections updated, but generator adjustment failed.', 'error');
        }
    }

    autoConnectConsumerToProvider(consumerId) {
        // Try to find a provider (prefer generator) and auto-create a connection
        const all = [
            ...Array.from(this.connectedDevices.values()),
            ...Array.from(this.availableDevices.values())
        ];

        const providers = all.filter(d => d.type === 'provider');
        if (providers.length === 0) return false;

        // Prefer generator, otherwise use first provider
        const generator = providers.find(p => String(p.name || '').toLowerCase().includes('generator'));
        const provider = generator || providers[0];
        const providerId = this.getConnDiagramId(provider);

        // Create the connection
        this.connections.push({ fromId: providerId, toId: consumerId, kw: 0 });
        this.saveConnections();
        this.showToast(`Auto-connected ${provider.name} → Consumer`);
        return true;
    }

    getDeviceNameFromId(deviceId) {
        const all = [
            ...Array.from(this.connectedDevices.values()),
            ...Array.from(this.availableDevices.values())
        ];
        const dev = all.find(d => this.getConnDiagramId(d) === deviceId);
        return dev ? dev.name : deviceId;
    }

    showDemandStatus(message, type = '') {
        const statusEl = document.getElementById('demandRequestStatus');
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.className = 'demand-request-status';
        if (type) statusEl.classList.add(type);
    }

    renderConnections() {
        const providersEl = document.getElementById('connProviders');
        const consumersEl = document.getElementById('connConsumers');
        const statusEl = document.getElementById('connStatus');
        const svg = document.getElementById('connSvg');
        const canvas = document.getElementById('connCanvas');
        if (!providersEl || !consumersEl || !statusEl || !svg || !canvas) return;

        this.initConnectionsUI();
        
        // Update demand request list with current consumers
        this.renderDemandRequestList();
        
        // Update surplus handler display
        this.updateSurplusDisplay();
        this.updateSurplusTargetSelect();
        
        this.normalizeConnections();
        this.saveConnections();

        // Build blocks from both Connected and Available devices so the diagram isn't empty
        // when devices haven't been dragged to Connected yet.
        const toDiagramDevice = (d, source) => ({
            ...d,
            id: this.getConnDiagramId(d),
            _connSource: source
        });

        const pool = [
            ...Array.from(this.connectedDevices.values()).map(d => toDiagramDevice(d, 'connected')),
            ...Array.from(this.availableDevices.values()).map(d => toDiagramDevice(d, 'available'))
        ];

        // De-dupe by id (Connected wins if same device appears twice)
        const byId = new Map();
        for (const d of pool) {
            if (!d || !d.id) continue;
            if (!byId.has(d.id) || d._connSource === 'connected') byId.set(d.id, d);
        }

        const all = Array.from(byId.values());
        const providers = all.filter(d => d.type === 'provider');
        const consumers = all.filter(d => d.type === 'consumer');

        const totals = this.computeConnTotals();

        const mkBlock = (d, kind) => {
            const sel = (kind === 'provider' && this.connPendingFrom === d.id) ? ' selected' : '';
            const sub = (kind === 'provider') ? 'Producer' : 'Consumer';
            const icon = this.getDeviceIcon(d.name);
            const src = d._connSource === 'available' ? ' (Available)' : '';
            const give = totals.giveBy.get(d.id);
            const get = totals.getBy.get(d.id);
            const extra = (kind === 'provider')
                ? (give != null ? ` • Give ${give.toFixed(2)} kW` : '')
                : (get != null ? ` • Get ${get.toFixed(2)} kW` : '');
            return `
                <div class="conn-block ${kind}${sel}" data-device-id="${this.encodeAttr(d.id)}" data-kind="${kind}" tabindex="0" role="button" aria-label="${this.escapeHtml(d.name)} ${sub}">
                    <div>
                        <div class="conn-block-title">${icon} ${this.escapeHtml(d.name)}</div>
                        <div class="conn-block-sub">${sub}${src}${extra}</div>
                    </div>
                </div>
            `;
        };

        providersEl.innerHTML = providers.length
            ? providers.map(d => mkBlock(d, 'provider')).join('')
            : '<div class="empty-state">No Provider devices found. Scan devices or add a Provider device.</div>';

        consumersEl.innerHTML = consumers.length
            ? consumers.map(d => mkBlock(d, 'consumer')).join('')
            : '<div class="empty-state">No Consumer devices found. Scan devices or add a Consumer device.</div>';

        // Click handling is wired globally in initConnectionsUI() (capture phase).

        const n = (this.connections || []).length;
        statusEl.textContent = n
            ? `${n} connection${n === 1 ? '' : 's'}. (Click a label to edit; Shift+click a line to remove)${this.connAutoMode2Enabled ? ' • Auto Mode 2 ON' : ''}`
            : `No connections yet.${this.connAutoMode2Enabled ? ' • Auto Mode 2 ON' : ''}`;

        // Clear SVG then redraw after layout settles
        svg.innerHTML = '';
        if (this._connDrawRaf) cancelAnimationFrame(this._connDrawRaf);
        this._connDrawRaf = requestAnimationFrame(() => {
            try { this.drawConnections(); } catch {}
        });
    }

    drawConnections() {
        const svg = document.getElementById('connSvg');
        const canvas = document.getElementById('connCanvas');
        if (!svg || !canvas) return;

        // Clear existing lines
        svg.innerHTML = '';

        const rectCanvas = canvas.getBoundingClientRect();
        if (!rectCanvas.width || !rectCanvas.height) return;
        const toLocal = (rect) => ({
            x: rect.left - rectCanvas.left,
            y: rect.top - rectCanvas.top,
            w: rect.width,
            h: rect.height
        });

        // Set viewBox so coordinates are stable
        const w = rectCanvas.width;
        const h = rectCanvas.height;
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('preserveAspectRatio', 'none');

        const getBlockRect = (deviceId) => {
            const el = canvas.querySelector(`.conn-block[data-device-id="${CSS.escape(String(deviceId))}"]`);
            if (!el) return null;
            return toLocal(el.getBoundingClientRect());
        };

        const edges = (this.connections || []).slice();
        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            const a = getBlockRect(e.fromId);
            const b = getBlockRect(e.toId);
            if (!a || !b) continue;

            const x1 = a.x + a.w;
            const y1 = a.y + (a.h / 2);
            const x2 = b.x;
            const y2 = b.y + (b.h / 2);

            // simple smooth curve
            const dx = Math.max(40, (x2 - x1) * 0.55);
            const c1x = x1 + dx;
            const c1y = y1;
            const c2x = x2 - dx;
            const c2y = y2;
            const d = `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.setAttribute('class', 'conn-line');

            const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            hit.setAttribute('d', d);
            hit.setAttribute('class', 'conn-line-hit');
            hit.addEventListener('click', (ev) => {
                ev.stopPropagation();
                // If shift-click, remove; otherwise edit kW.
                if (ev.shiftKey) this.removeConnection(e.fromId, e.toId);
                else this.editConnectionKW(e.fromId, e.toId);
            });

            // Label (kW) at the midpoint of the curve
            const t = 0.5;
            const bez = (p0, p1, p2, p3, t) => {
                const u = 1 - t;
                return (u*u*u*p0) + (3*u*u*t*p1) + (3*u*t*t*p2) + (t*t*t*p3);
            };
            let mx = bez(x1, c1x, c2x, x2, t);
            let my = bez(y1, c1y, c2y, y2, t);

            // Offset labels a bit so multiple edges don't stack exactly on top of each other.
            const offset = ((i % 3) - 1) * 16; // -16, 0, +16
            my += offset;

            const kw = this.getConnectionKW(e);
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', String(mx));
            label.setAttribute('y', String(my));
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('dominant-baseline', 'central');
            label.setAttribute('class', 'conn-label');
            label.textContent = `${kw.toFixed(2)}kW`;
            label.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.editConnectionKW(e.fromId, e.toId);
            });

            const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            labelBg.setAttribute('class', 'conn-label-bg');

            // Append in order: line, hit, bg, label
            svg.appendChild(path);
            svg.appendChild(hit);
            svg.appendChild(labelBg);
            svg.appendChild(label);

            const bb = label.getBBox();
            const padX = 8;
            const padY = 4;
            labelBg.setAttribute('x', String(bb.x - padX));
            labelBg.setAttribute('y', String(bb.y - padY));
            labelBg.setAttribute('width', String(bb.width + padX * 2));
            labelBg.setAttribute('height', String(bb.height + padY * 2));
            labelBg.setAttribute('rx', '8');
            labelBg.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.editConnectionKW(e.fromId, e.toId);
            });

            // (already appended in the right order)
        }
    }

    removeConnection(fromId, toId) {
        const a = String(fromId || '');
        const b = String(toId || '');
        if (!a || !b) return;
        this.connections = (this.connections || []).filter(e => !(e.fromId === a && e.toId === b));
        this.saveConnections();
        this.renderConnections();
        this.showToast('Connection removed');
    }

    loadAutoEstimateEnabled() {
        try {
            return localStorage.getItem(this.autoEstKey) === '1';
        } catch {
            return false;
        }
    }

    loadAutoEstimateTuning() {
        try {
            const raw = localStorage.getItem(this.autoEstTuningKey);
            if (!raw) return { alpha: 0.35, maxStepKW: 1.0 };
            const v = JSON.parse(raw);
            const alpha = Number(v && v.alpha);
            const maxStepKW = Number(v && v.maxStepKW);
            return {
                alpha: (Number.isFinite(alpha) ? Math.max(0.05, Math.min(0.95, alpha)) : 0.35),
                maxStepKW: (Number.isFinite(maxStepKW) ? Math.max(0.1, Math.min(20, maxStepKW)) : 1.0)
            };
        } catch {
            return { alpha: 0.35, maxStepKW: 1.0 };
        }
    }

    saveAutoEstimateTuning() {
        try {
            localStorage.setItem(this.autoEstTuningKey, JSON.stringify({
                alpha: this.autoEstAlpha,
                maxStepKW: this.autoEstMaxStepKW
            }));
        } catch {
            // ignore
        }
    }

    setAutoEstimateEnabled(v) {
        this.autoEstEnabled = Boolean(v);
        try {
            localStorage.setItem(this.autoEstKey, this.autoEstEnabled ? '1' : '0');
        } catch {
            // ignore
        }

        // Reset inference state whenever toggled.
        this.autoEstLastSupplyKW = null;
        this.autoEstDemandKW = null;
        this.autoEstUpdatedAt = null;

        this.renderMetrics();
    }

    inferDemandKW(totalSupplyKW, manualDemandKW) {
        // Returns inferred demand, or null if inference not possible.
        if (!this.autoEstEnabled) return null;

        if (!(typeof totalSupplyKW === 'number' && Number.isFinite(totalSupplyKW))) return null;
        if (totalSupplyKW <= 0) return null;

        const manual = (typeof manualDemandKW === 'number' && Number.isFinite(manualDemandKW)) ? manualDemandKW : 0;

        // Model choice (simple + demo-friendly):
        // When we have no consumer telemetry, the best proxy for demand is the supply output itself.
        // We treat demand ≈ supply, smoothed, with an optional floor at the manual estimate.

        const floor = Math.max(0, manual);
        const rawTarget = Math.max(floor, totalSupplyKW);

        // Apply a max step to avoid sudden jumps (demo stability)
        if (typeof this.autoEstDemandKW === 'number' && Number.isFinite(this.autoEstDemandKW)) {
            const maxStep = (typeof this.autoEstMaxStepKW === 'number' && Number.isFinite(this.autoEstMaxStepKW))
                ? Math.max(0.1, this.autoEstMaxStepKW)
                : 1.0;
            const bounded = this.autoEstDemandKW + Math.max(-maxStep, Math.min(maxStep, rawTarget - this.autoEstDemandKW));
            // Smooth towards bounded target
            const a = (typeof this.autoEstAlpha === 'number' && Number.isFinite(this.autoEstAlpha))
                ? Math.max(0.05, Math.min(0.95, this.autoEstAlpha))
                : 0.35;
            this.autoEstDemandKW = (a * bounded) + ((1 - a) * this.autoEstDemandKW);
            this.autoEstLastSupplyKW = totalSupplyKW;
            this.autoEstUpdatedAt = Date.now();
            return this.autoEstDemandKW;
        }

        if (!(typeof this.autoEstDemandKW === 'number' && Number.isFinite(this.autoEstDemandKW))) {
            this.autoEstDemandKW = rawTarget;
            this.autoEstLastSupplyKW = totalSupplyKW;
            this.autoEstUpdatedAt = Date.now();
            return this.autoEstDemandKW;
        }

        {
            const a = (typeof this.autoEstAlpha === 'number' && Number.isFinite(this.autoEstAlpha))
                ? Math.max(0.05, Math.min(0.95, this.autoEstAlpha))
                : 0.35;
            this.autoEstDemandKW = (a * rawTarget) + ((1 - a) * this.autoEstDemandKW);
        }
        this.autoEstLastSupplyKW = totalSupplyKW;
        this.autoEstUpdatedAt = Date.now();
        return this.autoEstDemandKW;
    }

    // ---------------- Power estimation (manual inputs) ----------------
    getPowerEstKey(deviceName) {
        return `${this.powerEstKeyPrefix}${String(deviceName || '').trim()}`;
    }

    loadPowerEst(deviceName) {
        try {
            const raw = localStorage.getItem(this.getPowerEstKey(deviceName));
            if (!raw) return null;
            const v = JSON.parse(raw);
            return v && typeof v === 'object' ? v : null;
        } catch {
            return null;
        }
    }

    savePowerEst(deviceName, value) {
        try {
            localStorage.setItem(this.getPowerEstKey(deviceName), JSON.stringify(value));
        } catch {
            // ignore
        }
    }

    clamp01(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(1, n));
    }

    fmtKW(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return '—';
        return `${n.toFixed(n < 10 ? 2 : 1)} kW`;
    }

    parsePositiveNumber(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        if (n < 0) return null;
        return n;
    }

    // Returns estimated kW based on manual inputs; falls back to telemetry if present.
    computeEstimatedKW(deviceInfo, metric) {
        const name = deviceInfo ? deviceInfo.name : '';
        const est = this.loadPowerEst(name) || {};

        // If user prefers manual estimates (demo mode), try manual first.
        if (this.preferManualEstimates && deviceInfo) {
            if (deviceInfo.type === 'consumer') {
                const ratedW = this.parsePositiveNumber(est.ratedW);
                const util = this.clamp01(est.utilization ?? 1);
                if (ratedW != null) return { kw: (ratedW * util) / 1000, source: 'estimate' };
            }
            if (deviceInfo.type === 'provider') {
                const capacityKW = this.parsePositiveNumber(est.capacityKW);
                const avail = this.clamp01(est.availability ?? 1);
                if (capacityKW != null) return { kw: capacityKW * avail, source: 'estimate' };
            }
        }

        // Default: telemetry first (if present)
        if (metric && metric.kw != null && Number.isFinite(Number(metric.kw))) {
            return { kw: Number(metric.kw), source: 'telemetry' };
        }

        if (deviceInfo && deviceInfo.type === 'consumer') {
            const ratedW = this.parsePositiveNumber(est.ratedW);
            const util = this.clamp01(est.utilization ?? 1);
            if (ratedW == null) return { kw: null, source: 'none' };
            return { kw: (ratedW * util) / 1000, source: 'estimate' };
        }

        if (deviceInfo && deviceInfo.type === 'provider') {
            const capacityKW = this.parsePositiveNumber(est.capacityKW);
            const avail = this.clamp01(est.availability ?? 1);
            if (capacityKW == null) return { kw: null, source: 'none' };
            return { kw: capacityKW * avail, source: 'estimate' };
        }

        return { kw: null, source: 'none' };
    }

    renderPowerEstInputs(deviceInfo, metric) {
        if (!deviceInfo) return '';
        const est = this.loadPowerEst(deviceInfo.name) || {};

        if (deviceInfo.type === 'consumer') {
            const ratedW = (est.ratedW != null) ? String(est.ratedW) : '';
            const util = this.clamp01(est.utilization ?? 1);
            const utilPct = Math.round(util * 100);
            const hint = (metric && metric.telemetryStatus === 'no-telemetry-cmds')
                ? 'No telemetry; use estimates.'
                : 'Optional estimate.';
            return `
                <div class="metrics-est">
                    <div class="metrics-est-hint">${hint}</div>
                    <label class="metrics-est-row">
                        <span>Rated (W)</span>
                        <input class="metrics-est-input" type="number" min="0" step="1" value="${ratedW}" placeholder="e.g., 120" data-est="ratedW" data-device="${deviceInfo.name}" />
                    </label>
                    <label class="metrics-est-row">
                        <span>Utilization</span>
                        <input class="metrics-est-range" type="range" min="0" max="100" step="5" value="${utilPct}" data-est="utilization" data-device="${deviceInfo.name}" />
                        <span class="metrics-est-val">${utilPct}%</span>
                    </label>
                </div>
            `;
        }

        if (deviceInfo.type === 'provider') {
            const cap = (est.capacityKW != null) ? String(est.capacityKW) : '';
            const avail = this.clamp01(est.availability ?? 1);
            const availPct = Math.round(avail * 100);
            const hint = (metric && metric.telemetryStatus === 'no-telemetry-cmds')
                ? 'No telemetry; use estimates.'
                : 'Optional estimate.';
            return `
                <div class="metrics-est">
                    <div class="metrics-est-hint">${hint}</div>
                    <label class="metrics-est-row">
                        <span>Capacity (kW)</span>
                        <input class="metrics-est-input" type="number" min="0" step="0.1" value="${cap}" placeholder="e.g., 1.5" data-est="capacityKW" data-device="${deviceInfo.name}" />
                    </label>
                    <label class="metrics-est-row">
                        <span>Availability</span>
                        <input class="metrics-est-range" type="range" min="0" max="100" step="5" value="${availPct}" data-est="availability" data-device="${deviceInfo.name}" />
                        <span class="metrics-est-val">${availPct}%</span>
                    </label>
                </div>
            `;
        }

        return '';
    }

    attachMetricsEstimateListeners() {
        const container = document.getElementById('metricsTableBody');
        if (!container) return;

        // One-time wiring; the handler reads data-* from the event target
        if (container._estHandlersAttached) return;
        container._estHandlersAttached = true;

        const onChange = (e) => {
            const t = e.target;
            if (!t || !t.dataset) return;
            const deviceName = t.dataset.device;
            const field = t.dataset.est;
            if (!deviceName || !field) return;

            const cur = this.loadPowerEst(deviceName) || {};
            if (field === 'utilization' || field === 'availability') {
                const pct = this.parsePositiveNumber(t.value);
                const v = pct == null ? 0 : this.clamp01((pct / 100));
                cur[field] = v;

                // update nearby label
                const row = t.closest('.metrics-est-row');
                const valEl = row ? row.querySelector('.metrics-est-val') : null;
                if (valEl) valEl.textContent = `${Math.round(v * 100)}%`;
            } else {
                const n = this.parsePositiveNumber(t.value);
                if (t.value === '' || n == null) {
                    delete cur[field];
                } else {
                    cur[field] = n;
                }
            }

            this.savePowerEst(deviceName, cur);
            this.renderMetrics();
        };

        container.addEventListener('input', onChange);
        container.addEventListener('change', onChange);
    }

    buildCommandHelpEN() {
        // Keep this lightweight: map command name -> short English description.
        // Device-specific nuances can be explained in the "notes" text.
        return {
            // --- Solar tracker ---
            init: 'Initialize/reset the device state. Use after connecting or if behavior feels off.',
            runScan: 'Run a calibration/scan routine to find limits or calibrate sensors (may take time; device may move).',
            trackOn: 'Enable automatic sun tracking.',
            trackOff: 'Disable automatic sun tracking (hold current position).',
            runIVScan: 'Run an I–V scan (current/voltage sweep) to characterize the panel / find MPP (may take time).',
            goHome: 'Move to the home/reference position.',
            goMax: 'Move to the maximum travel/angle limit (use with care).',
            go: 'Go to a specific position/angle. Usually requires an argument (e.g., degrees or steps).',
            moveCW: 'Move clockwise (manual adjustment).',
            moveCCW: 'Move counter-clockwise (manual adjustment).',

            // --- Common / generic ---
            status: 'Query device status (if supported by firmware).',
            help: 'List available commands (if supported).',
            info: 'Show device information (if supported).',

            // --- Generator / loads (generic, firmware dependent) ---
            genOn: 'Turn the generator ON.',
            genOff: 'Turn the generator OFF.',
            start: 'Start the device.',
            stop: 'Stop the device.',
            on: 'Turn ON.',
            off: 'Turn OFF.',

            // set* is risky / parameterized
            setLoad: 'Set house load value (requires an argument). [Demo/Safe Mode may block set* commands]',
            set: 'Set a parameter (requires argument). [Demo/Safe Mode may block set* commands]'
        };
    }

    getCommandHelpText(cmdName) {
        const key = String(cmdName || '').trim();
        if (!key) return '';

        // Exact match first
        if (this.commandHelp && this.commandHelp[key]) return this.commandHelp[key];

        // Case-insensitive match
        const lower = key.toLowerCase();
        const found = Object.keys(this.commandHelp || {}).find(k => k.toLowerCase() === lower);
        if (found) return this.commandHelp[found];

        // Generic fallback for set*
        if (lower.startsWith('set')) {
            return 'Set a parameter (requires argument). [Demo/Safe Mode may block set* commands]';
        }

        return '';
    }

    loadSafeModeEnabled() {
        try {
            const raw = localStorage.getItem(this.safeModeKey);
            if (raw == null) return false;
            return raw === '1' || raw === 'true';
        } catch {
            return false;
        }
    }

    setSafeModeEnabled(enabled) {
        this.safeModeEnabled = Boolean(enabled);
        try {
            localStorage.setItem(this.safeModeKey, this.safeModeEnabled ? '1' : '0');
        } catch {
            // ignore
        }
        this.updateSafeModeUI();
        this.updateAllocationUIState();
        this.renderFlow();
        this.showToast(this.safeModeEnabled ? 'Demo/Safe Mode: ON (set* blocked)' : 'Demo/Safe Mode: OFF');
    }

    updateSafeModeUI() {
        const toggle = document.getElementById('safeModeToggle');
        if (toggle) toggle.checked = !!this.safeModeEnabled;
        document.documentElement.classList.toggle('safe-mode-on', !!this.safeModeEnabled);
    }
    
    init() {
        document.getElementById('scanBtn').addEventListener('click', () => this.scanDevices());

        // Navigation bar page switching
        this.initNavbar();

        // Demo Cycle button
        const demoCycleBtn = document.getElementById('demoCycleBtn');
        if (demoCycleBtn) {
            demoCycleBtn.addEventListener('click', () => this.runDemoCycle());
        }

        // Tutorial button
        const tutorialHeaderBtn = document.getElementById('showTutorialBtn');
        if (tutorialHeaderBtn) {
            tutorialHeaderBtn.addEventListener('click', () => {
                this.showOnboarding();
                this.startTour();
            });
        }

        // Live metrics quick actions
        const jumpBtn = document.getElementById('jumpToEstimatesBtn');
        if (jumpBtn) {
            jumpBtn.addEventListener('click', () => this.jumpToEstimates());
        }

        const safeToggle = document.getElementById('safeModeToggle');
        if (safeToggle) {
            safeToggle.addEventListener('change', () => this.setSafeModeEnabled(safeToggle.checked));
        }

        const detailsToggle = document.getElementById('metricsShowDetailsToggle');
        if (detailsToggle) {
            detailsToggle.addEventListener('change', () => this.setMetricsDetailsEnabled(detailsToggle.checked));
        }
        this.updateMetricsDetailsUI();

        const preferManualToggle = document.getElementById('preferManualEstimatesToggle');
        if (preferManualToggle) {
            preferManualToggle.addEventListener('change', () => this.setPreferManualEstimatesEnabled(preferManualToggle.checked));
        }
        this.updatePreferManualEstimatesUI();
        
    // Check Web Serial API support
        if (!navigator.serial) {
            this.showNotSupported();
            return;
        }
        
    // Listen for serial connect/disconnect events
        navigator.serial.addEventListener('connect', (e) => this.onPortConnect(e));
        navigator.serial.addEventListener('disconnect', (e) => this.onPortDisconnect(e));
        
        this.updateUI();

        // Flow builder might exist in the page; initialize UI if present
        this.renderFlow();
    this.renderRunSummary();
        this.renderRunHistory();

        // Command library (drag commands into flow)
        const search = document.getElementById('librarySearch');
        if (search) {
            search.addEventListener('input', () => this.refreshCommandLibrary());
        }
        this.refreshCommandLibrary();

        // Templates (one-click flow presets)
        const tplGenLoad = document.querySelector('[data-template="gen_load_cycle"]');
        const tplSolar = document.querySelector('[data-template="solar_tracker_routine"]');
        const tplSafe = document.querySelector('[data-template="safe_demo"]');
        if (tplGenLoad) tplGenLoad.addEventListener('click', () => this.applyTemplate('gen_load_cycle'));
        if (tplSolar) tplSolar.addEventListener('click', () => this.applyTemplate('solar_tracker_routine'));
        if (tplSafe) tplSafe.addEventListener('click', () => this.applyTemplate('safe_demo'));

        // Onboarding UI
        this.initOnboarding();

        // Apply persisted safe mode state
        this.updateSafeModeUI();

        // Allocation UI (optional: older index.html may not have it)
        this.initAllocationUI();

        // Auto-estimate demand UI (optional)
        const autoBtn = document.getElementById('autoEstDemandToggleBtn');
        if (autoBtn) {
            autoBtn.addEventListener('click', () => {
                this.setAutoEstimateEnabled(!this.autoEstEnabled);
                this.updateAutoEstimateUI();
                this.updateDemandSourceHint();
                this.showToast(`Auto-estimate demand: ${this.autoEstEnabled ? 'ON' : 'OFF'}`, 'info');
            });
        }

        // Auto-estimate tuning UI
        const alphaEl = document.getElementById('autoEstAlpha');
        const maxStepEl = document.getElementById('autoEstMaxStep');
        if (alphaEl) {
            alphaEl.value = String(this.autoEstAlpha);
            alphaEl.addEventListener('input', () => {
                const v = Number(alphaEl.value);
                if (Number.isFinite(v)) {
                    this.autoEstAlpha = Math.max(0.05, Math.min(0.95, v));
                    this.saveAutoEstimateTuning();
                    this.renderMetrics();
                }
            });
        }
        if (maxStepEl) {
            maxStepEl.value = String(this.autoEstMaxStepKW);
            maxStepEl.addEventListener('change', () => {
                const v = Number(maxStepEl.value);
                if (Number.isFinite(v)) {
                    this.autoEstMaxStepKW = Math.max(0.1, Math.min(20, v));
                    this.saveAutoEstimateTuning();
                    this.renderMetrics();
                }
            });
        }

        // Demo Tour
        const demoBtn = document.getElementById('demoTourBtn');
        if (demoBtn) {
            demoBtn.addEventListener('click', () => this.runDemoTour());
        }
        this.updateAutoEstimateUI();
        this.updateDemandSourceHint();
    }

    updateDemandSourceHint() {
        const el = document.getElementById('demandSourceHint');
        if (!el) return;
        el.textContent = this.autoEstEnabled
            ? 'Demand source: Auto-estimate (from supply)'
            : 'Demand source: Manual (device estimates)';
    }

    jumpToEstimates() {
        // Per-device estimate inputs are rendered as extra rows in the metrics table.
        const first = document.querySelector('.metrics-est-row');
        if (!first) {
            this.showToast('No device estimates to edit yet. Connect devices first.', 'warning');
            return;
        }

        try {
            first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {
            first.scrollIntoView();
        }

        // Brief highlight so it’s obvious where to edit.
        const rows = Array.from(document.querySelectorAll('.metrics-est-row'));
        rows.forEach(r => r.classList.remove('flash'));
        void first.offsetHeight;
        rows.forEach(r => r.classList.add('flash'));

        this.showToast('Edit Capacity/Availability (providers) and Rated/Utilization (consumers) below.', 'info');
    }

    // ========== Navigation Bar ==========
    initNavbar() {
        const navBtns = document.querySelectorAll('.nav-btn');
        const pages = document.querySelectorAll('.nav-page');
        
        navBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetPage = btn.dataset.page;
                
                // Update active button
                navBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                // Update active page
                pages.forEach(p => p.classList.remove('active'));
                const page = document.getElementById(`page-${targetPage}`);
                if (page) {
                    page.classList.add('active');
                }
                
                // Save preference
                try {
                    localStorage.setItem('revidyne.currentPage', targetPage);
                } catch {}
            });
        });
        
        // Restore last page from localStorage
        try {
            const savedPage = localStorage.getItem('revidyne.currentPage');
            if (savedPage) {
                const btn = document.querySelector(`.nav-btn[data-page="${savedPage}"]`);
                if (btn) btn.click();
            }
        } catch {}
    }

    // Navigate to a specific page programmatically
    navigateTo(pageName) {
        const btn = document.querySelector(`.nav-btn[data-page="${pageName}"]`);
        if (btn) btn.click();
    }

    updateAutoEstimateUI() {
        const btn = document.getElementById('autoEstDemandToggleBtn');
        const status = document.getElementById('autoEstDemandStatus');
        if (btn) btn.textContent = this.autoEstEnabled ? 'Disable auto-estimate' : 'Enable auto-estimate';
        if (status) {
            if (!this.autoEstEnabled) {
                status.textContent = 'Auto-estimate is OFF. Estimated demand comes from manual Consumer estimates.';
            } else if (this.autoEstUpdatedAt && typeof this.autoEstDemandKW === 'number' && Number.isFinite(this.autoEstDemandKW)) {
                status.textContent = `Auto-estimate is ON. Inferred demand: ${this.fmtKW(this.autoEstDemandKW)} (updated ${this.formatDateTime(this.autoEstUpdatedAt)}).`;
            } else {
                status.textContent = 'Auto-estimate is ON. Waiting for supply signal (connect a Provider and enter Capacity/Availability if no telemetry).';
            }
        }

        // Keep related UI in sync
        this.updateDemandSourceHint();
    }

    // ---------------- Demo Tour (guided showcase) ----------------
    async runDemoTour() {
        if (this.demoTourRunning) {
            this.showToast('Demo Tour is already running', 'warning');
            return;
        }
        this.demoTourRunning = true;

    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        try {
            this.showToast('Demo Tour: 1) Scan Devices, then drag cards to Connected.', 'info');
            await wait(1500);

            if (this.connectedDevices.size === 0) {
                this.showToast('Demo Tour: connect at least one device to continue.', 'warning');
                return;
            }

            // Pick a houseload-like consumer for a visible effect.
            const connected = Array.from(this.connectedDevices.values());
            const house = connected.find(d => String(d.name || '').toLowerCase().includes('houseload'))
                || connected.find(d => d.type === 'consumer');
            const provider = connected.find(d => d.type === 'provider') || null;

            if (house && house.revidyneDevice && house.revidyneDevice.cmds) {
                const cmds = house.revidyneDevice.cmds;
                // A more demo-like mini sequence: run several safe visual actions (skip missing commands).
                const pick = (candidates) => candidates.filter(c => Boolean(cmds[c]));

                // We want something that visibly changes, and we end with lightsOut/off when available.
                const sequence = [];
                sequence.push(...pick(['lightAll']));
                sequence.push(...pick(['blinkHouses']));
                sequence.push(...pick(['chaseOn']));
                // If autoOn exists, it can be fun, but it may run indefinitely; keep it short and then stop.
                sequence.push(...pick(['autoOn']));

                const stopCmd = (cmds['lightsOut'] ? 'lightsOut'
                    : (cmds['chaseOff'] ? 'chaseOff'
                        : (cmds['autoOff'] ? 'autoOff'
                            : (cmds['off'] ? 'off' : null))));

                // De-duplicate while keeping order
                const seen = new Set();
                const seq = sequence.filter(c => (seen.has(c) ? false : (seen.add(c), true)));

                if (seq.length) {
                    this.showToast(`Demo Tour: 2) Run HouseLoad demo sequence (${house.name}).`, 'info');
                    await wait(900);

                    for (const cmd of seq) {
                        this.showToast(`HouseLoad: ${cmd}`, 'info');
                        await this.executeCommand(house.id, cmd, { source: 'demo-tour' });
                        await wait(cmd === 'autoOn' ? 1800 : 1200);
                    }

                    if (stopCmd) {
                        this.showToast(`HouseLoad: ${stopCmd}`, 'info');
                        await this.executeCommand(house.id, stopCmd, { source: 'demo-tour' });
                        await wait(900);
                    }
                } else {
                    this.showToast(
                        `Demo Tour: no safe visual commands found on ${house.name}. Found: ${Object.keys(cmds).slice(0, 8).join(', ')}${Object.keys(cmds).length > 8 ? ', …' : ''}`,
                        'warning'
                    );
                    await wait(1200);
                }
            }

            this.showToast('Demo Tour: 3) Fill estimates (no telemetry needed).', 'info');
            await wait(900);

            // Auto-fill reasonable defaults only if fields are empty.
            if (provider) {
                const cur = this.loadPowerEst(provider.name) || {};
                if (cur.capacityKW == null) {
                    cur.capacityKW = 2.0;
                    cur.availability = 1;
                    this.savePowerEst(provider.name, cur);
                }
            }
            if (house) {
                const cur = this.loadPowerEst(house.name) || {};
                if (cur.ratedW == null) {
                    cur.ratedW = 300;
                    cur.utilization = 1;
                    this.savePowerEst(house.name, cur);
                }
            }

            this.renderMetrics();
            await wait(900);

            this.showToast('Demo Tour: 4) Enable Auto-estimate demand (for HouseLoad boards without getLoads/getAll).', 'info');
            this.setAutoEstimateEnabled(true);
            this.updateAutoEstimateUI();
            await wait(1100);

            this.showToast('Demo Tour complete. Tip: Use Option A to apply Estimated demand to Generator (turn Safe mode OFF for real setLoad).', 'success');
        } catch (e) {
            this.showToast('Demo Tour failed: ' + (e && e.message ? e.message : String(e)), 'error');
        } finally {
            this.demoTourRunning = false;
        }
    }

    // ---------------- Allocation (Generator setLoad) ----------------
    loadAllocState() {
        try {
            const raw = localStorage.getItem(this.allocKey);
            if (!raw) return { targetKW: '', maxKW: '' };
            const v = JSON.parse(raw);
            return v && typeof v === 'object' ? v : { targetKW: '', maxKW: '' };
        } catch {
            return { targetKW: '', maxKW: '' };
        }
    }

    saveAllocState(state) {
        try {
            localStorage.setItem(this.allocKey, JSON.stringify(state || {}));
        } catch {
            // ignore
        }
    }

    findConnectedGenerator() {
        const list = Array.from(this.connectedDevices.values());
        // Prefer explicit name match
        let g = list.find(d => String(d.name || '').toLowerCase().includes('generator'));
        if (!g) {
            // fallback: provider with setLoad command
            g = list.find(d => d.type === 'provider' && d.revidyneDevice && d.revidyneDevice.cmds && d.revidyneDevice.cmds['setLoad']);
        }
        return g || null;
    }

    updateAllocationUIState() {
        const btn = document.getElementById('allocApplyBtn');
        const input = document.getElementById('allocTargetKW');
        const maxInput = document.getElementById('allocMaxKW');
        const btnFromDemand = document.getElementById('allocApplyFromDemandBtn');
        if (!btn || !input) return;

        const gen = this.findConnectedGenerator();
        const hasGen = !!gen;
        const hasSetLoad = !!(gen && gen.revidyneDevice && gen.revidyneDevice.cmds && gen.revidyneDevice.cmds['setLoad']);

        const n = this.parsePositiveNumber(input.value);
        const hasValue = input.value !== '' && n != null;

        // Safe mode blocks set* commands; keep the UI honest.
        const blocked = !!this.safeModeEnabled;
        btn.disabled = blocked || !hasGen || !hasSetLoad || !hasValue;

        // Option A: apply from Estimated demand
        if (btnFromDemand) {
            const demandKW = this.latestEstimatedDemandKW;
            const hasDemand = typeof demandKW === 'number' && isFinite(demandKW) && demandKW > 0;
            btnFromDemand.disabled = blocked || !hasGen || !hasSetLoad || !hasDemand;
        }

        if (blocked) {
            btn.title = 'Demo/Safe mode is ON. Turn it OFF to send setLoad.';
        } else if (!hasGen) {
            btn.title = 'Connect a generator device first.';
        } else if (!hasSetLoad) {
            btn.title = 'This generator does not expose setLoad.';
        } else if (!hasValue) {
            btn.title = 'Enter a target load in kW.';
        } else {
            btn.title = 'Send setLoad to the generator.';
        }

        if (btnFromDemand) {
            if (blocked) {
                btnFromDemand.title = 'Demo/Safe mode is ON. Turn it OFF to apply from Estimated demand.';
            } else if (!hasGen) {
                btnFromDemand.title = 'Connect a generator device first.';
            } else if (!hasSetLoad) {
                btnFromDemand.title = 'This generator does not expose setLoad.';
            } else if (!(typeof this.latestEstimatedDemandKW === 'number' && isFinite(this.latestEstimatedDemandKW) && this.latestEstimatedDemandKW > 0)) {
                btnFromDemand.title = 'Estimated demand is 0. Enter Consumer estimates first.';
            } else {
                btnFromDemand.title = 'Set generator load equal to the current Estimated demand.';
            }
        }

        if (maxInput) {
            maxInput.disabled = blocked;
            maxInput.title = blocked
                ? 'Demo/Safe mode is ON. Max cap is disabled.'
                : 'Optional. Limits the load used by Option A.';
        }
    }

    initAllocationUI() {
        const input = document.getElementById('allocTargetKW');
        const btn = document.getElementById('allocApplyBtn');
        if (!input || !btn) return;

        const maxInput = document.getElementById('allocMaxKW');
        const btnFromDemand = document.getElementById('allocApplyFromDemandBtn');

        const state = this.loadAllocState();
        if (state && state.targetKW != null && input.value === '') {
            input.value = String(state.targetKW);
        }
        if (maxInput && state && state.maxKW != null && maxInput.value === '') {
            maxInput.value = String(state.maxKW);
        }

        const onInput = () => {
            this.saveAllocState({
                targetKW: input.value,
                maxKW: maxInput ? maxInput.value : undefined
            });
            this.updateAllocationUIState();
        };
        input.addEventListener('input', onInput);
        input.addEventListener('change', onInput);

        if (maxInput) {
            maxInput.addEventListener('input', onInput);
            maxInput.addEventListener('change', onInput);
        }

        btn.addEventListener('click', async () => {
            try {
                if (this.safeModeEnabled) {
                    this.showToast('Demo/Safe mode is ON (set* blocked). Turn it OFF to apply allocation.', 'warning');
                    return;
                }

                const gen = this.findConnectedGenerator();
                if (!gen) {
                    this.showToast('Connect a generator first', 'warning');
                    return;
                }
                if (!gen.revidyneDevice || !gen.revidyneDevice.cmds || !gen.revidyneDevice.cmds['setLoad']) {
                    this.showToast('Generator does not support setLoad', 'error');
                    return;
                }

                const target = this.parsePositiveNumber(input.value);
                if (target == null) {
                    this.showToast('Enter a valid target load (kW)', 'warning');
                    return;
                }

                // Confirmation to prevent accidental real hardware changes.
                const ok = window.confirm(`Apply allocation now?\n\nThis will send: ${gen.name}.setLoad(${target} kW)`);
                if (!ok) return;

                // send via existing execution pipeline (logging + UI updates)
                await this.executeCommand(gen.id, 'setLoad', {
                    args: [String(target)],
                    source: 'allocation',
                    note: `Allocation target: ${target} kW`
                });

                this.showToast(`Applied generator load: ${target} kW`);
            } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                this.showToast('Allocation failed: ' + msg, 'error');
            } finally {
                this.updateAllocationUIState();
            }
        });

        if (btnFromDemand) {
            btnFromDemand.addEventListener('click', async () => {
                try {
                    if (this.safeModeEnabled) {
                        this.showToast('Demo/Safe mode is ON (set* blocked). Turn it OFF to apply from Estimated demand.', 'warning');
                        return;
                    }

                    const gen = this.findConnectedGenerator();
                    if (!gen) {
                        this.showToast('Connect a generator first', 'warning');
                        return;
                    }
                    if (!gen.revidyneDevice || !gen.revidyneDevice.cmds || !gen.revidyneDevice.cmds['setLoad']) {
                        this.showToast('Generator does not support setLoad', 'error');
                        return;
                    }

                    const demandKW = this.latestEstimatedDemandKW;
                    if (!(typeof demandKW === 'number' && isFinite(demandKW) && demandKW > 0)) {
                        this.showToast('Estimated demand is 0. Enter Consumer estimates first.', 'warning');
                        return;
                    }

                    let targetKW = demandKW;
                    const cap = maxInput ? this.parsePositiveNumber(maxInput.value) : null;
                    if (cap != null) targetKW = Math.min(targetKW, cap);
                    targetKW = Math.round(targetKW * 10) / 10;

                    const capNote = (cap != null) ? ` (cap ${cap} kW)` : '';
                    const ok = window.confirm(
                        `Apply Option A now?\n\nThis will send: ${gen.name}.setLoad(${targetKW} kW)\nBased on Estimated demand: ${this.fmtKW(demandKW)}${capNote}`
                    );
                    if (!ok) return;

                    await this.executeCommand(gen.id, 'setLoad', {
                        args: [String(targetKW)],
                        source: 'alloc-from-estimate',
                        note: `Option A: setLoad from Estimated demand (${demandKW} kW)${cap != null ? `, cap ${cap} kW` : ''}`
                    });

                    // Reflect applied value in manual target for clarity
                    input.value = String(targetKW);
                    this.saveAllocState({
                        targetKW: input.value,
                        maxKW: maxInput ? maxInput.value : undefined
                    });

                    this.showToast(`Applied generator load from demand: ${targetKW} kW`);
                } catch (e) {
                    const msg = e && e.message ? e.message : String(e);
                    this.showToast('Option A failed: ' + msg, 'error');
                } finally {
                    this.updateAllocationUIState();
                }
            });
        }

        this.updateAllocationUIState();
    }

    // ---------------- Run history (KPI / trends) ----------------
    loadRunHistory() {
        try {
            const raw = localStorage.getItem(this.runHistoryKey);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    saveRunHistory() {
        try {
            localStorage.setItem(this.runHistoryKey, JSON.stringify(this.runHistory));
        } catch {
            // ignore storage errors
        }
    }

    pushRunHistory(summary) {
        if (!summary) return;
        this.runHistory.unshift(summary);
        if (this.runHistory.length > this.runHistoryMax) {
            this.runHistory.length = this.runHistoryMax;
        }
        this.saveRunHistory();
        this.renderRunHistory();
    }

    clearRunHistory() {
        this.runHistory = [];
        this.saveRunHistory();
        this.renderRunHistory();
        this.showToast('Run history cleared');
    }

    exportRunHistory(format = 'json') {
        const fmt = String(format || 'json').toLowerCase();
        if (fmt !== 'json') {
            this.showToast('Only JSON export is supported right now', 'warning');
            return;
        }
        const blob = new Blob([JSON.stringify(this.runHistory, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `revidyne-run-history-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        this.showToast('Exported run history');
    }

    renderRunHistory() {
        const body = document.getElementById('runHistoryBody');
        const nEl = document.getElementById('runHistoryN');
        if (!body) return;

        const N = this.runHistoryDefaultN;
        if (nEl) nEl.textContent = String(N);

        const recent = this.runHistory.slice(0, N);
        if (recent.length === 0) {
            body.innerHTML = '<div class="empty-state">No history yet. Run a flow a few times to see KPIs and a trend chart.</div>';
            return;
        }

        const safeNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
        const okCount = recent.filter(r => String(r.status) === 'OK').length;
        const errCount = recent.filter(r => String(r.status) === 'ERROR').length;
        const stopCount = recent.filter(r => String(r.status) === 'STOPPED').length;
        const durations = recent.map(r => safeNum(r.durationMs)).filter(v => v != null);
        const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
        const min = durations.length ? Math.min(...durations) : null;

    // (Timestamp formatting is intentionally English-only; see formatDateTimeEN())
        const max = durations.length ? Math.max(...durations) : null;
        const timeouts = recent.reduce((sum, r) => sum + (safeNum(r.timeoutCount) || 0), 0);

        const fmtMs = (ms) => {
            if (!Number.isFinite(ms)) return '—';
            if (ms < 1000) return `${Math.round(ms)} ms`;
            return `${(ms / 1000).toFixed(2)} s`;
        };

        const successRate = recent.length ? Math.round((okCount / recent.length) * 100) : 0;

        // Mini bar chart (normalize to max duration)
        const maxDur = durations.length ? Math.max(...durations) : 0;
        const bars = recent.slice().reverse().map((r) => {
            const d = safeNum(r.durationMs) || 0;
            const h = maxDur > 0 ? Math.max(6, Math.round((d / maxDur) * 60)) : 6;
            const st = String(r.status || 'UNKNOWN');
            const cls = st === 'OK' ? 'ok' : (st === 'STOPPED' ? 'warn' : 'bad');
            const title = `${st} • ${fmtMs(d)} • ${r.startedAt || ''}`;
            return `<div class="run-history-bar ${cls}" style="height:${h}px" title="${this.escapeHtml(title)}"></div>`;
        }).join('');

        body.innerHTML = `
            <div class="run-history-kpis">
                <div class="run-summary-grid">
                    <div class="run-summary-item">
                        <div class="run-summary-label">Success rate</div>
                        <div class="run-summary-value ${successRate >= 80 ? 'ok' : (successRate >= 50 ? 'warn' : 'bad')}">${successRate}%</div>
                    </div>
                    <div class="run-summary-item">
                        <div class="run-summary-label">OK / ERROR / STOPPED</div>
                        <div class="run-summary-value">${okCount} / ${errCount} / ${stopCount}</div>
                    </div>
                    <div class="run-summary-item">
                        <div class="run-summary-label">Avg duration</div>
                        <div class="run-summary-value">${fmtMs(avg)}</div>
                    </div>
                    <div class="run-summary-item">
                        <div class="run-summary-label">Fastest</div>
                        <div class="run-summary-value">${fmtMs(min)}</div>
                    </div>
                    <div class="run-summary-item">
                        <div class="run-summary-label">Slowest</div>
                        <div class="run-summary-value">${fmtMs(max)}</div>
                    </div>
                    <div class="run-summary-item">
                        <div class="run-summary-label">Timeouts (sum)</div>
                        <div class="run-summary-value">${timeouts}</div>
                    </div>
                </div>
            </div>
            <div class="run-history-chart" aria-label="Run duration trend chart">
                <div class="run-history-chart-title">Duration trend (newest → oldest)</div>
                <div class="run-history-bars">${bars}</div>
            </div>
        `;
    }

    // ---------------- Run summary (KPI) ----------------
    clearRunSummary() {
        this.lastRunSummary = null;
        this.renderRunSummary();
        this.showToast('Run summary cleared');
    }

    renderRunSummary() {
        const body = document.getElementById('runSummaryBody');
        if (!body) return;

        if (!this.lastRunSummary) {
            body.innerHTML = '<div class="empty-state">No runs yet. Click “Run flow” to generate a summary.</div>';
            return;
        }

        const s = this.lastRunSummary;
        const status = String(s.status || 'UNKNOWN');
        const statusClass = status === 'OK' ? 'ok' : (status === 'STOPPED' ? 'warn' : 'bad');
        const started = s.startedAt ? new Date(s.startedAt) : null;
        const ended = s.endedAt ? new Date(s.endedAt) : null;
        const durMs = Number.isFinite(Number(s.durationMs)) ? Number(s.durationMs) : null;

        const fmtMs = (ms) => {
            if (!Number.isFinite(ms)) return '—';
            if (ms < 1000) return `${Math.round(ms)} ms`;
            return `${(ms / 1000).toFixed(2)} s`;
        };

        body.innerHTML = `
            <div class="run-summary-grid">
                <div class="run-summary-item">
                    <div class="run-summary-label">Status</div>
                    <div class="run-summary-value ${statusClass}">${status}</div>
                </div>
                <div class="run-summary-item">
                    <div class="run-summary-label">Duration</div>
                    <div class="run-summary-value">
                        ${fmtMs(durMs)}
                    </div>
                </div>
                <div class="run-summary-item">
                    <div class="run-summary-label">Cycles</div>
                    <div class="run-summary-value">${s.cyclesDone ?? 0}/${s.cyclesPlanned ?? 0}</div>
                </div>
                <div class="run-summary-item">
                    <div class="run-summary-label">Steps</div>
                    <div class="run-summary-value">${s.stepsDone ?? 0}/${s.stepsPlanned ?? 0}</div>
                </div>
                <div class="run-summary-item">
                    <div class="run-summary-label">Timeouts</div>
                    <div class="run-summary-value">${s.timeoutCount ?? 0}</div>
                </div>
                <div class="run-summary-item">
                    <div class="run-summary-label">Last step</div>
                    <div class="run-summary-value">${s.lastStepLabel || '—'}</div>
                </div>
            </div>
            <div class="run-summary-foot">
                <div><span class="run-summary-foot-label">Started:</span> ${this.formatDateTime(started)}</div>
                <div><span class="run-summary-foot-label">Ended:</span> ${this.formatDateTime(ended)}</div>
                ${s.errorMessage ? `<div class="run-summary-error"><span class="run-summary-foot-label">Error:</span> ${this.escapeHtml(String(s.errorMessage))}</div>` : ''}
            </div>
        `;
    }

    exportRunSummary(format = 'json') {
        if (!this.lastRunSummary) {
            this.showToast('No run summary yet', 'warning');
            return;
        }
        const fmt = String(format || 'json').toLowerCase();
        if (fmt !== 'json') {
            this.showToast('Only JSON export is supported right now', 'warning');
            return;
        }

        const blob = new Blob([JSON.stringify(this.lastRunSummary, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `revidyne-run-summary-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        this.showToast('Exported run summary');
    }

    async copyRunSummary() {
        if (!this.lastRunSummary) {
            this.showToast('No run summary yet', 'warning');
            return;
        }
        const text = JSON.stringify(this.lastRunSummary, null, 2);
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                this.showToast('Copied run summary');
                return;
            }
        } catch {}

        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        this.showToast('Copied run summary');
    }

    escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---------------- Templates ----------------
    buildTemplates() {
        // Note: command names can differ by firmware; we pick the first matching command.
        return {
            gen_load_cycle: {
                title: 'Generator + Load (Cycle)',
                description: 'A small demo loop: set a generator load, show house visual effects, then reset. (Note: set* steps are blocked when Demo/Safe Mode is ON.)',
                flowMode: 'loop',
                flowCycles: 2,
                flowRestMs: 800,
                steps: [
                    // House visual actions (safe + demo-friendly)
                    { deviceHint: 'houseload', cmdCandidates: ['lightAll', 'blinkHouses', 'chaseOn', 'autoOn'], args: '', delayMs: 900 },

                    // Generator ramp (uses setLoad; will be blocked in Safe Mode)
                    { deviceHint: 'generator', cmdCandidates: ['setLoad'], args: '1', delayMs: 900 },
                    { deviceHint: 'generator', cmdCandidates: ['setLoad'], args: '3', delayMs: 1200 },
                    { deviceHint: 'generator', cmdCandidates: ['setLoad'], args: '5', delayMs: 1200 },

                    // House off / reset
                    { deviceHint: 'houseload', cmdCandidates: ['lightsOut', 'chaseOff', 'autoOff'], args: '', delayMs: 800 },

                    // Generator reset
                    { deviceHint: 'generator', cmdCandidates: ['setLoad'], args: '0', delayMs: 800 }
                ]
            },
            solar_tracker_routine: {
                title: 'Solar tracker routine',
                description: 'Turn tracking on, wait, then turn tracking off.',
                flowMode: 'once',
                flowCycles: 1,
                flowRestMs: 0,
                steps: [
                    { deviceHint: 'solar', cmdCandidates: ['trackOn', 'on', 'startTrack'], args: '', delayMs: 200 },
                    { deviceHint: 'solar', cmdCandidates: ['trackOff', 'off', 'stopTrack'], args: '', delayMs: 500 }
                ]
            },
            safe_demo: {
                title: 'Safe demo (no set*)',
                description: 'A gentle demo using non-set commands only (best for classroom / live demo).',
                flowMode: 'once',
                flowCycles: 1,
                flowRestMs: 0,
                steps: [
                    { deviceHint: 'any', cmdCandidates: ['status', 'help', 'info', 'trackOn', 'trackOff', 'lightsOut'], args: '', delayMs: 250 },
                    { deviceHint: 'any', cmdCandidates: ['status', 'help', 'info', 'trackOn', 'trackOff', 'lightsOut'], args: '', delayMs: 250 }
                ]
            },
            wind_turbine_demo: {
                title: 'Wind turbine demo',
                description: 'A simple wind routine using common non-telemetry commands (init → scan → toggle track).',
                flowMode: 'once',
                flowCycles: 1,
                flowRestMs: 0,
                steps: [
                    { deviceHint: 'wind', cmdCandidates: ['init'], args: '', delayMs: 200 },
                    { deviceHint: 'wind', cmdCandidates: ['runScan', 'scan', 'calibrate'], args: '', delayMs: 350 },
                    { deviceHint: 'wind', cmdCandidates: ['trackOn', 'on', 'start'], args: '', delayMs: 250 },
                    { deviceHint: 'wind', cmdCandidates: ['trackOff', 'off', 'stop'], args: '', delayMs: 350 },
                    { deviceHint: 'wind', cmdCandidates: ['goHome', 'home'], args: '', delayMs: 200 }
                ]
            },
            fan_speed_demo: {
                title: 'Fan speed demo',
                description: 'Ramp fan speed up/down (uses setSpeed; blocked when Demo/Safe Mode is ON).',
                flowMode: 'once',
                flowCycles: 1,
                flowRestMs: 0,
                steps: [
                    { deviceHint: 'fan', cmdCandidates: ['fanOn', 'on', 'start'], args: '', delayMs: 150 },
                    { deviceHint: 'fan', cmdCandidates: ['setSpeed'], args: '3', delayMs: 250 },
                    { deviceHint: 'fan', cmdCandidates: ['setSpeed'], args: '6', delayMs: 250 },
                    { deviceHint: 'fan', cmdCandidates: ['setSpeed'], args: '9', delayMs: 250 },
                    { deviceHint: 'fan', cmdCandidates: ['setSpeed'], args: '0', delayMs: 250 },
                    { deviceHint: 'fan', cmdCandidates: ['fanOff', 'off', 'stop'], args: '', delayMs: 150 }
                ]
            }
        };
    }

    findConnectedDeviceIdByHint(hint) {
        const devices = Array.from(this.connectedDevices.values());
        if (devices.length === 0) return '';
        if (!hint || hint === 'any') return devices[0].id;

        const h = String(hint).toLowerCase();
        const score = (d) => {
            const name = String(d.name || '').toLowerCase();
            const t = String(d.type || '').toLowerCase();
            const cls = String(d.revidyneDevice?.constructor?.name || '').toLowerCase();
            const text = `${name} ${t} ${cls}`;
            if (h === 'generator') return /(gen|generator)/.test(text) ? 2 : 0;
            if (h === 'houseload' || h === 'load') return /(load|house)/.test(text) ? 2 : 0;
            if (h === 'solar') return /(solar|tracker)/.test(text) ? 2 : 0;
            if (h === 'wind') return /(wind|turbine)/.test(text) ? 2 : 0;
            if (h === 'fan') return /(fan)/.test(text) ? 2 : 0;
            return text.includes(h) ? 1 : 0;
        };

        const ranked = devices
            .map(d => ({ d, s: score(d) }))
            .sort((a, b) => b.s - a.s);

        return (ranked[0]?.s || 0) > 0 ? ranked[0].d.id : devices[0].id;
    }

    pickCommandForDevice(deviceId, candidates) {
        const cmds = this.getCommandsForDeviceId(deviceId);
        if (!cmds || cmds.length === 0) return '';

        const set = new Set(cmds.map(c => String(c)));
        const cand = (Array.isArray(candidates) ? candidates : []).map(String);
        for (const c of cand) {
            if (set.has(c)) return c;
        }

        // Fallback: if template asks for a set* command but firmware differs, try any set*.
        const wantsSet = cand.some(c => /^set/i.test(c));
        if (wantsSet) {
            const anySet = cmds.find(c => /^set/i.test(String(c)));
            if (anySet) return anySet;
        }

        return cmds[0] || '';
    }

    applyTemplate(templateId) {
        const tpl = this.templates?.[templateId];
        if (!tpl) {
            this.showToast('Template not found', 'error');
            return;
        }

        const devicesConnected = this.connectedDevices.size > 0;
        const steps = tpl.steps.map(s => {
            const deviceId = devicesConnected ? this.findConnectedDeviceIdByHint(s.deviceHint) : '';
            const cmd = deviceId ? this.pickCommandForDevice(deviceId, s.cmdCandidates) : '';
            return {
                deviceId,
                cmd,
                args: String(s.args ?? ''),
                delayMs: Number.isFinite(Number(s.delayMs)) ? Number(s.delayMs) : 150
            };
        });

        this.flowSteps = steps;
        this.renderFlow();

        // Apply cycle controls if present
        const modeEl = document.getElementById('flowMode');
        const cyclesEl = document.getElementById('flowCycles');
        const restEl = document.getElementById('flowRestMs');
        if (modeEl) modeEl.value = tpl.flowMode || 'once';
        if (cyclesEl) cyclesEl.value = String(tpl.flowCycles ?? 1);
        if (restEl) restEl.value = String(tpl.flowRestMs ?? 0);

        const note = devicesConnected
            ? `Loaded template: ${tpl.title}`
            : `Loaded template: ${tpl.title} (connect devices, then choose device/command)`;
        this.setFlowStatus(note);
        this.showToast(note);
        try {
            document.getElementById('flowList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch {}
    }

    // ---------------- Onboarding / Tutorial ----------------
    initOnboarding() {
        const onboarding = document.querySelector('.onboarding');
        const tutorialBtn = document.getElementById('tutorialBtn');
        const dismissBtn = document.getElementById('dismissOnboardingBtn');
        const helpBtn = document.getElementById('helpBtn');

        if (onboarding) {
            // Reversible UI: don't permanently hide onboarding.
            onboarding.style.display = 'block';
        }

        if (dismissBtn && onboarding) {
            dismissBtn.addEventListener('click', () => {
                onboarding.style.display = 'none';
            });
        }

        if (tutorialBtn) {
            tutorialBtn.addEventListener('click', () => this.startTour());
        }

        if (helpBtn) {
            helpBtn.addEventListener('click', () => {
                // Help should open the right-side drawer. Do NOT trigger the tutorial tour.
                try { console.debug('[help] helpBtn click (app.js)'); } catch {}

                if (typeof window.openHelp === 'function') {
                    window.openHelp();
                    return;
                }

                // Fallback: if drawer isn't available for some reason, show onboarding.
                this.showOnboarding();
            });
        }
    }

    showOnboarding() {
        const onboarding = document.querySelector('.onboarding');
        if (!onboarding) return;
        onboarding.style.display = 'block';
        localStorage.removeItem(this.onboardingStorageKey);
        try {
            onboarding.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch {}
    }

    buildTourSteps() {
        return [
            {
                title: 'Step 1: Scan devices',
                body: 'Click “Scan Devices”, then choose your device in the browser popup dialog.',
                getEl: () => document.getElementById('scanBtn'), page: 'devices'
            },
            {
                title: 'Step 2: Move to Connected',
                body: 'Drag a device card into “Connected Devices” to enable controls.',
                getEl: () => document.querySelector('.right-panel'), page: 'devices'
            },
            {
                title: 'Step 3: Run a command',
                body: 'Click any command button on a connected device. Watch Last/Status/Time update.',
                getEl: () => document.getElementById('connectedDevices'), page: 'devices'
            },
            {
                title: 'Step 4: Try a Scenario',
                body: 'Scenarios run multiple devices. Start with Startup.',
                getEl: () => document.querySelector('.controller'), page: 'logs'
            },
            {
                title: 'Step 5: Build a Flow',
                body: 'Drag commands from the Command library into Flow Builder, then Run flow.',
                getEl: () => document.querySelector('.flow'), page: 'logs'
            }
        ];
    }

    startTour() {
        this.endTour();
        this.tour.active = true;
        this.tour.stepIndex = 0;
        this.tour.steps = this.buildTourSteps();
        this.showTourStep();
    }

    endTour() {
        this.tour.active = false;
        this.tour.stepIndex = 0;
        this.clearTourHighlight();
        this.removeTourToast();
    }

    nextTourStep() {
        if (!this.tour.active) return;
        this.tour.stepIndex += 1;
        if (this.tour.stepIndex >= this.tour.steps.length) {
            this.endTour();
            this.showToast('Tutorial complete');
            return;
        }
        this.showTourStep();
    }

    prevTourStep() {
        if (!this.tour.active) return;
        this.tour.stepIndex = Math.max(0, this.tour.stepIndex - 1);
        this.showTourStep();
    }

    clearTourHighlight() {
        document.querySelectorAll('.tour-highlight').forEach(el => el.classList.remove('tour-highlight'));
    }

    showTourStep() {
        if (!this.tour.active) return;
        const step = this.tour.steps[this.tour.stepIndex];
        if (!step) return;

        // Auto-navigate to the correct page if specified
        if (step.page) {
            this.navigateTo(step.page);
        }

        this.clearTourHighlight();

        const el = step.getEl ? step.getEl() : null;
        if (el) {
            el.classList.add('tour-highlight');
            try {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch {}
        }

        this.renderTourToast({
            title: step.title,
            body: step.body,
            index: this.tour.stepIndex + 1,
            total: this.tour.steps.length
        });
    }

    removeTourToast() {
        if (this.tour.toastEl && this.tour.toastEl.parentNode) {
            this.tour.toastEl.parentNode.removeChild(this.tour.toastEl);
        }
        this.tour.toastEl = null;
    }

    renderTourToast({ title, body, index, total }) {
        this.removeTourToast();

        const wrap = document.createElement('div');
        wrap.className = 'tour-toast';

        const t = document.createElement('div');
        t.className = 'tour-toast-title';
        t.textContent = `${title} (${index}/${total})`;

        const b = document.createElement('div');
        b.className = 'tour-toast-body';
        b.textContent = body;

        const actions = document.createElement('div');
        actions.className = 'tour-toast-actions';

        const exitBtn = document.createElement('button');
        exitBtn.textContent = 'Exit';
        exitBtn.addEventListener('click', () => this.endTour());

        const backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.disabled = index <= 1;
        backBtn.addEventListener('click', () => this.prevTourStep());

        const nextBtn = document.createElement('button');
        nextBtn.className = 'primary';
        nextBtn.textContent = (index >= total) ? 'Finish' : 'Next';
        nextBtn.addEventListener('click', () => this.nextTourStep());

        actions.appendChild(exitBtn);
        actions.appendChild(backBtn);
        actions.appendChild(nextBtn);

        wrap.appendChild(t);
        wrap.appendChild(b);
        wrap.appendChild(actions);

        document.body.appendChild(wrap);
        this.tour.toastEl = wrap;
    }

    // ============== Demo Cycle ==============
    // One-click demo: turn on house lights one by one, read demand, send to generator
    async runDemoCycle() {
        // Find connected HouseLoad and Generator
        const houseload = this.findConnectedDeviceByType('houseload');
        const generator = this.findConnectedDeviceByType('generator');

        if (!houseload) {
            this.showToast('Demo Cycle: Connect a HouseLoad first!', 'error');
            return;
        }
        if (!generator) {
            this.showToast('Demo Cycle: Connect a Generator first!', 'error');
            return;
        }

        // Disable the button during cycle
        const btn = document.getElementById('demoCycleBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '🔄 Running...';
        }

        try {
            this.showToast('🔄 Demo Cycle started!', 'success');

            // Step 0: Initialize - turn off all lights
            await this.executeCommand(houseload.id, 'lightsOut');
            this.showToast('Step 0: All lights OFF', 'info');
            await this.sleep(1500);

            // Cycle through each light
            const lights = ['light0', 'light1', 'light2', 'light3'];
            
            for (let i = 0; i < lights.length; i++) {
                const light = lights[i];
                
                // Turn on this light
                this.showToast(`Step ${i + 1}a: Turning ON ${light}...`, 'info');
                await this.executeCommand(houseload.id, light);
                await this.sleep(1000);

                // Read demand from HouseLoad
                this.showToast(`Step ${i + 1}b: Reading demand (getKW)...`, 'info');
                const kwResult = await this.executeCommand(houseload.id, 'getKW');
                
                // Parse the kW value from the response
                let demandKW = 0;
                if (kwResult && kwResult.response) {
                    // Try to extract a number from the response
                    const match = String(kwResult.response).match(/[\d.]+/);
                    if (match) {
                        demandKW = parseFloat(match[0]);
                    }
                }
                
                this.showToast(`Step ${i + 1}c: Demand = ${demandKW} kW`, 'success');
                await this.sleep(500);

                // Send demand to Generator - always send, use light index as fallback value
                const loadValue = demandKW > 0 ? demandKW : (i + 1);  // Fallback: 1, 2, 3, 4 based on light
                this.showToast(`Step ${i + 1}d: Setting Generator to ${loadValue} kW...`, 'info');
                await this.setGeneratorLoad(generator.id, loadValue);
                this.showToast(`Step ${i + 1}d: ✅ Sent setLoad(${loadValue}) to Generator!`, 'success');

                await this.sleep(2000);
            }

            // Final step: Read total and show summary
            this.showToast('🎉 Demo Cycle complete!', 'success');

        } catch (err) {
            console.error('Demo Cycle error:', err);
            this.showToast('Demo Cycle failed: ' + (err.message || err), 'error');
        } finally {
            // Re-enable button
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🔄 Demo Cycle';
            }
        }
    }

    // Helper: find a connected device by name pattern
    findConnectedDeviceByType(namePattern) {
        for (const device of this.connectedDevices.values()) {
            if (String(device.name || '').toLowerCase().includes(namePattern.toLowerCase())) {
                return device;
            }
        }
        return null;
    }

    // Helper: sleep
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    showNotSupported() {
        const msg = `
            <div class="empty-state">
                <p>⚠️ Your browser doesn't support the Web Serial API</p>
                <p>Please use Chrome or Edge</p>
            </div>
        `;
        document.getElementById('availableDevices').innerHTML = msg;
    }
    
    async scanDevices() {
        try {
            this.showToast('Scanning devices...', 'warning');
            console.log('[scanDevices] start: requesting serial port picker...');
            const result = await this.allDevice.scanPorts();
            
            console.log('Scan result:', result);
            
            if (result) {
                this.lastScanAt = new Date();
                const id = `device_${this.deviceIdCounter++}`;

                // Use the commands already discovered by setupCommands() in revidyne.js.
                // Do NOT call getCommands() again - Arduino won't respond twice.
                let commands = [];
                let signaturesByCommand = {};
                try {
                    // listCmds() returns the keys from device.cmds built during setupCommands()
                    commands = result.device.listCmds ? result.device.listCmds() : [];
                    console.log('命令列表获取完成:', commands);
                } catch {
                    commands = [];
                }
                // Normalize signature-style commands into base names + signature metadata.
                try {
                    const parsed = this.parseFirmwareCommands(commands);
                    commands = parsed.commands;
                    signaturesByCommand = parsed.signaturesByCommand;
                } catch {
                    commands = (commands || []).filter(c => c && c !== 'eoc' && c !== '').map(String);
                }
                
                const deviceInfo = {
                    id,
                    revidyneDevice: result.device,
                    name: result.name,
                    type: result.type || 'consumer',
                    commands: commands,
                    commandSignatures: signaturesByCommand,
                    isConnected: true
                };
                
                console.log('Device added:', deviceInfo);
                
                this.availableDevices.set(id, deviceInfo);
                this.updateUI();
                this.showToast(`Device found: ${result.name}`);
            } else {
                this.lastScanAt = new Date();
                this.updateSummary();
                this.showToast('Device not recognized', 'error');
            }
        } catch (err) {
            console.error('Failed to scan devices:', err);
            // Provide clearer pointers for common Web Serial errors
            const name = err && err.name ? err.name : '';
            if (name === 'NotAllowedError') {
                this.showToast('Port selection cancelled or not allowed. Click "Scan Devices" and pick a port in the dialog.', 'error');
            } else if (name === 'SecurityError') {
                this.showToast('Security restriction: open this page on http://localhost or HTTPS', 'error');
            } else if (name === 'NotFoundError') {
                this.showToast('No serial device found (make sure your device is plugged in and recognized by macOS)', 'error');
            } else {
                this.showToast('Scan failed: ' + (err && err.message ? err.message : String(err)), 'error');
            }
        }
    }
    
    onPortConnect(event) {
        if (this.debug) console.log('Serial port connected');
        this.showToast('New serial port connected');
    }
    
    onPortDisconnect(event) {
        if (this.debug) console.log('Serial port disconnected');
        // Find and remove the disconnected device
        for (const [id, info] of [...this.availableDevices, ...this.connectedDevices]) {
            if (info.revidyneDevice && info.revidyneDevice.port === event.target) {
                this.availableDevices.delete(id);
                this.connectedDevices.delete(id);
            }
        }
        this.updateUI();
        this.showToast('Device disconnected', 'warning');
    }
    
    moveDevice(deviceId, targetLocation) {
        let device;
        
        if (targetLocation === 'connected') {
            device = this.availableDevices.get(deviceId);
            if (device) {
                this.availableDevices.delete(deviceId);
                this.connectedDevices.set(deviceId, device);
            }
        } else {
            device = this.connectedDevices.get(deviceId);
            if (device) {
                this.connectedDevices.delete(deviceId);
                this.availableDevices.set(deviceId, device);
            }
        }
        
        this.updateUI();
    }

    formatDateTime(dt) {
        if (!dt) return '—';
        try {
            return dt.toLocaleString('en-US', {
                hour12: false,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch {
            return dt.toLocaleString();
        }
    }

    ensureMetricsPolling() {
        if (this.metricsIntervalId) return;
        this.metricsIntervalId = window.setInterval(() => {
            // fire-and-forget; errors are handled per-device
            this.refreshLiveMetrics();
        }, this.metricsIntervalMs);
    }

    stopMetricsPolling() {
        if (this.metricsIntervalId) {
            clearInterval(this.metricsIntervalId);
            this.metricsIntervalId = null;
        }
    }

    parseFirstNumber(value) {
        if (value == null) return null;
        const s = Array.isArray(value) ? String(value[0] ?? '') : String(value);
        const m = s.match(/-?\d+(?:\.\d+)?/);
        return m ? Number(m[0]) : null;
    }

    sanitizeMetricNumber(field, value) {
        if (value == null) return null;
        const n = Number(value);
        if (!Number.isFinite(n)) return null;

        // Voltage should never be negative in our UI.
        // Also cap to a reasonable range for this project to avoid showing garbage
        // when serial output is corrupted/misaligned.
        if (field === 'volts') {
            if (n < 0) return null;
            if (n > 1000) return null;
        }

        // Power (kW) sanity: allow negative only if a board intentionally reports it.
        // For now, keep as-is but drop absurd values.
        if (field === 'kw') {
            if (Math.abs(n) > 1000) return null;
        }

        return n;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    withTimeout(promise, timeoutMs, label = 'operation') {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs))
        ]);
    }

    getQueueForDevice(deviceId) {
        if (!this.deviceQueues.has(deviceId)) {
            this.deviceQueues.set(deviceId, Promise.resolve());
        }
        return this.deviceQueues.get(deviceId);
    }

    enqueueDeviceCommand(deviceId, taskFn) {
        const prev = this.getQueueForDevice(deviceId);
        // Ensure errors don't break the chain
        const next = prev
            .catch(() => undefined)
            .then(() => taskFn());
        this.deviceQueues.set(deviceId, next);
        return next;
    }

    // ---------------- Command library ----------------
    refreshCommandLibrary() {
        const body = document.getElementById('libraryBody');
        const empty = document.getElementById('libraryEmpty');
        if (!body || !empty) return;

        const query = (document.getElementById('librarySearch')?.value || '').trim().toLowerCase();
        const devices = Array.from(this.connectedDevices.values());

        if (devices.length === 0) {
            body.innerHTML = '';
            empty.style.display = 'block';
            return;
        }

        empty.style.display = 'none';
        body.innerHTML = '';

        for (const d of devices) {
            const cmds = this.getCommandsForDeviceId(d.id);
            const filtered = query
                ? cmds.filter(c => String(c).toLowerCase().includes(query))
                : cmds;

            const group = document.createElement('div');
            group.className = 'library-group';

            const title = document.createElement('div');
            title.className = 'library-group-title';
            title.textContent = d.name;

            const chips = document.createElement('div');
            chips.className = 'library-chips';

            if (filtered.length === 0) {
                const note = document.createElement('div');
                note.className = 'empty-state';
                note.style.padding = '10px 0';
                note.textContent = query ? 'No commands match this search.' : 'No commands found.';
                group.appendChild(title);
                group.appendChild(note);
                body.appendChild(group);
                continue;
            }

            for (const cmd of filtered) {
                const chip = document.createElement('div');
                chip.className = 'library-chip';
                chip.textContent = cmd;
                const help = this.getCommandHelpText(cmd);
                if (help) {
                    chip.title = help;
                    chip.setAttribute('aria-label', `${cmd}: ${help}`);
                }
                chip.draggable = true;
                chip.addEventListener('dragstart', (e) => {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('application/json', JSON.stringify({ deviceId: d.id, cmd }));
                    e.dataTransfer.setData('text/plain', `${d.name}.${cmd}`);
                });
                chips.appendChild(chip);
            }

            group.appendChild(title);
            group.appendChild(chips);
            body.appendChild(group);
        }

        // Make flow list a drop target for library chips
        const flowList = document.getElementById('flowList');
        if (flowList) {
            flowList.addEventListener('dragover', (e) => {
                e.preventDefault();
                flowList.classList.add('drag-over');
                e.dataTransfer.dropEffect = 'copy';
            });
            flowList.addEventListener('dragleave', () => flowList.classList.remove('drag-over'));
            flowList.addEventListener('drop', (e) => {
                e.preventDefault();
                flowList.classList.remove('drag-over');
                const raw = e.dataTransfer.getData('application/json');
                if (!raw) return;
                try {
                    const payload = JSON.parse(raw);
                    if (!payload || !payload.deviceId || !payload.cmd) return;
                    this.flowSteps.push({ deviceId: payload.deviceId, cmd: payload.cmd, args: '', delayMs: 150 });
                    this.renderFlow();
                    this.setFlowStatus(`Added: ${payload.cmd}`);
                } catch {
                    // ignore
                }
            });
        }
    }

    // ---------------- Flow Builder ----------------
    getConnectedDeviceOptions() {
        const devices = Array.from(this.connectedDevices.values());
        return devices.map(d => ({ id: d.id, name: d.name }));
    }

    getCommandsForDeviceId(deviceId) {
        const d = this.connectedDevices.get(deviceId);
        if (!d || !d.revidyneDevice) return [];
        const cmds = d.revidyneDevice.listCmds ? d.revidyneDevice.listCmds() : (d.commands || []);
        return (cmds || []).filter(c => c && c !== 'eoc');
    }

    addFlowStep() {
        const firstDev = this.getConnectedDeviceOptions()[0];
        const deviceId = firstDev ? firstDev.id : '';
        const cmds = deviceId ? this.getCommandsForDeviceId(deviceId) : [];
        const cmd = cmds[0] || '';
        this.flowSteps.push({ deviceId, cmd, args: '', delayMs: 150 });
        this.renderFlow();
    }

    clearFlow() {
        this.flowSteps = [];
        this.renderFlow();
        this.setFlowStatus('Cleared.');
    }

    saveFlow() {
        try {
            localStorage.setItem(this.flowStorageKey, JSON.stringify(this.flowSteps));
            this.setFlowStatus('Saved.');
            this.showToast('Flow saved');
        } catch (e) {
            this.setFlowStatus('Save failed.');
            this.showToast('Save failed', 'error');
        }
    }

    loadFlow() {
        try {
            const raw = localStorage.getItem(this.flowStorageKey);
            if (!raw) {
                this.setFlowStatus('No saved flow found.');
                return;
            }
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error('Invalid flow');
            this.flowSteps = parsed.map(s => ({
                deviceId: String(s.deviceId || ''),
                cmd: String(s.cmd || ''),
                args: String(s.args || ''),
                delayMs: Number.isFinite(Number(s.delayMs)) ? Number(s.delayMs) : 150
            }));
            this.renderFlow();
            this.setFlowStatus('Loaded.');
            this.showToast('Flow loaded');
        } catch (e) {
            this.setFlowStatus('Load failed.');
            this.showToast('Load failed', 'error');
        }
    }

    setFlowStatus(msg) {
        const el = document.getElementById('flowStatus');
        if (!el) return;
        el.textContent = msg;
    }

    updateFlowStep(index, patch) {
        if (index < 0 || index >= this.flowSteps.length) return;
        this.flowSteps[index] = { ...this.flowSteps[index], ...patch };
        this.renderFlow();
    }

    removeFlowStep(index) {
        if (index < 0 || index >= this.flowSteps.length) return;
        this.flowSteps.splice(index, 1);
        this.renderFlow();
    }

    attachFlowDnD(li, index) {
        li.draggable = true;
        li.addEventListener('dragstart', (e) => {
            li.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(index));
        });
        li.addEventListener('dragend', () => {
            li.classList.remove('dragging');
        });
    }

    reorderFlow(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || fromIndex >= this.flowSteps.length) return;
        if (toIndex < 0 || toIndex >= this.flowSteps.length) return;
        const [moved] = this.flowSteps.splice(fromIndex, 1);
        this.flowSteps.splice(toIndex, 0, moved);
        this.renderFlow();
    }

    renderFlow() {
        const list = document.getElementById('flowList');
        const empty = document.getElementById('flowEmpty');
        if (!list || !empty) return;

        if (this.flowSteps.length === 0) {
            list.innerHTML = '';
            empty.style.display = 'block';
            return;
        }
        empty.style.display = 'none';

        const deviceOptions = this.getConnectedDeviceOptions();

        list.innerHTML = '';
        this.flowSteps.forEach((step, idx) => {
            const li = document.createElement('li');
            li.className = 'flow-step';
            li.dataset.index = String(idx);

            const devSelect = document.createElement('select');
            devSelect.innerHTML = ['<option value="">(choose device)</option>']
                .concat(deviceOptions.map(d => `<option value="${d.id}">${d.name}</option>`))
                .join('');
            devSelect.value = step.deviceId || '';

            const cmdSelect = document.createElement('select');
            const cmds = step.deviceId ? this.getCommandsForDeviceId(step.deviceId) : [];
            cmdSelect.innerHTML = ['<option value="">(choose command)</option>']
                .concat(cmds.map(c => `<option value="${c}">${c}</option>`))
                .join('');
            cmdSelect.value = step.cmd || '';

            const argsInput = document.createElement('input');
            argsInput.type = 'text';
            argsInput.placeholder = 'Args (e.g. 5 or 1 2 3)';
            argsInput.value = step.args || '';

            const safeChip = document.createElement('span');
            safeChip.className = 'flow-safe-chip';
            safeChip.textContent = 'SAFE MODE blocks set*';
            safeChip.title = 'Demo/Safe Mode is ON: set* commands are blocked.';
            const isSetCmdNow = String(step.cmd || '').toLowerCase().startsWith('set');
            safeChip.style.display = (this.safeModeEnabled && isSetCmdNow) ? 'inline-flex' : 'none';

            const delayWrap = document.createElement('div');
            delayWrap.className = 'flow-delay';

            const delayTag = document.createElement('span');
            delayTag.className = 'flow-delay-tag';
            delayTag.textContent = 'Delay (ms)';

            const delayInput = document.createElement('input');
            delayInput.type = 'number';
            delayInput.min = '0';
            delayInput.step = '50';
            delayInput.placeholder = '150';
            delayInput.value = String(step.delayMs ?? 150);

            // Helps some browsers focus the correct control when clicking the tag area
            delayTag.addEventListener('click', () => delayInput.focus());

            delayWrap.appendChild(delayTag);
            delayWrap.appendChild(delayInput);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'flow-remove';
            removeBtn.title = 'Remove step';
            removeBtn.textContent = '×';

            const grip = document.createElement('div');
            grip.className = 'flow-grip';
            grip.textContent = '⋮⋮';

            const indexEl = document.createElement('div');
            indexEl.className = 'flow-index';
            indexEl.textContent = `#${idx + 1}`;

            li.appendChild(grip);
            li.appendChild(indexEl);
            li.appendChild(devSelect);
            li.appendChild(cmdSelect);
            li.appendChild(safeChip);
            li.appendChild(argsInput);
            li.appendChild(delayWrap);
            li.appendChild(removeBtn);

            // keep DnD simple: drag the whole row
            this.attachFlowDnD(li, idx);

            li.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            li.addEventListener('drop', (e) => {
                e.preventDefault();
                const from = Number(e.dataTransfer.getData('text/plain'));
                const to = Number(li.dataset.index);
                if (Number.isFinite(from) && Number.isFinite(to)) this.reorderFlow(from, to);
            });

            devSelect.addEventListener('change', () => {
                const newDeviceId = devSelect.value;
                const newCmds = newDeviceId ? this.getCommandsForDeviceId(newDeviceId) : [];
                const newCmd = newCmds.includes(step.cmd) ? step.cmd : (newCmds[0] || '');
                this.updateFlowStep(idx, { deviceId: newDeviceId, cmd: newCmd });
            });
            cmdSelect.addEventListener('change', () => {
                const v = String(cmdSelect.value || '');
                safeChip.style.display = (this.safeModeEnabled && v.toLowerCase().startsWith('set')) ? 'inline-flex' : 'none';
                this.updateFlowStep(idx, { cmd: v });
            });
            argsInput.addEventListener('input', () => {
                this.flowSteps[idx].args = argsInput.value;
            });
            delayInput.addEventListener('input', () => {
                const v = Number(delayInput.value);
                this.flowSteps[idx].delayMs = Number.isFinite(v) ? v : 0;
            });
            removeBtn.addEventListener('click', () => this.removeFlowStep(idx));

            list.appendChild(li);
        });

        // Keep command library synced
        this.refreshCommandLibrary();
    }

    async runFlow() {
        if (this.flowIsRunning) return;
        if (this.flowSteps.length === 0) {
            this.setFlowStatus('No steps to run.');
            return;
        }

        // Run summary (KPI): initialize
        const runId = `run_${Date.now()}`;
        const startedAtMs = Date.now();
        this.lastRunSummary = {
            id: runId,
            startedAt: new Date(startedAtMs).toISOString(),
            endedAt: null,
            durationMs: null,
            status: 'RUNNING',
            mode: document.getElementById('flowMode')?.value || 'once',
            cyclesPlanned: 0,
            cyclesDone: 0,
            stepsPlanned: 0,
            stepsDone: 0,
            timeoutCount: 0,
            lastStepLabel: '',
            errorMessage: ''
        };
        this.renderRunSummary();

        this.flowIsRunning = true;
        this.flowStopRequested = false;
        const stopBtn = document.getElementById('flowStopBtn');
        if (stopBtn) stopBtn.disabled = false;
        this.showToast('Running flow...', 'warning');

        // Only count runnable steps so progress is accurate
        const runnable = this.flowSteps
            .map((s, idx) => ({ s, idx }))
            .filter(x => x.s && x.s.deviceId && x.s.cmd);

        const total = runnable.length;
        if (total === 0) {
            this.setFlowStatus('No runnable steps (missing device/command).');

            if (this.lastRunSummary) {
                const endedAtMs = Date.now();
                this.lastRunSummary.status = 'ERROR';
                this.lastRunSummary.errorMessage = 'No runnable steps (missing device/command).';
                this.lastRunSummary.cyclesPlanned = 0;
                this.lastRunSummary.cyclesDone = 0;
                this.lastRunSummary.stepsPlanned = 0;
                this.lastRunSummary.stepsDone = 0;
                this.lastRunSummary.endedAt = new Date(endedAtMs).toISOString();
                this.lastRunSummary.durationMs = endedAtMs - startedAtMs;
                this.renderRunSummary();
            }

            this.flowIsRunning = false;
            if (stopBtn) stopBtn.disabled = true;
            return;
        }

        const mode = document.getElementById('flowMode')?.value || 'once';
        const cyclesInput = Number(document.getElementById('flowCycles')?.value || 1);
        const requestedCycles = Number.isFinite(cyclesInput) && cyclesInput > 0 ? Math.floor(cyclesInput) : 1;
        const restMsInput = Number(document.getElementById('flowRestMs')?.value || 0);
        const restMs = Number.isFinite(restMsInput) && restMsInput >= 0 ? restMsInput : 0;

        const maxCycles = (mode === 'loop') ? requestedCycles : 1;

        if (this.lastRunSummary) {
            this.lastRunSummary.mode = mode;
            this.lastRunSummary.cyclesPlanned = maxCycles;
            this.lastRunSummary.stepsPlanned = runnable.length * maxCycles;
            this.renderRunSummary();
        }

        const cycleLabel = (mode === 'loop') ? `Cycle 1/${maxCycles}` : 'Run';
        this.setFlowStatus(`${cycleLabel}: ready (0/${total})...`);

        try {
            for (let cycle = 1; cycle <= maxCycles; cycle++) {
                if (this.flowStopRequested) {
                    this.setFlowStatus('Stopped.');
                    break;
                }

                const cyclePrefix = (mode === 'loop') ? `Cycle ${cycle}/${maxCycles}` : 'Run';
                for (let i = 0; i < runnable.length; i++) {
                    if (this.flowStopRequested) {
                        this.setFlowStatus('Stopped.');
                        break;
                    }

                    const { s, idx } = runnable[i];
                    const device = this.connectedDevices.get(s.deviceId);

                    if (!device) {
                        const msg = `Device not connected (step ${idx + 1}).`;
                        this.addCommandLog({
                            time: new Date(),
                            deviceName: s.deviceId,
                            command: s.cmd,
                            args: (s.args || '').trim() ? (s.args || '').trim().split(/\s+/) : [],
                            result: '',
                            error: msg,
                            meta: { flow: true, cycle, maxCycles, step: i + 1, total }
                        });
                        this.setFlowStatus(`${cyclePrefix} failed (step ${i + 1}/${total}): ${msg}`);
                        throw new Error(msg);
                    }

                    const args = (s.args || '').trim();
                    const statusLabel = `${cyclePrefix} - Step ${i + 1}/${total}: ${device.name}.${s.cmd}`;
                    this.setFlowStatus(args ? `${statusLabel} (${args})` : statusLabel);

                    if (this.lastRunSummary) {
                        this.lastRunSummary.lastStepLabel = args ? `${device.name}.${s.cmd} (${args})` : `${device.name}.${s.cmd}`;
                        this.renderRunSummary();
                    }

                    // Execute with provided args without prompting
                    const argList = args ? args.split(/\s+/) : [];
                    await this.executeCommand(device.id, s.cmd, {
                        args: argList,
                        prompt: null,
                        timeoutMs: this.defaultCommandTimeoutMs,
                        meta: { flow: true, cycle, maxCycles, step: i + 1, total }
                    });

                    // Timeout heuristic (executeCommand updates device.lastStatus)
                    if (this.lastRunSummary && device && device.lastStatus === 'TIMEOUT') {
                        this.lastRunSummary.timeoutCount = (this.lastRunSummary.timeoutCount || 0) + 1;
                    }
                    if (this.lastRunSummary) {
                        this.lastRunSummary.stepsDone = (this.lastRunSummary.stepsDone || 0) + 1;
                        this.renderRunSummary();
                    }

                    const delay = Number.isFinite(Number(s.delayMs)) ? Number(s.delayMs) : 0;
                    if (delay > 0) await this.sleep(delay);
                }

                if (this.flowStopRequested) break;

                if (this.lastRunSummary) {
                    this.lastRunSummary.cyclesDone = cycle;
                    this.renderRunSummary();
                }

                if (mode === 'loop' && cycle < maxCycles && restMs > 0) {
                    this.setFlowStatus(`Cycle ${cycle}/${maxCycles} complete. Resting ${restMs}ms...`);
                    await this.sleep(restMs);
                }
            }

            if (!this.flowStopRequested) {
                this.setFlowStatus('Done.');
                this.showToast('Flow done');

                if (this.lastRunSummary) {
                    this.lastRunSummary.status = 'OK';
                }
            }
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            this.setFlowStatus(`Flow failed: ${msg}`);
            this.showToast('Flow failed', 'error');

            if (this.lastRunSummary) {
                this.lastRunSummary.status = this.flowStopRequested ? 'STOPPED' : 'ERROR';
                this.lastRunSummary.errorMessage = msg;
            }
            throw e;
        } finally {

            if (this.lastRunSummary) {
                const endedAtMs = Date.now();
                this.lastRunSummary.endedAt = new Date(endedAtMs).toISOString();
                this.lastRunSummary.durationMs = endedAtMs - startedAtMs;
                if (this.flowStopRequested && this.lastRunSummary.status === 'RUNNING') {
                    this.lastRunSummary.status = 'STOPPED';
                }
                this.renderRunSummary();

                // Persist into history for KPI/trend (store a snapshot)
                this.pushRunHistory({ ...this.lastRunSummary });
            }

            this.flowIsRunning = false;
            if (stopBtn) stopBtn.disabled = true;
        }
    }

    stopFlow() {
        if (!this.flowIsRunning) return;
        this.flowStopRequested = true;
        this.setFlowStatus('Stopping...');
        this.showToast('Stopping flow...', 'warning');
    }

    formatForLog(value) {
        if (value == null) return '';
        if (Array.isArray(value)) return value.join(' | ');
        return String(value);
    }

    addCommandLog(entry) {
        this.commandLog.push(entry);
        // keep it bounded
        if (this.commandLog.length > 500) this.commandLog.shift();
        this.renderCommandLog();
    }

    renderCommandLog() {
        const body = document.getElementById('cmdLogBody');
        const empty = document.getElementById('cmdLogEmpty');
        if (!body || !empty) return;

        if (this.commandLog.length === 0) {
            body.innerHTML = '';
            empty.style.display = 'block';
            return;
        }

        empty.style.display = 'none';

        const rows = this.commandLog.slice().reverse().map(e => {
            const time = this.formatDateTime(e.time);
            const args = e.args && e.args.length ? e.args.join(', ') : '';
            const result = e.error ? `ERROR: ${e.error}` : (e.result || '');
            const safe = (s) => String(s)
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;');
            return `
                <tr>
                    <td>${safe(time)}</td>
                    <td>${safe(e.deviceName || '')}</td>
                    <td>${safe(e.command || '')}</td>
                    <td>${safe(args)}</td>
                    <td>${safe(result)}</td>
                </tr>
            `;
        });

        body.innerHTML = rows.join('');
    }

    clearCommandLog() {
        this.commandLog = [];
        this.renderCommandLog();
        this.showToast('Command log cleared');
    }

    exportCommandLog(format) {
        const data = this.commandLog.slice();
        if (format === 'csv') {
            const header = ['time', 'device', 'command', 'args', 'result', 'error'];
            const esc = (v) => {
                const s = String(v ?? '');
                const needs = s.includes(',') || s.includes('"') || s.includes('\n');
                const out = s.replaceAll('"', '""');
                return needs ? `"${out}"` : out;
            };
            const lines = [header.join(',')].concat(data.map(e => {
                return [
                    e.time ? e.time.toISOString() : '',
                    e.deviceName || '',
                    e.command || '',
                    (e.args && e.args.length) ? e.args.join(' ') : '',
                    e.result || '',
                    e.error || ''
                ].map(esc).join(',');
            }));
            this.downloadText(lines.join('\n'), `revidyne-command-log-${Date.now()}.csv`, 'text/csv');
            return;
        }

        // default json
        this.downloadText(JSON.stringify(data, null, 2), `revidyne-command-log-${Date.now()}.json`, 'application/json');
    }

    downloadText(text, filename, mime) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 500);
    }

    findConnectedDeviceByNameSubstring(keyword) {
        const k = String(keyword || '').toLowerCase();
        for (const d of this.connectedDevices.values()) {
            if (String(d.name || '').toLowerCase().includes(k)) return d;
        }
        return null;
    }

    setControllerStatus(msg, type = 'info') {
        const el = document.getElementById('controllerStatus');
        if (!el) return;
        el.textContent = msg;
        el.dataset.type = type;
    }

    async runScenario(name) {
        const solar = this.findConnectedDeviceByNameSubstring('solar');
        const gen = this.findConnectedDeviceByNameSubstring('gen');
        const load = this.findConnectedDeviceByNameSubstring('load');
        const wind = this.findConnectedDeviceByNameSubstring('wind');
        const fan = this.findConnectedDeviceByNameSubstring('fan');

    // We'll compute "missing" per-scenario after we decide what we actually tried to run.
    let missing = [];

    this.setControllerStatus(`Running scenario: ${name}...`);
        this.showToast(`Scenario: ${name}`, 'warning');

        // run whatever is connected (don't hard-fail)
        const steps = [];

        if (name === 'startup') {
            if (solar) steps.push([solar, 'init'], [solar, 'goHome'], [solar, 'runScan'], [solar, 'trackOn']);
            if (gen) steps.push([gen, 'init'], [gen, 'trackOn']);
            if (load) steps.push([load, 'init'], [load, 'autoOn']);
            // If solar isn't connected, let wind act as the renewable provider.
            if (!solar && wind) steps.push([wind, 'init'], [wind, 'runScan'], [wind, 'trackOn']);
            // If load isn't connected, use fan as a simple consumer demo.
            if (!load && fan) steps.push([fan, 'init'], [fan, 'fanOn']);
        } else if (name === 'eco') {
            // low demand, prioritize renewable
            if (load) steps.push([load, 'lightsOut']);
            if (solar) steps.push([solar, 'trackOn']);
            if (!solar && wind) steps.push([wind, 'trackOn']);
            if (fan) {
                // gentle consumer demo: low speed
                steps.push([fan, 'fanOn']);
                steps.push([fan, 'setSpeed', { prompt: 'Fan speed (eco mode)', defaultValue: '3' }]);
            }
            if (gen) {
                // if setLoad exists and needs input, we'll ask once
                steps.push([gen, 'setLoad', { prompt: 'Generator setLoad value (eco mode)', defaultValue: '1' }]);
                steps.push([gen, 'trackOn']);
            }
        } else if (name === 'demand') {
            // higher demand
            if (load) steps.push([load, 'lightAll']);
            if (solar) steps.push([solar, 'runIVScan'], [solar, 'trackOn']);
            if (!solar && wind) steps.push([wind, 'runScan'], [wind, 'trackOn']);
            if (fan) {
                // higher demand demo: higher speed
                steps.push([fan, 'fanOn']);
                steps.push([fan, 'setSpeed', { prompt: 'Fan speed (demand mode)', defaultValue: '8' }]);
            }
            if (gen) {
                steps.push([gen, 'setLoad', { prompt: 'Generator setLoad value (demand mode)', defaultValue: '5' }]);
                steps.push([gen, 'trackOn']);
            }
        } else {
            this.setControllerStatus(`Unknown scenario: ${name}`, 'error');
            return;
        }

        // Missing devices: only those relevant to this scenario and not present.
        // (Scenarios are best-effort; they can still succeed with partial hardware.)
        const needs = {
            startup: ['solartracker', 'generator', 'houseload', 'windturbine', 'fan'],
            eco: ['solartracker', 'generator', 'houseload', 'windturbine', 'fan'],
            demand: ['solartracker', 'generator', 'houseload', 'windturbine', 'fan']
        };
        const want = needs[name] || [];
        const have = new Set();
        if (solar) have.add('solartracker');
        if (gen) have.add('generator');
        if (load) have.add('houseload');
        if (wind) have.add('windturbine');
        if (fan) have.add('fan');
        missing = want.filter(x => !have.has(x));

        try {
            const total = steps.length;
            for (let i = 0; i < total; i++) {
                const [deviceInfo, cmd, meta] = steps[i];
                if (!deviceInfo || !cmd) continue;

                const label = `Step ${i + 1}/${total}: ${deviceInfo.name}.${cmd}`;
                this.setControllerStatus(label);

                await this.executeCommand(deviceInfo.id, cmd, { scenario: name, step: i + 1, total, ...(meta || {}) });
                await this.sleep(120);
            }

            const msg = missing.length
                ? `Scenario '${name}' done (missing: ${missing.join(', ')}).`
                : `Scenario '${name}' done.`;
            this.setControllerStatus(msg, missing.length ? 'warning' : 'success');
            this.showToast(msg);
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            this.setControllerStatus(`Scenario '${name}' failed: ${msg}`, 'error');
            this.showToast('Scenario failed', 'error');
            throw e;
        }
    }

    // Prefer extracting the first number from a specific line index
    parseNumberAtLine(value, lineIndex) {
        if (!Array.isArray(value)) return null;
        if (lineIndex < 0 || lineIndex >= value.length) return null;
        return this.parseFirstNumber(value[lineIndex]);
    }

    // Returns a set of known telemetry commands that exist on this device
    getTelemetryCapabilities(revidyneDevice) {
        const cmds = (revidyneDevice && revidyneDevice.cmds) ? revidyneDevice.cmds : {};
        const has = (name) => Boolean(cmds && cmds[name]);
        return {
            getAll: has('getAll'),
            getKW: has('getKW'),
            getVolts: has('getVolts'),
            getVal: has('getVal'),
            getBV: has('getBV'),
            getCurrent: has('getCurrent'),
            getRes: has('getRes'),
            getDrop: has('getDrop'),
            getLoads: has('getLoads'),
            getLoadVal: has('getLoadVal'),
            any: has('getAll') || has('getKW') || has('getVolts') || has('getVal') || has('getBV') || has('getCurrent') || has('getRes') || has('getDrop') || has('getLoads') || has('getLoadVal')
        };
    }

    async safeCall(revidyneDevice, cmd) {
        try {
            if (!revidyneDevice || !revidyneDevice.cmds || !revidyneDevice.cmds[cmd]) return null;
            return await revidyneDevice.call(cmd, true);
        } catch (e) {
            return null;
        }
    }

    async refreshLiveMetrics() {
        const now = new Date();
        const connected = Array.from(this.connectedDevices.values());
        if (connected.length === 0) {
            this.metrics.clear();
            this.renderMetrics();
            return;
        }

        for (const d of connected) {
            const dev = d.revidyneDevice;
            if (!dev) continue;

            // Add delay between devices to prevent serial buffer issues
            await this.sleep(300);

            const caps = this.getTelemetryCapabilities(dev);

            // Only call what exists (important: your generator list currently has no get* commands)
            // Add small delays between commands to prevent buffer overflow
            const allResp = caps.getAll ? await this.safeCall(dev, 'getAll') : null;
            if (caps.getAll) await this.sleep(100);
            
            const kwResp = caps.getKW ? await this.safeCall(dev, 'getKW') : null;
            if (caps.getKW) await this.sleep(100);
            
            const voltsResp = caps.getVolts ? await this.safeCall(dev, 'getVolts') : null;
            if (caps.getVolts) await this.sleep(100);
            
            const valResp = caps.getVal ? await this.safeCall(dev, 'getVal') : null;
            if (caps.getVal) await this.sleep(100);
            
            const bvResp = caps.getBV ? await this.safeCall(dev, 'getBV') : null;
            const currentResp = caps.getCurrent ? await this.safeCall(dev, 'getCurrent') : null;

            // Heuristics:
            // - getVolts/getVal: first numeric
            // - getBV: first line often voltage
            // - getAll: for our prompts, the last line is often line voltage/power, but device firmware can differ
            const volts =
                this.parseFirstNumber(voltsResp) ??
                this.parseFirstNumber(valResp) ??
                this.parseNumberAtLine(bvResp, 0) ??
                this.parseFirstNumber(bvResp) ??
                // generator.getAll prompt ends with "线电压" in revidyne.js; try last line
                (Array.isArray(allResp) ? this.parseNumberAtLine(allResp, allResp.length - 1) : null) ??
                this.parseFirstNumber(allResp);

            const kw =
                this.parseFirstNumber(kwResp) ??
                // solar/wind/load/fan getAll prompt ends with current power; try last line
                (Array.isArray(allResp) ? this.parseNumberAtLine(allResp, allResp.length - 1) : null);

            const currentmA = this.parseFirstNumber(currentResp);

            // Log raw values for debugging
            if (this.metricsShowRaw) {
                console.log(`[Raw Metrics] ${d.name}: voltage=${volts}, power=${kw}`);
            }

            // DISABLED: Filtering was causing issues with values jumping between 0 and correct values
            // Use raw values directly instead
            const filteredVolts = this.sanitizeMetricNumber('volts', volts);
            const filteredKw = this.sanitizeMetricNumber('kw', kw);

            const metric = {
                updatedAt: now,
                volts: filteredVolts,
                kw: filteredKw,
                rawVolts: volts,  // Store raw value for reference
                rawKw: kw,        // Store raw value for reference
                currentmA,
                rawAll: allResp,
                telemetryStatus: caps.any ? 'ok' : 'no-telemetry-cmds',
                telemetryCmds: caps
            };
            this.metrics.set(d.id, metric);
        }

        this.renderMetrics();
    }

    // ========== Metrics Filtering ==========
    // Filters out outlier values that jump too much from the moving average
    filterMetricValue(deviceId, field, newValue) {
        if (newValue == null || isNaN(newValue)) return null;

        // Get or create history for this device
        if (!this.metricsHistory.has(deviceId)) {
            this.metricsHistory.set(deviceId, { volts: [], kw: [] });
        }
        const history = this.metricsHistory.get(deviceId);
        const arr = history[field] || [];

        // If no history yet, accept the value
        if (arr.length === 0) {
            arr.push(newValue);
            history[field] = arr;
            return newValue;
        }

        // Calculate moving average of recent values
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;

        // Check if new value is an outlier
        // Special case: if avg is near zero, use absolute threshold
        const absThreshold = 50; // Allow small fluctuations around zero
        let isOutlier = false;

        if (Math.abs(avg) < 10) {
            // Near zero: use absolute difference
            isOutlier = Math.abs(newValue - avg) > absThreshold && Math.abs(newValue) > absThreshold;
        } else {
            // Normal case: use percentage change
            const changePercent = Math.abs((newValue - avg) / avg) * 100;
            isOutlier = changePercent > this.metricsMaxChangePercent;
        }

        // Reject negative voltage (usually error)
        if (field === 'volts' && newValue < 0) {
            console.log(`[Metrics Filter] ${deviceId}.${field}: rejected negative value ${newValue}`);
            return arr.length > 0 ? arr[arr.length - 1] : null; // Return last good value
        }

        if (isOutlier) {
            console.log(`[Metrics Filter] ${deviceId}.${field}: rejected outlier ${newValue} (avg: ${avg.toFixed(2)})`);
            // Return the last good value instead
            return arr.length > 0 ? arr[arr.length - 1] : null;
        }

        // Accept value, add to history
        arr.push(newValue);
        // Keep only recent values
        while (arr.length > this.metricsHistorySize) {
            arr.shift();
        }
        history[field] = arr;

        return newValue;
    }

    // Clear metrics history (call when device disconnects or on manual reset)
    clearMetricsHistory(deviceId) {
        if (deviceId) {
            this.metricsHistory.delete(deviceId);
        } else {
            this.metricsHistory.clear();
        }
    }

    renderMetrics() {
        const container = document.getElementById('metricsTableBody');
        const empty = document.getElementById('metricsEmpty');
        const updated = document.getElementById('metricsUpdatedAt');
        const balEl = document.getElementById('metricsBalance');
        const supplyEl = document.getElementById('metricsSupply');
        const demandEl = document.getElementById('metricsDemand');
        const balTextEl = document.getElementById('metricsBalanceText');
        const balHintEl = document.getElementById('metricsBalanceHint');

    // If index.html has no metrics panel, just skip
    if (!container || !empty || !updated) return;

        let totalSupplyKW = 0;
        let totalDemandKW = 0;

        const rows = Array.from(this.connectedDevices.values()).map(d => {
            const metric = this.metrics.get(d.id);
            const volts = metric && metric.volts != null ? `${metric.volts}` : 'N/A';

            const est = this.computeEstimatedKW(d, metric);
            const showKW = (est.kw != null) ? `${est.kw}` : 'N/A';
            const status = (metric && metric.telemetryStatus === 'no-telemetry-cmds')
                ? 'No telemetry commands (device only exposes control/set commands)'
                : '';

            if (d.type === 'provider' && est.kw != null) totalSupplyKW += est.kw;
            if (d.type === 'consumer' && est.kw != null) totalDemandKW += est.kw;

            const estUI = this.renderPowerEstInputs(d, metric);

            const kwCell = (est.source === 'estimate')
                ? `${showKW} <span class="metrics-cell-hint">(est.)</span>`
                : showKW;

            return `
                <tr>
                    <td>${d.name}</td>
                    <td>${d.type === 'provider' ? 'Provider' : 'Consumer'}</td>
                    <td>${volts}</td>
                    <td>${kwCell}</td>
                </tr>
                ${estUI ? `<tr class="metrics-est-row"><td colspan="4">${estUI}</td></tr>` : ''}
                ${status ? `<tr class="metrics-note"><td colspan="4"><small>${status}</small></td></tr>` : ''}
            `;
        });

        if (rows.length === 0) {
            container.innerHTML = '';
            empty.style.display = 'block';
        } else {
            container.innerHTML = rows.join('');
            empty.style.display = 'none';
        }

        // Balance strip (optional: older HTML might not have it)
        if (balEl && supplyEl && demandEl && balTextEl) {
            // If auto-estimate demand is enabled, infer demand from supply dynamics.
            // Note: this does NOT send any device commands.
            const inferred = this.inferDemandKW(totalSupplyKW, totalDemandKW);
            const demandForUI = (typeof inferred === 'number' && Number.isFinite(inferred)) ? inferred : totalDemandKW;

            supplyEl.textContent = this.fmtKW(totalSupplyKW);
            demandEl.textContent = this.fmtKW(demandForUI);

            // Persist latest totals for other UI features (e.g., Option A allocation)
            this.latestEstimatedSupplyKW = totalSupplyKW;
            this.latestEstimatedDemandKW = demandForUI;

            this.updateAutoEstimateUI();

            const diff = totalSupplyKW - demandForUI;
            const abs = Math.abs(diff);
            const pct = (demandForUI > 0) ? (abs / demandForUI) : 0;
            if (totalSupplyKW === 0 && demandForUI === 0) {
                balTextEl.textContent = 'Enter estimates to compute balance.';
                balEl.classList.remove('ok', 'warn', 'bad');
                if (balHintEl) balHintEl.textContent = 'Tip: enter Consumer Rated (W) and Provider Capacity (kW). This never sends device commands.';
            } else if (diff >= 0) {
                balTextEl.textContent = `Sufficient (+${this.fmtKW(diff)})`;
                balEl.classList.remove('warn', 'bad');
                balEl.classList.add('ok');
                if (balHintEl) {
                    // Guidance for common “looks wrong” cases
                    if (demandForUI > 0 && (totalSupplyKW / demandForUI) >= 20) {
                        balHintEl.textContent = 'Estimates look very unbalanced (supply ≫ demand). Consider lowering Provider Capacity/Availability or increasing Consumer Rated (W).';
                    } else if (demandForUI === 0) {
                        balHintEl.textContent = 'Demand is 0. Add Consumer Rated (W) (e.g., fan 120W, houseload 300–800W) to get a meaningful balance.';
                    } else {
                        balHintEl.textContent = 'Looks reasonable. You can adjust Utilization/Availability to model real-world variability.';
                    }
                }
            } else if (pct < 0.15) {
                balTextEl.textContent = `Slight deficit (−${this.fmtKW(abs)})`;
                balEl.classList.remove('ok', 'bad');
                balEl.classList.add('warn');
                if (balHintEl) {
                    balHintEl.textContent = 'Close! Try increasing Provider Availability a bit, or reduce Consumer Utilization to avoid overload.';
                }
            } else {
                balTextEl.textContent = `Insufficient (−${this.fmtKW(abs)})`;
                balEl.classList.remove('ok', 'warn');
                balEl.classList.add('bad');
                if (balHintEl) {
                    balHintEl.textContent = 'Not enough supply. Increase Provider Capacity/Availability, or lower Consumer Rated (W)/Utilization.';
                }
            }
        }

        this.attachMetricsEstimateListeners();
    this.updateAllocationUIState();

        // Auto-estimate demand toggle
        try {
            const btn = document.getElementById('autoEstDemandToggleBtn');
            if (btn && !btn._autoEstWired) {
                btn._autoEstWired = true;
                btn.addEventListener('click', () => {
                    this.setAutoEstimateEnabled(!this.autoEstEnabled);
                });
            }
        } catch {
            // ignore
        }

        // Updated time = latest metric we have
        const latest = Array.from(this.metrics.values())
            .map(m => m.updatedAt)
            .sort((a, b) => b - a)[0];
        updated.textContent = latest ? this.formatDateTime(latest) : '—';
    }

    updateSummary() {
        const elConnected = document.getElementById('summaryConnected');
        const elAvailable = document.getElementById('summaryAvailable');
        const elProviders = document.getElementById('summaryProviders');
        const elConsumers = document.getElementById('summaryConsumers');
        const elLastScan = document.getElementById('summaryLastScan');

        // If the summary panel doesn't exist (older index.html), just skip.
        if (!elConnected || !elAvailable || !elProviders || !elConsumers || !elLastScan) {
            return;
        }

        const connected = Array.from(this.connectedDevices.values());
        const providers = connected.filter(d => d.type === 'provider').length;
        const consumers = connected.filter(d => d.type === 'consumer').length;

        elConnected.textContent = String(this.connectedDevices.size);
        elAvailable.textContent = String(this.availableDevices.size);
        elProviders.textContent = String(providers);
        elConsumers.textContent = String(consumers);
        elLastScan.textContent = this.formatDateTime(this.lastScanAt);
    }

    
    async executeCommand(deviceId, cmdName, options = {}) {
        const device = this.connectedDevices.get(deviceId);
        if (!device || !device.revidyneDevice) return;

        // Demo/Safe Mode guard: block set* commands (manual/scenario/flow)
        const isSetCmd = String(cmdName || '').toLowerCase().startsWith('set');
        if (this.safeModeEnabled && isSetCmd) {
            const msg = `Blocked by Demo/Safe Mode: ${cmdName}`;
            this.showToast(msg, 'warning');
            this.addCommandLog({
                time: new Date(),
                deviceName: device.name,
                command: cmdName,
                args: Array.isArray(options.args) ? options.args : [],
                result: '',
                error: msg,
                meta: { ...(options.meta || {}), safeMode: true }
            });

            device.lastCommand = cmdName;
            device.lastStatus = 'BLOCKED';
            device.lastAt = new Date();
            this.updateUI();
            return;
        }

        const dev = device.revidyneDevice;

        // Ensure commands for the same device are serialized
    return this.enqueueDeviceCommand(deviceId, async () => {
            // If command needs input (or is a known set*), prompt for args
            let args = [];
            // mark as running
            device.lastCommand = cmdName;
            device.lastStatus = 'RUNNING';
            device.lastAt = new Date();
            this.updateUI();

            try {
                const cmdObj = dev && dev.cmds ? dev.cmds[cmdName] : null;
                const inArg = cmdObj && typeof cmdObj.inArg === 'number' ? cmdObj.inArg : 0;
                const needsInput = inArg > 0 || String(cmdName).startsWith('set');
                // options.args: explicit arg list (used by Flow Builder)
                if (Array.isArray(options.args)) {
                    args = options.args.map(String);
                } else if (needsInput && options.prompt !== null) {
                    const raw = window.prompt(options.prompt || `Enter value(s) for ${device.name}.${cmdName} (separate by spaces)`, options.defaultValue || '');
                    if (raw == null) {
                        // cancelled
                        this.addCommandLog({
                            time: new Date(),
                            deviceName: device.name,
                            command: cmdName,
                            args: [],
                            result: '',
                            error: 'cancelled'
                        });
                        return;
                    }
                    args = raw.trim() ? raw.trim().split(/\s+/) : [];
                }
            } catch {
                // ignore prompt errors
            }

            const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : this.defaultCommandTimeoutMs;

            try {
                let result;
                if (args.length > 0) {
                    // For inArg commands, send cmd then args lines.
                    await this.withTimeout(dev.sendCommand(cmdName), timeoutMs, `${cmdName} send`);
                    for (const a of args) {
                        await this.withTimeout(dev.sendCommand(String(a)), timeoutMs, `${cmdName} arg send`);
                        await this.sleep(50);
                    }

                    // Read any returned lines if device defines out args.
                    const cmdObj = dev && dev.cmds ? dev.cmds[cmdName] : null;
                    const outArg = cmdObj && typeof cmdObj.outArg === 'number' ? cmdObj.outArg : 0;
                    if (outArg > 0) {
                        const data = [];
                        for (let i = 0; i < outArg; i++) {
                            const line = await this.withTimeout(dev.readResponse(), timeoutMs, `${cmdName} read`);
                            data.push(line);
                        }
                        result = data;
                    } else {
                        result = null;
                    }
                } else {
                    result = await this.withTimeout(dev.call(cmdName, true), timeoutMs, `${cmdName} call`);
                }

                const hasPayload = Array.isArray(result) ? result.length > 0 : Boolean(result);
                this.showCommandResult(device.name, cmdName, hasPayload ? result : 'Command sent. (No payload returned)');
                this.showToast(`Running command: ${cmdName}`);

                device.lastCommand = cmdName;
                device.lastStatus = 'OK';
                device.lastAt = new Date();
                this.updateUI();

                this.addCommandLog({
                    time: new Date(),
                    deviceName: device.name,
                    command: cmdName,
                    args,
                    result: hasPayload ? this.formatForLog(result) : 'sent (no payload)',
                    error: ''
                });
            } catch (err) {
                console.error('Failed to execute command:', err);
                this.showToast('Command failed', 'error');

                const msg = err && err.message ? err.message : String(err);
                device.lastCommand = cmdName;
                device.lastStatus = msg.includes('timeout') ? 'TIMEOUT' : 'ERROR';
                device.lastAt = new Date();
                this.updateUI();

                this.addCommandLog({
                    time: new Date(),
                    deviceName: device.name,
                    command: cmdName,
                    args,
                    result: '',
                    error: msg
                });
            }
        });
    }
    
    showCommandResult(deviceName, cmdName, result) {
        const modal = document.getElementById('resultModal');
        const content = document.getElementById('resultContent');
        
        content.innerHTML = `
            <h4>${deviceName} - ${cmdName}</h4>
            <pre>${Array.isArray(result) ? result.join('\n') : result}</pre>
        `;
        modal.style.display = 'flex';
    }
    
    closeModal() {
        document.getElementById('resultModal').style.display = 'none';
    }
    
    async disconnectDevice(deviceId) {
        const device = this.connectedDevices.get(deviceId) || this.availableDevices.get(deviceId);
        if (!device || !device.revidyneDevice) return;
        
        try {
            await device.revidyneDevice.disconnect();
            device.isConnected = false;
            this.showToast(`Disconnected: ${device.name}`);
            this.updateUI();
        } catch (err) {
            console.error('Failed to disconnect device:', err);
        }
    }

    async setFanSpeed(deviceId, value) {
        const device = this.connectedDevices.get(deviceId);
        if (!device) {
            this.showToast('Connect the fan first', 'warning');
            return;
        }

        const v = Math.max(0, Math.min(10, Math.round(Number(value))));

        // Keep UI slider in sync if it exists
        try {
            const slider = document.getElementById(`fanSpeed_${deviceId}`);
            const valEl = document.getElementById(`fanSpeedVal_${deviceId}`);
            if (slider) slider.value = String(v);
            if (valEl) valEl.textContent = String(v);
        } catch {}

        // Persist last used speed per device name (best-effort)
        try {
            const nameLower = String(device.name || '').toLowerCase();
            localStorage.setItem(`revidyne.fan.speed.${nameLower}`, String(v));
        } catch {}

        // Delegate to normal command execution pipeline (logs, statuses, timeouts, safe mode gating)
        return await this.executeCommand(deviceId, 'setSpeed', { args: [String(v)] });
    }

    async setGeneratorLoad(deviceId, value) {
        const device = this.connectedDevices.get(deviceId);
        if (!device) {
            this.showToast('Connect the generator first', 'warning');
            return;
        }

        const raw = Array.isArray(value) ? value[0] : value;
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0) {
            this.showToast('Invalid generator load value', 'error');
            return;
        }

        // Persist last used load per device name (best-effort)
        try {
            const nameLower = String(device.name || '').toLowerCase();
            localStorage.setItem(`revidyne.generator.load.${nameLower}`, String(v));
        } catch {}

        // Delegate to normal command execution pipeline (logs, statuses, timeouts, safe mode gating)
        await this.executeCommand(deviceId, 'setLoad', { args: [String(v)] });

        // Even without telemetry, show a clear “we sent it” signal on the card.
        try {
            this.lastSetLoadByDeviceId.set(deviceId, { valueKW: v, at: Date.now() });
            this.updateUI();
        } catch {
            // ignore
        }
    }
    
    showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
    
    createDeviceCard(device, location) {
        const typeLabel = device.type === 'provider' ? '⚡ Provider' : '🔋 Consumer';
        const typeIcon = this.getDeviceIcon(device.name);
        const statusHtml = device.isConnected 
            ? '<span class="status-indicator"></span>Connected' 
            : '';
        
    // Build command buttons
        let commandsHtml = '';
        if (location === 'connected' && device.commands && device.commands.length > 0) {
            const commands = device.commands
                .filter(cmd => cmd && cmd !== 'eoc' && cmd !== '')
                .map(cmd => String(cmd));

            const nameLower = String(device?.name || '').toLowerCase();
            const isHouseLoad = nameLower.includes('houseload');

            // UX: HouseLoad often has many useful read commands.
            // Show all by default so it doesn't look like the device only has a handful.
            const primaryCount = isHouseLoad ? 999 : 8;
            const primary = commands.slice(0, primaryCount);
            const extra = commands.slice(primaryCount);

            const mkBtn = (cmd) => {
                // cmd is the executable base command name.
                const signature = (device && device.commandSignatures && device.commandSignatures[cmd])
                    ? String(device.commandSignatures[cmd])
                    : null;
                const label = signature || cmd;

                const help = this.getCommandHelpText(cmd);
                const pieces = [];
                if (signature) pieces.push(signature);
                if (help) pieces.push(help);
                const tooltip = pieces.join(' — ');

                const t = tooltip ? `title="${this.escapeHtml(tooltip)}"` : '';
                const aria = tooltip ? `aria-label="${this.escapeHtml(label + ': ' + tooltip)}"` : '';

                // Safe mode blocks set* commands. Keep buttons visible but disabled.
                const isSet = /^set/i.test(cmd);
                const disabled = (this.safeModeEnabled && isSet) ? 'disabled' : '';
                const disabledTitle = (this.safeModeEnabled && isSet)
                    ? 'title="Demo/Safe Mode is ON: set* commands are blocked"'
                    : '';

                return `<button class="cmd-btn" ${t} ${aria} ${disabled} ${disabledTitle} onclick="manager.executeCommand('${device.id}', '${cmd}')">${this.escapeHtml(label)}</button>`;
            };

            const cmdButtons = primary.map(mkBtn).join('');
            const moreHtml = extra.length
                ? `
                    <details class="device-commands-more" aria-label="More commands">
                        <summary class="device-commands-more-summary">More commands (${extra.length})</summary>
                        <div class="device-commands device-commands-extra">${extra.map(mkBtn).join('')}</div>
                    </details>
                `
                : '';

            commandsHtml = `<div class="device-commands-wrap"><div class="device-commands">${cmdButtons}</div>${moreHtml}</div>`;
        }
        
        const meta = (location === 'connected')
            ? this.renderDeviceMeta(device)
            : '';

        const fwDiag = (location === 'connected')
            ? this.renderFirmwareCommandDiagnostics(device)
            : '';

        const quickControls = (location === 'connected')
            ? this.renderDeviceQuickControls(device)
            : '';

        const actionBtn = location === 'connected'
            ? `<button class="connect-btn disconnect-btn" onclick="manager.disconnectDevice('${device.id}')">Disconnect</button>`
            : '';
        
        return `
            <div class="device-card ${device.type}" 
                 draggable="true" 
                 ondragstart="drag(event)" 
                 data-id="${device.id}">
                <div class="device-header">
                    <span class="device-icon">${typeIcon}</span>
                    <div class="device-name">${device.name} ${statusHtml}</div>
                </div>
                <span class="device-type ${device.type}">${typeLabel}</span>
                ${meta}
                ${fwDiag}
                ${quickControls}
                ${commandsHtml}
                ${actionBtn}
            </div>
        `;
    }

    // Show what firmware commands were actually discovered (helps diagnose missing getAll/getLoads/setLimits)
    renderFirmwareCommandDiagnostics(device) {
        try {
            const dev = device && device.revidyneDevice ? device.revidyneDevice : null;
            const cmdsObj = (dev && dev.cmds) ? dev.cmds : {};
            const all = Object.keys(cmdsObj || {});

            // device.commands is what we render; keep it consistent in case of future changes
            const cmds = Array.isArray(device.commands) ? device.commands : all;
            const count = cmds.length;

            // Just show the count, no "Missing" warnings
            return `<div class="fw-diag"><span class="fw-diag-label">Firmware commands</span><span class="fw-diag-value">${count}</span></div>`;
        } catch {
            return '';
        }
    }

    renderDeviceQuickControls(device) {
        const nameLower = String(device.name || '').toLowerCase();

        // Generator quick controls: show a setLoad field when setLoad exists.
        const isGenerator = nameLower.includes('generator');
        const supportsSetLoad = Array.isArray(device.commands) && device.commands.includes('setLoad');

        if (isGenerator && supportsSetLoad) {
            const disabled = this.safeModeEnabled ? 'disabled' : '';
            const disabledHint = this.safeModeEnabled
                ? ' title="Demo/Safe Mode is ON: set* commands are blocked"'
                : '';

            // Persist last used load (kW) per device name (best-effort)
            const key = `revidyne.generator.load.${nameLower}`;
            let initial = 0;
            try {
                const raw = localStorage.getItem(key);
                if (raw != null && raw !== '') initial = Number(raw);
            } catch {}
            if (!Number.isFinite(initial)) initial = 0;
            initial = Math.max(0, Math.min(9999, initial));

            const inputId = `genLoad_${device.id}`;
            const apply = `manager.setGeneratorLoad('${device.id}', document.getElementById('${inputId}').value)`;

            return `
                <div class="device-quick gen-quick" aria-label="Generator quick controls">
                    <div class="device-quick-row">
                        <span class="device-quick-label">Load (kW)</span>
                        <input id="${inputId}" class="gen-load" type="number" min="0" step="0.1" value="${initial}" />
                        <button class="cmd-btn gen-apply" ${disabled}${disabledHint} onclick="${apply}">Apply</button>
                    </div>
                    <div class="device-quick-row gen-presets">
                        <button class="cmd-btn" ${disabled}${disabledHint} onclick="manager.setGeneratorLoad('${device.id}', 0)">0</button>
                        <button class="cmd-btn" ${disabled}${disabledHint} onclick="manager.setGeneratorLoad('${device.id}', 1)">1</button>
                        <button class="cmd-btn" ${disabled}${disabledHint} onclick="manager.setGeneratorLoad('${device.id}', 3)">3</button>
                        <button class="cmd-btn" ${disabled}${disabledHint} onclick="manager.setGeneratorLoad('${device.id}', 5)">5</button>
                        <button class="cmd-btn" ${disabled}${disabledHint} onclick="manager.setGeneratorLoad('${device.id}', 8)">8</button>
                    </div>
                </div>
            `;
        }

        // Fan quick controls: show a speed slider when setSpeed exists.
        // This is safe to show even if firmware ignores it; execution result will be reflected in Last/Status/Time.
        const isFan = nameLower.includes('fan');
        const supportsSetSpeed = Array.isArray(device.commands) && device.commands.includes('setSpeed');

        if (isFan && supportsSetSpeed) {
            const disabled = this.safeModeEnabled ? 'disabled' : '';
            const disabledHint = this.safeModeEnabled
                ? ' title="Demo/Safe Mode is ON: set* commands are blocked"'
                : '';

            // Persist last used fan speed per device name (best-effort)
            const key = `revidyne.fan.speed.${nameLower}`;
            let initial = 0;
            try {
                const raw = localStorage.getItem(key);
                if (raw != null && raw !== '') initial = Number(raw) || 0;
            } catch {}
            initial = Math.max(0, Math.min(10, Math.round(initial)));

            const sliderId = `fanSpeed_${device.id}`;
            const valueId = `fanSpeedVal_${device.id}`;
            const apply = `manager.setFanSpeed('${device.id}', document.getElementById('${sliderId}').value)`;

            return `
                <div class="device-quick fan-quick" aria-label="Fan quick controls">
                    <div class="device-quick-row">
                        <span class="device-quick-label">Speed</span>
                        <input id="${sliderId}" class="fan-speed" type="range" min="0" max="10" step="1" value="${initial}"
                               oninput="document.getElementById('${valueId}').textContent = this.value" />
                        <span id="${valueId}" class="device-quick-value">${initial}</span>
                        <button class="cmd-btn fan-apply" ${disabled}${disabledHint} onclick="${apply}">Apply</button>
                    </div>
                    <div class="device-quick-row fan-presets">
                        <button class="cmd-btn" ${disabled}${disabledHint} onclick="manager.setFanSpeed('${device.id}', 0)">0</button>
                        <button class="cmd-btn" ${disabled}${disabledHint} onclick="manager.setFanSpeed('${device.id}', 3)">3</button>
                        <button class="cmd-btn" ${disabled}${disabledHint} onclick="manager.setFanSpeed('${device.id}', 6)">6</button>
                        <button class="cmd-btn" ${disabled}${disabledHint} onclick="manager.setFanSpeed('${device.id}', 9)">9</button>
                    </div>
                </div>
            `;
        }

        return '';
    }

    renderDeviceMeta(device) {
        const lc = device.lastCommand || '—';
        const ls = device.lastStatus || '—';
        const lt = device.lastAt ? this.formatDateTime(device.lastAt) : '—';
        const statusClass = (ls || '').toLowerCase();

        // Helpful for generator boards that don't expose telemetry (no getKW/getAll):
        // show last setLoad we sent so users can confirm the action happened.
        let genExtra = '';
        try {
            const nameLower = String(device.name || '').toLowerCase();
            if (nameLower.includes('generator')) {
                const last = this.lastSetLoadByDeviceId.get(device.id);
                if (last && typeof last.valueKW === 'number' && Number.isFinite(last.valueKW) && last.at) {
                    genExtra = `
                        <div class="device-meta-row">
                            <span class="device-meta-label">Last setLoad</span>
                            <span class="device-meta-value">${last.valueKW} kW @ ${this.formatDateTime(last.at)}</span>
                        </div>
                    `;
                }
            }
        } catch {
            // ignore
        }
        return `
            <div class="device-meta">
                <div class="device-meta-row">
                    <span class="device-meta-label">Last</span>
                    <span class="device-meta-value">${lc}</span>
                </div>
                <div class="device-meta-row">
                    <span class="device-meta-label">Status</span>
                    <span class="device-meta-badge ${statusClass}">${ls}</span>
                </div>
                <div class="device-meta-row">
                    <span class="device-meta-label">Time</span>
                    <span class="device-meta-value">${lt}</span>
                </div>
                ${genExtra}
            </div>
        `;
    }
    
    getDeviceIcon(name) {
        const icons = {
            'generator': '🏭',
            'solartracker': '☀️',
            'windturbine': '🌬️',
            'houseload': '🏠',
            'fan': '🌀',
            'cvt': '⚙️'
        };
        
        for (const [key, icon] of Object.entries(icons)) {
            if (name.toLowerCase().includes(key)) {
                return icon;
            }
        }
        return '🔌';
    }
    
    updateUI() {
        if (this.debug) console.log('updateUI called, available devices:', this.availableDevices.size);
        
        const availableContainer = document.getElementById('availableDevices');
        const connectedContainer = document.getElementById('connectedDevices');
        
        if (!availableContainer || !connectedContainer) {
            console.error('Could not find UI container elements');
            return;
        }
        
        if (this.availableDevices.size === 0) {
            availableContainer.innerHTML = '<div class="empty-state">Click "Scan Devices" to add a Revidyne device</div>';
        } else {
            const cards = Array.from(this.availableDevices.values())
                .map(d => {
                    console.log('Creating device card:', d);
                    return this.createDeviceCard(d, 'available');
                })
                .join('');
            if (this.debug) console.log('generated HTML:', cards);
            availableContainer.innerHTML = cards;
        }
        
        if (this.connectedDevices.size === 0) {
            connectedContainer.innerHTML = '<div class="empty-state">Drag a device here to control it</div>';
        } else {
            connectedContainer.innerHTML = Array.from(this.connectedDevices.values())
                .map(d => this.createDeviceCard(d, 'connected'))
                .join('');
        }

        this.updateSummary();

        // Live metrics polling starts once there's at least one connected device
        if (this.connectedDevices.size > 0) {
            this.ensureMetricsPolling();
        } else {
            this.stopMetricsPolling();
        }
        this.renderMetrics();

        // command log (safe no-op if panel not present)
        this.renderCommandLog();

        // command library
        this.refreshCommandLibrary();

        // flow builder
        this.renderFlow();

        // connections diagram (optional section)
        try { this.renderConnections(); } catch {}
    }
}

// Global drag-and-drop helpers
let draggedDeviceId = null;

function drag(event) {
    draggedDeviceId = event.target.dataset.id;
    event.target.classList.add('dragging');
}

function allowDrop(event) {
    event.preventDefault();
    event.currentTarget.parentElement.classList.add('drag-over');
}

function drop(event, target) {
    event.preventDefault();
    event.currentTarget.parentElement.classList.remove('drag-over');
    
    if (draggedDeviceId) {
        manager.moveDevice(draggedDeviceId, target);
        draggedDeviceId = null;
    }
}

// Remove drag styles
document.addEventListener('dragend', () => {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('drag-over'));
    document.querySelectorAll('.device-card').forEach(c => c.classList.remove('dragging'));
});

// Close modal
function closeModal() {
    manager.closeModal();
}

// Initialize manager after DOM is ready
let manager;
document.addEventListener('DOMContentLoaded', () => {
    manager = new USBDeviceManager();
    // Ensure inline onclick handlers (Templates buttons) can always access the instance.
    window.manager = manager;
    // Also expose as a global variable for DevTools convenience.
    // (In some browsers, `window.manager` exists but `manager` is not a global identifier.)
    globalThis.manager = manager;
    console.log('Manager initialized');
});

// Robust UI wiring: event delegation for dynamically-added elements.
document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t) return;
    if (t && t.id === 'autoEstDemandToggleBtn') {
        if (!globalThis.manager) return;
        globalThis.manager.setAutoEstimateEnabled(!globalThis.manager.autoEstEnabled);
        globalThis.manager.updateAutoEstimateUI();
        globalThis.manager.showToast(globalThis.manager.autoEstEnabled ? 'Auto-estimate demand: ON' : 'Auto-estimate demand: OFF');
    }
});
