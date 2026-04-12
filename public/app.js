/* ─── State ──────────────────────────────────────────────────────────────────── */
const state = {
    bots: {},          // botId → { id, online, mode, health, food, position, inventory, armor, actionQueue, … }
    logs: {},          // botId → [{ username, message, timestamp }]
    selectedBot: null, // currently active bot in chat view
    ws: null,
    knowledge: {
        status: null,
        results: [],
    },
};

const MACRO_STORAGE_KEY = 'forgeaip_macros_v1';
const MACRO_ACTIONS = ['goto', 'come', 'collect', 'give', 'equip', 'craft', 'place', 'eat', 'smelt', 'kill', 'status', 'wait', 'stop', 'chat'];

// Per-action field definitions: which inputs are relevant for each action type.
// Each entry is an array of { key, placeholder, type, hint } objects.
// Fields not listed are hidden so the row stays compact.
const ACTION_FIELDS = {
    goto:    [{ key:'x', ph:'x', type:'num' }, { key:'y', ph:'y', type:'num' }, { key:'z', ph:'z', type:'num' }, { key:'timeout', ph:'timeout(s)', type:'num' }],
    come:    [{ key:'target', ph:'player name' }, { key:'timeout', ph:'timeout(s)', type:'num' }],
    collect: [{ key:'target', ph:'block/item' }, { key:'quantity', ph:'qty', type:'num' }, { key:'timeout', ph:'timeout(s)', type:'num' }],
    give:    [{ key:'target', ph:'player name' }, { key:'item', ph:'item name' }, { key:'quantity', ph:'qty', type:'num' }],
    equip:   [{ key:'item', ph:'item name' }],
    craft:   [{ key:'item', ph:'item name' }, { key:'quantity', ph:'qty', type:'num' }],
    place:   [{ key:'item', ph:'item/block name' }, { key:'x', ph:'x', type:'num' }, { key:'y', ph:'y', type:'num' }, { key:'z', ph:'z', type:'num' }],
    eat:     [{ key:'item', ph:'food item (opt)' }],
    smelt:   [{ key:'item', ph:'item to smelt' }, { key:'quantity', ph:'qty', type:'num' }, { key:'timeout', ph:'timeout(s)', type:'num' }],
    kill:    [{ key:'target', ph:'mob/player' }, { key:'timeout', ph:'timeout(s)', type:'num' }],
    status:  [],
    wait:    [{ key:'timeout', ph:'seconds', type:'num' }],
    stop:    [],
    chat:    [{ key:'message', ph:'message text' }],
};

