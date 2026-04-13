// src/mod_interaction_executor.js
//
// Macro execution engine for MOD-specific interactions.
//
// LLM generates a "macro" action containing a sequence of primitive steps.
// This module executes each step in order, providing a safe abstraction over
// raw mineflayer API calls.
//
// Supported primitives:
//   equip          { item: "create:wrench" }
//   goto           { x, y, z, tolerance? }
//   look_at        { x, y, z }
//   sneak          { value: true/false }
//   sprint         { value: true/false }
//   activate_block { x, y, z, face?: "top"|"bottom"|"north"|"south"|"east"|"west" }
//   activate_item  {}  (right-click / use held item in the air)
//   swing_arm      {}  (left-click animation)
//   attack_block   { x, y, z }  (single left-click on a block face, does NOT mine)
//   wait           { ms: 500 }
//   send_packet    { channel: "modname:channel", data: "hex_string" }
//   chat           { message: "text" }
//
// ── GUI interaction primitives (work with ANY open window) ───────────────────
//   click_slot     { slot, button?: 0|1|2, mode?: 0-6 }
//                  Click a slot in the current window.
//                  button 0 = left, 1 = right, 2 = middle.
//                  mode follows Minecraft's window action modes (0 = normal click).
//   transfer_slot  { slot }  Shift+click to quick-transfer an item.
//   drop_slot      { slot }  Drop an item from a slot (Q key equivalent).
//   close_window   {}        Close the currently open window.
//   read_window    {}        Emit a GUI_SNAPSHOT IPC message with the current
//                            window state (used by AgentManager for re-reading).
//
// send_packet sends a ServerboundCustomPayloadPacket, which is how most mods
// receive key-press events from the client (e.g. remote inventory access).
// The `data` field is an optional hex string of the packet body.

const Vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { buildSnapshot } = require('./gui_snapshot');

const FACE_VECTORS = {
    top:    new Vec3(0,  1, 0),
    bottom: new Vec3(0, -1, 0),
    north:  new Vec3(0,  0, -1),
    south:  new Vec3(0,  0, 1),
    east:   new Vec3(1,  0, 0),
    west:   new Vec3(-1, 0, 0),
};

