'use strict';
// obs_connector.js — Optional OBS WebSocket integration.
// Silently skips initialisation when OBS_WS_URL is not set.
// Uses obs-websocket-js v5 API.

let _obs = null;
let _connected = false;

/**
 * Connect to OBS WebSocket.
 * Env vars: OBS_WS_URL (default ws://localhost:4455), OBS_WS_PASSWORD
 */
async function connect() {
    const url = process.env.OBS_WS_URL;
    if (!url) {
        // OBS integration disabled — skip silently
        return;
    }

    try {
        const { default: OBSWebSocket } = require('obs-websocket-js');
        _obs = new OBSWebSocket();

        _obs.on('ConnectionClosed', () => {
            _connected = false;
        });

        await _obs.connect(url, process.env.OBS_WS_PASSWORD || undefined);
        _connected = true;
        process.stderr.write('[OBS] Connected to OBS WebSocket.\n');
    } catch (err) {
        process.stderr.write(`[OBS] Connection failed (non-fatal): ${err.message}\n`);
        _obs = null;
        _connected = false;
    }
}

/**
 * Start OBS recording if not already recording.
 */
async function startRecordIfNotRecording() {
    if (!_obs || !_connected) return;
    try {
        const { outputActive } = await _obs.call('GetRecordStatus');
        if (!outputActive) {
            await _obs.call('StartRecord');
            process.stderr.write('[OBS] Recording started.\n');
        }
    } catch (err) {
        process.stderr.write(`[OBS] startRecord failed: ${err.message}\n`);
    }
}

/**
 * Stop OBS recording.
 */
async function stopRecord() {
    if (!_obs || !_connected) return;
    try {
        const { outputActive } = await _obs.call('GetRecordStatus');
        if (outputActive) {
            await _obs.call('StopRecord');
            process.stderr.write('[OBS] Recording stopped.\n');
        }
    } catch (err) {
        process.stderr.write(`[OBS] stopRecord failed: ${err.message}\n`);
    }
}

/**
 * Returns true if currently connected to OBS.
 */
function isConnected() {
    return _connected;
}

module.exports = { connect, startRecordIfNotRecording, stopRecord, isConnected };