/* ─── DOM Refs ───────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const els = {
    botList:      $('bot-list'),
    botSelect:    $('chat-bot-select'),
    chatMessages: $('chat-messages'),
    chatInput:    $('chat-input'),
    sendBtn:      $('send-btn'),
    serverInfo:   $('server-info'),
    statusDot:    $('status-dot'),
    botCount:     $('header-bot-count'),
    macrosBtn:    $('macros-btn'),
    invGrid:      $('inventory-grid'),
    armorRows:    $('armor-rows'),
    manageBtn:    $('manage-btn'),
    settingsBtn:  $('settings-btn'),
    addBotBtn:    $('add-bot-btn'),
    // Modals
    manageModal:   $('manage-modal'),
    settingsModal: $('settings-modal'),
    sentryModal:   $('sentry-modal'),
    botManageList: $('bot-manage-list'),
    newBotName:    $('new-bot-name'),
    newBotHost:    $('new-bot-host'),
    newBotPort:    $('new-bot-port'),
    bulkCount:     $('bulk-count'),
    bulkHost:      $('bulk-host'),
    bulkPort:      $('bulk-port'),
    bulkSpawnBtn:  $('bulk-spawn-btn'),
    manageAdd:     $('manage-add'),
    manageCancel:  $('manage-cancel'),
    settingsSave:  $('settings-save'),
    settingsCancel:$('settings-cancel'),
    cfgUrl:        $('cfg-url'),
    cfgModel:      $('cfg-model'),
    cfgKey:        $('cfg-key'),
    // Macro modal
    macroModal:    $('macro-modal'),
    macroName:     $('macro-name'),
    macroBotSelect:$('macro-bot-select'),
    macroRows:     $('macro-rows'),
    macroAddRow:   $('macro-add-row'),
    macroSave:     $('macro-save'),
    macroLoad:     $('macro-load'),
    macroRun:      $('macro-run'),
    macroCancel:   $('macro-cancel'),
    knowledgeStatus: $('knowledge-status'),
    knowledgeRefresh: $('knowledge-refresh'),
    knowledgeQuery: $('knowledge-query'),
    knowledgeTopN: $('knowledge-topn'),
    knowledgeSearchBtn: $('knowledge-search-btn'),
    knowledgeResults: $('knowledge-results'),
    sentryAccept:  $('sentry-accept'),
    sentryDecline: $('sentry-decline'),
    sentryDontAsk: $('sentry-dont-ask'),
};

/* ─── WebSocket ──────────────────────────────────────────────────────────────── */
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    state.ws = ws;

    ws.onopen = () => {
        els.statusDot.classList.remove('offline');
        els.serverInfo.textContent = `Connected · ${location.host}`;
    };

    ws.onclose = () => {
        els.statusDot.classList.add('offline');
        els.serverInfo.textContent = 'Disconnected – reconnecting…';
        setTimeout(connectWS, 3000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        switch (msg.type) {
            case 'init':
                for (const bot of msg.bots) mergeBotState(bot);
                for (const [id, log] of Object.entries(msg.logs || {})) {
                    state.logs[id] = log;
                }
                renderAll();
                break;

            case 'bot_status':
                mergeBotState({ id: msg.botId, online: true, ...msg.data });
                renderBotCard(msg.botId);
                if (state.selectedBot === msg.botId) renderStatusPanel();
                if (msg.data && msg.data.position) {
                    const p = msg.data.position;
                    window.dispatchEvent(new CustomEvent('forgeaip_status_update', { detail: {
                        botId: msg.botId,
                        pos: [p.x, p.y, p.z],
                        action: msg.data.currentAction || 'idle',
                        health: msg.data.health || 20,
                        stuckSec: 0
                    }}));
                }
                break;

            case 'bot_chat':
                appendLog(msg.botId, msg.username, msg.message, msg.timestamp);
                if (state.selectedBot === msg.botId) appendChatMessage(msg.username, msg.message, msg.timestamp);
                break;

            case 'bot_connected':
                mergeBotState({ id: msg.botId, online: true });
                renderBotCard(msg.botId);
                updateBotSelect();
                updateHeaderCount();
                break;

            case 'bot_disconnected':
                if (state.bots[msg.botId]) {
                    state.bots[msg.botId].online = false;
                    renderBotCard(msg.botId);
                    updateHeaderCount();
                }
                break;

            case 'path_update':
                window.dispatchEvent(new CustomEvent('forgeaip_path_update', { detail: msg.data }));
                break;

            case 'entity_update':
                // Reserved for future overlay usage; keep connection handler tolerant.
                break;
        }
    };
}

/* ─── State helpers ──────────────────────────────────────────────────────────── */
function mergeBotState(data) {
    const id = data.id;
    state.bots[id] = Object.assign(state.bots[id] || { id }, data);
    if (!state.logs[id]) state.logs[id] = [];
}

function appendLog(botId, username, message, timestamp) {
    if (!state.logs[botId]) state.logs[botId] = [];
    state.logs[botId].push({ username, message, timestamp: timestamp || Date.now() });
    if (state.logs[botId].length > 300) state.logs[botId].shift();
}

async function syncSelectedBotLog() {
    const id = state.selectedBot;
    if (!id) return;
    try {
        const remote = await fetch(`/api/bots/${encodeURIComponent(id)}/log`).then(r => r.json());
        if (!Array.isArray(remote)) return;
        const localLen = (state.logs[id] || []).length;
        if (remote.length > localLen) {
            state.logs[id] = remote;
            renderChat();
        }
    } catch (_) {}
}

/* ─── Render helpers ─────────────────────────────────────────────────────────── */
function renderAll() {
    renderBotList();
    updateBotSelect();
    updateMacroBotSelect();
    updateHeaderCount();
    if (!state.selectedBot) {
        const first = Object.keys(state.bots)[0];
        if (first) selectBot(first);
    }
}

function renderBotList() {
    els.botList.innerHTML = '';
    for (const id of Object.keys(state.bots)) renderBotCard(id);
}