/**
 * Execute a single macro step.
 * @param {object} bot - mineflayer bot instance
 * @param {object} step - { primitive, ...params }
 * @param {object} cancelToken - { cancelled: bool }
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
async function executeStep(bot, step, cancelToken) {
    if (!step || typeof step.primitive !== 'string') {
        return { ok: false, message: 'Step has no primitive field' };
    }
    if (cancelToken.cancelled) {
        return { ok: false, message: 'Cancelled' };
    }

    const p = step.primitive.toLowerCase();

    // ── equip ────────────────────────────────────────────────────────────────
    if (p === 'equip') {
        const itemName = String(step.item || '');
        const item = bot.inventory.items().find(i =>
            i.name === itemName ||
            i.name.endsWith(':' + itemName) ||
            i.name.includes(itemName)
        );
        if (!item) return { ok: false, message: `equip: item "${itemName}" not in inventory` };
        try {
            await bot.equip(item, 'hand');
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `equip: ${e.message}` };
        }
    }

    // ── goto ─────────────────────────────────────────────────────────────────
    if (p === 'goto') {
        const { x, y, z } = step;
        if (x === undefined || z === undefined) {
            return { ok: false, message: 'goto: requires x and z' };
        }
        const tol = Number(step.tolerance) || 3;
        const timeout = Number(step.timeout) || 30000;
        try {
            const goal = y !== undefined
                ? new goals.GoalNear(x, y, z, tol)
                : new goals.GoalNearXZ(x, z, tol);
            await Promise.race([
                bot.pathfinder.goto(goal),
                new Promise((_, rej) => setTimeout(() => rej(new Error('goto timeout')), timeout))
            ]);
            bot.pathfinder.setGoal(null);
            return { ok: true };
        } catch (e) {
            bot.pathfinder.setGoal(null);
            return { ok: false, message: `goto: ${e.message}` };
        }
    }

    // ── look_at ──────────────────────────────────────────────────────────────
    if (p === 'look_at') {
        const { x, y, z } = step;
        if (x === undefined || y === undefined || z === undefined) {
            return { ok: false, message: 'look_at: requires x, y, z' };
        }
        try {
            const target = new Vec3(Number(x), Number(y), Number(z));
            const dx = target.x - bot.entity.position.x;
            const dy = target.y - bot.entity.position.y - 1.6; // eye height ~1.6
            const dz = target.z - bot.entity.position.z;
            const yaw   = Math.atan2(-dx, -dz);
            const pitch = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
            await bot.look(yaw, pitch, true);
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `look_at: ${e.message}` };
        }
    }

    // ── sneak ────────────────────────────────────────────────────────────────
    if (p === 'sneak') {
        bot.setControlState('sneak', !!step.value);
        return { ok: true };
    }

    // ── sprint ───────────────────────────────────────────────────────────────
    if (p === 'sprint') {
        bot.setControlState('sprint', !!step.value);
        return { ok: true };
    }

    // ── activate_block ───────────────────────────────────────────────────────
    // Right-click on a block at (x, y, z).
    // Optional: face ("top", "bottom", "north", etc.)
    if (p === 'activate_block') {
        const { x, y, z } = step;
        if (x === undefined || y === undefined || z === undefined) {
            return { ok: false, message: 'activate_block: requires x, y, z' };
        }
        const block = bot.blockAt(new Vec3(Number(x), Number(y), Number(z)));
        if (!block) return { ok: false, message: `activate_block: no block at (${x},${y},${z})` };
        try {
            await bot.activateBlock(block, FACE_VECTORS[step.face] || null);
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `activate_block: ${e.message}` };
        }
    }

    // ── activate_item ────────────────────────────────────────────────────────
    if (p === 'activate_item') {
        try {
            bot.activateItem();
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `activate_item: ${e.message}` };
        }
    }

    // ── swing_arm ────────────────────────────────────────────────────────────
    if (p === 'swing_arm') {
        try {
            bot.swingArm();
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `swing_arm: ${e.message}` };
        }
    }

    // ── attack_block ─────────────────────────────────────────────────────────
    // Single left-click on a block face (start-break packet), without actually mining.
    if (p === 'attack_block') {
        const { x, y, z } = step;
        if (x === undefined || y === undefined || z === undefined) {
            return { ok: false, message: 'attack_block: requires x, y, z' };
        }
        const block = bot.blockAt(new Vec3(Number(x), Number(y), Number(z)));
        if (!block) return { ok: false, message: `attack_block: no block at (${x},${y},${z})` };
        try {
            // Send start_dig packet then immediately abort_dig
            bot._client.write('block_dig', {
                status: 0, // start
                location: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) },
                face: 1,   // top face
                cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5,
                insideBlock: false
            });
            await new Promise(r => setTimeout(r, 50));
            bot._client.write('block_dig', {
                status: 1, // abort
                location: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) },
                face: 1,
                cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5,
                insideBlock: false
            });
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `attack_block: ${e.message}` };
        }
    }

    // ── wait ─────────────────────────────────────────────────────────────────
    if (p === 'wait') {
        const ms = Math.min(Math.max(Number(step.ms) || 500, 0), 30000);
        await new Promise(r => setTimeout(r, ms));
        return { ok: true };
    }

    // ── send_packet ──────────────────────────────────────────────────────────
    // Sends a ServerboundCustomPayloadPacket (Forge channel message).
    // Used to trigger server-side MOD key events (e.g., remote storage access,
    // tool modes, etc.) when the MOD uses a custom IPC channel.
    //
    // channel: "modname:channel_name"  (must match Forge's registered channel)
    // data:    hex string or empty, e.g. "01 00 ff" or ""
    if (p === 'send_packet') {
        const channel = String(step.channel || '');
        if (!channel || !channel.includes(':')) {
            return { ok: false, message: 'send_packet: channel must be "modname:channel_name"' };
        }
        try {
            let dataBuf = Buffer.alloc(0);
            if (step.data) {
                const hexStr = String(step.data).replace(/\s+/g, '');
                if (hexStr.length % 2 !== 0) {
                    return { ok: false, message: 'send_packet: data hex string must have even length' };
                }
                dataBuf = Buffer.from(hexStr, 'hex');
            }
            bot._client.write('custom_payload', {
                channel,
                data: dataBuf,
            });
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `send_packet: ${e.message}` };
        }
    }

    // ── chat ─────────────────────────────────────────────────────────────────
    if (p === 'chat') {
        const msg = String(step.message || '');
        if (msg) bot.chat(msg);
        return { ok: true };
    }

    // ── click_slot ───────────────────────────────────────────────────────────
    // Click a slot in the currently open window.
    //   slot:   required — zero-based slot index from the GUI snapshot
    //   button: 0 (left, default) | 1 (right) | 2 (middle)
    //   mode:   Minecraft window click mode 0-6 (default 0 = normal click)
    if (p === 'click_slot') {
        const slot = Number(step.slot);
        if (!Number.isFinite(slot) || slot < 0) {
            return { ok: false, message: 'click_slot: requires a non-negative slot number' };
        }
        if (!bot.currentWindow) {
            return { ok: false, message: 'click_slot: no window is currently open' };
        }
        const button = Number.isFinite(Number(step.button)) ? Number(step.button) : 0;
        const mode   = Number.isFinite(Number(step.mode))   ? Number(step.mode)   : 0;
        try {
            await bot.clickWindow(slot, button, mode);
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `click_slot: ${e.message}` };
        }
    }

    // ── transfer_slot ────────────────────────────────────────────────────────
    // Shift+click a slot to quick-transfer the item to the other inventory region.
    //   slot: required — zero-based slot index
    if (p === 'transfer_slot') {
        const slot = Number(step.slot);
        if (!Number.isFinite(slot) || slot < 0) {
            return { ok: false, message: 'transfer_slot: requires a non-negative slot number' };
        }
        if (!bot.currentWindow) {
            return { ok: false, message: 'transfer_slot: no window is currently open' };
        }
        try {
            // mode 1 = shift+click
            await bot.clickWindow(slot, 0, 1);
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `transfer_slot: ${e.message}` };
        }
    }

    // ── drop_slot ────────────────────────────────────────────────────────────
    // Drop the item stack in the specified slot (Q-key equivalent).
    //   slot: required — zero-based slot index
    if (p === 'drop_slot') {
        const slot = Number(step.slot);
        if (!Number.isFinite(slot) || slot < 0) {
            return { ok: false, message: 'drop_slot: requires a non-negative slot number' };
        }
        if (!bot.currentWindow) {
            return { ok: false, message: 'drop_slot: no window is currently open' };
        }
        try {
            // mode 4 with button 1 = drop whole stack from slot
            await bot.clickWindow(slot, 1, 4);
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `drop_slot: ${e.message}` };
        }
    }

    // ── close_window ─────────────────────────────────────────────────────────
    // Close the currently open window.
    if (p === 'close_window') {
        try {
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow);
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, message: `close_window: ${e.message}` };
        }
    }

    // ── read_window ──────────────────────────────────────────────────────────
    // Emit a GUI_SNAPSHOT IPC message with the current window state.
    // The AgentManager reads this to re-query the LLM with updated slot data.
    if (p === 'read_window') {
        const snapshot = buildSnapshot(bot);
        if (!snapshot) {
            return { ok: false, message: 'read_window: no window is currently open' };
        }
        if (process.send) {
            process.send({ type: 'GUI_SNAPSHOT', data: snapshot });
        }
        return { ok: true, snapshot };
    }

    return { ok: false, message: `Unknown primitive: "${p}"` };
}

/**
 * Execute a full macro (array of steps) sequentially.
 * Stops on first error unless `continueOnError` is true.
 *
 * @param {object} bot
 * @param {Array}  steps - array of step objects
 * @param {object} cancelToken - shared { cancelled: bool }
 * @param {boolean} continueOnError
 * @returns {Promise<{ ok: boolean, stepsRun: number, errors: string[] }>}
 */
async function executeMacro(bot, steps, cancelToken, continueOnError = false) {
    if (!Array.isArray(steps) || steps.length === 0) {
        return { ok: false, stepsRun: 0, errors: ['No steps provided'] };
    }

    const errors = [];
    let stepsRun = 0;

    for (const step of steps) {
        if (cancelToken.cancelled) break;
        const result = await executeStep(bot, step, cancelToken);
        stepsRun++;
        if (!result.ok) {
            const msg = result.message || 'Step failed';
            errors.push(`Step ${stepsRun} (${step.primitive || '?'}): ${msg}`);
            console.warn(`[ModMacro] Step failed: ${msg}`);
            if (!continueOnError) break;
        }
    }

    const ok = errors.length === 0;
    return { ok, stepsRun, errors };
}

module.exports = { executeMacro, executeStep, FACE_VECTORS };
