// src/actuator/ctx.js
// Singleton shared state for all actuator modules.
// bot_actuator.js sets ctx.bot, ctx.mcData, ctx.movements after creation.
// All action modules import this file and read/write state through it.
// Node.js module caching guarantees one instance per child process.

'use strict';

const path = require('path');

const botId     = process.env.BOT_ID || 'Bot';
const botOptions = process.env.BOT_OPTIONS ? JSON.parse(process.env.BOT_OPTIONS) : {};

const NON_RESUMABLE_ACTIONS = new Set([
    'give', 'smelt', 'brew', 'enchant', 'activate_end_portal',
    'place_pattern', 'place', 'sleep', 'find_land', 'find_and_equip',
    'loot_chest_special', 'come', 'fly', 'follow',
]);

const DEFAULT_JUNK_LIST = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'bone'];

const ctx = {
    // ── Identity ──────────────────────────────────────────────────────────────
    botId,
    botOptions,
    DEBUG: process.env.DEBUG === 'true',

    // ── Bot instance (populated by bot_actuator.js after createBot) ───────────
    bot:       null,
    mcData:    null,
    movements: null,

    // ── Action queue state ────────────────────────────────────────────────────
    actionQueue:         [],
    isExecuting:         false,
    currentCancelToken:  { cancelled: false },
    currentAction:       null,

    // ── Ready / stop flags ────────────────────────────────────────────────────
    botReady:             false,
    inStopMode:           false,
    disconnectedNotified: false,
    pendingIpcActions:    [],

    // ── Server position watchdog ──────────────────────────────────────────────
    serverPosCount:         0,
    lastServerPosCheck:     Date.now(),
    frozenPosKey:           null,
    frozenPeriods:          0,
    loggedPreReadyPosition: false,

    // ── Spawn / combat tracking ───────────────────────────────────────────────
    spawnInitDone:       false,
    passiveDefenseInterval: null,
    lastHealth:          20,
    inBossCombat:        false,
    autonomousTaskBusy:  false,
    lastSafePos:         null,
    lastSafeDim:         'overworld',
    treeDir:             null,

    // ── Aviation / physics helpers ────────────────────────────────────────────
    fallStartY:              null,
    mlgAttempted:            false,
    lavaEscapeActive:        false,
    jetpackSneakFallActive:  false,
    lastBridgeFailureReason: null,

    // ── Collections ───────────────────────────────────────────────────────────
    lootedChests:      new Set(),
    junkList:          new Set(DEFAULT_JUNK_LIST),
    chatDedup:         new Map(),
    externalPositions: new Map(),   // playerName → {x,y,z,dimension,updatedAt}
    trackedPlayers:    new Map(),
    aggroedNeutrals:   new Set(),

    // ── Constants ────────────────────────────────────────────────────────────
    NON_RESUMABLE_ACTIONS,
    DEFAULT_JUNK_LIST,

    // ── File paths ────────────────────────────────────────────────────────────
    DEATHS_FILE:           path.join(process.cwd(), 'data', `deaths_${botId}.json`),
    QUEUE_CHECKPOINT_FILE: path.join(process.cwd(), 'data', `queue_checkpoint_${botId}.json`),
    WAYPOINTS_FILE:        path.join(process.cwd(), 'data', 'waypoints.json'),
    PATH_CACHE_FILE:       path.join(process.cwd(), 'data', 'path_cache.json'),
    BLACKBOARD_FILE:       path.join(process.cwd(), 'data', 'blackboard.json'),
    SAFE_ZONES_FILE:       path.join(process.cwd(), 'data', 'safezones.json'),
    JUNK_LIST_FILE:        path.join(process.cwd(), 'data', 'junk_list.json'),
};

module.exports = ctx;
