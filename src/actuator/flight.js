// src/actuator/flight.js
// Jetpack & elytra flight helpers, bridge placement.
// All functions use ctx singleton for shared bot state.

'use strict';

const Vec3 = require('vec3');
const ctx  = require('./ctx');
const { withTimeout, isSolidBridgeSupport, chooseBridgeBlock, hasForwardGap, hasLikelyBridgeNeed, isSafeForward } = require('./utils');
const { getEnvironmentContext } = require('./environment');

// ── Jetpack mod registry ──────────────────────────────────────────────────────
const JETPACK_MOD_REGISTRY = {
    // Category A: passive ──────────────────────────────────────────────────────
    simplyjetpacks2:  { itemPattern: /jetpack/i, activateMethod: 'none', fuelType: 'nbt_fe',   fuelNbtPath: ['Energy'], fuelNbtMaxPath: ['MaxEnergy'] },
    simplerjetpacks2: { itemPattern: /jetpack/i, activateMethod: 'none', fuelType: 'nbt_fe',   fuelNbtPath: ['Energy'], fuelNbtMaxPath: ['MaxEnergy'] },
    create_jetpack:   { itemPattern: /jetpack/i, activateMethod: 'none', fuelType: 'durability' },
    create_sa:        { itemPattern: /jetpack_chestplate/i, activateMethod: 'none', fuelType: 'durability' },
    jetpacks:         { itemPattern: /jetpack/i, activateMethod: 'none', fuelType: 'nbt_fe' },
    pneumaticcraft:   { itemPattern: /pneumatic_chestplate|jetpack/i, activateMethod: 'none', fuelType: 'nbt_fe', fuelNbtPath: ['Air'], fuelNbtMaxPath: ['MaxAir'] },
    mekanism:         { itemPattern: /mekasuit_bodyarmor|jetpack/i, activateMethod: 'none', fuelType: 'nbt_fe' },
    powah:            { itemPattern: /jetpack/i, activateMethod: 'none', fuelType: 'nbt_fe' },
    biggerreactors:   { itemPattern: /jetpack/i, activateMethod: 'none', fuelType: 'nbt_fe' },
    extremereactors:  { itemPattern: /jetpack/i, activateMethod: 'none', fuelType: 'nbt_fe' },
    ironjetpacks:     { itemPattern: /jetpack/i, activateMethod: 'none', fuelType: 'nbt_fe' },
    // Category B: right-click toggle ──────────────────────────────────────────
    thermal:          { itemPattern: /jetpack/i, activateMethod: 'right_click', fuelType: 'nbt_fe' },
    thermalinnovation:{ itemPattern: /jetpack/i, activateMethod: 'right_click', fuelType: 'nbt_fe' },
    enderio:          { itemPattern: /jetpack/i, activateMethod: 'right_click', fuelType: 'nbt_fe' },
    ic2:              { itemPattern: /jetpack/i, activateMethod: 'right_click', fuelType: 'durability' },
    ic2classic:       { itemPattern: /jetpack/i, activateMethod: 'right_click', fuelType: 'durability' },
    galacticraftcore: { itemPattern: /jetpack/i, activateMethod: 'right_click', fuelType: 'durability' },
    advancedrocketry: { itemPattern: /jetpack/i, activateMethod: 'right_click', fuelType: 'durability' },
    // Category C: hover mode ───────────────────────────────────────────────────
    powersuits:       { itemPattern: /powersuit/i, activateMethod: 'none', fuelType: 'nbt_fe', hoverMode: true },
    // Generic fallback ─────────────────────────────────────────────────────────
    _generic:         { itemPattern: /jetpack/i, activateMethod: 'auto', fuelType: 'auto' },
};

// ── Aviation method detection ─────────────────────────────────────────────────

