import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import {
  PHASE,
  nowTime,
  formatCardLabel,
  ensureCardCompiled,
  parseFighters,
  selfTestFighters,
  createInitialState,
  buildContextForBattle,
  settleEffects,
  applyDeltas,
  checkWinner,
  enterConstructionIfNeeded,
  applyConstructionChoice,
  beginNextConstructionStep,
  triggerHpRulesAtCurrentHp,
  commitFlips,
} from "./shared/game-logic.js";

import {
  C_JOIN_ROOM, C_ICON_SELECT, C_PICK_FIGHTERS, C_DECK_ORDER,
  C_ADVANCE_BATTLE, C_ELF_PICK, C_CONSTRUCTION_CHOICE, C_CONFIRM_END, C_CONFIRM_INSERT_DISPLAY,
  S_GALLERY_INIT, S_ICON_PENDING, S_ICON_HINT, S_ICON_EXPIRED, S_PAIRED,
  S_ROOM_JOINED, S_OPPONENT_JOINED,
  S_OPPONENT_DISCONNECTED,
  S_PICKS_LOCKED, S_GAME_START,
  S_WAITING, S_ELF_PICK_NEEDED,
  S_GAME_OVER, S_STATE_SYNC, S_ERROR,
  makeMsg, parseMsg,
} from "./shared/protocol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 2603;

// ─── Static file serving (unchanged) ────────────────────────────────────────

const MIME_BY_EXT = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"],
]);

function safeResolve(rootDir, requestPathname) {
  const decoded = decodeURIComponent(requestPathname);
  const normalized = decoded.replaceAll("\\", "/");
  const clean = normalized.split("?")[0].split("#")[0];
  const rel = clean.startsWith("/") ? clean.slice(1) : clean;
  const abs = path.resolve(rootDir, rel);
  const rootAbs = path.resolve(rootDir);
  if (!abs.startsWith(rootAbs)) return null;
  return abs;
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT.get(ext) ?? "application/octet-stream";
}

function decodeTxtToUtf8(buffer) {
  const cutoff = buffer.indexOf(0x1a);
  const sliced = cutoff >= 0 ? buffer.subarray(0, cutoff) : buffer;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(sliced);
  } catch {
    return new TextDecoder("gb18030").decode(sliced);
  }
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (!req.url) { res.writeHead(400); res.end("Bad Request"); return; }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = safeResolve(__dirname, pathname);
    if (!filePath) { res.writeHead(403); res.end("Forbidden"); return; }
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const IMAGE_CONTENT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"]);
    const cacheControl = IMAGE_CONTENT.has(ext)
      ? "public, max-age=86400"          // images: cache 1 day
      : "no-cache";                       // html/js/css: revalidate every time
    res.writeHead(200, { "Content-Type": guessContentType(filePath), "Cache-Control": cacheControl });
    if (ext === ".txt") { res.end(decodeTxtToUtf8(data)); return; }
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not Found");
  }
});

// ─── Load game data at startup ──────────────────────────────────────────────

let fighterDefs = [];
let fighterPoolByName = new Map();
let galleryPool = []; // all icon filenames from gallery/

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

async function loadGameData() {
  const fightersTxt = decodeTxtToUtf8(await readFile(path.join(__dirname, "战士库.txt")));
  fighterDefs = parseFighters(fightersTxt);
  fighterPoolByName = new Map(fighterDefs.map((f) => [f.name, f]));
  const warnings = selfTestFighters(fighterDefs);
  for (const w of warnings) console.log(`[self-test] ${w}`);
  console.log(`Loaded ${fighterDefs.length} fighters.`);

  // Scan gallery/ for icon images
  const galleryDir = path.join(__dirname, "gallery");
  const files = await readdir(galleryDir);
  galleryPool = files.filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  console.log(`Loaded ${galleryPool.length} gallery icons.`);
}

// ─── Room management ────────────────────────────────────────────────────────

const rooms = new Map();
const ROOM_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = generateRoomCode();
  const room = {
    code,
    phase: "lobby", // lobby | picking | ordering | playing | done
    sockets: { p1: null, p2: null },
    disconnectTimers: { p1: null, p2: null },
    picks: { p1: null, p2: null },
    deckOrder: { p1: null, p2: null },
    gameState: null,
    log: [],
    fighterNames: fighterDefs.map((f) => f.name),
  };
  rooms.set(code, room);
  return room;
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimeout(room.disconnectTimers.p1);
  clearTimeout(room.disconnectTimers.p2);
  rooms.delete(code);
}

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === 1) ws.send(makeMsg(type, payload));
}

function sendBoth(room, type, payload = {}) {
  send(room.sockets.p1, type, payload);
  send(room.sockets.p2, type, payload);
}

function sendEach(room, type, payloadFn) {
  for (const pid of ["p1", "p2"]) {
    send(room.sockets[pid], type, payloadFn(pid));
  }
}

function oppOf(pid) { return pid === "p1" ? "p2" : "p1"; }

// ─── Gallery matchmaking ─────────────────────────────────────────────────────

// pendingSelections: iconId → { ws, timer }
const pendingSelections = new Map();
// Track per-client: which 9 icons they were dealt + their current pending iconId
// ws._galleryIcons = ["file1.jpg", ...] (the 9 dealt to this client)
// ws._pendingIconId = "file1.jpg" | null

