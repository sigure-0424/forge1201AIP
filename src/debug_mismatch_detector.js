'use strict';
// debug_mismatch_detector.js — Compares the BOT's internal block mapping against
// a freshly read chunk_dump.json and returns blocks where they differ.
//
// chunk_dump.json format (written by dump_chunks action):
//   { "blockName": [ {x, y, z}, ... ], ... }

const fs   = require('fs');
const path = require('path');

const DEFAULT_DUMP_PATH = path.join(process.cwd(), 'chunk_dump.json');

/**
 * Compare the bot's internal block state against server truth from a dump file.
 *
 * @param {object} bot            Mineflayer bot instance
 * @param {string} [chunkDumpPath]  Path to chunk_dump.json
 * @returns {Promise<Array<{x:number,y:number,z:number,botStateId:number,botName:string,realName:string}>>}
 */
async function detectMismatches(bot, chunkDumpPath = DEFAULT_DUMP_PATH) {
    // Vec3 may not be available in standalone mode; require lazily
    const Vec3 = require('vec3');

    const raw = fs.readFileSync(chunkDumpPath, 'utf8');
    const dump = JSON.parse(raw);

    const mismatches = [];

    for (const [realName, positions] of Object.entries(dump)) {
        if (!Array.isArray(positions)) continue;
        for (const pos of positions) {
            if (pos == null || !Number.isFinite(pos.x)) continue;
            try {
                const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
                if (!block) continue;
                const botName = block.name || '';
                if (botName !== realName) {
                    mismatches.push({
                        x: pos.x,
                        y: pos.y,
                        z: pos.z,
                        botStateId: block.stateId || block.type || 0,
                        botName,
                        realName
                    });
                }
            } catch (_) {
                // blockAt can throw on unloaded chunks — skip silently
            }
        }
    }

    return mismatches;
}

module.exports = { detectMismatches };

// ── CLI entry point ────────────────────────────────────────────────────────────
if (require.main === module) {
    const dumpPath = process.argv[2] || DEFAULT_DUMP_PATH;

    // In standalone mode there is no live bot; print the dump entries as-is
    // so the user can at least inspect the file.
    try {
        const raw  = fs.readFileSync(dumpPath, 'utf8');
        const dump = JSON.parse(raw);
        let count = 0;
        for (const [name, positions] of Object.entries(dump)) {
            if (!Array.isArray(positions)) continue;
            for (const pos of positions) {
                process.stdout.write(JSON.stringify({ realName: name, ...pos }) + '\n');
                count++;
            }
        }
        process.stderr.write(`[mismatch-detector] Printed ${count} entries from ${dumpPath}. ` +
            'Run against a live bot to detect actual mismatches.\n');
    } catch (err) {
        process.stderr.write(`[mismatch-detector] Error: ${err.message}\n`);
        process.exit(1);
    }
}
