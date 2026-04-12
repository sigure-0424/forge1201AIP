// src/actuator/environment.js
// Environment sensing and persistent data helpers extracted from bot_actuator.js.
// All functions access bot state via the ctx singleton.

'use strict';

const fs   = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const ctx  = require('./ctx');

// ── File paths (mirrored from ctx for internal use) ──────────────────────────
const WAYPOINTS_FILE       = ctx.WAYPOINTS_FILE;
const PATH_CACHE_FILE      = ctx.PATH_CACHE_FILE;
const BLACKBOARD_FILE      = ctx.BLACKBOARD_FILE;
const SAFE_ZONES_FILE      = ctx.SAFE_ZONES_FILE;
const QUEUE_CHECKPOINT_FILE= ctx.QUEUE_CHECKPOINT_FILE;
const JUNK_LIST_FILE       = ctx.JUNK_LIST_FILE;

const PATH_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

// ── Structure name normalisation ─────────────────────────────────────────────

const STRUCTURE_NAMES = {
    'fortress': 'fortress', 'nether_fortress': 'fortress',
    'nether fortress': 'fortress', 'netherfortress': 'fortress',
    'stronghold': 'stronghold',
    'mansion': 'mansion', 'woodland_mansion': 'mansion',
    'woodland mansion': 'mansion',
    'village': 'village',
    'monument': 'monument', 'ocean_monument': 'monument',
    'ocean monument': 'monument',
    'desert_pyramid': 'desert_pyramid', 'desert_temple': 'desert_pyramid',
    'desert pyramid': 'desert_pyramid', 'desert temple': 'desert_pyramid',
    'jungle_pyramid': 'jungle_temple', 'jungle_temple': 'jungle_temple',
    'jungle pyramid': 'jungle_temple', 'jungle temple': 'jungle_temple',
    'ruined_portal': 'ruined_portal', 'ruined portal': 'ruined_portal',
    'shipwreck': 'shipwreck',
    'pillager_outpost': 'pillager_outpost', 'pillager outpost': 'pillager_outpost',
    'bastion_remnant': 'bastion_remnant', 'bastion remnant': 'bastion_remnant',
    'end_city': 'end_city', 'end city': 'end_city', 'endcity': 'end_city',
    'igloo': 'igloo',
    'swamp_hut': 'swamp_hut', 'swamp hut': 'swamp_hut',
    'ocean_ruin': 'ocean_ruin', 'ocean ruin': 'ocean_ruin',
    'buried_treasure': 'buried_treasure', 'buried treasure': 'buried_treasure',
    'ancient_city': 'ancient_city', 'ancient city': 'ancient_city',
    'trail_ruins': 'trail_ruins', 'trail ruins': 'trail_ruins',
};