function renderBotCard(id) {
    const bot = state.bots[id];
    let card = document.querySelector(`.bot-card[data-id="${id}"]`);
    if (!card) {
        card = document.createElement('div');
        card.className = 'bot-card';
        card.dataset.id = id;
        card.addEventListener('click', () => selectBot(id));
        els.botList.appendChild(card);
    }
    const hp  = bot.health ?? 20;
    const food = bot.food  ?? 20;
    const online = bot.online !== false;
    const isActive = state.selectedBot === id;
    const action = (bot.actionQueue && bot.actionQueue[0]) ? bot.actionQueue[0].action : (bot.isExecuting ? 'working…' : 'idle');

    card.className = `bot-card${isActive ? ' active' : ''}${!online ? ' offline' : ''}`;
    card.innerHTML = `
      <div class="bot-card-header">
        <span class="bot-dot${!online ? ' offline' : ''}"></span>
        <span class="bot-name" title="${id}">${id}</span>
        <span class="bot-mode">${bot.mode || 'normal'}</span>
      </div>
      ${online ? `
      <div class="bar-row">
        <span class="bar-label">♥</span>
        <div class="bar-track"><div class="bar-fill health" style="width:${(hp/20*100).toFixed(0)}%"></div></div>
        <span class="bar-val">${hp}/20</span>
      </div>
      <div class="bar-row">
        <span class="bar-label">🍖</span>
        <div class="bar-track"><div class="bar-fill food" style="width:${(food/20*100).toFixed(0)}%"></div></div>
        <span class="bar-val">${food}/20</span>
      </div>
      ${bot.position ? `<div class="bot-pos">X:${bot.position.x} Y:${bot.position.y} Z:${bot.position.z}${bot.dimension ? ` · ${dimLabel(bot.dimension)}` : ''}</div>` : ''}
      <div class="bot-action">${online ? action : 'offline'}</div>
      ` : '<div class="bot-action" style="color:var(--danger)">Offline / Restarting</div>'}
    `;
}

function updateBotSelect() {
    const cur = els.botSelect.value;
    els.botSelect.innerHTML = '<option value="">— select bot —</option>';
    for (const id of Object.keys(state.bots)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id + (state.bots[id].online === false ? ' (offline)' : '');
        els.botSelect.appendChild(opt);
    }
    if (cur && state.bots[cur]) els.botSelect.value = cur;
}

function updateHeaderCount() {
    const online = Object.values(state.bots).filter(b => b.online !== false).length;
    const total  = Object.keys(state.bots).length;
    els.botCount.textContent = `${online}/${total} bots online`;
}

function selectBot(id) {
    state.selectedBot = id;
    els.botSelect.value = id;
    // Re-render all cards to update active state
    for (const bid of Object.keys(state.bots)) renderBotCard(bid);
    renderChat();
    renderStatusPanel();
}

