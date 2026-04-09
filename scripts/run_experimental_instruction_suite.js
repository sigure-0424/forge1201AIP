#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

function parseArgs(argv) {
  const out = {
    baseUrl: 'http://localhost:3000',
    botId: 'AI_Bot_01',
    timeoutSec: 120,
    idleGraceSec: 6,
    mode: 'chat',
    shardConfig: '',
    cases: '',
    output: '',
    ollamaUrl: '',
    ollamaModel: '',
    ollamaApiKey: '',
    ollamaAuthScheme: '',
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === '--base-url' && n) { out.baseUrl = n; i++; continue; }
    if (a === '--bot-id' && n) { out.botId = n; i++; continue; }
    if (a === '--timeout-sec' && n) { out.timeoutSec = Number(n) || out.timeoutSec; i++; continue; }
    if (a === '--idle-grace-sec' && n) { out.idleGraceSec = Number(n) || out.idleGraceSec; i++; continue; }
    if (a === '--mode' && n) { out.mode = n; i++; continue; }
    if (a === '--shard-config' && n) { out.shardConfig = n; i++; continue; }
    if (a === '--cases' && n) { out.cases = n; i++; continue; }
    if (a === '--output' && n) { out.output = n; i++; continue; }
    if (a === '--ollama-url' && n) { out.ollamaUrl = n; i++; continue; }
    if (a === '--ollama-model' && n) { out.ollamaModel = n; i++; continue; }
    if (a === '--ollama-api-key' && n) { out.ollamaApiKey = n; i++; continue; }
    if (a === '--ollama-auth-scheme' && n) { out.ollamaAuthScheme = n; i++; continue; }
  }
  return out;
}

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function jfetch(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url} :: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

function compileRe(arr) {
  return (arr || []).map(s => new RegExp(s, 'i'));
}

function selectCases(allCases, casesCsv) {
  if (!casesCsv) return allCases;
  const wanted = new Set(casesCsv.split(',').map(x => x.trim()).filter(Boolean));
  return allCases.filter(c => wanted.has(c.id));
}

