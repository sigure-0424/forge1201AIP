// src/gui_snapshot.js
//
// Converts a Mineflayer bot's currently open window (bot.currentWindow) into
// a structured, LLM-readable text snapshot.  No extra dependencies — uses only
// the unified slot API that Mineflayer exposes for *every* window type,
// including completely unknown MOD GUIs.
//
// Output format example
// ─────────────────────
// window_type: "minecraft:crafting"
// title: "Crafting"
// slots (46):
//   [0]  output: empty
//   [1]  grid_0: minecraft:oak_planks x4
//   [2]  grid_1: empty
//   ...
//   [36] player_inv_0: minecraft:stone x64
//   ...
//   [45] player_hotbar_8: minecraft:wooden_pickaxe x1  {Damage:12}
//
// Usage
// ─────
//   const { buildSnapshot, buildGuiPrompt } = require('./gui_snapshot');
//   const snapshot = buildSnapshot(bot);
//   const promptText = buildGuiPrompt(snapshot, 'put coal into the fuel slot');

'use strict';

// ── Known window type → readable name ────────────────────────────────────────
const WINDOW_TYPE_NAMES = {
    'minecraft:generic_9x1': 'Chest (1 row)',
    'minecraft:generic_9x2': 'Chest (2 rows)',
    'minecraft:generic_9x3': 'Chest (3 rows)',
    'minecraft:generic_9x4': 'Large chest (4 rows)',
    'minecraft:generic_9x5': 'Large chest (5 rows)',
    'minecraft:generic_9x6': 'Large chest (6 rows)',
    'minecraft:generic_3x3': '3×3 Dispenser/Dropper',
    'minecraft:crafting':    'Crafting Table',
    'minecraft:furnace':     'Furnace',
    'minecraft:blast_furnace': 'Blast Furnace',
    'minecraft:smoker':      'Smoker',
    'minecraft:enchantment': 'Enchanting Table',
    'minecraft:brewing_stand': 'Brewing Stand',
    'minecraft:beacon':      'Beacon',
    'minecraft:anvil':       'Anvil',
    'minecraft:hopper':      'Hopper',
    'minecraft:shulker_box': 'Shulker Box',
    'minecraft:barrel':      'Barrel',
    'minecraft:grindstone':  'Grindstone',
    'minecraft:cartography_table': 'Cartography Table',
    'minecraft:stonecutter': 'Stonecutter',
    'minecraft:loom':        'Loom',
    'minecraft:smithing':    'Smithing Table',
};

// Returns a human-readable label for a window type string.
function windowTypeName(type) {
    if (!type) return 'Unknown';
    if (WINDOW_TYPE_NAMES[type]) return WINDOW_TYPE_NAMES[type];
    // MOD GUI: strip namespace prefix for readability if present
    const bare = type.includes(':') ? type : `(id ${type})`;
    return `MOD GUI ${bare}`;
}

// ── NBT summary helpers ───────────────────────────────────────────────────────

/**
 * Walk a prismarine-nbt compound value and collect human-readable key=value
 * pairs for the most useful tags (display name, enchantments, damage, etc.).
 *
 * @param {object} nbtValue - The `.value` of a prismarine-nbt compound tag
 * @returns {string[]}  Array of "key:value" strings
 */