/* ─── Chat rendering ─────────────────────────────────────────────────────────── */
function renderChat() {
    els.chatMessages.innerHTML = '';
    const log = state.logs[state.selectedBot] || [];
    for (const entry of log) appendChatMessage(entry.username, entry.message, entry.timestamp, false);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function appendChatMessage(username, message, timestamp, scroll = true) {
    const d = new Date(timestamp || Date.now());
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const isError = username === 'System' && message.startsWith('[Error]');
    div.innerHTML = `
      <span class="chat-time">${time}</span>
      <span class="chat-user ${username}">${username}</span>
      <span class="chat-text${isError ? ' error-text' : ''}">${escHtml(message)}</span>
    `;
    els.chatMessages.appendChild(div);
    if (scroll) els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

/* ─── Status panel ───────────────────────────────────────────────────────────── */
function renderStatusPanel() {
    const bot = state.bots[state.selectedBot];
    if (!bot) {
        els.invGrid.innerHTML = '<span class="inv-empty">No bot selected</span>';
        els.armorRows.innerHTML = '';
        return;
    }

    // Inventory
    const inv = bot.inventory || [];
    if (inv.length === 0) {
        els.invGrid.innerHTML = '<span class="inv-empty">Empty</span>';
    } else {
        els.invGrid.innerHTML = inv.map(it =>
            `<div class="inv-slot"><span class="inv-name">${escHtml(it.name)}</span><span class="inv-count">×${it.count}</span></div>`
        ).join('');
    }

    // Armor / equipment
    const ar = bot.armor || {};
    const slots = [
        { label: 'Helmet',     key: 'head'  },
        { label: 'Chestplate', key: 'torso' },
        { label: 'Leggings',   key: 'legs'  },
        { label: 'Boots',      key: 'feet'  },
        { label: 'Hand',       key: 'hand'  },
    ];
    els.armorRows.innerHTML = slots.map(s => {
        const val = ar[s.key];
        return `<div class="armor-row">
          <span class="armor-slot-label">${s.label}</span>
          <span class="armor-slot-val${val ? '' : ' none'}">${val ? escHtml(val) : 'none'}</span>
        </div>`;
    }).join('');
}

/* ─── Send chat ──────────────────────────────────────────────────────────────── */
function sendChat() {
    const msg = els.chatInput.value.trim();
    const botId = els.botSelect.value || state.selectedBot;
    if (!msg || !botId) return;
    els.chatInput.value = '';

    // Optimistic: show in chat immediately
    const ts = Date.now();
    appendLog(botId, 'You', msg, ts);
    if (state.selectedBot === botId) appendChatMessage('You', msg, ts);

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'chat', botId, message: msg }));
    } else {
        fetch(`/api/bots/${encodeURIComponent(botId)}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
    }
}

/* ─── Manage bots modal ──────────────────────────────────────────────────────── */
function openManageModal() {
    renderManageList();
    els.manageModal.classList.remove('hidden');
}

function renderManageList() {
    els.botManageList.innerHTML = '';
    for (const [id, bot] of Object.entries(state.bots)) {
        const online = bot.online !== false;
        const row = document.createElement('div');
        row.className = 'bot-manage-row';
        row.innerHTML = `
          <span class="bot-manage-name">${escHtml(id)}</span>
          <span class="bot-manage-status${!online ? ' offline' : ''}">${online ? 'Online' : 'Offline'}</span>
          <button class="btn btn-secondary" onclick="restartBot('${escAttr(id)}')">Restart</button>
          <button class="btn btn-danger"    onclick="removeBot('${escAttr(id)}')">Remove</button>
        `;
        els.botManageList.appendChild(row);
    }
    if (Object.keys(state.bots).length === 0) {
        els.botManageList.innerHTML = '<p style="color:var(--text-dim);font-size:13px">No bots running.</p>';
    }
}

async function restartBot(id) {
    await fetch(`/api/bots/${encodeURIComponent(id)}/restart`, { method: 'POST' });
    renderManageList();
}

async function removeBot(id) {
    await fetch(`/api/bots/${encodeURIComponent(id)}`, { method: 'DELETE' });
    delete state.bots[id];
    delete state.logs[id];
    if (state.selectedBot === id) state.selectedBot = null;
    renderAll();
    renderManageList();
}

async function addBot() {
    const name = els.newBotName.value.trim();
    if (!name) return;
    await fetch('/api/bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, host: els.newBotHost.value.trim(), port: els.newBotPort.value.trim() })
    });
    els.newBotName.value = '';
    els.manageModal.classList.add('hidden');
}

async function spawnBulkBots() {
    const count = parseInt(els.bulkCount.value, 10);
    if (!count || count < 1) return;
    const btn = els.bulkSpawnBtn;
    btn.disabled = true;
    btn.textContent = 'Spawning…';
    try {
        const res = await fetch('/api/bots/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                count,
                host: els.bulkHost.value.trim() || undefined,
                port: els.bulkPort.value.trim() || undefined
            })
        });
        const data = await res.json();
        if (data.ok) {
            btn.textContent = `✔ Spawned ${data.botIds.length} bot(s)`;
            setTimeout(() => { btn.textContent = '⚡ Spawn Bots'; btn.disabled = false; }, 2000);
        } else {
            btn.textContent = `Error: ${data.error || 'unknown'}`;
            btn.disabled = false;
        }
    } catch (e) {
        btn.textContent = 'Request failed';
        btn.disabled = false;
    }
}

/* ─── Settings modal ─────────────────────────────────────────────────────────── */
async function openSettingsModal() {
    const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
    els.cfgUrl.value   = cfg.ollamaUrl   || '';
    els.cfgModel.value = cfg.ollamaModel || '';
    els.cfgKey.value   = '';
    els.settingsModal.classList.remove('hidden');
}

async function saveSettings() {
    const body = { OLLAMA_URL: els.cfgUrl.value, OLLAMA_MODEL: els.cfgModel.value };
    if (els.cfgKey.value) body.OLLAMA_API_KEY = els.cfgKey.value;
    await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    els.settingsModal.classList.add('hidden');
}

/* ─── Macro builder ─────────────────────────────────────────────────────────── */
function openMacroModal() {
    updateMacroBotSelect();
    if (els.macroRows.children.length === 0) addMacroRow();
    els.macroModal.classList.remove('hidden');
}

function updateMacroBotSelect() {
    if (!els.macroBotSelect) return;
    const cur = els.macroBotSelect.value;
    els.macroBotSelect.innerHTML = '';
    for (const id of Object.keys(state.bots)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        els.macroBotSelect.appendChild(opt);
    }
    if (cur && state.bots[cur]) els.macroBotSelect.value = cur;
    if (!els.macroBotSelect.value && state.selectedBot) els.macroBotSelect.value = state.selectedBot;
}

function _buildMacroRowFields(action) {
    const fieldDefs = ACTION_FIELDS[action] || [];
    const hasCoords = fieldDefs.some(f => f.key === 'x');
    let html = '';
    for (const f of fieldDefs) {
        const cls = f.type === 'num' ? 'macro-field macro-num' : 'macro-field macro-text';
        html += `<input class="${cls}" data-key="${f.key}" placeholder="${f.ph}" title="${f.key}">`;
    }
    // Add "use bot position" button when x/y/z are present
    if (hasCoords) {
        html += `<button class="btn macro-usepos" title="Fill coords from selected bot's current position">📍</button>`;
    }
    return html;
}

function _rebuildMacroRowFields(row) {
    const action = row.querySelector('.macro-action').value;
    // Collect existing values before rebuilding
    const existing = {};
    for (const f of row.querySelectorAll('[data-key]')) existing[f.dataset.key] = f.value;

    // Replace only the dynamic part (everything after the action select, before the del button)
    const sel = row.querySelector('.macro-action');
    const del = row.querySelector('.macro-del');
    // Remove all nodes between sel and del
    let cur = sel.nextSibling;
    while (cur && cur !== del) {
        const next = cur.nextSibling;
        row.removeChild(cur);
        cur = next;
    }
    // Insert new fields
    const tmp = document.createElement('div');
    tmp.innerHTML = _buildMacroRowFields(action);
    while (tmp.firstChild) row.insertBefore(tmp.firstChild, del);

    // Restore values
    for (const [k, v] of Object.entries(existing)) {
        const f = row.querySelector(`[data-key="${k}"]`);
        if (f && v) f.value = v;
    }

    // Wire position button
    const posBtn = row.querySelector('.macro-usepos');
    if (posBtn) {
        posBtn.addEventListener('click', () => {
            const botId = els.macroBotSelect?.value || state.selectedBot;
            const botState = state.bots[botId];
            const pos = botState?.environment?.position || botState?.status?.position;
            if (pos) {
                const xf = row.querySelector('[data-key="x"]');
                const yf = row.querySelector('[data-key="y"]');
                const zf = row.querySelector('[data-key="z"]');
                if (xf) xf.value = Math.round(pos.x);
                if (yf) yf.value = Math.round(pos.y);
                if (zf) zf.value = Math.round(pos.z);
            }
        });
    }
}

function addMacroRow(data = {}) {
    const row = document.createElement('div');
    row.className = 'macro-row';
    const action = data.action || 'goto';
    row.innerHTML = `
      <select class="macro-field macro-action">${MACRO_ACTIONS.map(a => `<option value="${a}"${a === action ? ' selected' : ''}>${a}</option>`).join('')}</select>
      ${_buildMacroRowFields(action)}
      <button class="btn btn-danger macro-del">✕</button>
    `;
    // Fill values from data
    for (const [k, v] of Object.entries(data)) {
        const field = row.querySelector(`[data-key="${k}"]`);
        if (field) field.value = v;
    }
    // Rebuild fields when action changes
    row.querySelector('.macro-action').addEventListener('change', () => _rebuildMacroRowFields(row));
    // Wire position button (if present after initial build)
    const posBtn = row.querySelector('.macro-usepos');
    if (posBtn) {
        posBtn.addEventListener('click', () => {
            const botId = els.macroBotSelect?.value || state.selectedBot;
            const botState = state.bots[botId];
            const pos = botState?.environment?.position || botState?.status?.position;
            if (pos) {
                const xf = row.querySelector('[data-key="x"]');
                const yf = row.querySelector('[data-key="y"]');
                const zf = row.querySelector('[data-key="z"]');
                if (xf) xf.value = Math.round(pos.x);
                if (yf) yf.value = Math.round(pos.y);
                if (zf) zf.value = Math.round(pos.z);
            }
        });
    }
    row.querySelector('.macro-del').addEventListener('click', () => row.remove());
    els.macroRows.appendChild(row);
}

function collectMacroActions() {
    const rows = [...els.macroRows.querySelectorAll('.macro-row')];
    const actions = [];
    for (const row of rows) {
        const action = row.querySelector('.macro-action').value;
        const obj = { action };
        for (const field of row.querySelectorAll('[data-key]')) {
            const key = field.dataset.key;
            const raw = field.value.trim();
            if (!raw) continue;
            if (['x', 'y', 'z', 'quantity', 'timeout'].includes(key)) {
                const n = Number(raw);
                if (!Number.isNaN(n)) obj[key] = n;
            } else {
                obj[key] = raw;
            }
        }
        actions.push(obj);
    }
    return actions;
}

function loadSavedMacros() {
    try { return JSON.parse(localStorage.getItem(MACRO_STORAGE_KEY) || '{}'); }
    catch (_) { return {}; }
}

function saveCurrentMacro() {
    const name = els.macroName.value.trim();
    if (!name) return;
    const db = loadSavedMacros();
    db[name] = collectMacroActions();
    localStorage.setItem(MACRO_STORAGE_KEY, JSON.stringify(db));
}

function loadMacroByPrompt() {
    const db = loadSavedMacros();
    const names = Object.keys(db);
    if (names.length === 0) return;
    const selected = prompt(`Macro name:\n${names.join('\n')}`);
    if (!selected || !db[selected]) return;
    els.macroName.value = selected;
    els.macroRows.innerHTML = '';
    for (const action of db[selected]) addMacroRow(action);
}

async function runMacroNow() {
    const botId = els.macroBotSelect.value || state.selectedBot;
    const actions = collectMacroActions();
    if (!botId || actions.length === 0) return;
    await fetch(`/api/bots/${encodeURIComponent(botId)}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions, queue_op: 'replace' })
    });
    els.macroModal.classList.add('hidden');
}

