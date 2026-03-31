// web_ui_server.js — local dashboard for the Forge AI Player System
'use strict';
const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const path     = require('path');
const fs       = require('fs');

class WebUIServer {
    constructor(agentManager, connectionDefaults = {}, sentryReporter = null) {
        this.manager  = agentManager;
        this.defaults = connectionDefaults; // { host, port, mode }
        this.sentry   = sentryReporter;    // optional sentry_reporter module

        this.app    = express();
        this.server = http.createServer(this.app);
        this.wss    = new WebSocket.Server({ server: this.server });
        this.clients = new Set();

        this._setupMiddleware();
        this._setupRoutes();
        this._setupWebSocket();

        // Wire into AgentManager event hook
        agentManager.onEvent = (event) => this._broadcast(event);
    }

    // ─── Middleware ───────────────────────────────────────────────────────────

    _setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, '../public')));
    }

    // ─── REST API ─────────────────────────────────────────────────────────────

    _setupRoutes() {
        const m = this.manager;

        // GET /api/bots — list all bots with latest status (includes restarting bots as offline)
        this.app.get('/api/bots', (req, res) => {
            const bots = [];
            const seen = new Set();
            for (const [id] of m.bots.entries()) {
                seen.add(id);
                bots.push(this._botSummary(id, true));
            }
            // Also include known bots that are restarting (in botConnOptions but not yet spawned)
            for (const [id] of m.botConnOptions.entries()) {
                if (!seen.has(id)) bots.push(this._botSummary(id, false));
            }
            res.json(bots);
        });

        // POST /api/bots — add a new bot
        this.app.post('/api/bots', (req, res) => {
            const { name, host, port } = req.body || {};
            if (!name) return res.status(400).json({ error: 'name required' });
            if (!/^[a-zA-Z0-9_]{1,32}$/.test(name)) return res.status(400).json({ error: 'Invalid bot name. Must be 1-32 alphanumeric characters or underscores.' });
            if (m.bots.has(name)) return res.status(409).json({ error: 'Bot already running' });
            const h = host || this.defaults.host || 'localhost';
            const p = parseInt(port || this.defaults.port || 25565);
            const mode = this.defaults.mode || 'full_auto';
            m.startBot(name, { host: h, port: p, mode });
            res.json({ ok: true, botId: name });
        });

        // DELETE /api/bots/:id — remove a bot
        this.app.delete('/api/bots/:id', (req, res) => {
            const { id } = req.params;
            const proc = m.bots.get(id);
            if (!proc) return res.status(404).json({ error: 'Bot not found' });
            // Clear connection options first so handleProcessCrash won't auto-restart this bot
            m.botConnOptions.delete(id);
            proc.kill('SIGINT');
            res.json({ ok: true });
        });

        // POST /api/bots/:id/restart — restart a bot
        this.app.post('/api/bots/:id/restart', (req, res) => {
            const { id } = req.params;
            if (!m.bots.has(id) && !m.botConnOptions.has(id)) {
                return res.status(404).json({ error: 'Bot not found' });
            }
            m.scheduleRestart(id);
            res.json({ ok: true });
        });

        // POST /api/bots/:id/chat — send an instruction to a bot (no - prefix needed)
        this.app.post('/api/bots/:id/chat', (req, res) => {
            const { id } = req.params;
            const { message } = req.body || {};
            if (!message) return res.status(400).json({ error: 'message required' });

            // Enrich environment from latest status
            const env = m.botStatus.get(id) || {};
            m.handleIPCMessage(id, {
                type: 'USER_CHAT',
                data: { username: 'WebUI', message, async: false, environment: env }
            });
            res.json({ ok: true });
        });

        // GET /api/bots/:id/log — return stored chat history
        this.app.get('/api/bots/:id/log', (req, res) => {
            const { id } = req.params;
            res.json(m.chatLog.get(id) || []);
        });

        // GET /api/config — current LLM + server config
        this.app.get('/api/config', (req, res) => {
            res.json({
                host:        this.defaults.host  || process.env.MC_HOST  || 'localhost',
                port:        this.defaults.port  || process.env.MC_PORT  || '25565',
                ollamaUrl:   process.env.OLLAMA_URL   || '',
                ollamaModel: process.env.OLLAMA_MODEL || 'gpt-oss:20b-cloud',
                ollamaApiKey: process.env.OLLAMA_API_KEY ? '••••••••' : '',
            });
        });

        // PUT /api/config — update LLM settings (in-process; does not rewrite .env)
        this.app.put('/api/config', (req, res) => {
            const allowedKeys = ['OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_API_KEY', 'OLLAMA_AUTH_SCHEME', 'WEBUI_PORT'];
            const keys = Object.keys(req.body || {});

            for (const key of keys) {
                if (!allowedKeys.includes(key)) {
                    return res.status(400).json({ error: `Invalid configuration key: ${key}` });
                }
            }

            // --- SSRF Protection for OLLAMA_URL ---
            if (req.body?.OLLAMA_URL) {
                try {
                    const url = new URL(req.body.OLLAMA_URL);
                    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                        return res.status(400).json({ error: 'Invalid OLLAMA_URL: protocol must be http or https' });
                    }

                    const host = url.hostname.toLowerCase();

                    // --- SSRF Protection Logic ---
                    // 1. Block Cloud Metadata Services (AWS, GCP, Azure, etc.)
                    const isMetadata =
                        host === '169.254.169.254' ||
                        host === '[fd00:ec2::254]' ||
                        host.includes('metadata.google.internal') ||
                        host.includes('instance-data') ||
                        host.includes('169.254'); // Covers 169.254.0.0/16 Link-local range

                    if (isMetadata) {
                        return res.status(400).json({ error: 'Invalid OLLAMA_URL: access to cloud metadata service is restricted' });
                    }

                    // 2. Block sensitive internal names and patterns
                    const isRestrictedInternal =
                        host === 'kubernetes.default.svc' ||
                        (host.endsWith('.internal') && !host.includes('ollama')); // Allow if user has ollama.internal

                    if (isRestrictedInternal) {
                        return res.status(400).json({ error: 'Invalid OLLAMA_URL: access to internal service is restricted' });
                    }

                } catch (e) {
                    return res.status(400).json({ error: 'Invalid OLLAMA_URL: must be a valid URL' });
                }
            }

            if (req.body?.OLLAMA_URL) {
                process.env.OLLAMA_URL = req.body.OLLAMA_URL;
                m.llm.url = req.body.OLLAMA_URL;
            }
            if (req.body?.OLLAMA_MODEL) {
                process.env.OLLAMA_MODEL = req.body.OLLAMA_MODEL;
                m.llm.model = req.body.OLLAMA_MODEL;
            }
            if (req.body?.OLLAMA_API_KEY) process.env.OLLAMA_API_KEY = req.body.OLLAMA_API_KEY;
            if (req.body?.OLLAMA_AUTH_SCHEME) process.env.OLLAMA_AUTH_SCHEME = req.body.OLLAMA_AUTH_SCHEME;
            if (req.body?.WEBUI_PORT) {
                const port = parseInt(req.body.WEBUI_PORT);
                if (isNaN(port) || port < 1 || port > 65535) {
                    return res.status(400).json({ error: 'Invalid WEBUI_PORT: must be a number between 1 and 65535' });
                }
                process.env.WEBUI_PORT = req.body.WEBUI_PORT;
            }

            res.json({ ok: true });
        });

        // GET /api/waypoints
        this.app.get('/api/waypoints', (req, res) => {
            try {
                const wp = path.join(process.cwd(), 'data', 'waypoints.json');
                res.json(fs.existsSync(wp) ? JSON.parse(fs.readFileSync(wp, 'utf8')) : []);
            } catch (e) { res.json([]); }
        });

        // ─── Safe Zones API (Change 3) ────────────────────────────────────────

        const SAFE_ZONES_FILE = path.join(process.cwd(), 'data', 'safezones.json');

        function _loadSafeZonesWeb() {
            try {
                if (!fs.existsSync(SAFE_ZONES_FILE)) return [];
                return JSON.parse(fs.readFileSync(SAFE_ZONES_FILE, 'utf8'));
            } catch(e) { return []; }
        }

        function _saveSafeZonesWeb(zones) {
            try {
                const dir = path.dirname(SAFE_ZONES_FILE);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(SAFE_ZONES_FILE, JSON.stringify(zones, null, 2));
            } catch(e) {}
        }

        // GET /api/safezones — return all safe zones
        this.app.get('/api/safezones', (req, res) => {
            res.json(_loadSafeZonesWeb());
        });

        // POST /api/safezones — add a safe zone
        this.app.post('/api/safezones', (req, res) => {
            const { name, minX, minY, minZ, maxX, maxY, maxZ, dimension } = req.body || {};
            if (!name) return res.status(400).json({ error: 'name required' });
            if (minX === undefined || minY === undefined || minZ === undefined ||
                maxX === undefined || maxY === undefined || maxZ === undefined) {
                return res.status(400).json({ error: 'minX, minY, minZ, maxX, maxY, maxZ required' });
            }
            const zones = _loadSafeZonesWeb();
            if (zones.some(z => z.name === name)) {
                return res.status(409).json({ error: `Safe zone '${name}' already exists` });
            }
            zones.push({ name, minX: Number(minX), minY: Number(minY), minZ: Number(minZ),
                         maxX: Number(maxX), maxY: Number(maxY), maxZ: Number(maxZ),
                         dimension: dimension || null });
            _saveSafeZonesWeb(zones);
            res.json({ ok: true, name });
        });

        // DELETE /api/safezones/:name — remove a safe zone by name
        this.app.delete('/api/safezones/:name', (req, res) => {
            const { name } = req.params;
            let zones = _loadSafeZonesWeb();
            const before = zones.length;
            zones = zones.filter(z => z.name !== name);
            if (zones.length === before) return res.status(404).json({ error: `Safe zone '${name}' not found` });
            _saveSafeZonesWeb(zones);
            res.json({ ok: true });
        });

        // DELETE /api/waypoints/:name
        this.app.delete('/api/waypoints/:name', (req, res) => {
            try {
                const wp = path.join(process.cwd(), 'data', 'waypoints.json');
                let wps = fs.existsSync(wp) ? JSON.parse(fs.readFileSync(wp, 'utf8')) : [];
                wps = wps.filter(w => w.name !== req.params.name);
                fs.writeFileSync(wp, JSON.stringify(wps, null, 2));
                res.json({ ok: true });
            } catch (e) { res.status(500).json({ error: e.message }); }
        });

        // POST /api/bots/bulk — spawn N bots with auto-generated AI_Bot_XX names
        this.app.post('/api/bots/bulk', (req, res) => {
            let count = parseInt(req.body?.count || 1, 10);
            if (!count || count < 1) return res.status(400).json({ error: 'count must be at least 1' });
            count = Math.min(count, 10);

            const h    = req.body?.host || this.defaults.host || 'localhost';
            const p    = parseInt(req.body?.port || this.defaults.port || 25565);
            const mode = this.defaults.mode || 'full_auto';

            const botIds = this._nextBotNames(count);
            for (const id of botIds) m.startBot(id, { host: h, port: p, mode }); // m is captured at top of _setupRoutes
            res.json({ ok: true, botIds });
        });

        // GET /api/crash-prefs — return current Sentry consent prefs
        this.app.get('/api/crash-prefs', (req, res) => {
            const prefs = this.sentry ? this.sentry.getPrefs() : { opted: null, dontAskAgain: false };
            res.json({ ...prefs, needsConsent: this.sentry ? this.sentry.needsConsent() : false });
        });

        // PUT /api/crash-prefs — save consent and (re)initialise Sentry if opted in
        this.app.put('/api/crash-prefs', (req, res) => {
            if (!this.sentry) return res.status(503).json({ error: 'crash reporting not available' });
            const { opted, dontAskAgain } = req.body || {};
            this.sentry.savePrefs({ opted, dontAskAgain: !!dontAskAgain });
            if (opted === 'yes') this.sentry.initSentry(process.env.SENTRY_DSN);
            res.json({ ok: true });
        });

        // POST /api/entity_updates — receive entity tracking data from the aux mod
        this.app.post('/api/entity_updates', (req, res) => {
            if (req.body) {
                this._broadcast({
                    type: 'entity_update',
                    data: req.body
                });
            }
            res.json({ ok: true });
        });
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────

    _setupWebSocket() {
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);

            // Send initial snapshot of all bots + their chat logs
            // Includes bots currently restarting (in botConnOptions but not yet spawned) as offline
            const snapshot = {
                type: 'init',
                bots: [],
                logs: {}
            };
            const seen = new Set();
            for (const [id] of this.manager.bots.entries()) {
                seen.add(id);
                snapshot.bots.push(this._botSummary(id, true));
                snapshot.logs[id] = this.manager.chatLog.get(id) || [];
            }
            for (const [id] of this.manager.botConnOptions.entries()) {
                if (!seen.has(id)) {
                    snapshot.bots.push(this._botSummary(id, false));
                    snapshot.logs[id] = this.manager.chatLog.get(id) || [];
                }
            }
            ws.send(JSON.stringify(snapshot));

            ws.on('close', () => this.clients.delete(ws));
            ws.on('error', () => this.clients.delete(ws));

            // Accept chat messages over WebSocket as well
            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw);
                    if (msg.type === 'chat' && msg.botId && msg.message) {
                        const env = this.manager.botStatus.get(msg.botId) || {};
                        this.manager.handleIPCMessage(msg.botId, {
                            type: 'USER_CHAT',
                            data: { username: 'WebUI', message: msg.message, async: false, environment: env }
                        });
                    }
                } catch (e) { /* ignore malformed */ }
            });
        });
    }

    _broadcast(event) {
        const payload = JSON.stringify(event);
        for (const ws of this.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(payload); } catch (e) {}
            }
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /** Generate `count` new AI_Bot_XX names that don't clash with running bots. */
    _nextBotNames(count) {
        const used = new Set(this.manager.bots.keys());
        let max = 0;
        for (const id of used) {
            const m = id.match(/^AI_Bot_(\d+)$/);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        }
        const names = [];
        let n = max + 1;
        while (names.length < count) {
            const candidate = `AI_Bot_${String(n).padStart(2, '0')}`;
            if (!used.has(candidate)) names.push(candidate);
            n++;
        }
        return names;
    }

    _botSummary(id, online) {
        const status = this.manager.botStatus.get(id) || {};
        return {
            id,
            online: !!online,
            mode:   this.manager.botModes.get(id) || 'normal',
            ...status
        };
    }

    // ─── Start ────────────────────────────────────────────────────────────────

    start(port = 3000) {
        this.server.listen(port, () => {
            console.log(`[WebUI] Dashboard available at http://localhost:${port}`);
        });
        this.server.on('error', (e) => {
            console.error(`[WebUI] Server error: ${e.message}`);
        });
    }
}

module.exports = WebUIServer;