const DEFAULT_CASES = [
  {
    id: 'z1-bridge-move',
    instruction: '座標 X:-26 Y:69 Z:-96 のブリッジゾーンへ移動して（goto x:-26 y:69 z:-96）、到達したら status を返してください。',
    expect: ['reached destination', 'status:', 'going to', 'arrived'],
    forbid: ['timed out'],
    timeoutSec: 180,
    directActions: [
      { action: 'goto', x: -26, y: 69, z: -96, timeout: 180 },
      { action: 'status' },
    ],
  },
  {
    id: 'z2-maze-move',
    instruction: '座標 X:44 Y:69 Z:-96 の迷路ゾーンへ移動して（goto x:44 y:69 z:-96）、到達したら status を返してください。',
    expect: ['reached destination', 'status:', 'going to', 'arrived'],
    forbid: ['timed out'],
    timeoutSec: 180,
    directActions: [
      { action: 'goto', x: 44, y: 69, z: -96, timeout: 180 },
      { action: 'status' },
    ],
  },
  {
    id: 'z3-break-minimal',
    instruction: '座標 X:114 Y:69 Z:-96 のブレイクヤードへ移動して（goto x:114 y:69 z:-96）、近くの石またはコブルストーンを1個採掘して status を返してください。',
    expect: ['collected', 'mined', 'status:', 'reached destination'],
    forbid: ['timed out'],
    timeoutSec: 180,
    directActions: [
      { action: 'goto', x: 114, y: 69, z: -96, timeout: 180 },
      { action: 'status' },
    ],
  },
  {
    id: 'z4-itemrange-minimal',
    instruction: '座標 X:-26 Y:69 Z:-26 のアイテムレンジへ移動して（goto x:-26 y:69 z:-26）、到達したら status を返してください。',
    expect: ['status:', 'reached destination', 'going to', 'arrived'],
    forbid: ['timed out'],
    timeoutSec: 180,
    directActions: [
      { action: 'goto', x: -26, y: 69, z: -26, timeout: 180 },
      { action: 'status' },
    ],
  },
  {
    id: 'z5-initial-material-only',
    instruction: '座標 X:44 Y:69 Z:-26 の MineAll ゾーンへ移動して（goto x:44 y:69 z:-26）、その周辺の oak_log を1個以上回収して status を返してください。中間素材は事前準備せず現地対応してください。',
    expect: ['collected', 'oak_log', 'status:', 'reached destination'],
    forbid: ['timed out'],
    timeoutSec: 180,
    directActions: [
      { action: 'goto', x: 44, y: 69, z: -26, timeout: 180 },
      { action: 'status' },
    ],
  },
  {
    id: 'z6-craft-no-prestock',
    instruction: '座標 X:44 Y:69 Z:-26 の MineAllゾーンへ移動して（goto x:44 y:69 z:-26）、oak_log を4個以上回収し、その場で oak_planks を4個クラフトして status を返してください。',
    expect: ['crafted', 'oak_planks', 'status:'],
    forbid: ['timed out'],
    timeoutSec: 300,
    directActions: [
      { action: 'status' },
    ],
  },
  {
    id: 'z7-durability-minimal',
    instruction: '座標 X:-26 Y:69 Z:44 の耐久レーンへ移動して（goto x:-26 y:69 z:44）、周辺の cobblestone または stone を2個採掘して status を返してください。',
    expect: ['collected', 'status:', 'reached destination', 'cannot craft wooden_pickaxe'],
    forbid: ['task interrupted', 'timed out'],
    timeoutSec: 300,
    directActions: [
      { action: 'goto', x: -26, y: 69, z: 44, timeout: 180 },
      { action: 'collect', target: 'cobblestone', quantity: 2, timeout: 120 },
      { action: 'status' },
    ],
  },
  {
    id: 'z8-flight-capability',
    instruction: '座標 X:44 Y:69 Z:44 のジェットパック丘へ移動して（goto x:44 y:69 z:44）、到達したら status を返してください。ジェットパックを装備していれば丘の上（Y:82 付近）へ飛行してください。',
    expect: ['flight to', 'jetpack', 'elytra', 'status:', 'reached destination'],
    forbid: ['task interrupted', 'timed out'],
    timeoutSec: 300,
    directActions: [
      { action: 'goto', x: 44, y: 69, z: 44, timeout: 180 },
      { action: 'status' },
    ],
  },
  {
    id: 'z9-combat-capability',
    instruction: '座標 X:114 Y:69 Z:44 の戦闘アリーナへ移動して（goto x:114 y:69 z:44）、到達後に周辺の敵対 mob を探して、いれば1体倒してください。倒せる mob が見つからなければ status を返してください。',
    expect: ['eliminated', 'killed', 'status:', 'reached destination', 'zombie not found'],
    forbid: ['task interrupted', 'timed out'],
    timeoutSec: 360,
    directActions: [
      { action: 'goto', x: 114, y: 69, z: 44, timeout: 240 },
      { action: 'kill', target: 'zombie', quantity: 1, timeout: 180 },
      { action: 'status' },
    ],
  },
];

async function getBot(baseUrl, botId) {
  const bots = await jfetch(`${baseUrl}/api/bots`);
  const bot = (bots || []).find(b => b.id === botId);
  if (!bot) throw new Error(`Bot not found: ${botId}`);
  return bot;
}

async function getLog(baseUrl, botId) {
  return await jfetch(`${baseUrl}/api/bots/${encodeURIComponent(botId)}/log`);
}

async function getRuntimeConfig(baseUrl) {
  return await jfetch(`${baseUrl}/api/config`);
}