/* ─── Sentry consent modal ────────────────────────────────────────────────────── */
async function checkSentryConsent() {
    try {
        const prefs = await fetch('/api/crash-prefs').then(r => r.json()).catch(() => null);
        if (prefs && prefs.needsConsent) {
            els.sentryModal.classList.remove('hidden');
        }
    } catch (_) {}
}

async function saveSentryChoice(opted) {
    const dontAskAgain = els.sentryDontAsk.checked;
    await fetch('/api/crash-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opted, dontAskAgain })
    }).catch(() => {});
    els.sentryModal.classList.add('hidden');
}

/* ─── Knowledge panel ─────────────────────────────────────────────────────── */
async function refreshKnowledgeStatus() {
    try {
        const data = await fetch('/api/knowledge/status').then(r => r.json());
        if (!data || data.error) throw new Error(data?.error || 'Failed to load status');
        state.knowledge.status = data;
        renderKnowledgeStatus();
    } catch (_) {
        state.knowledge.status = null;
        renderKnowledgeStatus();
    }
}

function renderKnowledgeStatus() {
    const s = state.knowledge.status;
    if (!s) {
        els.knowledgeStatus.textContent = 'Crawl status unavailable';
        return;
    }
    const pages = Number(s.pages || 0);
    const frontier = Number(s.frontier || 0);
    const crawled = s.lastRun?.crawled || '-';
    const saved = s.lastRun?.saved || '-';
    els.knowledgeStatus.textContent = `pages: ${pages} | frontier: ${frontier} | last run crawled/saved: ${crawled}/${saved}`;
}

