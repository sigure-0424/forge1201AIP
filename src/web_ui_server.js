// web_ui_server.js — local dashboard for the Forge AI Player System
'use strict';
const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const path     = require('path');
const fs       = require('fs');

class WebUIServer {
    constructor(agentManager, connectionDefaults = {}) {
        this.manager  = agentManager;
        this.defaults = connectionDefaults; // { host, port, mode }

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

        // GET /api/bots — list all bots with latest status
        this.app.get('/api/bots', (req, res) => {
            const bots = [];
            // Active bots
            for (const [id] of m.bots.entries()) {
                bots.push(this._botSummary(id, true));
            }
            res.json(bots);
        });

        // POST /api/bots — add a new bot
        this.app.post('/api/bots', (req, res) => {
            const { name, host, port } = req.body || {};
            if (!name) return res.status(400).json({ error: 'name required' });
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
            const { ollamaUrl, ollamaModel, ollamaApiKey } = req.body || {};
            if (ollamaUrl)   process.env.OLLAMA_URL   = ollamaUrl;
            if (ollamaModel) {
                process.env.OLLAMA_MODEL = ollamaModel;
                m.llm.model = ollamaModel;
            }
            if (ollamaApiKey) process.env.OLLAMA_API_KEY = ollamaApiKey;
            res.json({ ok: true });
        });

        // GET /api/waypoints
        this.app.get('/api/waypoints', (req, res) => {
            try {
                const wp = path.join(process.cwd(), 'data', 'waypoints.json');
                res.json(fs.existsSync(wp) ? JSON.parse(fs.readFileSync(wp, 'utf8')) : []);
            } catch (e) { res.json([]); }
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
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────

    _setupWebSocket() {
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);

            // Send initial snapshot of all bots + their chat logs
            const snapshot = {
                type: 'init',
                bots: [],
                logs: {}
            };
            for (const [id] of this.manager.bots.entries()) {
                snapshot.bots.push(this._botSummary(id, true));
                snapshot.logs[id] = this.manager.chatLog.get(id) || [];
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
        this.server.listen(port, '127.0.0.1', () => {
            console.log(`[WebUI] Dashboard available at http://localhost:${port}`);
        });
        this.server.on('error', (e) => {
            console.error(`[WebUI] Server error: ${e.message}`);
        });
    }
}

module.exports = WebUIServer;
