// src/actuator/utils.js
// Pure utility functions and block-spatial helpers used across actuator modules.
// Uses ctx singleton for bot access; withTimeout is a standalone pure function.

'use strict';

const Vec3 = require('vec3');
const ctx  = require('./ctx');

// ── Async timeout wrapper ────────────────────────────────────────────────────

/**
 * Races a promise against a timeout.  On timeout, calls cancelFn (if provided)
 * and rejects with a descriptive error.
 */
function withTimeout(promise, ms, actionName, cancelFn) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            if (cancelFn) cancelFn();
            reject(new Error(`Timeout exceeded for action: ${actionName} (${ms}ms)`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// ── Block classification helpers ─────────────────────────────────────────────

function isAirLikeBlock(b) {
    if (!b) return true;
    return b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
}

function isSolidBridgeSupport(b) {
    if (!b) return false;
    return b.boundingBox === 'block' && !b.name.includes('water') && !b.name.includes('lava');
}

// ── Terrain-safety helpers ───────────────────────────────────────────────────

/**
 * Returns false if lava, fire, magma, or a >3-block cliff lies within 3 steps
 * in angleRad direction.
 * Convention: angleRad = atan2(rdz, rdx) where cos(a)=dX, sin(a)=dZ.
 */
function isSafeForward(angleRad) {
    const bot = ctx.bot;
    try {
        const pos = bot.entity.position;
        const fdx = Math.cos(angleRad), fdz = Math.sin(angleRad);
        for (let step = 1; step <= 3; step++) {
            const bx = Math.floor(pos.x + step * fdx);
            const bz = Math.floor(pos.z + step * fdz);
            const by = Math.floor(pos.y);
            for (let dy = 0; dy <= 1; dy++) {
                const b = bot.blockAt(new Vec3(bx, by + dy, bz));
                if (b && (b.name.includes('lava') || b.name.includes('fire') || b.name === 'magma_block')) return false;
            }
            let hasGround = false;
            for (let dy = -1; dy >= -3; dy--) {
                const b = bot.blockAt(new Vec3(bx, by + dy, bz));
                if (b && b.boundingBox === 'block' && !b.name.includes('lava')) { hasGround = true; break; }
            }
            if (!hasGround) return false;
        }
        return true;
    } catch (_) { return false; }
}

function hasForwardGap(angleRad) {
    const bot = ctx.bot;
    try {
        const pos = bot.entity.position;
        const bx = Math.floor(pos.x + Math.cos(angleRad));
        const bz = Math.floor(pos.z + Math.sin(angleRad));
        const by = Math.floor(pos.y);
        const below1 = bot.blockAt(new Vec3(bx, by - 1, bz));
        const below2 = bot.blockAt(new Vec3(bx, by - 2, bz));
        return isAirLikeBlock(below1) && isAirLikeBlock(below2);
    } catch (_) {
        return false;
    }
}

/** Broader bridge trigger for edge cases where ground shape confuses hasForwardGap(). */
function hasLikelyBridgeNeed(angleRad) {
    const bot = ctx.bot;
    try {
        const pos = bot.entity.position;
        const by = Math.floor(pos.y);
        const ux = Math.cos(angleRad);
        const uz = Math.sin(angleRad);
        for (let step = 1; step <= 2; step++) {
            const bx = Math.floor(pos.x + step * ux);
            const bz = Math.floor(pos.z + step * uz);
            const foot   = bot.blockAt(new Vec3(bx, by,     bz));
            const below1 = bot.blockAt(new Vec3(bx, by - 1, bz));
            const below2 = bot.blockAt(new Vec3(bx, by - 2, bz));
            const below3 = bot.blockAt(new Vec3(bx, by - 3, bz));
            const noFooting = isAirLikeBlock(foot) && isAirLikeBlock(below1) && isAirLikeBlock(below2);
            const deepDrop  = isAirLikeBlock(below1) && isAirLikeBlock(below2) && isAirLikeBlock(below3);
            if (noFooting || deepDrop) return true;
        }
    } catch (_) {}
    return false;
}

// ── Bridge block selection ───────────────────────────────────────────────────

function chooseBridgeBlock(preferredName) {
    const bot = ctx.bot;
    const preferredNeedle = (preferredName || '').toLowerCase().trim();
    const items = bot.inventory.items();
    if (!items || items.length === 0) return null;

    const blockKeyFromItemName = (rawName) => {
        const n = (rawName || '').toLowerCase();
        if (!n) return null;
        if (bot.registry.blocksByName[n]) return n;
        const short = n.includes(':') ? n.split(':').pop() : n;
        if (short && bot.registry.blocksByName[short]) return short;
        return null;
    };

    const isClearlyNonPlaceable = (name) => {
        const n = (name || '').toLowerCase();
        if (!n) return true;
        if (n.includes('sword') || n.includes('pickaxe') || n.includes('axe') ||
            n.includes('shovel') || n.includes('hoe') || n.includes('helmet') ||
            n.includes('chestplate') || n.includes('leggings') || n.includes('boots') ||
            n.includes('elytra') || n.includes('jetpack') || n.includes('bow') || n.includes('crossbow') ||
            n.includes('trident') || n.includes('arrow') || n.includes('bucket') ||
            n.includes('boat') || n.includes('minecart') || n.includes('food') ||
            n.includes('potion') || n.includes('torch') || n.includes('rail')) {
            return true;
        }
        return false;
    };

    const isGoodBridgeBlock = (item) => {
        const name = (item?.name || '').toLowerCase();
        if (!name) return false;
        if (isClearlyNonPlaceable(name)) return false;
        const hasBlockMapping = !!blockKeyFromItemName(name);
        if (name.includes('slab') || name.includes('stair') || name.includes('wall') ||
            name.includes('fence') || name.includes('door') || name.includes('trapdoor') ||
            name.includes('pane') || name.includes('torch') || name.includes('carpet') ||
            name.includes('button') || name.includes('pressure_plate') || name.includes('rail') ||
            name.includes('bucket') || name.includes('bed') || name.includes('boat')) {
            return false;
        }
        return hasBlockMapping || name.includes(':');
    };

    if (preferredNeedle) {
        const preferred = items
            .filter(isGoodBridgeBlock)
            .filter(i => i.name.toLowerCase().includes(preferredNeedle))
            .sort((a, b) => b.count - a.count)[0];
        if (preferred) return preferred;
    }

    const candidates = items
        .filter(isGoodBridgeBlock)
        .sort((a, b) => b.count - a.count);

    if (candidates.length > 0) return candidates[0];

    const fallback = items
        .filter(i => !isClearlyNonPlaceable(i?.name))
        .sort((a, b) => b.count - a.count)[0] || null;

    if (!fallback) {
        const snapshot = items
            .slice(0, 12)
            .map(i => {
                const n = i?.name || 'unknown';
                return `${n}x${i?.count || 0}[blk:${blockKeyFromItemName(n) ? 'Y' : 'N'}]`;
            })
            .join(', ');
        console.log(`[Actuator] chooseBridgeBlock: no candidate found. Inventory snapshot: ${snapshot}`);
    }

    return fallback;
}

module.exports = {
    withTimeout,
    isAirLikeBlock,
    isSolidBridgeSupport,
    isSafeForward,
    hasForwardGap,
    hasLikelyBridgeNeed,
    chooseBridgeBlock,
};