function detectAviationMethod(torsoItem) {
    if (!torsoItem) return null;
    if (torsoItem.name === 'elytra') return 'elytra';
    const rawName  = torsoItem.name || '';
    const colonIdx = rawName.indexOf(':');
    const namespace = colonIdx >= 0 ? rawName.slice(0, colonIdx) : null;
    const localName = colonIdx >= 0 ? rawName.slice(colonIdx + 1) : rawName;
    const cfg = namespace ? JETPACK_MOD_REGISTRY[namespace] : null;
    if (cfg && cfg.itemPattern.test(localName)) return { type: 'jetpack', mod: namespace, config: cfg };
    if (JETPACK_MOD_REGISTRY._generic.itemPattern.test(localName)) {
        return { type: 'jetpack', mod: namespace || 'unknown', config: JETPACK_MOD_REGISTRY._generic };
    }
    return null;
}

// ── Server flying-flag helper ─────────────────────────────────────────────────

function _setServerFlyingFlag(flying) {
    const bot = ctx.bot;
    try {
        const flags = flying ? 0x06 : 0x00;
        bot._client.write('abilities', { flags, flyingSpeed: flying ? 0.05 : 0.0, walkingSpeed: 0.1 });
        if (bot.entity && bot.entity.abilities) {
            bot.entity.abilities.flying     = flying;
            bot.entity.abilities.allowFlight = flying;
        }
    } catch (_) {}
}

// ── Jetpack fuel reader ───────────────────────────────────────────────────────

function getJetpackFuelRatio(torsoItem, config) {
    if (!torsoItem) return 0;
    const fuelType = config.fuelType || 'auto';
    if (fuelType === 'none') return 1.0;

    function _nbtGet(obj, keyPath) {
        let cur = obj;
        for (const key of keyPath) {
            if (cur === null || cur === undefined) return undefined;
            if (typeof cur === 'object' && 'value' in cur && typeof cur.value === 'object') cur = cur.value;
            cur = cur[key];
        }
        if (cur !== null && cur !== undefined && typeof cur === 'object' && 'value' in cur) cur = cur.value;
        return cur;
    }

    if (fuelType === 'nbt_fe' || fuelType === 'auto') {
        try {
            const nbtRoot = torsoItem.nbt;
            if (nbtRoot) {
                const root = (nbtRoot.value || nbtRoot);
                let energy = null, maxEnergy = null;
                if (config.fuelNbtPath)    energy    = _nbtGet(root, config.fuelNbtPath);
                if (config.fuelNbtMaxPath) maxEnergy = _nbtGet(root, config.fuelNbtMaxPath);
                if (energy === null || energy === undefined) {
                    for (const k of ['Energy', 'energy', 'Charge', 'RF', 'Air', 'Pressure']) {
                        const v = _nbtGet(root, [k]);
                        if (typeof v === 'number') { energy = v; break; }
                    }
                }
                if (maxEnergy === null || maxEnergy === undefined) {
                    for (const k of ['MaxEnergy', 'maxEnergy', 'MaxCharge', 'MaxRF', 'MaxAir', 'MaxPressure', 'Capacity', 'capacity']) {
                        const v = _nbtGet(root, [k]);
                        if (typeof v === 'number') { maxEnergy = v; break; }
                    }
                }
                if (typeof energy === 'number' && typeof maxEnergy === 'number' && maxEnergy > 0) {
                    return Math.max(0, Math.min(1, energy / maxEnergy));
                }
                if (typeof energy === 'number' && energy === 0) return 0;
            }
        } catch (_) {}
        if (fuelType === 'nbt_fe') {
            console.warn(`[Actuator] getJetpackFuelRatio: could not read NBT energy for ${torsoItem.name}; assuming 50%.`);
            return 0.5;
        }
    }

    const maxDur = torsoItem.maxDurability;
    if (!maxDur || maxDur <= 0) return 1.0;
    const damage = torsoItem.durabilityUsed || 0;
    return Math.max(0, Math.min(1, (maxDur - damage) / maxDur));
}

// ── Elytra gap cross ──────────────────────────────────────────────────────────