function summariseNbt(nbtValue) {
    if (!nbtValue || typeof nbtValue !== 'object') return [];
    const parts = [];

    // Custom display name
    if (nbtValue.display?.value?.Name?.value) {
        try {
            const raw = nbtValue.display.value.Name.value;
            const parsed = JSON.parse(raw);
            const name = String(parsed.text || parsed.translate || raw)
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"');
            parts.push(`name:"${name}"`);
        } catch (_) {
            const safe = String(nbtValue.display.value.Name.value)
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"');
            parts.push(`name:"${safe}"`);
        }
    }

    // Damage
    if (nbtValue.Damage?.value !== undefined) {
        parts.push(`Damage:${nbtValue.Damage.value}`);
    }

    // Enchantments
    const enchList = nbtValue.Enchantments?.value?.value
        ?? nbtValue.StoredEnchantments?.value?.value;
    if (Array.isArray(enchList) && enchList.length > 0) {
        const enchStr = enchList
            .slice(0, 5)
            .map(e => {
                const id  = e?.value?.id?.value  ?? e?.id?.value  ?? '?';
                const lvl = e?.value?.lvl?.value ?? e?.lvl?.value ?? '?';
                return `${id}:${lvl}`;
            })
            .join(',');
        parts.push(`ench:[${enchStr}]`);
    }

    // Potion type
    if (nbtValue.Potion?.value) {
        parts.push(`potion:${nbtValue.Potion.value}`);
    }

    // Energy / stored charge (common in tech mods)
    for (const key of ['Energy', 'StoredEnergy', 'FE', 'RF']) {
        if (nbtValue[key]?.value !== undefined) {
            parts.push(`${key}:${nbtValue[key].value}`);
        }
    }

    return parts;
}

/**
 * Build a short NBT annotation string for an item stack.
 * Returns empty string if there is nothing interesting.
 *
 * @param {object} item - mineflayer Item object
 * @returns {string}  e.g. "{Damage:12,ench:[sharpness:3]}" or ""
 */
function itemNbtAnnotation(item) {
    if (!item || !item.nbt) return '';
    try {
        const compound = item.nbt.value ?? item.nbt;
        const parts = summariseNbt(compound);
        return parts.length ? `  {${parts.join(', ')}}` : '';
    } catch (_) {
        return '';
    }
}

// ── Slot role labelling ───────────────────────────────────────────────────────

/**
 * Return a descriptive role string for a slot index, given the window type and
 * total slot count.  This helps the LLM understand *what* a slot is for without
 * any MOD-specific knowledge.
 *
 * @param {number} idx - zero-based slot index
 * @param {string} windowType
 * @param {number} totalSlots
 * @returns {string}
 */
function slotRole(idx, windowType, totalSlots) {
    const playerSlots = 36; // 27 main + 9 hotbar
    const containerSlots = totalSlots - playerSlots;

    // Player inventory always occupies the last 36 slots
    if (idx >= containerSlots) {
        const playerIdx = idx - containerSlots;
        if (playerIdx < 27) return `player_inv_${playerIdx}`;
        return `player_hotbar_${playerIdx - 27}`;
    }

    // Container-specific roles for common vanilla windows
    const t = windowType || '';

    if (t === 'minecraft:furnace' || t === 'minecraft:blast_furnace' || t === 'minecraft:smoker') {
        if (idx === 0) return 'input';
        if (idx === 1) return 'fuel';
        if (idx === 2) return 'output';
    }

    if (t === 'minecraft:brewing_stand') {
        if (idx === 0) return 'ingredient';
        if (idx >= 1 && idx <= 3) return `bottle_${idx - 1}`;
        if (idx === 4) return 'blaze_powder';
    }

    if (t === 'minecraft:crafting') {
        if (idx === 0) return 'output';
        if (idx >= 1 && idx <= 9) return `grid_${idx - 1}`;
    }

    if (t === 'minecraft:enchantment') {
        if (idx === 0) return 'item';
        if (idx === 1) return 'lapis';
    }

    if (t === 'minecraft:anvil' || t === 'minecraft:grindstone') {
        if (idx === 0) return 'input_0';
        if (idx === 1) return 'input_1';
        if (idx === 2) return 'output';
    }

    if (t === 'minecraft:stonecutter' || t === 'minecraft:loom' || t === 'minecraft:cartography_table') {
        if (idx === 0) return 'input_0';
        if (idx === 1) return 'input_1';
        if (idx === 2) return 'output';
    }

    if (t === 'minecraft:smithing') {
        if (idx === 0) return 'template';
        if (idx === 1) return 'base';
        if (idx === 2) return 'addition';
        if (idx === 3) return 'output';
    }

    if (t === 'minecraft:beacon') {
        if (idx === 0) return 'payment';
    }

    if (t === 'minecraft:hopper') {
        return `hopper_${idx}`;
    }

    // Generic chest / barrel / shulker / unknown MOD
    if (containerSlots > 0) {
        return `container_${idx}`;
    }

    return `slot_${idx}`;
}