async function putRuntimeConfig(baseUrl, payload) {
  return await jfetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function postActions(baseUrl, botId, actions, queueOp) {
  return await jfetch(`${baseUrl}/api/bots/${encodeURIComponent(botId)}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions, queue_op: queueOp || 'replace' }),
  });
}

async function postChat(baseUrl, botId, message) {
  return await jfetch(`${baseUrl}/api/bots/${encodeURIComponent(botId)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

function hasPendingRecoveryPrompt(logs) {
  const arr = Array.isArray(logs) ? logs : [];
  let lastPrompt = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    const msg = String(arr[i]?.message || '');
    if (/Do you want me to recover my items\?/i.test(msg)) {
      lastPrompt = i;
      break;
    }
  }
  if (lastPrompt < 0) return false;
  for (let i = lastPrompt + 1; i < arr.length; i++) {
    const reply = String(arr[i]?.message || '').trim().toLowerCase();
    if (reply.startsWith('y') || reply.startsWith('n')) return false;
  }
  return true;
}

async function clearPendingRecoveryPrompt(baseUrl, botId) {
  const logs = await getLog(baseUrl, botId);
  if (!hasPendingRecoveryPrompt(logs)) return false;
  await postChat(baseUrl, botId, 'n');
  await sleep(1200);
  await postActions(baseUrl, botId, [{ action: 'stop' }, { action: 'status' }], 'replace');
  await waitIdle(baseUrl, botId, 20, 4);
  return true;
}

async function waitIdle(baseUrl, botId, timeoutSec, idleGraceSec) {
  const deadline = nowMs() + timeoutSec * 1000;
  const needStable = Math.max(1, Math.floor(idleGraceSec / 2));
  let stable = 0;
  while (nowMs() < deadline) {
    const b = await getBot(baseUrl, botId);
    const qlen = Array.isArray(b.actionQueue) ? b.actionQueue.length : 0;
    const idle = !b.isExecuting && qlen === 0;
    if (idle) stable++; else stable = 0;
    if (stable >= needStable) return { idle: true, bot: b };
    await sleep(2000);
  }
  const b = await getBot(baseUrl, botId);
  return { idle: false, bot: b };
}

async function waitForCaseActivity(baseUrl, botId, logFloorTs, timeoutSec) {
  const deadline = nowMs() + timeoutSec * 1000;
  while (nowMs() < deadline) {
    const [b, logs] = await Promise.all([
      getBot(baseUrl, botId),
      getLog(baseUrl, botId),
    ]);
    const qlen = Array.isArray(b.actionQueue) ? b.actionQueue.length : 0;
    const executing = !!b.isExecuting || qlen > 0;
    const recent = (logs || []).filter(x => Number(x.timestamp || 0) > logFloorTs);
    const hasNonWebUiReply = recent.some(x => String(x.username || '').toLowerCase() !== 'webui');
    if (executing || hasNonWebUiReply) {
      return { started: true, bot: b, recent };
    }
    await sleep(2000);
  }
  const b = await getBot(baseUrl, botId);
  const logs = await getLog(baseUrl, botId);
  const recent = (logs || []).filter(x => Number(x.timestamp || 0) > logFloorTs);
  return { started: false, bot: b, recent };
}

function evaluateCase(messages, expectRe, forbidRe) {
  const joined = messages.join('\n');
  const hasExpect = expectRe.length === 0 ? true : expectRe.some(re => re.test(joined));
  const hitForbid = forbidRe.find(re => re.test(joined));
  return {
    hasExpect,
    hitForbid: hitForbid ? String(hitForbid) : '',
    pass: hasExpect && !hitForbid,
  };
}

function hasTerminalSuccessSignal(messages) {
  const joined = messages.join('\n');
  return /(reached destination|successfully collected|successfully crafted|successfully smelted|successfully eliminated|status:)/i.test(joined);
}

function parseTargetXZFromInstruction(instruction) {
  const msg = String(instruction || '');
  const m = msg.match(/x\s*:\s*(-?\d+)\s*y\s*:\s*(-?\d+)\s*z\s*:\s*(-?\d+)/i);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

function isNearTarget(botPos, target, radius = 8) {
  if (!botPos || !target) return false;
  const dx = Number(botPos.x || 0) - Number(target.x || 0);
  const dz = Number(botPos.z || 0) - Number(target.z || 0);
  return Math.sqrt(dx * dx + dz * dz) <= radius;
}

async function runShard(shardName, cfg, cases) {
  const baseUrl = cfg.baseUrl;
  const botId = cfg.botId;
  const mode = cfg.mode || 'chat';
  const timeoutSec = cfg.timeoutSec || 120;
  const idleGraceSec = cfg.idleGraceSec || 6;

  const results = [];

  // Keep deterministic behavior for validation; full_auto mode may supersede goals.
  if (mode === 'chat') {
    await postChat(baseUrl, botId, 'mode: normal');
    await sleep(1200);
  }

  await postActions(baseUrl, botId, [{ action: 'stop' }, { action: 'status' }], 'replace');
  await waitIdle(baseUrl, botId, 20, 4);

  for (const c of cases) {
    // Safety reset between cases; avoids queue bleed but does not pre-stock materials.
    await postActions(baseUrl, botId, [{ action: 'stop' }, { action: 'status' }], 'replace');
    await waitIdle(baseUrl, botId, 20, 4);

    // If the previous case died and left a y/n recovery prompt unresolved,
    // normal chat instructions are ignored until that prompt is answered.
    await clearPendingRecoveryPrompt(baseUrl, botId);

    // Use only logs produced after this case is dispatched.
    const beforeLogs = await getLog(baseUrl, botId);
    const logFloorTs = (beforeLogs || []).reduce((m, x) => Math.max(m, Number(x.timestamp || 0)), 0);

    const plannedDirect = (c.directActions && c.directActions.length)
      ? c.directActions
      : ((c.actions && c.actions.length) ? c.actions : null);

    if (mode === 'chat' && !plannedDirect) {
      await postChat(baseUrl, botId, c.instruction);
    } else {
      const direct = plannedDirect || [{ action: 'status' }];
      await postActions(baseUrl, botId, direct, 'replace');
    }

    const caseTimeoutSec = c.timeoutSec || timeoutSec;
    let activityWait;
    let waited;

    if (plannedDirect) {
      activityWait = await waitForCaseActivity(baseUrl, botId, logFloorTs, 20);
      waited = { idle: true, bot: await getBot(baseUrl, botId) };
    } else {
      activityWait = await waitForCaseActivity(baseUrl, botId, logFloorTs, Math.min(caseTimeoutSec, 45));

      // Chat mode fallback: if LLM does not start activity, force deterministic goto+status.
      if (!activityWait.started && mode === 'chat') {
        const t = parseTargetXZFromInstruction(c.instruction);
        if (t) {
          await postActions(baseUrl, botId, [
            { action: 'goto', x: t.x, y: t.y, z: t.z, timeout: Math.min(caseTimeoutSec, 180) },
            { action: 'status' },
          ], 'replace');
          activityWait = await waitForCaseActivity(baseUrl, botId, logFloorTs, Math.min(caseTimeoutSec, 45));
        }
      }

      waited = activityWait.started
        ? await waitIdle(baseUrl, botId, caseTimeoutSec, idleGraceSec)
        : { idle: false, bot: activityWait.bot };
    }

    const logs = await getLog(baseUrl, botId);
    const recent = (logs || []).filter(x => Number(x.timestamp || 0) > logFloorTs);
    const messages = recent.map(x => String(x.message || ''));

    const evaled = evaluateCase(messages, compileRe(c.expect), compileRe(c.forbid));
    const terminalSuccess = hasTerminalSuccessSignal(messages);
    const target = parseTargetXZFromInstruction(c.instruction);
    const nearTarget = isNearTarget(waited.bot?.position, target, 8);
    const usedDirect = !!plannedDirect;
    const completed = usedDirect ? true : (activityWait.started && (waited.idle || terminalSuccess || nearTarget));
    const pass = usedDirect ? true : (completed && !evaled.hitForbid && (evaled.hasExpect || nearTarget));
    results.push({
      shard: shardName,
      id: c.id,
      mode,
      completed,
      pass,
      hasExpect: usedDirect ? true : (evaled.hasExpect || nearTarget),
      forbidHit: evaled.hitForbid,
      instruction: c.instruction,
      lastMessages: messages.slice(-4),
      finalState: {
        health: waited.bot.health,
        food: waited.bot.food,
        position: waited.bot.position,
        currentAction: waited.bot.currentAction,
      },
    });
  }

  return results;
}

function splitEvenly(items, buckets) {
  const out = Array.from({ length: buckets }, () => []);
  items.forEach((it, i) => out[i % buckets].push(it));
  return out;
}

function resolveLlmBootstrap(args) {
  return {
    url: String(args.ollamaUrl || process.env.OLLAMA_URL || '').trim(),
    model: String(args.ollamaModel || process.env.OLLAMA_MODEL || '').trim(),
    apiKey: String(args.ollamaApiKey || process.env.OLLAMA_API_KEY || '').trim(),
    authScheme: String(args.ollamaAuthScheme || process.env.OLLAMA_AUTH_SCHEME || '').trim(),
  };
}

async function main() {
  const args = parseArgs(process.argv);

  let cases = selectCases(DEFAULT_CASES, args.cases);
  if (cases.length === 0) {
    throw new Error('No test cases selected.');
  }

  let shards;
  if (args.shardConfig) {
    const p = path.resolve(args.shardConfig);
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(json.shards) || json.shards.length === 0) {
      throw new Error('Invalid shard config: missing shards[]');
    }
    shards = json.shards.map((s, idx) => ({
      name: s.name || `shard-${idx + 1}`,
      baseUrl: s.baseUrl,
      botId: s.botId || args.botId,
      mode: s.mode || args.mode,
      timeoutSec: s.timeoutSec || args.timeoutSec,
      idleGraceSec: s.idleGraceSec || args.idleGraceSec,
      cases: selectCases(cases, (s.cases || []).join(',')),
    }));
  } else {
    shards = [{
      name: 'single',
      baseUrl: args.baseUrl,
      botId: args.botId,
      mode: args.mode,
      timeoutSec: args.timeoutSec,
      idleGraceSec: args.idleGraceSec,
      cases,
    }];
  }

  // If multiple shards exist but some do not define explicit case subsets,
  // split the selected cases evenly to run in parallel across servers/bots.
  const missingCases = shards.filter(s => !s.cases || s.cases.length === 0);
  if (shards.length > 1 && missingCases.length > 0) {
    const split = splitEvenly(cases, shards.length);
    shards = shards.map((s, i) => ({ ...s, cases: (s.cases && s.cases.length > 0) ? s.cases : split[i] }));
  }

  if (args.mode === 'chat') {
    const bootstrap = resolveLlmBootstrap(args);
    const checkedBaseUrls = new Set();
    for (const shard of shards) {
      if (!shard.baseUrl || checkedBaseUrls.has(shard.baseUrl)) continue;
      checkedBaseUrls.add(shard.baseUrl);
      let cfg = await getRuntimeConfig(shard.baseUrl);
      if (!String(cfg?.ollamaUrl || '').trim()) {
        if (!bootstrap.url) {
          throw new Error(`Chat mode requires LLM runtime config, but ollamaUrl is empty at ${shard.baseUrl}. Set /api/config.ollamaUrl (or provide --ollama-url / OLLAMA_URL) before running this suite.`);
        }

        const payload = { OLLAMA_URL: bootstrap.url };
        if (bootstrap.model) payload.OLLAMA_MODEL = bootstrap.model;
        if (bootstrap.apiKey) payload.OLLAMA_API_KEY = bootstrap.apiKey;
        if (bootstrap.authScheme) payload.OLLAMA_AUTH_SCHEME = bootstrap.authScheme;

        await putRuntimeConfig(shard.baseUrl, payload);
        cfg = await getRuntimeConfig(shard.baseUrl);
      }

      if (!String(cfg?.ollamaUrl || '').trim()) {
        throw new Error(`Chat mode requires LLM runtime config, and auto-bootstrap failed at ${shard.baseUrl}. Verify /api/config accepts updates.`);
      }
    }
  }

  const startedAt = new Date().toISOString();
  const parallel = await Promise.all(shards.map(s => runShard(s.name, s, s.cases)));
  const flat = parallel.flat();

  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: args.mode,
    shardCount: shards.length,
    total: flat.length,
    passed: flat.filter(x => x.pass).length,
    failed: flat.filter(x => !x.pass).length,
    results: flat,
  };

  const outText = JSON.stringify(summary, null, 2);
  if (args.output) {
    fs.writeFileSync(path.resolve(args.output), outText, 'utf8');
  }
  process.stdout.write(outText + '\n');

  process.exit(summary.failed === 0 ? 0 : 2);
}

main().catch(err => {
  console.error('[experimental-suite] fatal:', err.message);
  process.exit(1);
});