async function tryElytraGapCross(angleRad) {
    const bot = ctx.bot;
    try {
        const torso  = bot.inventory.slots[bot.getEquipmentDestSlot('torso')];
        if (!torso || torso.name !== 'elytra') return false;
        const rocket = bot.inventory.items().find(i => i.name === 'firework_rocket');
        if (!rocket) return false;

        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        try { await bot.equip(rocket, 'hand'); } catch (_) {}

        const tx = bot.entity.position.x + 18 * Math.cos(angleRad);
        const tz = bot.entity.position.z + 18 * Math.sin(angleRad);
        try { await bot.lookAt(new Vec3(tx, bot.entity.position.y + 2, tz), true); } catch (_) {}

        if (bot.entity.onGround) {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 220));
            bot.setControlState('jump', false);
            await new Promise(r => setTimeout(r, 120));
        }
        try {
            if (bot._client && bot.entity?.id !== undefined) {
                bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 8, jumpBoost: 0 });
            }
        } catch (_) {}

        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        try { bot.activateItem(); } catch (_) {}
        await new Promise(r => setTimeout(r, 900));
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        return true;
    } catch (_) {
        return false;
    }
}

// ── Bridge builder ────────────────────────────────────────────────────────────

async function tryBridgeForward(angleRad, preferredName, maxPlacements = 3) {
    const bot = ctx.bot;
    ctx.lastBridgeFailureReason = null;
    const bridgeBlock = chooseBridgeBlock(preferredName);
    if (!bridgeBlock) {
        ctx.lastBridgeFailureReason = 'no_block';
        bot.chat('[System Error] Cannot bridge: no placeable blocks in inventory.');
        return false;
    }

    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.setControlState('sneak', true);

    try { await bot.equip(bridgeBlock, 'hand'); } catch (_) {}

    const base = bot.entity.position;
    const by   = Math.floor(base.y);
    const ux   = Math.cos(angleRad);
    const uz   = Math.sin(angleRad);

    const dominantFace = () => {
        if (Math.abs(ux) >= Math.abs(uz)) return new Vec3(ux > 0 ? -1 : 1, 0, 0);
        return new Vec3(0, 0, uz > 0 ? -1 : 1);
    };
    const df = dominantFace();
    const backwardFaces = [
        df,
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1),
        new Vec3(0, 1, 0), new Vec3(0, -1, 0),
    ].filter((f, i, arr) => i === 0 || !(f.x === arr[0].x && f.y === arr[0].y && f.z === arr[0].z));

    let placedCount = 0;
    for (let step = 1; step <= maxPlacements; step++) {
        const tx     = Math.floor(base.x + step * ux);
        const tz     = Math.floor(base.z + step * uz);
        const target = new Vec3(tx, by - 1, tz);
        const existing = bot.blockAt(target);
        if (isSolidBridgeSupport(existing)) { placedCount++; continue; }

        let placed = false;
        for (const face of backwardFaces) {
            const refBlock = bot.blockAt(target.minus(face));
            if (!isSolidBridgeSupport(refBlock)) continue;
            try {
                await withTimeout(bot.placeBlock(refBlock, face), 3000, 'bridge place');
                placed = true;
                placedCount++;
                break;
            } catch (_) {}
        }
        if (!placed) break;
        await new Promise(r => setTimeout(r, 150));
    }

    bot.setControlState('sneak', false);
    if (placedCount > 0) return true;
    ctx.lastBridgeFailureReason = 'placement_failed';
    return false;
}

// ── Jetpack flight ────────────────────────────────────────────────────────────