function normalizeStructureTarget(target) {
    return String(target || '')
        .toLowerCase()
        .replace(/^minecraft:/, '')
        .replace(/[\s-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .trim();
}

// ── /locate result listener ──────────────────────────────────────────────────

async function waitForLocateResult(timeoutMs = 12000) {
    const bot = ctx.bot;
    return await new Promise((resolve) => {
        const done = (result) => {
            clearTimeout(timeout);
            bot.removeListener('messagestr', onMessageStr);
            bot.removeListener('message', onMessageJson);
            resolve(result);
        };
        const tryExtract = (text) => {
            const msg = String(text || '');
            const xz = msg.match(/\[X:\s*(-?\d+)[^\]]*Z:\s*(-?\d+)\]/i)
                || msg.match(/x\s*[:=]\s*(-?\d+).{0,40}z\s*[:=]\s*(-?\d+)/i);
            if (xz) return { x: parseInt(xz[1], 10), z: parseInt(xz[2], 10) };
            if (/could not find|not find|no structure|cannot locate/i.test(msg)) return { error: msg };
            return null;
        };
        const onMessageStr  = (message)  => { const found = tryExtract(message); if (found) done(found); };
        const onMessageJson = (jsonMsg)  => {
            const text = typeof jsonMsg?.toString === 'function' ? jsonMsg.toString() : '';
            const found = tryExtract(text);
            if (found) done(found);
        };
        const timeout = setTimeout(() => done(null), timeoutMs);
        bot.on('messagestr', onMessageStr);
        bot.on('message',    onMessageJson);
    });
}

// ── Waypoints ────────────────────────────────────────────────────────────────

function loadWaypoints() {
    try {
        if (fs.existsSync(WAYPOINTS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(WAYPOINTS_FILE, 'utf8'));
            if (!Array.isArray(raw)) return [];
            return raw.filter(w => {
                if (!w || !w.name || w.x === undefined || w.y === undefined || w.z === undefined || !w.dimension) {
                    console.warn(`[Actuator] Dropped invalid waypoint entry: ${JSON.stringify(w)}`);
                    return false;
                }
                return true;
            });
        }
    } catch (e) {}
    return [];
}

/**
 * Atomically persists waypoints: write to .tmp then rename.
 * This prevents file corruption when multiple bots write concurrently.
 */
function saveWaypoints(waypoints) {
    try {
        const dir = path.dirname(WAYPOINTS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = WAYPOINTS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(waypoints, null, 2));
        fs.renameSync(tmp, WAYPOINTS_FILE);
    } catch (e) {
        console.error(`[Actuator] Failed to save waypoints: ${e.message}`);
    }
}

function findWaypoint(name) {
    const waypoints = loadWaypoints();
    return waypoints.find(w => w.name.toLowerCase() === name.toLowerCase()) || null;
}

// ── Path cache ───────────────────────────────────────────────────────────────

function loadPathCache() {
    try {
        if (fs.existsSync(PATH_CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(PATH_CACHE_FILE, 'utf8'));
        }
    } catch (e) {}
    return {};
}

function savePathCache(cache) {
    try {
        const dir = path.dirname(PATH_CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PATH_CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.error(`[Actuator] Failed to save path cache: ${e.message}`);
    }
}

/** Quantise to 16-block grid so nearby destinations get a cache hit. */
function getPathCacheKey(destX, destZ, dimension) {
    return `${dimension || 'overworld'}:${Math.round(destX / 16) * 16}:${Math.round(destZ / 16) * 16}`;
}

// ── Blackboard ───────────────────────────────────────────────────────────────

function _readBlackboard() {
    try {
        if (!fs.existsSync(BLACKBOARD_FILE)) return {};
        return JSON.parse(fs.readFileSync(BLACKBOARD_FILE, 'utf8'));
    } catch (e) { return {}; }
}

function _writeBlackboard(data) {
    try {
        const dir = path.dirname(BLACKBOARD_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(BLACKBOARD_FILE, JSON.stringify(data, null, 2));
    } catch (e) {}
}

// ── Safe zones ───────────────────────────────────────────────────────────────

function _loadSafeZones() {
    try {
        if (!fs.existsSync(SAFE_ZONES_FILE)) return [];
        return JSON.parse(fs.readFileSync(SAFE_ZONES_FILE, 'utf8'));
    } catch (e) { return []; }
}

function _isInSafeZone(pos, dimension) {
    try {
        const zones = _loadSafeZones();
        for (const zone of zones) {
            if (zone.dimension && zone.dimension !== dimension) continue;
            if (pos.x >= zone.minX && pos.x <= zone.maxX &&
                pos.y >= zone.minY && pos.y <= zone.maxY &&
                pos.z >= zone.minZ && pos.z <= zone.maxZ) {
                return true;
            }
        }
    } catch (e) {}
    return false;
}

// ── Queue checkpoint ─────────────────────────────────────────────────────────

function _saveQueueCheckpoint(queue) {
    const NON_RESUMABLE = ctx.NON_RESUMABLE_ACTIONS;
    try {
        const resumable = queue.filter(a => a && a.action && !NON_RESUMABLE.has(a.action));
        if (resumable.length === 0) {
            if (fs.existsSync(QUEUE_CHECKPOINT_FILE)) fs.unlinkSync(QUEUE_CHECKPOINT_FILE);
            return;
        }
        const dir = path.dirname(QUEUE_CHECKPOINT_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(QUEUE_CHECKPOINT_FILE, JSON.stringify(
            { savedAt: new Date().toISOString(), queue: resumable }, null, 2
        ));
    } catch (e) { /* non-fatal */ }
}

function _loadQueueCheckpoint() {
    try {
        if (!fs.existsSync(QUEUE_CHECKPOINT_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(QUEUE_CHECKPOINT_FILE, 'utf8'));
        const age = Date.now() - new Date(raw.savedAt).getTime();
        if (age > 10 * 60 * 1000) {
            fs.unlinkSync(QUEUE_CHECKPOINT_FILE);
            return null;
        }
        return Array.isArray(raw.queue) && raw.queue.length > 0 ? raw.queue : null;
    } catch (e) { return null; }
}

function _clearQueueCheckpoint() {
    try {
        if (fs.existsSync(QUEUE_CHECKPOINT_FILE)) fs.unlinkSync(QUEUE_CHECKPOINT_FILE);
    } catch (e) {}
}

// ── Boat auto-selection ──────────────────────────────────────────────────────

/**
 * Returns true if the straight-line path to (destX, destZ) crosses >20 consecutive
 * water blocks, the destination is >40 blocks away, and not in End/Nether.
 */
function _shouldUseBoat(destX, destZ) {
    const bot = ctx.bot;
    try {
        if (!bot.entity) return false;
        const dim = bot.game?.dimension || 'overworld';
        if (dim === 'the_nether' || dim === 'minecraft:the_nether' ||
            dim === 'the_end'    || dim === 'minecraft:the_end') return false;
        const cx = bot.entity.position.x, cz = bot.entity.position.z;
        const dx = destX - cx, dz = destZ - cz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= 40) return false;
        const steps = Math.floor(dist / 4);
        if (steps === 0) return false;
        let consecutive = 0, maxConsecutive = 0;
        const waterBlockId = bot.registry.blocksByName['water']?.id;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const sx = cx + dx * t, sz = cz + dz * t;
            const bAt    = bot.blockAt(new Vec3(Math.floor(sx), Math.floor(bot.entity.position.y),     Math.floor(sz)));
            const bBelow = bot.blockAt(new Vec3(Math.floor(sx), Math.floor(bot.entity.position.y) - 1, Math.floor(sz)));
            const isWater = (b) => b && (b.name === 'water' || b.name === 'flowing_water' ||
                                          (waterBlockId !== undefined && b.type === waterBlockId));
            if (isWater(bAt) || isWater(bBelow)) {
                consecutive++;
                if (consecutive > maxConsecutive) maxConsecutive = consecutive;
            } else {
                consecutive = 0;
            }
        }
        return maxConsecutive > 20;
    } catch (e) { return false; }
}

// ── Junk list ────────────────────────────────────────────────────────────────

const DEFAULT_JUNK_LIST_ENV = [
    'granite', 'diorite', 'andesite', 'tuff', 'calcite',
    'dirt', 'gravel', 'netherrack', 'rotten_flesh',
    'poisonous_potato', 'ink_sac'
];

function _loadJunkList() {
    try {
        if (fs.existsSync(JUNK_LIST_FILE)) {
            ctx.junkList = new Set(JSON.parse(fs.readFileSync(JUNK_LIST_FILE, 'utf8')));
        } else {
            ctx.junkList = new Set(DEFAULT_JUNK_LIST_ENV);
            _saveJunkList();
        }
    } catch (e) { ctx.junkList = new Set(DEFAULT_JUNK_LIST_ENV); }
}

function _saveJunkList() {
    try {
        const dir = path.dirname(JUNK_LIST_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(JUNK_LIST_FILE, JSON.stringify([...ctx.junkList], null, 2));
    } catch (e) {}
}

async function _runAutoShredder() {
    const bot = ctx.bot;
    if (!bot.inventory) return;
    const items = bot.inventory.items();
    const usedSlots = new Set(items.filter(i => i.slot >= 9 && i.slot <= 44).map(i => i.slot)).size;
    if (usedSlots < 32) return;
    for (const item of items) {
        if (ctx.junkList.has(item.name) && item.slot >= 9) {
            try {
                await bot.toss(item.type, null, item.count);
                console.log(`[AutoShredder] Discarded ${item.count}x ${item.name}`);
            } catch (e) {}
        }
    }
}

// ── Environment context ──────────────────────────────────────────────────────

function getEnvironmentContext() {
    const bot = ctx.bot;
    const nearbyBlocks = [];
    if (bot.entity) {
        const interactiveNames = [
            'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel',
            'anvil', 'enchanting_table', 'brewing_stand', 'end_portal', 'end_portal_frame', 'nether_portal'
        ];
        const interactiveIds = new Set();
        for (const name of interactiveNames) {
            const id = bot.registry.blocksByName[name]?.id;
            if (id !== undefined) interactiveIds.add(id);
        }
        const isInteractive = b => b && (interactiveIds.has(b.type) || b.name.endsWith('_bed'));
        const foundInteractive = bot.findBlocks({ matching: isInteractive, maxDistance: 16, count: 24 });
        const addedInteractive = new Set();
        for (const pos of foundInteractive) {
            const b = bot.blockAt(pos);
            if (b && !addedInteractive.has(b.name)) {
                nearbyBlocks.push(b.name);
                addedInteractive.add(b.name);
            }
        }

        try {
            const pos = bot.entity.position.floored();
            const counts = {};
            for (let dx = -8; dx <= 8; dx++) {
                for (let dy = -8; dy <= 8; dy++) {
                    for (let dz = -8; dz <= 8; dz++) {
                        const b = bot.blockAt(pos.offset(dx, dy, dz));
                        if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
                            counts[b.name] = (counts[b.name] || 0) + 1;
                        }
                    }
                }
            }
            const sortedBlocks = Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([name, count]) => `${count}x ${name}`);
            if (sortedBlocks.length > 0) nearbyBlocks.push(...sortedBlocks);
        } catch (e) {}
    }

    const nearbyStructures = [];
    if (bot.entity) {
        const structureMarkers = [
            { name: 'nether_fortress', blocks: ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs'] },
            { name: 'stronghold',      blocks: ['end_portal_frame', 'mossy_stone_bricks'] },
            { name: 'ocean_monument',  blocks: ['prismarine', 'sea_lantern'] },
        ];
        const markerIdToStruct = new Map();
        for (const { name, blocks } of structureMarkers) {
            for (const blockName of blocks) {
                const id = bot.registry.blocksByName[blockName]?.id;
                if (id !== undefined) markerIdToStruct.set(id, name);
            }
        }
        const isMarker = b => b && markerIdToStruct.has(b.type);
        const foundMarkers = bot.findBlocks({ matching: isMarker, maxDistance: 24, count: 20 });
        const addedStructures = new Set();
        for (const pos of foundMarkers) {
            const b = bot.blockAt(pos);
            if (b) {
                const structName = markerIdToStruct.get(b.type);
                if (structName && !addedStructures.has(structName)) {
                    nearbyStructures.push(structName);
                    addedStructures.add(structName);
                }
            }
        }
    }

    const nearbyEntities = [];
    if (bot.entity && bot.entities) {
        for (const ent of Object.values(bot.entities)) {
            if (ent === bot.entity || !ent.isValid) continue;
            if (bot.entity.position.distanceTo(ent.position) <= 128) {
                const name = (ent.name || ent.displayName || ent.username || '').toLowerCase();
                if (name && name !== 'item' && name !== 'experience_orb') nearbyEntities.push(name);
            }
        }
    }
    const entityCounts = nearbyEntities.reduce((acc, name) => {
        acc[name] = (acc[name] || 0) + 1;
        return acc;
    }, {});
    const entitySummary = Object.entries(entityCounts).map(([name, count]) => `${count}x ${name}`);

    const inventoryItems = bot.inventory ? bot.inventory.items() : [];
    return {
        position: bot.entity ? {
            x: Math.round(bot.entity.position.x),
            y: Math.round(bot.entity.position.y),
            z: Math.round(bot.entity.position.z)
        } : null,
        dimension:      bot.game?.dimension || null,
        health:         bot.health ? Math.round(bot.health) : null,
        food:           bot.food   ? Math.round(bot.food)   : null,
        players_nearby: Object.keys(bot.players).filter(p => p !== bot.username && bot.players[p].entity),
        inventory:      inventoryItems.map(item => ({ name: item.name, count: item.count })),
        has_pickaxe:    inventoryItems.some(i => i.name.endsWith('_pickaxe')),
        has_axe:        inventoryItems.some(i => i.name.endsWith('_axe')),
        has_sword:      inventoryItems.some(i => i.name.endsWith('_sword')),
        nearby_blocks:     nearbyBlocks,
        nearby_structures: nearbyStructures,
        nearby_entities:   entitySummary,
        blackboard:        _readBlackboard(),
    };
}

module.exports = {
    STRUCTURE_NAMES,
    normalizeStructureTarget,
    waitForLocateResult,
    loadWaypoints,
    saveWaypoints,
    findWaypoint,
    loadPathCache,
    savePathCache,
    getPathCacheKey,
    PATH_CACHE_MAX_AGE_MS,
    _readBlackboard,
    _writeBlackboard,
    _loadSafeZones,
    _isInSafeZone,
    _saveQueueCheckpoint,
    _loadQueueCheckpoint,
    _clearQueueCheckpoint,
    _shouldUseBoat,
    _loadJunkList,
    _saveJunkList,
    _runAutoShredder,
    getEnvironmentContext,
};
