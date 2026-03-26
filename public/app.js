/* ─── State ──────────────────────────────────────────────────────────────────── */
const state = {
    bots: {},          // botId → { id, online, mode, health, food, position, inventory, armor, actionQueue, … }
    logs: {},          // botId → [{ username, message, timestamp }]
    selectedBot: null, // currently active bot in chat view
    ws: null,
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
    invGrid:      $('inventory-grid'),
    armorRows:    $('armor-rows'),
    manageBtn:    $('manage-btn'),
    settingsBtn:  $('settings-btn'),
    addBotBtn:    $('add-bot-btn'),
    // Modals
    manageModal:  $('manage-modal'),
    settingsModal:$('settings-modal'),
    botManageList:$('bot-manage-list'),
    newBotName:   $('new-bot-name'),
    newBotHost:   $('new-bot-host'),
    newBotPort:   $('new-bot-port'),
    manageAdd:    $('manage-add'),
    manageCancel: $('manage-cancel'),
    settingsSave: $('settings-save'),
    settingsCancel:$('settings-cancel'),
    cfgUrl:       $('cfg-url'),
    cfgModel:     $('cfg-model'),
    cfgKey:       $('cfg-key'),
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
                if (state.bots[msg.botId]) state.bots[msg.botId].online = false;
                renderBotCard(msg.botId);
                updateHeaderCount();
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

/* ─── Render helpers ─────────────────────────────────────────────────────────── */
function renderAll() {
    renderBotList();
    updateBotSelect();
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

/* ─── Settings modal ─────────────────────────────────────────────────────────── */
async function openSettingsModal() {
    const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
    els.cfgUrl.value   = cfg.ollamaUrl   || '';
    els.cfgModel.value = cfg.ollamaModel || '';
    els.cfgKey.value   = '';
    els.settingsModal.classList.remove('hidden');
}

async function saveSettings() {
    const body = { ollamaUrl: els.cfgUrl.value, ollamaModel: els.cfgModel.value };
    if (els.cfgKey.value) body.ollamaApiKey = els.cfgKey.value;
    await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    els.settingsModal.classList.add('hidden');
}

/* ─── Utilities ──────────────────────────────────────────────────────────────── */
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/"/g,'&quot;'); }
function dimLabel(d) { return { overworld: 'OW', the_nether: 'NE', the_end: 'EN' }[d] || d; }

/* ─── Events ─────────────────────────────────────────────────────────────────── */
els.sendBtn.addEventListener('click', sendChat);
els.chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
els.botSelect.addEventListener('change', () => { if (els.botSelect.value) selectBot(els.botSelect.value); });
els.manageBtn.addEventListener('click', openManageModal);
els.settingsBtn.addEventListener('click', openSettingsModal);
els.addBotBtn.addEventListener('click', openManageModal);
els.manageCancel.addEventListener('click', () => els.manageModal.classList.add('hidden'));
els.manageAdd.addEventListener('click', addBot);
els.settingsCancel.addEventListener('click', () => els.settingsModal.classList.add('hidden'));
els.settingsSave.addEventListener('click', saveSettings);
// Close modal on overlay click
[els.manageModal, els.settingsModal].forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));

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