async function flyWithJetpack(destX, destY, destZ, config, cancelToken) {
    const bot          = ctx.bot;
    const targetY      = destY !== null ? destY : bot.entity.position.y;
    const actMethod    = config.activateMethod || 'auto';
    const hoverMode    = !!config.hoverMode;
    const fuelLow      = config.fuelLow      ?? 0.20;
    const fuelCritical = config.fuelCritical ?? 0.05;

    const _torsoIdx = () => bot.getEquipmentDestSlot('torso');
    const _fuelNow  = () => getJetpackFuelRatio(bot.inventory.slots[_torsoIdx()], config);

    const preFuel = _fuelNow();
    if (preFuel <= fuelCritical) {
        const pct = Math.round(preFuel * 100);
        bot.chat(`[System Error] Jetpack fuel critically low (${pct}%) — refusing to fly.`);
        process.send({ type: 'USER_CHAT', data: {
            username: 'System',
            message: `Jetpack fuel is at ${pct}% (below ${Math.round(fuelCritical*100)}% critical). Refuel first.`,
            environment: getEnvironmentContext(),
        }});
        return;
    }
    if (preFuel <= fuelLow) {
        bot.chat(`[System] Warning: Jetpack fuel low (${Math.round(preFuel*100)}%). Proceeding with caution.`);
    }

    bot.chat(`[System] Jetpack engaging — heading to X:${Math.round(destX)} Y:${Math.round(targetY)} Z:${Math.round(destZ)}.`);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    _setServerFlyingFlag(true);
    await new Promise(r => setTimeout(r, 100));

    if (actMethod === 'right_click') {
        try { bot.activateItem(); } catch (_) {}
        await new Promise(r => setTimeout(r, 350));
    }

    let _flyPhase = 'ascend';
    const _flyTick = () => {
        if (_flyPhase === 'done') return;
        const diff = targetY - bot.entity.position.y;
        if (_flyPhase === 'ascend') {
            if (diff > 0.5) { bot.entity.velocity.y = 0.28; }
            else { _flyPhase = 'cruise'; bot.entity.velocity.y = 0; }
        } else if (_flyPhase === 'cruise') {
            bot.entity.velocity.y = Math.max(-0.12, Math.min(0.18, diff * 0.18));
        } else if (_flyPhase === 'descend') {
            bot.entity.velocity.y = Math.max(-0.15, bot.entity.velocity.y);
        }
    };

    bot.on('physicsTick', _flyTick);
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 200));

    // Phase 1: Ascend
    const riseDeadline = Date.now() + 20000;
    let _stallMs = 0, _lastY = bot.entity.position.y, _recoveries = 0;
    while (bot.entity.position.y < targetY - 0.5 && Date.now() < riseDeadline && !cancelToken.cancelled) {
        await new Promise(r => setTimeout(r, 100));
        const dy = bot.entity.position.y - _lastY;
        _lastY = bot.entity.position.y;
        const fuel = _fuelNow();
        if (fuel <= fuelCritical) { bot.chat(`[System] Jetpack fuel critical (${Math.round(fuel*100)}%) — aborting ascent!`); break; }
        if (dy < 0.01) {
            _stallMs += 100;
            if (_stallMs >= 3000 && _recoveries < 2) {
                if (actMethod === 'auto' || actMethod === 'right_click') {
                    bot.chat('[System] Jetpack stall — retrying activation toggle.');
                    try { bot.activateItem(); } catch (_) {}
                    _recoveries++;
                } else {
                    bot.chat('[System] Jetpack not ascending — possible fuel exhaustion.');
                    break;
                }
                _stallMs = 0;
            }
        } else { _stallMs = 0; }
    }

    // Phase 2: Horizontal navigation
    _flyPhase = 'cruise';
    if (hoverMode) bot.setControlState('jump', false);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    const horizDeadline = Date.now() + 90000;
    let _lastFuelCheck  = Date.now();
    while (Date.now() < horizDeadline && !cancelToken.cancelled) {
        const dx = destX - bot.entity.position.x;
        const dz = destZ - bot.entity.position.z;
        if (Math.sqrt(dx * dx + dz * dz) < 3) break;
        if (Date.now() - _lastFuelCheck >= 5000) {
            _lastFuelCheck = Date.now();
            const fuel = _fuelNow();
            if (fuel <= fuelCritical) { bot.chat(`[System] Jetpack fuel critical (${Math.round(fuel*100)}%) — aborting!`); break; }
            if (fuel <= fuelLow) bot.chat(`[System] Jetpack fuel low (${Math.round(fuel*100)}%) — returning soon.`);
        }
        if (hoverMode && bot.entity.position.y < targetY - 1.5) {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 150));
            bot.setControlState('jump', false);
        }
        try { await bot.lookAt(new Vec3(destX, bot.entity.position.y, destZ), true); } catch (_) {}
        await new Promise(r => setTimeout(r, 150));
    }

    // Phase 3: Safe descent
    _flyPhase = 'descend';
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
    bot.setControlState('sneak', true);
    if (actMethod === 'right_click' || (actMethod === 'auto' && _recoveries > 0)) {
        try { bot.activateItem(); } catch (_) {}
        await new Promise(r => setTimeout(r, 200));
    }
    _setServerFlyingFlag(false);
    const landDeadline = Date.now() + 12000;
    while (!bot.entity.onGround && Date.now() < landDeadline && !cancelToken.cancelled) {
        await new Promise(r => setTimeout(r, 100));
    }
    _flyPhase = 'done';
    bot.removeListener('physicsTick', _flyTick);
    bot.clearControlStates();

    const postFuel = _fuelNow();
    const postPct  = Math.round(postFuel * 100);
    const jetpackName = bot.inventory.slots[_torsoIdx()]?.name || 'jetpack';
    if (postFuel <= fuelCritical) {
        process.send({ type: 'USER_CHAT', data: {
            username: 'System',
            message: `Jetpack (${jetpackName}) fuel critically low after landing: ${postPct}%. Refuel before next flight.`,
            environment: getEnvironmentContext(),
        }});
    } else if (postFuel <= fuelLow) {
        bot.chat(`[System] Jetpack fuel at ${postPct}% after landing.`);
    }
}