// ── Main export: buildSnapshot ────────────────────────────────────────────────

/**
 * Build a snapshot object from the bot's current window.
 *
 * @param {object} bot - mineflayer bot instance
 * @returns {object|null}  snapshot or null if no window is open
 */
function buildSnapshot(bot) {
    const win = bot && bot.currentWindow;
    if (!win) return null;

    const windowType  = win.type  ?? win.id ?? 'unknown';
    const windowTitle = (typeof win.title === 'string')
        ? win.title
        : (win.title?.toString?.() ?? 'unknown');
    const slots       = Array.isArray(win.slots) ? win.slots : [];
    const totalSlots  = slots.length;

    const slotData = slots.map((item, idx) => {
        const role = slotRole(idx, windowType, totalSlots);
        if (!item || item.type === 0 || item.name === 'air') {
            return { idx, role, empty: true };
        }
        return {
            idx,
            role,
            empty:    false,
            name:     item.name,
            count:    item.count,
            nbtNote:  itemNbtAnnotation(item),
        };
    });

    return {
        windowType,
        windowTitle,
        windowTypeName: windowTypeName(windowType),
        totalSlots,
        slots: slotData,
    };
}

// ── Main export: snapshotToText ───────────────────────────────────────────────

/**
 * Convert a snapshot object (from buildSnapshot) into a plain-text string
 * suitable for embedding in an LLM prompt.
 *
 * @param {object} snapshot - from buildSnapshot()
 * @returns {string}
 */
function snapshotToText(snapshot) {
    if (!snapshot) return '(no window open)';

    const lines = [];
    lines.push(`window_type: "${snapshot.windowType}"  (${snapshot.windowTypeName})`);
    lines.push(`title: "${snapshot.windowTitle}"`);
    lines.push(`slots (${snapshot.totalSlots}):`);

    for (const s of snapshot.slots) {
        if (s.empty) {
            lines.push(`  [${s.idx}]  ${s.role}: empty`);
        } else {
            lines.push(`  [${s.idx}]  ${s.role}: ${s.name} x${s.count}${s.nbtNote}`);
        }
    }

    return lines.join('\n');
}

// ── Main export: buildGuiPrompt ───────────────────────────────────────────────

/**
 * Build the full prompt segment to send to the LLM when a GUI is open.
 * Returns a self-contained string containing the snapshot plus instructions.
 *
 * @param {object} snapshot  - from buildSnapshot()
 * @param {string} instruction - the user's natural-language intent
 * @returns {string}
 */
function buildGuiPrompt(snapshot, instruction) {
    const snapshotText = snapshotToText(snapshot);
    return `\n━━━ OPEN GUI ━━━
${snapshotText}

User instruction: "${instruction}"

Based on the GUI snapshot above, output a JSON array of primitive steps to perform the instruction.
Available GUI primitives:
  {"primitive":"click_slot",    "slot":<n>, "button":0, "mode":0}  -- left-click slot
  {"primitive":"click_slot",    "slot":<n>, "button":1, "mode":0}  -- right-click slot
  {"primitive":"transfer_slot", "slot":<n>}                         -- shift+click to quick-transfer
  {"primitive":"drop_slot",     "slot":<n>}                         -- drop item (Q key equivalent)
  {"primitive":"close_window"}                                       -- close GUI
  {"primitive":"read_window"}                                        -- re-read window state

Use slot numbers (idx) from the snapshot above.  The [n] at the start of each slot line is its index.
Close the window after completing the task unless further interaction is needed.

Example — move item from slot 0 to player inventory:
[{"primitive":"transfer_slot","slot":0},{"primitive":"close_window"}]
━━━ END GUI ━━━
`;
}

module.exports = { buildSnapshot, snapshotToText, buildGuiPrompt, windowTypeName, slotRole };