function pickRandomIcons(n) {
  const shuffled = [...galleryPool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function sendGalleryInit(ws) {
  const icons = pickRandomIcons(9);
  ws._galleryIcons = icons;
  ws._pendingIconId = null;
  send(ws, S_GALLERY_INIT, { icons: icons.map((f) => ({ id: f, filename: f })) });
}

function clearPendingSelection(ws) {
  const iconId = ws._pendingIconId;
  if (!iconId) return;
  const entry = pendingSelections.get(iconId);
  if (entry && entry.ws === ws) {
    clearTimeout(entry.timer);
    pendingSelections.delete(iconId);
  }
  ws._pendingIconId = null;
}

function onIconSelect(ws, msg) {
  const iconId = msg.iconId;
  if (!iconId || !ws._galleryIcons || !ws._galleryIcons.includes(iconId)) return;
  if (ws._roomCode) return; // already in a room

  // Clear any previous pending selection by this client
  clearPendingSelection(ws);

  // Check if another client already selected this icon
  const existing = pendingSelections.get(iconId);
  if (existing && existing.ws !== ws && existing.ws.readyState === 1) {
    // Match! Pair them.
    clearTimeout(existing.timer);
    pendingSelections.delete(iconId);
    existing.ws._pendingIconId = null;
    ws._pendingIconId = null;

    // Create room and pair
    const room = createRoom();
    room.sockets.p1 = existing.ws;
    room.sockets.p2 = ws;
    existing.ws._roomCode = room.code;
    existing.ws._playerId = "p1";
    ws._roomCode = room.code;
    ws._playerId = "p2";
    room.phase = "picking";

    send(existing.ws, S_PAIRED, { playerId: "p1", roomCode: room.code, fighterNames: room.fighterNames, matchedIconId: iconId });
    send(ws, S_PAIRED, { playerId: "p2", roomCode: room.code, fighterNames: room.fighterNames, matchedIconId: iconId });
    return;
  }

  // No match yet — store as pending
  const timer = setTimeout(() => {
    if (pendingSelections.get(iconId)?.ws === ws) {
      pendingSelections.delete(iconId);
      ws._pendingIconId = null;
      send(ws, S_ICON_EXPIRED, {});
    }
  }, 2000);

  pendingSelections.set(iconId, { ws, timer });
  ws._pendingIconId = iconId;
  send(ws, S_ICON_PENDING, { iconId });

  // Send hint to all other unmatched clients who have this icon in their 9
  for (const client of wss.clients) {
    if (client !== ws && client.readyState === 1 && !client._roomCode &&
        client._galleryIcons && client._galleryIcons.includes(iconId)) {
      send(client, S_ICON_HINT, { iconId });
    }
  }
}

// ─── State serialization (strip functions, convert Maps) ────────────────────

function serializeFighter(f) {
  if (!f) return null;
  const o = { ...f };
  o.flame = { ...f.flame };
  o.ning = { ...f.ning };
  if (f.elf) o.elf = { ...f.elf, spirits: f.elf.spirits?.map((s) => ({ ...s, hpRules: s.hpRules })) };
  if (f.plan) o.plan = { ...f.plan };
  if (f.planTexts) o.planTexts = [...f.planTexts];
  if (f.koLines) o.koLines = [...f.koLines];
  o.hpRules = f.hpRules; // read-only for display
  return o;
}

function serializeCard(c) {
  if (!c) return null;
  return {
    id: c.id,
    fighterName: c.fighterName,
    fighterAlias: c.fighterAlias,
    fighterCode: c.fighterCode,
    cardNo: c.cardNo,
    cardName: c.cardName,
    text: c.text,
    flipped: c.flipped,
  };
}

function serializePlayer(player, hideDecks) {
  const p = {
    id: player.id,
    fighters: player.fighters.map(serializeFighter),
    battleDeckCount: player.battleDeck.length,
    resolvedPileCount: player.resolvedPile.length,
    constructionDeckCount: player.constructionDeck.length,
  };
  // Only show deck contents to the owning player
  if (!hideDecks) {
    p.battleDeck = player.battleDeck.map(serializeCard);
    p.resolvedPile = player.resolvedPile.map(serializeCard);
    p.constructionDeck = player.constructionDeck.map(serializeCard);
  }
  return p;
}

function serializeMap(m) {
  if (!m || typeof m.entries !== "function") return {};
  const o = {};
  for (const [k, v] of m.entries()) o[k] = v;
  return o;
}

function serializeSet(s) {
  if (!s || typeof s.values !== "function") return [];
  return [...s.values()];
}

function serializeLastRound(lr) {
  if (!lr) return null;
  return {
    round: lr.round,
    turn: lr.turn,
    before: serializeMap(lr.before),
    after: serializeMap(lr.after),
    hpTraceById: serializeMap(lr.hpTraceById),
    planEvents: lr.planEvents ?? [],
    guardBlockedByPlayerId: serializeSet(lr.guardBlockedByPlayerId),
    flipTriggeredByCardId: serializeSet(lr.flipTriggeredByCardId),
  };
}

function serializeLastFlip(lf) {
  if (!lf) return null;
  return {
    round: lf.round,
    turn: lf.turn,
    p1Card: serializeCard(lf.p1Card),
    p2Card: serializeCard(lf.p2Card),
    p1FlippedAtStart: lf.p1FlippedAtStart,
    p2FlippedAtStart: lf.p2FlippedAtStart,
  };
}

function serializeStateForPlayer(state, pid) {
  if (!state) return null;
  const opp = oppOf(pid);
  return {
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    awaitingConstruction: state.awaitingConstruction,
    pendingGameOver: state.pendingGameOver,
    pendingElfPickByPlayer: state.pendingElfPickByPlayer,
    pendingDoubleQueue: state.pendingDoubleQueue,
    lastFlip: serializeLastFlip(state.lastFlip),
    lastRound: serializeLastRound(state.lastRound),
    lastIntermissionEffect: state.lastIntermissionEffect
      ? { before: serializeMap(state.lastIntermissionEffect.before), after: serializeMap(state.lastIntermissionEffect.after) }
      : null,
    compareHold: false,
    players: {
      [pid]: serializePlayer(state.players[pid], false),
      [opp]: serializePlayer(state.players[opp], true),
    },
    construction: {
      [pid]: state.construction[pid]
        ? {
            drawn: state.construction[pid].drawn.map(serializeCard),
            insertIndex: state.construction[pid].insertIndex,
            insertPos: state.construction[pid].insertPos,
            previewPos: state.construction[pid].previewPos,
            dragging: state.construction[pid].dragging,
            bottomOrder: state.construction[pid].bottomOrder,
          }
        : null,
      [opp]: state.construction[opp] ? "pending" : null, // just a flag, no details
      active: state.construction.active,
    },
    winner: state.winner,
    doubleNextByPlayer: state.doubleNextByPlayer,
    pendingOnInsertDisplay: state.pendingOnInsertDisplay || false,
    onInsertSummary: state.onInsertSummary || null,
  };
}

// ─── Server-side game logic (mirrors battleTurn from app.js) ────────────────

function snapshotFightersState(state) {
  const m = new Map();
  for (const pid of ["p1", "p2"]) {
    for (const f of state.players[pid].fighters) {
      m.set(f.id, { hp: f.hp, power: f.power });
    }
  }
  return m;
}

function roomPushLog(room, line) {
  const ts = nowTime();
  room.log.push(`[${ts}] ${line}`);
}

function serverBattleTurn(room) {
  const state = room.gameState;
  if (state.phase !== PHASE.BATTLE) return;
  if (state.awaitingConstruction) return;
  if (state.pendingGameOver) return;
  const p1 = state.players.p1;
  const p2 = state.players.p2;
  const pushLog = (line) => roomPushLog(room, line);

  // Handle pending double (golem rebirth)
  if (Array.isArray(state.pendingDoubleQueue) && state.pendingDoubleQueue.length > 0) {
    const pid = state.pendingDoubleQueue.shift();
    const lf = state.lastFlip;
    const p1Card = lf?.p1Card;
    const p2Card = lf?.p2Card;
    if (!pid || !p1Card || !p2Card) {
      state.pendingDoubleQueue = [];
      return;
    }
    state.lastIntermissionEffect = null;
    const beforeSnapshot = snapshotFightersState(state);
    pushLog(`土偶重生：结算第二次（${pid.toUpperCase()} ${formatCardLabel(pid === "p1" ? p1Card : p2Card)}）`);
    const ctx = buildContextForBattle(p1, p2, p1Card, p2Card);
    for (const f of [...p1.fighters, ...p2.fighters]) f.snakeFlipMark = null;
    const p1Effects = ensureCardCompiled(p1Card);
    const p2Effects = ensureCardCompiled(p2Card);
    const settlement = settleEffects({
      ctx, myCard: p1Card, oppCard: p2Card,
      myEffects: p1Effects, oppEffects: p2Effects,
      myPlayer: p1, oppPlayer: p2,
      // onlySide removed: after first settlement, cards may be flipped,
      // so both sides need to re-settle with updated (flipped) effects
      guardAtStartById: lf?.guardAtStartById,
    });
    commitFlips(settlement.flipTriggeredByCardId, p1Card, p2Card);
    for (const line of settlement.log) pushLog(line);
    if (settlement?.golemRebirthByPlayerId?.size) {
      for (const x of settlement.golemRebirthByPlayerId) state.doubleNextByPlayer[x] = true;
    }
    const applied = applyDeltas(
      state, settlement.hpDelta, settlement.powerDelta, beforeSnapshot,
      lf?.guardAtStartById,
      settlement?.blockActiveByPlayerId ?? null,
      settlement?.blockInnerByPlayerId ?? null,
    );
    for (const line of applied?.log ?? []) pushLog(line);
    const hpTraceById = applied?.hpTraceById ?? new Map();
    const planEvents = [...(settlement.planEvents ?? []), ...(applied?.planEvents ?? [])];
    if (settlement?.removeBothCardsFromGame === true) {
      pushLog(`移除游戏：P1 ${formatCardLabel(p1Card)} / P2 ${formatCardLabel(p2Card)}`);
      p1.resolvedPile = p1.resolvedPile.filter((c) => c !== p1Card);
      p2.resolvedPile = p2.resolvedPile.filter((c) => c !== p2Card);
    }
    const afterSnapshot = snapshotFightersState(state);
    const guardBlocked = new Set([...(settlement?.guardBlockedByPlayerId ?? []), ...(applied?.guardBlockedByPlayerId ?? [])]);
    const flipTriggered = settlement?.flipTriggeredByCardId && typeof settlement.flipTriggeredByCardId[Symbol.iterator] === "function" ? new Set(settlement.flipTriggeredByCardId) : new Set();
    state.lastRound = { round: state.round, turn: state.turn, before: beforeSnapshot, after: afterSnapshot, hpTraceById, planEvents, guardBlockedByPlayerId: guardBlocked, flipTriggeredByCardId: flipTriggered };
    logSettlementChanges(state, beforeSnapshot, afterSnapshot, pushLog);

    if (!state.pendingDoubleQueue.length) {
      processAllElfRoundEnd(state, pushLog);
    }

    checkEndConditions(state, settlement, pushLog);
    return;
  }

  // Normal turn
  if (state.pendingElfPickByPlayer?.p1 || state.pendingElfPickByPlayer?.p2) return;
  if (p1.battleDeck.length === 0 || p2.battleDeck.length === 0) return;

  const plannedDoubleQueue = [];
  if (state.doubleNextByPlayer?.p1 === true) { plannedDoubleQueue.push("p1"); state.doubleNextByPlayer.p1 = false; }
  if (state.doubleNextByPlayer?.p2 === true) { plannedDoubleQueue.push("p2"); state.doubleNextByPlayer.p2 = false; }

  state.lastIntermissionEffect = null;
  const beforeSnapshot = snapshotFightersState(state);
  const p1Card = p1.battleDeck.shift();
  const p2Card = p2.battleDeck.shift();
  state.lastFlip = {
    round: state.round, turn: state.turn, p1Card, p2Card,
    p1FlippedAtStart: p1Card?.flipped === true,
    p2FlippedAtStart: p2Card?.flipped === true,
  };
  pushLog(`翻牌（轮次${state.round}回合${state.turn}）：P1 ${formatCardLabel(p1Card)} / P2 ${formatCardLabel(p2Card)}`);

  const ctx = buildContextForBattle(p1, p2, p1Card, p2Card);
  state.lastFlip.guardAtStartById = new Map([...p1.fighters, ...p2.fighters].map((f) => [f.id, f?.guard === true]));
  for (const f of [...p1.fighters, ...p2.fighters]) f.snakeFlipMark = null;
  const p1Effects = ensureCardCompiled(p1Card);
  const p2Effects = ensureCardCompiled(p2Card);

  const settlement = settleEffects({
    ctx, myCard: p1Card, oppCard: p2Card,
    myEffects: p1Effects, oppEffects: p2Effects,
    myPlayer: p1, oppPlayer: p2,
    guardAtStartById: state.lastFlip.guardAtStartById,
  });
  commitFlips(settlement.flipTriggeredByCardId, p1Card, p2Card);
  for (const line of settlement.log) pushLog(line);
  if (settlement?.golemRebirthByPlayerId?.size) {
    for (const x of settlement.golemRebirthByPlayerId) state.doubleNextByPlayer[x] = true;
  }

  const applied = applyDeltas(
    state, settlement.hpDelta, settlement.powerDelta, beforeSnapshot,
    state.lastFlip.guardAtStartById,
    settlement?.blockActiveByPlayerId ?? null,
    settlement?.blockInnerByPlayerId ?? null,
  );
  for (const line of applied?.log ?? []) pushLog(line);
  const hpTraceById = applied?.hpTraceById ?? new Map();
  const planEvents = [...(settlement.planEvents ?? []), ...(applied?.planEvents ?? [])];

  if (settlement?.removeBothCardsFromGame === true) {
    pushLog(`移除游戏：P1 ${formatCardLabel(p1Card)} / P2 ${formatCardLabel(p2Card)}`);
  } else {
    p1.resolvedPile.unshift(p1Card);
    p2.resolvedPile.unshift(p2Card);
  }
  const afterSnapshot = snapshotFightersState(state);
  const guardBlocked = new Set([...(settlement?.guardBlockedByPlayerId ?? []), ...(applied?.guardBlockedByPlayerId ?? [])]);
  const flipTriggered = settlement?.flipTriggeredByCardId && typeof settlement.flipTriggeredByCardId[Symbol.iterator] === "function" ? new Set(settlement.flipTriggeredByCardId) : new Set();
  state.lastRound = { round: state.round, turn: state.turn, before: beforeSnapshot, after: afterSnapshot, hpTraceById, planEvents, guardBlockedByPlayerId: guardBlocked, flipTriggeredByCardId: flipTriggered };
  logSettlementChanges(state, beforeSnapshot, afterSnapshot, pushLog);

  if (plannedDoubleQueue.length) {
    state.pendingDoubleQueue = plannedDoubleQueue;
    return;
  }

  processAllElfRoundEnd(state, pushLog);
  checkEndConditions(state, settlement, pushLog);
}

function logSettlementChanges(state, beforeSnapshot, afterSnapshot, pushLog) {
  for (const [id, a] of afterSnapshot.entries()) {
    const b = beforeSnapshot.get(id);
    if (!b) continue;
    const dh = (a.hp ?? 0) - (b.hp ?? 0);
    const dp = (a.power ?? 0) - (b.power ?? 0);
    if (dh === 0 && dp === 0) continue;
    const f = [...state.players.p1.fighters, ...state.players.p2.fighters].find((x) => x.id === id);
    const name = f?.name ?? id;
    const pid = String(id).split(":")[0];
    const who = pid === "p2" ? "P2" : "P1";
    const parts = [];
    if (dh !== 0) parts.push(`HP ${dh > 0 ? "+" : ""}${dh}`);
    if (dp !== 0) parts.push(`力量 ${dp > 0 ? "+" : ""}${dp}`);
    pushLog(`结算变化：${who} ${name}（${parts.join("，")}）`);
  }
}

function processAllElfRoundEnd(state, pushLog) {
  if (!state.pendingElfPickByPlayer) return;
  for (const playerId of ["p1", "p2"]) {
    const player = state.players[playerId];
    const elf = player?.fighters?.find?.((f) => f?.name === "精灵族");
    if (!elf || !elf.elf) continue;
    if (elf.elf.gameKo === true) continue;
    const active = elf.elf.active;
    const dead = Array.isArray(elf.elf.dead) ? elf.elf.dead : [false, false, false];
    elf.elf.dead = dead;
    if (active == null) {
      state.pendingElfPickByPlayer[playerId] = dead.some((x) => x === false);
      continue;
    }
    if (dead[active] === true) continue;
    if (Number(elf.hp) > Number(elf.koLine)) continue;
    const alreadyPending = Number.isFinite(elf.elf.pendingKoIndex) && elf.elf.pendingKoIndex !== null;
    if (alreadyPending) continue;
    elf.elf.pendingKoIndex = active;
    elf.elf.soul = (Number(elf.elf.soul) || 0) + 1;
    const hasAlive = dead.some((x, i) => i !== active && x === false);
    if (hasAlive) {
      state.pendingElfPickByPlayer[playerId] = true;
      pushLog(`灵：${playerId.toUpperCase()} 灵${active + 1} 被KO（魂=${elf.elf.soul}），请选择下一位灵`);
    } else {
      dead[active] = true;
      elf.elf.dead = dead;
      elf.elf.pendingKoIndex = null;
      elf.elf.active = null;
      elf.elf.pendingPick = false;
      elf.hp = 0;
      elf.maxHp = 0;
      elf.hpRules = [];
      state.pendingElfPickByPlayer[playerId] = false;
      pushLog(`灵：${playerId.toUpperCase()} 无存活灵，精灵族进入沉寂（不再受伤/回复）`);
    }
  }
}

function isKoNow(fx) {
  if (fx?.koByFlame === true) return true;
  if (fx?.name === "精灵族") return fx?.elf?.gameKo === true;
  if (Array.isArray(fx.koLines) && fx.koLines.length > 0) return fx.koLines.includes(Number(fx.hp) || 0);
  return Number(fx.hp) <= Number(fx.koLine);
}

function checkEndConditions(state, settlement, pushLog) {
  const p1KO = state.players.p1.fighters.some(isKoNow);
  const p2KO = state.players.p2.fighters.some(isKoNow);
  const flameKoP1 = settlement?.flameKoByPlayerId?.has?.("p1") === true;
  const flameKoP2 = settlement?.flameKoByPlayerId?.has?.("p2") === true;
  const winOnSelfKoP1 = settlement?.winOnSelfKoByPlayer?.get?.("p1") === true;
  const winOnSelfKoP2 = settlement?.winOnSelfKoByPlayer?.get?.("p2") === true;
  const p1ClaimWin = winOnSelfKoP1 && p1KO;
  const p2ClaimWin = winOnSelfKoP2 && p2KO;

  let w = checkWinner(state);
  if (p1ClaimWin || p2ClaimWin) {
    if (p1ClaimWin && p2ClaimWin) {
      w = "draw"; pushLog(`特殊胜负：双方被KO且均触发"被KO则胜利"，最终为平局`);
    } else if (p1ClaimWin) {
      w = "p1"; pushLog(`特殊胜负：P1 被KO且触发"被KO则胜利"，最终 P1 获胜`);
    } else {
      w = "p2"; pushLog(`特殊胜负：P2 被KO且触发"被KO则胜利"，最终 P2 获胜`);
    }
  } else if ((flameKoP1 && !flameKoP2) || (flameKoP2 && !flameKoP1)) {
    w = flameKoP1 ? "p2" : "p1";
    pushLog(`特殊胜负：焰=5 判KO，忽略对方本回合KO判定，最终 ${w.toUpperCase()} 获胜`);
  }

  if (w) {
    state.pendingGameOver = w;
    const koP1 = p1KO ? "KO" : "未KO";
    const koP2 = p2KO ? "KO" : "未KO";
    const resLine = w === "draw" ? "平局" : w === "p1" ? "P1 胜 / P2 败" : "P2 胜 / P1 败";
    pushLog(`游戏结束！${resLine}（P1 ${koP1}，P2 ${koP2}）`);
    return;
  }

  if (state.players.p1.battleDeck.length === 0 && state.players.p2.battleDeck.length === 0) {
    state.awaitingConstruction = true;
    pushLog(`战斗牌库结算完：进入构筑阶段`);
    return;
  }

  state.turn += 1;
}

// ─── Elf pick handler ───────────────────────────────────────────────────────

function handleElfPick(room, playerId, spiritIndex) {
  const state = room.gameState;
  if (!state || state.phase !== PHASE.BATTLE) return false;
  if (!state.pendingElfPickByPlayer?.[playerId]) return false;
  const player = state.players[playerId];
  const elf = player?.fighters?.find?.((f) => f?.name === "精灵族");
  if (!elf || !elf.elf) return false;
  const dead = elf.elf.dead;
  if (!Array.isArray(dead) || dead[spiritIndex] === true) return false;

  const pushLog = (line) => roomPushLog(room, line);

  // If pending KO, mark old spirit dead first
  if (Number.isFinite(elf.elf.pendingKoIndex) && elf.elf.pendingKoIndex !== null) {
    dead[elf.elf.pendingKoIndex] = true;
    elf.elf.pendingKoIndex = null;
  }

  elf.elf.active = spiritIndex;
  elf.elf.pendingPick = false;
  state.pendingElfPickByPlayer[playerId] = false;

  // Set HP/maxHp/hpRules from spirit data
  const spirit = elf.elf.spirits[spiritIndex];
  if (spirit) {
    elf.hp = spirit.maxHp;
    elf.maxHp = spirit.maxHp;
    elf.koLine = 0;
    elf.hpRules = spirit.hpRules ?? [];
  }
  pushLog(`灵：${playerId.toUpperCase()} 选择灵${spiritIndex + 1}（HP=${elf.hp}）`);

  // Trigger HP rules at initial HP (e.g. 灵1 HP=3 → 辅助力量+1)
  triggerHpRulesAtCurrentHp(state, elf.id, pushLog);

  return true;
}

// ─── WebSocket message handling ─────────────────────────────────────────────

function handleMessage(ws, raw) {
  const msg = parseMsg(raw);
  if (!msg) return;
  const { type } = msg;

  switch (type) {
    case C_ICON_SELECT: return onIconSelect(ws, msg);
    case C_JOIN_ROOM: return onJoinRoom(ws, msg);
    case C_PICK_FIGHTERS: return onPickFighters(ws, msg);
    case C_DECK_ORDER: return onDeckOrder(ws, msg);
    case C_ADVANCE_BATTLE: return onAdvanceBattle(ws, msg);
    case C_ELF_PICK: return onElfPick(ws, msg);
    case C_CONSTRUCTION_CHOICE: return onConstructionChoice(ws, msg);
    case C_CONFIRM_INSERT_DISPLAY: return onConfirmInsertDisplay(ws);
    case C_CONFIRM_END: return onConfirmEnd(ws, msg);
  }
}

function onJoinRoom(ws, msg) {
  const code = String(msg.code ?? "").toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) { send(ws, S_ERROR, { message: "房间不存在" }); return; }
  if (room.sockets.p2 && room.sockets.p2 !== ws && room.sockets.p2.readyState === 1) {
    // Check if it's a reconnection for p1
    if (room.sockets.p1 && room.sockets.p1 !== ws && room.sockets.p1.readyState === 1) {
      send(ws, S_ERROR, { message: "房间已满" }); return;
    }
  }

  // Determine which slot to assign
  let pid;
  if (ws._roomCode === code && ws._playerId) {
    pid = ws._playerId; // reconnecting same socket
  } else if (!room.sockets.p2 || room.sockets.p2.readyState !== 1) {
    pid = "p2";
  } else if (!room.sockets.p1 || room.sockets.p1.readyState !== 1) {
    pid = "p1";
  } else {
    send(ws, S_ERROR, { message: "房间已满" }); return;
  }

  room.sockets[pid] = ws;
  ws._roomCode = room.code;
  ws._playerId = pid;
  clearTimeout(room.disconnectTimers[pid]);
  room.disconnectTimers[pid] = null;

  send(ws, S_ROOM_JOINED, { code: room.code, playerId: pid, fighterNames: room.fighterNames });
  send(room.sockets[oppOf(pid)], S_OPPONENT_JOINED, {});

  if (room.sockets.p1?.readyState === 1 && room.sockets.p2?.readyState === 1) {
    if (room.phase === "lobby") {
      room.phase = "picking";
    }
    // If reconnecting mid-game, send full state sync
    if (room.gameState) {
      send(ws, S_STATE_SYNC, {
        state: serializeStateForPlayer(room.gameState, pid),
        log: room.log,
      });
    }
  }
}

function onPickFighters(ws, msg) {
  const room = rooms.get(ws._roomCode);
  const pid = ws._playerId;
  if (!room || !pid || room.phase !== "picking") return;
  const picks = msg.picks;
  if (!Array.isArray(picks) || picks.length !== 2) { send(ws, S_ERROR, { message: "必须选择2位战士" }); return; }
  if (!picks.every((n) => fighterPoolByName.has(n))) { send(ws, S_ERROR, { message: "无效战士名称" }); return; }
  if (picks[0] === picks[1]) { send(ws, S_ERROR, { message: "不能选择相同战士" }); return; }

  // Check opponent hasn't already picked same fighters
  const oppPicks = room.picks[oppOf(pid)];
  if (oppPicks) {
    const oppSet = new Set(oppPicks);
    if (picks.some((n) => oppSet.has(n))) { send(ws, S_ERROR, { message: "对手已选择该战士" }); return; }
  }

  room.picks[pid] = picks;
  if (room.picks.p1 && room.picks.p2) {
    // Validate no overlap
    const p1Set = new Set(room.picks.p1);
    if (room.picks.p2.some((n) => p1Set.has(n))) {
      // Conflict — reject later picker
      room.picks[pid] = null;
      send(ws, S_ERROR, { message: "对手已选择该战士，请重新选择" });
      return;
    }
    room.phase = "ordering";
    sendBoth(room, S_PICKS_LOCKED, {
      p1Picks: room.picks.p1,
      p2Picks: room.picks.p2,
    });
  } else {
    send(room.sockets[oppOf(pid)], S_WAITING, { action: "pick", who: pid });
  }
}

function onDeckOrder(ws, msg) {
  const room = rooms.get(ws._roomCode);
  const pid = ws._playerId;
  if (!room || !pid || room.phase !== "ordering") return;
  const topName = String(msg.topName ?? "");
  if (!topName) { send(ws, S_ERROR, { message: "请选择起手顶牌" }); return; }
  room.deckOrder[pid] = topName;

  if (room.deckOrder.p1 && room.deckOrder.p2) {
    // Both ready — create game state
    const picksByPlayer = {
      p1: room.picks.p1,
      p2: room.picks.p2,
    };
    const startTopByPlayer = {
      p1: room.deckOrder.p1,
      p2: room.deckOrder.p2,
    };
    room.gameState = createInitialState(fighterPoolByName, picksByPlayer, startTopByPlayer);
    room.phase = "playing";
    room.battleReady = { p1: false, p2: false };
    room.log = [];
    roomPushLog(room, `对局开始`);
    sendEach(room, S_GAME_START, (pid) => ({
      state: serializeStateForPlayer(room.gameState, pid),
      log: room.log,
    }));
  } else {
    send(room.sockets[oppOf(pid)], S_WAITING, { action: "order", who: pid });
  }
}

function onAdvanceBattle(ws) {
  const room = rooms.get(ws._roomCode);
  const pid = ws._playerId;
  if (!room || !pid || room.phase !== "playing") return;
  const state = room.gameState;
  if (!state || state.phase !== PHASE.BATTLE) return;

  // Initialize battleReady if missing
  if (!room.battleReady) room.battleReady = { p1: false, p2: false };

  // Prevent double-click from the same player
  if (room.battleReady[pid]) return;
  room.battleReady[pid] = true;

  const opp = oppOf(pid);

  // If opponent hasn't clicked yet, show waiting and notify opponent
  if (!room.battleReady[opp]) {
    send(room.sockets[pid], S_WAITING, { action: "battle_flip" });
    return;
  }

  // Both players ready — reset for next turn
  room.battleReady = { p1: false, p2: false };

  // Auto enter construction if awaiting
  if (state.awaitingConstruction && !state.pendingGameOver) {
    const pushLog = (line) => roomPushLog(room, line);
    const entered = enterConstructionIfNeeded(state, pushLog);
    state.awaitingConstruction = false;
    state.onInsertSummary = null;
    state.pendingOnInsertDisplay = false;
    if (entered) beginNextConstructionStep(state, pushLog);
    broadcastState(room);
    return;
  }

  serverBattleTurn(room);

  broadcastState(room);

  // Check for elf pick needed
  if (state.pendingElfPickByPlayer) {
    for (const pid of ["p1", "p2"]) {
      if (state.pendingElfPickByPlayer[pid]) {
        send(room.sockets[pid], S_ELF_PICK_NEEDED, { playerId: pid });
        send(room.sockets[oppOf(pid)], S_WAITING, { action: "elf_pick", who: pid });
      }
    }
  }
}

function onElfPick(ws, msg) {
  const room = rooms.get(ws._roomCode);
  const pid = ws._playerId;
  if (!room || !pid || room.phase !== "playing") return;
  const spiritIndex = Number(msg.spiritIndex);
  if (!Number.isFinite(spiritIndex)) return;

  const ok = handleElfPick(room, pid, spiritIndex);
  if (!ok) { send(ws, S_ERROR, { message: "无效的精灵选择" }); return; }

  broadcastState(room);

  // After elf pick, check if there are still pending picks
  const state = room.gameState;
  if (state.pendingElfPickByPlayer?.p1 || state.pendingElfPickByPlayer?.p2) {
    for (const p of ["p1", "p2"]) {
      if (state.pendingElfPickByPlayer[p]) {
        send(room.sockets[p], S_ELF_PICK_NEEDED, { playerId: p });
        send(room.sockets[oppOf(p)], S_WAITING, { action: "elf_pick", who: p });
      }
    }
  }
}

function onConstructionChoice(ws, msg) {
  const room = rooms.get(ws._roomCode);
  const pid = ws._playerId;
  if (!room || !pid || room.phase !== "playing") return;
  const state = room.gameState;
  if (!state || state.phase !== PHASE.CONSTRUCTION) return;
  if (!state.construction[pid]) return;

  const { insertIndex, insertPos, bottomOrder } = msg;
  const choice = state.construction[pid];
  choice.insertIndex = Number(insertIndex) || 0;
  choice.insertPos = Number(insertPos);
  choice.bottomOrder = bottomOrder === "10" ? "10" : "01";

  if (!Number.isFinite(choice.insertPos)) {
    send(ws, S_ERROR, { message: "请选择插入位置" }); return;
  }

  const pushLog = (line) => roomPushLog(room, line);

  // Capture the inserted card info before applyConstructionChoice nulls the choice
  const insertedCard = state.construction[pid].drawn[Number(insertIndex) || 0];
  const insertCardLabel = formatCardLabel(insertedCard);
  const insertCardText = insertedCard?.text ?? "";

  const beforeSnapshot = snapshotFightersState(state);
  applyConstructionChoice(state, pid, pushLog);
  const afterSnapshot = snapshotFightersState(state);

  let changed = false;
  const changes = [];
  const allFighters = [...state.players.p1.fighters, ...state.players.p2.fighters];
  const fighterById = new Map(allFighters.map((f) => [f.id, f]));
  for (const [id, a] of afterSnapshot.entries()) {
    const b = beforeSnapshot.get(id);
    if (!b) continue;
    const dh = (a.hp ?? 0) - (b.hp ?? 0);
    const dp = (a.power ?? 0) - (b.power ?? 0);
    if (dh !== 0 || dp !== 0) {
      changed = true;
      const f = fighterById.get(id);
      const parts = [];
      if (dh !== 0) parts.push(`HP ${dh > 0 ? "+" : ""}${dh}`);
      if (dp !== 0) parts.push(`力量 ${dp > 0 ? "+" : ""}${dp}`);
      changes.push({ name: f?.name ?? id, detail: parts.join("，") });
    }
  }
  if (changed) state.lastIntermissionEffect = { before: beforeSnapshot, after: afterSnapshot };

  // Extract the "入库时" portion of the card text for the summary
  if (changed && insertCardText.includes("入库时")) {
    if (!state.onInsertSummary) state.onInsertSummary = [];
    // Parse out just the 入库时 effect text (everything between "入库时" and the next "；" separated non-入库时 effect)
    const match = insertCardText.match(/入库时([^；]+)/);
    const effectText = match ? match[1].trim() : "";
    state.onInsertSummary.push({ playerId: pid, cardLabel: insertCardLabel, effectText, changes });
  }

  const w = checkWinner(state);
  if (w) {
    state.phase = PHASE.GAME_OVER;
    state.winner = w;
    const p1KO = state.players.p1.fighters.some(isKoNow);
    const p2KO = state.players.p2.fighters.some(isKoNow);
    const resLine = w === "draw" ? "平局" : w === "p1" ? "P1 胜 / P2 败" : "P2 胜 / P1 败";
    pushLog(`游戏结束：${resLine}（P1 ${p1KO ? "KO" : "未KO"}，P2 ${p2KO ? "KO" : "未KO"}）`);
    room.phase = "done";
    broadcastState(room);
    sendBoth(room, S_GAME_OVER, { winner: w });
  } else if (!state.construction.p1 && !state.construction.p2) {
    if (state.onInsertSummary && state.onInsertSummary.length > 0) {
      // Hold in pending state so clients can display on-insert effects
      state.pendingOnInsertDisplay = true;
      pushLog(`构筑完成：展示入库时效果`);
      broadcastState(room);
    } else {
      state.phase = PHASE.BATTLE;
      state.awaitingConstruction = false;
      state.round += 1;
      state.turn = 1;
      state.lastFlip = null;
      state.lastRound = null;
      state.compareHold = false;
      pushLog(`构筑完成：回到战斗阶段`);
      broadcastState(room);
    }
  } else {
    // One player done, waiting for other
    send(room.sockets[oppOf(pid)], S_WAITING, { action: "construction", who: pid });
    broadcastState(room);
  }
}

function onConfirmInsertDisplay(ws) {
  const room = rooms.get(ws._roomCode);
  const pid = ws._playerId;
  if (!room || !pid || room.phase !== "playing") return;
  const state = room.gameState;
  if (!state || state.phase !== PHASE.CONSTRUCTION || !state.pendingOnInsertDisplay) return;

  const pushLog = (line) => roomPushLog(room, line);
  state.pendingOnInsertDisplay = false;
  state.onInsertSummary = null;
  state.phase = PHASE.BATTLE;
  state.awaitingConstruction = false;
  state.round += 1;
  state.turn = 1;
  state.lastFlip = null;
  state.lastRound = null;
  state.compareHold = false;
  pushLog(`构筑完成：回到战斗阶段`);
  broadcastState(room);
}

function onConfirmEnd(ws) {
  const room = rooms.get(ws._roomCode);
  if (!room || room.phase !== "playing") return;
  const state = room.gameState;
  if (!state || !state.pendingGameOver) return;
  state.phase = PHASE.GAME_OVER;
  state.winner = state.pendingGameOver;
  state.pendingGameOver = null;
  room.phase = "done";
  broadcastState(room);
  sendBoth(room, S_GAME_OVER, { winner: state.winner });
}

function broadcastState(room) {
  sendEach(room, S_STATE_SYNC, (pid) => ({
    state: serializeStateForPlayer(room.gameState, pid),
    log: room.log,
  }));
}

// ─── WebSocket server ───────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  // Send gallery init to new connections (they'll pick icons to pair)
  if (galleryPool.length > 0) {
    sendGalleryInit(ws);
  }

  ws.on("message", (data) => {
    try { handleMessage(ws, String(data)); }
    catch (e) { console.error("WS message error:", e); }
  });

  ws.on("close", () => {
    // Clean up any pending gallery selection
    clearPendingSelection(ws);

    const code = ws._roomCode;
    const pid = ws._playerId;
    if (!code || !pid) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.sockets[pid] === ws) {
      room.sockets[pid] = null;
      send(room.sockets[oppOf(pid)], S_OPPONENT_DISCONNECTED, {});
      // Start timeout to destroy room
      room.disconnectTimers[pid] = setTimeout(() => {
        // If still disconnected, destroy room
        if (!room.sockets[pid] || room.sockets[pid].readyState !== 1) {
          const other = room.sockets[oppOf(pid)];
          if (!other || other.readyState !== 1) {
            destroyRoom(code);
          }
        }
      }, ROOM_TIMEOUT_MS);
    }
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────

await loadGameData();
httpServer.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`Tagteam server: http://localhost:${PORT}/\n`);
});