function renderKnowledgeResults() {
    const results = state.knowledge.results || [];
    if (!results.length) {
        els.knowledgeResults.innerHTML = '<div class="knowledge-empty">No results yet</div>';
        return;
    }
    els.knowledgeResults.innerHTML = results.map(r => {
        const src = escHtml(String(r.file || 'unknown'));
        const line = Number(r.line || 0);
        const score = Number(r.score || 0);
        return `<div class="knowledge-item">
          <div class="knowledge-item-meta">${src}:${line} <span>score ${score}</span></div>
          <div class="knowledge-item-text">${escHtml(String(r.text || ''))}</div>
        </div>`;
    }).join('');
}

async function runKnowledgeSearch() {
    const query = els.knowledgeQuery.value.trim();
    if (!query) return;
    const topN = Math.max(1, Math.min(20, Number(els.knowledgeTopN.value || 8)));
    els.knowledgeSearchBtn.disabled = true;
    els.knowledgeSearchBtn.textContent = 'Searching...';
    try {
        const data = await fetch('/api/knowledge/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, topN })
        }).then(r => r.json());
        state.knowledge.results = Array.isArray(data?.results) ? data.results : [];
        renderKnowledgeResults();
    } catch (_) {
        state.knowledge.results = [];
        renderKnowledgeResults();
    } finally {
        els.knowledgeSearchBtn.disabled = false;
        els.knowledgeSearchBtn.textContent = 'Search';
    }
}

