'use strict';
// debug_ws_server.js — WebSocket debug broadcast server (port 3001 by default).
// Must not crash the main bot system if the port is already in use.

const { WebSocketServer } = require('ws');

let _wss = null;
let _started = false;

/**
 * Start the debug WebSocket server.
 * @param {number} [port=3001]
 */
function start(port = 3001) {
    if (_started) return;
    _started = true;

    try {
        _wss = new WebSocketServer({ port });

        _wss.on('listening', () => {
            process.stderr.write(`[DebugWS] Debug WebSocket server listening on ws://localhost:${port}\n`);
        });

        _wss.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                process.stderr.write(`[DebugWS] WARNING: port ${port} already in use — debug WS disabled.\n`);
                _wss = null;
            } else {
                process.stderr.write(`[DebugWS] Server error: ${err.message}\n`);
            }
        });

        _wss.on('connection', (ws) => {
            process.stderr.write('[DebugWS] Client connected.\n');
            ws.on('error', () => {}); // silence per-socket errors
        });
    } catch (err) {
        process.stderr.write(`[DebugWS] Failed to start: ${err.message}\n`);
        _wss = null;
    }
}

/**
 * Broadcast a message to all connected clients.
 * @param {string} type
 * @param {Object} data
 */
function broadcast(type, data) {
    if (!_wss) return;
    const payload = JSON.stringify({ type, data, ts: Date.now() });
    _wss.clients.forEach((client) => {
        try {
            if (client.readyState === 1 /* OPEN */) {
                client.send(payload);
            }
        } catch (_) {
            // ignore send errors on individual clients
        }
    });
}

module.exports = { start, broadcast };
