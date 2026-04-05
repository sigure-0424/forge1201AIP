'use strict';
// debug_trace_logger.js — Appends one JSON line per event to debug_trace.jsonl.
// Rotates the file to debug_trace.jsonl.bak when it exceeds 10 MB.

const fs   = require('fs');
const path = require('path');

const TRACE_FILE = path.join(process.cwd(), 'debug_trace.jsonl');
const BAK_FILE   = path.join(process.cwd(), 'debug_trace.jsonl.bak');
const MAX_BYTES  = 10 * 1024 * 1024; // 10 MB

function _rotate() {
    try {
        const stat = fs.statSync(TRACE_FILE);
        if (stat.size >= MAX_BYTES) {
            fs.renameSync(TRACE_FILE, BAK_FILE);
        }
    } catch (_) {
        // file may not exist yet — that's fine
    }
}

/**
 * Append a trace event line.
 * @param {string} botId
 * @param {string} event  'start' | 'complete' | 'fail' | 'stuck'
 * @param {string} actionName
 * @param {{x:number,y:number,z:number}|null} position
 * @param {Object} extra
 */
function logEvent(botId, event, actionName, position, extra = {}) {
    try {
        _rotate();
        const pos = position
            ? [Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)]
            : null;
        const line = JSON.stringify({
            ts: Date.now(),
            botId,
            event,
            action: actionName,
            pos,
            extra
        }) + '\n';
        fs.appendFileSync(TRACE_FILE, line);
    } catch (e) {
        // never crash the bot over logging
    }
}

/**
 * Append a status snapshot (called from agent_manager on BOT_STATUS messages).
 * @param {string} botId
 * @param {Object} statusPayload
 */
function logStatus(botId, statusPayload) {
    try {
        _rotate();
        const line = JSON.stringify({
            ts: Date.now(),
            botId,
            event: 'status',
            payload: statusPayload
        }) + '\n';
        fs.appendFileSync(TRACE_FILE, line);
    } catch (e) {
        // never crash the bot over logging
    }
}

module.exports = { logEvent, logStatus };