/* ─── Utilities ──────────────────────────────────────────────────────────────── */
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/"/g,'&quot;'); }
function dimLabel(d) { return { overworld: 'OW', the_nether: 'NE', the_end: 'EN' }[d] || d; }

/* ─── Events ─────────────────────────────────────────────────────────────────── */
els.sendBtn.addEventListener('click', sendChat);
els.chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
els.botSelect.addEventListener('change', () => { if (els.botSelect.value) selectBot(els.botSelect.value); });
els.macrosBtn.addEventListener('click', openMacroModal);
els.manageBtn.addEventListener('click', openManageModal);
els.settingsBtn.addEventListener('click', openSettingsModal);
els.addBotBtn.addEventListener('click', openManageModal);
els.manageCancel.addEventListener('click', () => els.manageModal.classList.add('hidden'));
els.manageAdd.addEventListener('click', addBot);
els.bulkSpawnBtn.addEventListener('click', spawnBulkBots);
els.settingsCancel.addEventListener('click', () => els.settingsModal.classList.add('hidden'));
els.settingsSave.addEventListener('click', saveSettings);
els.macroAddRow.addEventListener('click', () => addMacroRow());
els.macroSave.addEventListener('click', saveCurrentMacro);
els.macroLoad.addEventListener('click', loadMacroByPrompt);
els.macroRun.addEventListener('click', runMacroNow);
els.macroCancel.addEventListener('click', () => els.macroModal.classList.add('hidden'));
// Sentry consent
els.sentryAccept.addEventListener('click',  () => saveSentryChoice('yes'));
els.sentryDecline.addEventListener('click', () => saveSentryChoice('no'));
els.knowledgeRefresh.addEventListener('click', refreshKnowledgeStatus);
els.knowledgeSearchBtn.addEventListener('click', runKnowledgeSearch);
els.knowledgeQuery.addEventListener('keydown', e => { if (e.key === 'Enter') runKnowledgeSearch(); });
// Close modal on overlay click (not Sentry — user must make an explicit choice)
[els.manageModal, els.settingsModal, els.macroModal].forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));

/* ─── Boot ───────────────────────────────────────────────────────────────────── */
// Load initial state via REST (before WS is ready)
fetch('/api/bots').then(r => r.json()).then(async bots => {
    for (const bot of bots) {
        mergeBotState(bot);
        const logRes = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/log`).then(r => r.json()).catch(() => []);
        state.logs[bot.id] = logRes;
    }
    renderAll();
    if (!state.selectedBot && bots.length > 0) selectBot(bots[0].id);
}).catch(() => {});

connectWS();
refreshKnowledgeStatus();
renderKnowledgeResults();

// Fallback reconciliation: recover chat UI when a websocket message is missed.
setInterval(() => {
    if (!document.hidden) syncSelectedBotLog();
}, 5000);

// Check Sentry consent after initial render (small delay so the page isn't jarring)
setTimeout(checkSentryConsent, 800);