// ── Elytra flight ─────────────────────────────────────────────────────────────

async function flyWithElytra(destX, destY, destZ, cancelToken) {
    const bot = ctx.bot;
    const rocket = bot.inventory.items().find(i => i.name === 'firework_rocket');
    if (!rocket) {
        bot.chat('[System Error] No firework rockets — cannot launch Elytra.');
        return false;
    }

    bot.chat(`[System] Elytra launch — heading to X:${Math.round(destX)} Y:${Math.round(destY)} Z:${Math.round(destZ)}.`);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    try { await bot.lookAt(new Vec3(destX, destY, destZ), true); } catch (_) {}

    if (bot.entity.onGround) {
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 220));
        bot.setControlState('jump', false);
        await new Promise(r => setTimeout(r, 120));
    }
    try {
        if (bot._client && bot.entity?.id !== undefined) {
            bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 8, jumpBoost: 0 });
        }
    } catch (_) {}
    try { await bot.equip(rocket, 'hand'); } catch (_) {}
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    try { bot.activateItem(); } catch (_) {}

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !cancelToken.cancelled) {
        const dx = destX - bot.entity.position.x;
        const dz = destZ - bot.entity.position.z;
        if (Math.sqrt(dx * dx + dz * dz) < 5) break;
        try { await bot.lookAt(new Vec3(destX, destY, destZ), true); } catch (_) {}
        const vel   = bot.entity.velocity;
        const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
        if (speed < 0.3) {
            const r2 = bot.inventory.items().find(i => i.name === 'firework_rocket');
            if (r2) { try { await bot.equip(r2, 'hand'); bot.activateItem(); } catch (_) {} }
        }
        await new Promise(r => setTimeout(r, 500));
    }

    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    const landDeadline = Date.now() + 10000;
    while (!bot.entity.onGround && Date.now() < landDeadline && !cancelToken.cancelled) {
        await new Promise(r => setTimeout(r, 100));
    }
    bot.clearControlStates();
    return true;
}

module.exports = {
    JETPACK_MOD_REGISTRY,
    detectAviationMethod,
    _setServerFlyingFlag,
    getJetpackFuelRatio,
    tryElytraGapCross,
    tryBridgeForward,
    flyWithJetpack,
    flyWithElytra,
};
