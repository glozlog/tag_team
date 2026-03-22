import http from "node:http";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  PHASE,
  parseFighters,
  createInitialState,
  buildContextForBattle,
  ensureCardCompiled,
  settleEffects,
  applyDeltas,
  snapshotFightersState,
  checkWinner,
  enterConstructionIfNeeded,
  beginNextConstructionStep,
  applyConstructionChoice,
  formatCardLabel,
} from "./game-engine.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============== 加载战士数据 ==============
function loadFighterDefs() {
  const filePath = path.join(__dirname, "战士库.txt");
  const buffer = fs.readFileSync(filePath);
  // 与 decodeTxtToUtf8 逻辑一致
  const cutoff = buffer.indexOf(0x1a);
  const sliced = cutoff >= 0 ? buffer.subarray(0, cutoff) : buffer;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(sliced);
  } catch {
    text = new TextDecoder("gb18030").decode(sliced);
  }
  return parseFighters(text);
}

let fighterDefs = null;
let fighterPoolByName = new Map();
try {
  fighterDefs = loadFighterDefs();
  console.log(`[Server] 战士库加载成功，共 ${fighterDefs.length} 名战士`);
  // 构建 fighterPoolByName Map
  for (const f of fighterDefs) {
    fighterPoolByName.set(f.name, f);
    if (f.id && f.id !== f.name) fighterPoolByName.set(f.id, f);
  }
} catch (e) {
  console.error("[Server] 战士库加载失败:", e.message);
}

// ============== 房间管理 ==============
const rooms = new Map(); // key: 4位房间码, value: Room 对象

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 排除易混淆的 I/O/0/1
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

function createRoom(ws) {
  const code = generateRoomCode();
  const room = {
    code,
    p1: { ws, playerId: "p1", connected: true },
    p2: null,
    gameState: null,
    phase: "waiting",
    p1Selections: null,
    p2Selections: null,
    p1Order: null,
    p2Order: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  ws.roomCode = code;
  ws.playerId = "p1";
  console.log(`[Room] 创建房间 ${code}，P1 已加入`);
  return code;
}

function joinRoom(ws, code) {
  const upperCode = (code || "").toUpperCase();
  const room = rooms.get(upperCode);
  if (!room) {
    return { success: false, error: "房间不存在" };
  }
  if (room.p2 && room.p2.connected) {
    return { success: false, error: "房间已满" };
  }
  // 加入为 P2
  room.p2 = { ws, playerId: "p2", connected: true };
  room.lastActivity = Date.now();
  ws.roomCode = upperCode;
  ws.playerId = "p2";
  console.log(`[Room] ${upperCode} P2 已加入`);
  return { success: true, room };
}

function cleanupStaleRooms() {
  const now = Date.now();
  const staleThreshold = 2 * 60 * 60 * 1000; // 2小时
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > staleThreshold) {
      console.log(`[Room] 清理过期房间 ${code}`);
      // 关闭所有连接
      if (room.p1?.ws) room.p1.ws.close();
      if (room.p2?.ws) room.p2.ws.close();
      rooms.delete(code);
    }
  }
}

// 每10分钟清理一次过期房间
setInterval(cleanupStaleRooms, 10 * 60 * 1000);

// ============== 消息发送辅助函数 ==============
function send(ws, data) {
  if (ws && ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  if (room.p1) send(room.p1.ws, data);
  if (room.p2) send(room.p2.ws, data);
}

function sendToPlayer(room, playerId, data) {
  const slot = room[playerId];
  if (slot) send(slot.ws, data);
}

// ============== 状态过滤和广播函数 ==============

// 将 Card 对象转换为可序列化的 JSON 对象
function serializeCard(card) {
  if (!card) return null;
  return {
    id: card.id,
    fighterName: card.fighterName,
    fighterAlias: card.fighterAlias,
    fighterCode: card.fighterCode,
    cardNo: card.cardNo,
    cardName: card.cardName,
    text: card.text,
    flipped: card.flipped,
  };
}

// 将 Fighter 对象转换为可序列化的 JSON 对象
function serializeFighter(f) {
  if (!f) return null;
  return {
    id: f.id,
    name: f.name,
    alias: f.alias,
    code: f.code,
    hp: f.hp,
    maxHp: f.maxHp,
    power: f.power,
    revelation: f.revelation,
    battleship: f.battleship,
    snake: f.snake,
    snakeFlipMark: f.snakeFlipMark,
    flame: f.flame ? { ...f.flame } : {},
    ning: f.ning ? { ...f.ning } : {},
    guard: f.guard,
    elf: f.elf ? { ...f.elf, dead: [...(f.elf.dead || [])] } : null,
    rage: f.rage,
    bodvarForm: f.bodvarForm,
    plan: f.plan ? { available: [...f.plan.available], ready: [...f.plan.ready], discard: [...f.plan.discard] } : null,
    planTexts: f.planTexts ? [...f.planTexts] : null,
    police: f.police,
    koLine: f.koLine,
    koLines: f.koLines ? [...f.koLines] : null,
    hpRules: f.hpRules ? f.hpRules.map(r => ({ hp: r.hp, effect: r.effect, stop: r.stop })) : [],
    koByFlame: f.koByFlame,
  };
}

// 过滤状态，对方的牌库只发送 length
function filterStateForPlayer(state, playerId) {
  if (!state) return null;
  const oppId = playerId === "p1" ? "p2" : "p1";

  // 序列化玩家数据
  function serializePlayerForSelf(player) {
    return {
      id: player.id,
      fighters: player.fighters.map(serializeFighter),
      battleDeck: player.battleDeck.map(serializeCard),
      resolvedPile: player.resolvedPile.map(serializeCard),
      constructionDeck: player.constructionDeck.map(serializeCard),
    };
  }

  function serializePlayerForOpponent(player) {
    return {
      id: player.id,
      fighters: player.fighters.map(serializeFighter),
      battleDeck: { length: player.battleDeck.length },
      resolvedPile: player.resolvedPile.map(serializeCard),
      constructionDeck: { length: player.constructionDeck.length },
    };
  }

  // 序列化构筑状态
  function serializeConstruction(constr, forPlayerId) {
    if (!constr) return null;
    const result = { active: constr.active };
    // 自己的构筑信息完整发送
    if (constr[forPlayerId]) {
      result[forPlayerId] = {
        drawn: constr[forPlayerId].drawn.map(serializeCard),
        insertIndex: constr[forPlayerId].insertIndex,
        insertPos: constr[forPlayerId].insertPos,
        previewPos: constr[forPlayerId].previewPos,
        dragging: constr[forPlayerId].dragging,
        bottomOrder: constr[forPlayerId].bottomOrder,
      };
    } else {
      result[forPlayerId] = null;
    }
    // 对方的构筑信息只发送是否已完成
    const oppFor = forPlayerId === "p1" ? "p2" : "p1";
    result[oppFor] = constr[oppFor] ? "pending" : null;
    return result;
  }

  // 序列化 lastFlip
  function serializeLastFlip(lf) {
    if (!lf) return null;
    return {
      round: lf.round,
      turn: lf.turn,
      p1Card: serializeCard(lf.p1Card),
      p2Card: serializeCard(lf.p2Card),
      p1FlippedAtStart: lf.p1FlippedAtStart,
      p2FlippedAtStart: lf.p2FlippedAtStart,
      guardAtStartById: lf.guardAtStartById ? Object.fromEntries(lf.guardAtStartById) : null,
    };
  }

  return {
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    showDecks: state.showDecks,
    awaitingConstruction: state.awaitingConstruction,
    pendingGameOver: state.pendingGameOver,
    pendingElfPickByPlayer: state.pendingElfPickByPlayer ? { ...state.pendingElfPickByPlayer } : null,
    doubleNextByPlayer: state.doubleNextByPlayer ? { ...state.doubleNextByPlayer } : null,
    pendingDoubleQueue: state.pendingDoubleQueue ? [...state.pendingDoubleQueue] : [],
    lastFlip: serializeLastFlip(state.lastFlip),
    lastRound: state.lastRound,
    lastIntermissionEffect: state.lastIntermissionEffect,
    compareHold: state.compareHold,
    players: {
      [playerId]: serializePlayerForSelf(state.players[playerId]),
      [oppId]: serializePlayerForOpponent(state.players[oppId]),
    },
    construction: serializeConstruction(state.construction, playerId),
    winner: state.winner,
    myPlayerId: playerId,
  };
}

function broadcastState(room, logs = []) {
  const state = room.gameState;
  if (!state) return;
  sendToPlayer(room, "p1", {
    type: "STATE_UPDATE",
    state: filterStateForPlayer(state, "p1"),
    logs,
  });
  sendToPlayer(room, "p2", {
    type: "STATE_UPDATE",
    state: filterStateForPlayer(state, "p2"),
    logs,
  });
}

// ============== 战斗回合处理 ==============

function executeBattleTurn(room, pushLog) {
  const state = room.gameState;
  if (state.phase !== PHASE.BATTLE) return;
  if (state.awaitingConstruction) return;
  if (state.pendingGameOver) return;

  const p1 = state.players.p1;
  const p2 = state.players.p2;

  // 处理土偶重生的二次结算
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
      ctx,
      myCard: p1Card,
      oppCard: p2Card,
      myEffects: p1Effects,
      oppEffects: p2Effects,
      myPlayer: p1,
      oppPlayer: p2,
      onlySide: pid,
      guardAtStartById: lf?.guardAtStartById,
    });

    for (const line of settlement.log) pushLog(line);
    if (settlement?.golemRebirthByPlayerId?.size) {
      for (const x of settlement.golemRebirthByPlayerId) state.doubleNextByPlayer[x] = true;
    }

    const applied = applyDeltas(
      state, settlement.hpDelta, settlement.powerDelta, beforeSnapshot,
      lf?.guardAtStartById,
      settlement?.blockActiveByPlayerId ?? null,
      settlement?.blockInnerByPlayerId ?? null
    );
    for (const line of applied?.log ?? []) pushLog(line);

    if (settlement?.removeBothCardsFromGame === true) {
      pushLog(`移除游戏：P1 ${formatCardLabel(p1Card)} / P2 ${formatCardLabel(p2Card)}`);
      p1.resolvedPile = p1.resolvedPile.filter((c) => c !== p1Card);
      p2.resolvedPile = p2.resolvedPile.filter((c) => c !== p2Card);
    }

    const afterSnapshot = snapshotFightersState(state);
    logFighterChanges(state, beforeSnapshot, afterSnapshot, pushLog);

    if (!state.pendingDoubleQueue.length) {
      processElfRoundEnd(state, "p1", pushLog);
      processElfRoundEnd(state, "p2", pushLog);
    }

    const w = checkWinnerWithSpecialRules(state, settlement, pushLog);
    if (w) {
      state.pendingGameOver = w;
      return;
    }

    if (!state.pendingDoubleQueue.length) {
      if (p1.battleDeck.length === 0 && p2.battleDeck.length === 0) {
        state.awaitingConstruction = true;
        pushLog(`战斗牌库结算完：点击“进入构筑”进入构筑阶段`);
        return;
      }
      state.turn += 1;
    }
    return;
  }

  // 等待精灵族选择
  if (state.pendingElfPickByPlayer?.p1 || state.pendingElfPickByPlayer?.p2) return;
  if (p1.battleDeck.length === 0 || p2.battleDeck.length === 0) return;

  // 检查土偶重生标记
  const plannedDoubleQueue = [];
  if (state.doubleNextByPlayer?.p1 === true) {
    plannedDoubleQueue.push("p1");
    state.doubleNextByPlayer.p1 = false;
  }
  if (state.doubleNextByPlayer?.p2 === true) {
    plannedDoubleQueue.push("p2");
    state.doubleNextByPlayer.p2 = false;
  }

  state.lastIntermissionEffect = null;
  const beforeSnapshot = snapshotFightersState(state);

  // 翻牌
  const p1Card = p1.battleDeck.shift();
  const p2Card = p2.battleDeck.shift();
  state.lastFlip = {
    round: state.round,
    turn: state.turn,
    p1Card,
    p2Card,
    p1FlippedAtStart: p1Card?.flipped === true,
    p2FlippedAtStart: p2Card?.flipped === true,
    guardAtStartById: new Map([...p1.fighters, ...p2.fighters].map((f) => [f.id, f?.guard === true])),
  };

  pushLog(`翻牌（轮次${state.round}回合${state.turn}）：P1 ${formatCardLabel(p1Card)} / P2 ${formatCardLabel(p2Card)}`);

  const ctx = buildContextForBattle(p1, p2, p1Card, p2Card);
  for (const f of [...p1.fighters, ...p2.fighters]) f.snakeFlipMark = null;
  const p1Effects = ensureCardCompiled(p1Card);
  const p2Effects = ensureCardCompiled(p2Card);

  const settlement = settleEffects({
    ctx,
    myCard: p1Card,
    oppCard: p2Card,
    myEffects: p1Effects,
    oppEffects: p2Effects,
    myPlayer: p1,
    oppPlayer: p2,
    guardAtStartById: state.lastFlip.guardAtStartById,
  });

  for (const line of settlement.log) pushLog(line);
  if (settlement?.golemRebirthByPlayerId?.size) {
    for (const x of settlement.golemRebirthByPlayerId) state.doubleNextByPlayer[x] = true;
  }

  const applied = applyDeltas(
    state, settlement.hpDelta, settlement.powerDelta, beforeSnapshot,
    state.lastFlip.guardAtStartById,
    settlement?.blockActiveByPlayerId ?? null,
    settlement?.blockInnerByPlayerId ?? null
  );
  for (const line of applied?.log ?? []) pushLog(line);

  if (settlement?.removeBothCardsFromGame === true) {
    pushLog(`移除游戏：P1 ${formatCardLabel(p1Card)} / P2 ${formatCardLabel(p2Card)}`);
  } else {
    p1.resolvedPile.unshift(p1Card);
    p2.resolvedPile.unshift(p2Card);
  }

  const afterSnapshot = snapshotFightersState(state);
  logFighterChanges(state, beforeSnapshot, afterSnapshot, pushLog);

  if (plannedDoubleQueue.length) {
    state.pendingDoubleQueue = plannedDoubleQueue;
    return;
  }

  processElfRoundEnd(state, "p1", pushLog);
  processElfRoundEnd(state, "p2", pushLog);

  const w = checkWinnerWithSpecialRules(state, settlement, pushLog);
  if (w) {
    state.pendingGameOver = w;
    return;
  }

  if (p1.battleDeck.length === 0 && p2.battleDeck.length === 0) {
    state.awaitingConstruction = true;
    pushLog(`战斗牌库结算完：点击“进入构筑”进入构筑阶段`);
    return;
  }

  state.turn += 1;
}

function processElfRoundEnd(state, playerId, pushLog) {
  const player = state.players[playerId];
  const elf = player?.fighters?.find?.((f) => f?.name === "精灵族");
  if (!elf || !elf.elf) return;
  if (elf.elf.gameKo === true) return;

  const active = elf.elf.active;
  const dead = Array.isArray(elf.elf.dead) ? elf.elf.dead : [false, false, false];
  elf.elf.dead = dead;

  if (active == null) {
    state.pendingElfPickByPlayer[playerId] = dead.some((x) => x === false);
    return;
  }
  if (dead[active] === true) return;
  if (Number(elf.hp) > Number(elf.koLine)) return;

  const alreadyPending = Number.isFinite(elf.elf.pendingKoIndex) && elf.elf.pendingKoIndex !== null;
  if (alreadyPending) return;

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

function isKoNow(fx) {
  if (fx?.koByFlame === true) return true;
  if (fx?.name === "精灵族") return fx?.elf?.gameKo === true;
  if (Array.isArray(fx.koLines) && fx.koLines.length > 0) {
    return fx.koLines.includes(Number(fx.hp) || 0);
  }
  return Number(fx.hp) <= Number(fx.koLine);
}

function checkWinnerWithSpecialRules(state, settlement, pushLog) {
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
      w = "draw";
      pushLog(`特殊胜负：双方被KO且均触发“被KO则胜利”，最终为平局`);
    } else if (p1ClaimWin) {
      w = "p1";
      pushLog(`特殊胜负：P1 被KO且触发“被KO则胜利”，最终 P1 获胜`);
    } else {
      w = "p2";
      pushLog(`特殊胜负：P2 被KO且触发“被KO则胜利”，最终 P2 获胜`);
    }
  } else if ((flameKoP1 && !flameKoP2) || (flameKoP2 && !flameKoP1)) {
    w = flameKoP1 ? "p2" : "p1";
    pushLog(`特殊胜负：焰=5 判KO，忽略对方本回合KO判定，最终 ${w.toUpperCase()} 获胜`);
  }

  if (w) {
    const koP1 = p1KO ? "KO" : "未KO";
    const koP2 = p2KO ? "KO" : "未KO";
    const resLine = w === "draw" ? `平局` : w === "p1" ? `P1 胜 / P2 败` : `P2 胜 / P1 败`;
    pushLog(`游戏结束！${resLine}（P1 ${koP1}，P2 ${koP2}）`);
    return w;
  }
  return null;
}

function logFighterChanges(state, beforeSnapshot, afterSnapshot, pushLog) {
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

// ============== 游戏消息处理 ==============
function handleGameMessage(room, playerId, msg) {
  room.lastActivity = Date.now();
  const logs = [];
  const pushLog = (text) => logs.push(text);

  console.log(`[${room.code}] ${playerId}: ${msg.type}`);

  switch (msg.type) {
    case "SELECT_FIGHTERS": {
      // msg.data.fighters = ["战士A", "战士B"]
      // msg.data.confirmed = true/false
      const fighters = msg.data?.fighters;
      const confirmed = msg.data?.confirmed;
      if (!Array.isArray(fighters) || fighters.length !== 2) {
        send(room[playerId]?.ws, { type: "ERROR", error: "请选择 2 名战士" });
        return;
      }
      // 验证战士是否存在
      for (const name of fighters) {
        if (!fighterPoolByName.has(name)) {
          send(room[playerId]?.ws, { type: "ERROR", error: `战士不存在: ${name}` });
          return;
        }
      }
      // 记录选择
      if (playerId === "p1") {
        room.p1Selections = fighters;
        room.p1Confirmed = confirmed;
      } else {
        room.p2Selections = fighters;
        room.p2Confirmed = confirmed;
      }
      pushLog(`${playerId.toUpperCase()} 选择了战士: ${fighters.join(", ")}${confirmed ? ' (已确认)' : ''}`);
      send(room[playerId]?.ws, { type: "FIGHTERS_SELECTED", fighters, confirmed });

      // 通知对方该玩家已确认
      const opponentId = playerId === "p1" ? "p2" : "p1";
      if (confirmed) {
        send(room[opponentId]?.ws, { type: "OPPONENT_CONFIRMED", playerId });
      }

      // 检查是否双方都已确认
      if (room.p1Confirmed && room.p2Confirmed && room.p1Selections && room.p2Selections) {
        room.phase = "ordering";
        // 广播双方阵容，进入起始顺序设置阶段
        broadcast(room, {
          type: "FIGHTERS_REVEALED",
          p1Fighters: room.p1Selections,
          p2Fighters: room.p2Selections,
        });
        pushLog(`双方阵容已揭晓，请选择起始顶牌战士`);
      }
      break;
    }

    case "SET_START_ORDER": {
      // msg.data.topFighter = "战士A"（放在牌库顶部的战士名）
      const topFighter = msg.data?.topFighter;
      const selections = playerId === "p1" ? room.p1Selections : room.p2Selections;
      if (!selections || !selections.includes(topFighter)) {
        send(room[playerId]?.ws, { type: "ERROR", error: "无效的起始战士选择" });
        return;
      }
      if (playerId === "p1") {
        room.p1Order = topFighter;
      } else {
        room.p2Order = topFighter;
      }
      pushLog(`${playerId.toUpperCase()} 设置起始顶牌: ${topFighter}`);
      send(room[playerId]?.ws, { type: "ORDER_SET", topFighter });

      // 通知对手该玩家已设置起始顺序
      const opponentId = playerId === "p1" ? "p2" : "p1";
      send(room[opponentId]?.ws, { type: "OPPONENT_ORDER_SET", playerId, topFighter });

      // 检查是否双方都已设置
      if (room.p1Order && room.p2Order) {
        // 创建游戏初始状态
        const picksByPlayer = {
          p1: room.p1Selections,
          p2: room.p2Selections,
        };
        const startTopByPlayer = {
          p1: room.p1Order,
          p2: room.p2Order,
        };
        try {
          room.gameState = createInitialState(fighterPoolByName, picksByPlayer, startTopByPlayer);
          room.phase = "playing";
          room.readyPlayers = new Set();
          room.enterConstructionPlayers = new Set();
          pushLog(`游戏开始！`);

          // 结构化日志：游戏开始
          console.log(`[${new Date().toISOString()}] [${room.code}] 游戏开始 - P1: ${room.p1Selections.join(',')}, P2: ${room.p2Selections.join(',')}`);

          // 向各玩家发送过滤后的状态
          sendToPlayer(room, "p1", {
            type: "GAME_STARTED",
            playerId: "p1",
            state: filterStateForPlayer(room.gameState, "p1"),
            logs,
          });
          sendToPlayer(room, "p2", {
            type: "GAME_STARTED",
            playerId: "p2",
            state: filterStateForPlayer(room.gameState, "p2"),
            logs,
          });

          // 检查是否有精灵族需要选择灵
          if (room.gameState.pendingElfPickByPlayer?.p1) {
            sendToPlayer(room, "p1", { type: "ELF_PICK_NEEDED" });
          }
          if (room.gameState.pendingElfPickByPlayer?.p2) {
            sendToPlayer(room, "p2", { type: "ELF_PICK_NEEDED" });
          }
        } catch (e) {
          console.error(`[创建游戏失败]`, e);
          broadcast(room, { type: "ERROR", error: `创建游戏失败: ${e.message}` });
        }
      }
      break;
    }

    case "READY_FOR_BATTLE": {
      if (!room.gameState || room.gameState.phase !== PHASE.BATTLE) {
        send(room[playerId]?.ws, { type: "ERROR", error: "当前不在战斗阶段" });
        return;
      }
      if (room.gameState.awaitingConstruction) {
        send(room[playerId]?.ws, { type: "ERROR", error: "等待进入构筑阶段" });
        return;
      }
      if (room.gameState.pendingGameOver) {
        send(room[playerId]?.ws, { type: "ERROR", error: "游戏已结束" });
        return;
      }
      // 检查精灵族选择
      if (room.gameState.pendingElfPickByPlayer?.[playerId]) {
        send(room[playerId]?.ws, { type: "ERROR", error: "请先选择精灵族的灵" });
        return;
      }

      if (!room.readyPlayers) room.readyPlayers = new Set();
      room.readyPlayers.add(playerId);
      pushLog(`${playerId.toUpperCase()} 已准备`);

      // 通知对方
      const oppId = playerId === "p1" ? "p2" : "p1";
      sendToPlayer(room, oppId, { type: "OPPONENT_READY" });

      // 当双方都准备好时执行战斗
      if (room.readyPlayers.has("p1") && room.readyPlayers.has("p2")) {
        room.readyPlayers.clear();
        executeBattleTurn(room, pushLog);
        // 结构化日志：回合结算完毕
        console.log(`[${new Date().toISOString()}] [${room.code}] 回合 ${room.gameState.round}-${room.gameState.turn} 结算完毕`);
        broadcastState(room, logs);
      }
      break;
    }

    case "ENTER_CONSTRUCTION": {
      if (!room.gameState || room.gameState.phase !== PHASE.BATTLE) {
        send(room[playerId]?.ws, { type: "ERROR", error: "当前不在战斗阶段" });
        return;
      }
      if (!room.gameState.awaitingConstruction) {
        send(room[playerId]?.ws, { type: "ERROR", error: "还未到进入构筑的时机" });
        return;
      }

      if (!room.enterConstructionPlayers) room.enterConstructionPlayers = new Set();
      room.enterConstructionPlayers.add(playerId);
      pushLog(`${playerId.toUpperCase()} 请求进入构筑`);

      // 通知对方
      const oppId = playerId === "p1" ? "p2" : "p1";
      sendToPlayer(room, oppId, { type: "OPPONENT_ENTER_CONSTRUCTION" });

      // 当双方都请求时进入构筑
      if (room.enterConstructionPlayers.has("p1") && room.enterConstructionPlayers.has("p2")) {
        room.enterConstructionPlayers.clear();
        const entered = enterConstructionIfNeeded(room.gameState, pushLog);
        room.gameState.awaitingConstruction = false;
        if (entered) {
          beginNextConstructionStep(room.gameState, pushLog);
        }
        broadcastState(room, logs);
      }
      break;
    }

    case "CONSTRUCTION_CHOICE": {
      if (!room.gameState || room.gameState.phase !== PHASE.CONSTRUCTION) {
        send(room[playerId]?.ws, { type: "ERROR", error: "当前不在构筑阶段" });
        return;
      }
      const constr = room.gameState.construction[playerId];
      if (!constr) {
        send(room[playerId]?.ws, { type: "ERROR", error: "你已完成构筑" });
        return;
      }
      // msg.data = { insertIndex, insertPos, bottomOrder }
      const { insertIndex, insertPos, bottomOrder } = msg.data || {};
      if (typeof insertIndex !== "number" || typeof insertPos !== "number") {
        send(room[playerId]?.ws, { type: "ERROR", error: "构筑参数无效" });
        return;
      }
      constr.insertIndex = insertIndex;
      constr.insertPos = insertPos;
      constr.bottomOrder = bottomOrder || "01";

      applyConstructionChoice(room.gameState, playerId, pushLog);

      // 检查胜负
      const w = checkWinner(room.gameState);
      if (w) {
        room.gameState.phase = PHASE.GAME_OVER;
        room.gameState.winner = w;
        pushLog(`游戏结束！${w === "draw" ? "平局" : w.toUpperCase() + " 获胜"}`);
        broadcastState(room, logs);
        return;
      }

      // 检查双方是否都完成构筑
      if (!room.gameState.construction.p1 && !room.gameState.construction.p2) {
        room.gameState.phase = PHASE.BATTLE;
        room.gameState.round += 1;
        room.gameState.turn = 1;
        pushLog(`构筑完成，进入第 ${room.gameState.round} 轮战斗`);
        room.readyPlayers = new Set();
      }
      broadcastState(room, logs);
      break;
    }

    case "ELF_PICK": {
      // msg.data = { spiritIndex: 0|1|2 }
      if (!room.gameState) {
        send(room[playerId]?.ws, { type: "ERROR", error: "游戏未开始" });
        return;
      }
      if (!room.gameState.pendingElfPickByPlayer?.[playerId]) {
        send(room[playerId]?.ws, { type: "ERROR", error: "不需要选择灵" });
        return;
      }
      const spiritIndex = msg.data?.spiritIndex;
      if (typeof spiritIndex !== "number" || spiritIndex < 0 || spiritIndex > 2) {
        send(room[playerId]?.ws, { type: "ERROR", error: "无效的灵索引" });
        return;
      }

      const player = room.gameState.players[playerId];
      const elf = player?.fighters?.find((f) => f.name === "精灵族");
      if (!elf || !elf.elf) {
        send(room[playerId]?.ws, { type: "ERROR", error: "未找到精灵族战士" });
        return;
      }

      const dead = elf.elf.dead || [false, false, false];
      if (dead[spiritIndex] === true) {
        send(room[playerId]?.ws, { type: "ERROR", error: "该灵已被KO" });
        return;
      }

      // 处理之前的 pendingKoIndex
      if (elf.elf.pendingKoIndex != null) {
        dead[elf.elf.pendingKoIndex] = true;
        elf.elf.pendingKoIndex = null;
      }

      // 设置新的活跃灵
      elf.elf.active = spiritIndex;
      elf.elf.pendingPick = false;
      elf.elf.dead = dead;

      // 设置 HP 和 hpRules
      const spirit = elf.elf.spirits?.[spiritIndex];
      if (spirit) {
        elf.hp = spirit.maxHp;
        elf.maxHp = spirit.maxHp;
        elf.hpRules = spirit.hpRules || [];
        elf.koLine = 0;
      }

      room.gameState.pendingElfPickByPlayer[playerId] = false;
      pushLog(`灵：${playerId.toUpperCase()} 选择了灵${spiritIndex + 1}`);

      broadcastState(room, logs);
      break;
    }

    case "CONFIRM_GAME_OVER": {
      if (!room.gameState || !room.gameState.pendingGameOver) {
        send(room[playerId]?.ws, { type: "ERROR", error: "游戏未结束" });
        return;
      }
      room.gameState.phase = PHASE.GAME_OVER;
      room.gameState.winner = room.gameState.pendingGameOver;
      room.gameState.pendingGameOver = null;
      pushLog(`游戏结束已确认`);
      // 结构化日志：游戏结束
      const winnerLabel = room.gameState.winner === "draw" ? "平局" : room.gameState.winner.toUpperCase();
      console.log(`[${new Date().toISOString()}] [${room.code}] 游戏结束 - 胜者: ${winnerLabel}`);
      broadcastState(room, logs);
      break;
    }

    case "GET_FIGHTER_LIST": {
      // 返回可用战士列表
      const list = fighterDefs ? fighterDefs.map((f) => ({ name: f.name, id: f.id })) : [];
      send(room[playerId]?.ws, { type: "FIGHTER_LIST", fighters: list });
      break;
    }

    default:
      console.log(`[${room.code}] ${playerId}: 未知消息类型 ${msg.type}`);
  }
}

const PORT = 2603;

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

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    // 特殊路由：/shared-ui.mjs 从父目录提供
    if (pathname === "/shared-ui.mjs") {
      const sharedUiPath = path.join(__dirname, "..", "shared-ui.mjs");
      try {
        const data = await readFile(sharedUiPath);
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(data);
        return;
      } catch {
        res.writeHead(404);
        res.end("Not Found: shared-ui.mjs");
        return;
      }
    }

    const filePath = safeResolve(__dirname, pathname);
    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": guessContentType(filePath),
      "Cache-Control": "no-store",
    });
    if (ext === ".txt") {
      res.end(decodeTxtToUtf8(data));
      return;
    }
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// ============== WebSocket 服务器 ==============
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.playerId = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(ws, { type: "ERROR", error: "无效的JSON消息" });
      return;
    }

    switch (msg.type) {
      case "CREATE_ROOM": {
        const code = createRoom(ws);
        send(ws, { type: "ROOM_CREATED", code });
        break;
      }

      case "JOIN_ROOM": {
        const result = joinRoom(ws, msg.code);
        if (!result.success) {
          send(ws, { type: "ERROR", error: result.error });
        } else {
          const room = result.room;
          // 通知 P2 加入成功
          send(ws, { type: "ROOM_JOINED", playerId: "p2", code: room.code });
          // 通知 P1 对手已加入
          sendToPlayer(room, "p1", { type: "OPPONENT_JOINED" });
        }
        break;
      }

      case "RECONNECT": {
        const roomCode = (msg.roomId || "").toUpperCase();
        const room = rooms.get(roomCode);
        if (!room) {
          send(ws, { type: "ERROR", error: "房间不存在" });
          break;
        }
        const slot = room[msg.playerId];
        if (!slot) {
          send(ws, { type: "ERROR", error: "无效的玩家ID" });
          break;
        }
        // 恢复连接
        slot.ws = ws;
        slot.connected = true;
        ws.roomCode = roomCode;
        ws.playerId = msg.playerId;
        room.lastActivity = Date.now();
        console.log(`[${new Date().toISOString()}] [${roomCode}] ${msg.playerId} 重连成功`);

        // 发送重连成功消息及当前游戏状态
        const reconnectMsg = {
          type: "RECONNECTED",
          playerId: msg.playerId,
          phase: room.phase,
        };
        // 如果游戏已开始，附带完整的过滤后状态
        if (room.gameState) {
          reconnectMsg.state = filterStateForPlayer(room.gameState, msg.playerId);
          // 附带双方阵容信息（用于重建界面）
          reconnectMsg.p1Fighters = room.p1Selections;
          reconnectMsg.p2Fighters = room.p2Selections;
        } else if (room.p1Selections && room.p2Selections) {
          // 游戏未开始但双方已选战士，发送阵容信息
          reconnectMsg.revealedFighters = {
            p1: room.p1Selections,
            p2: room.p2Selections,
          };
        }
        // 标记是否正在等待该玩家的操作
        let awaitingAction = false;
        if (room.gameState) {
          const gs = room.gameState;
          // 1. 精灵选择最高优先级
          if (gs.pendingElfPickByPlayer?.[msg.playerId]) {
            awaitingAction = "elf_pick";
          }
          // 2. 构筑阶段内的具体操作
          else if (gs.phase === PHASE.CONSTRUCTION && gs.construction?.[msg.playerId]) {
            awaitingAction = "construction";
          }
          // 3. 等待进入构筑
          else if (gs.awaitingConstruction && !room.enterConstructionPlayers?.has(msg.playerId)) {
            awaitingAction = "enter_construction";
          }
          // 4. 战斗阶段，等待 READY
          else if (gs.phase === PHASE.BATTLE && !gs.awaitingConstruction && !room.readyPlayers?.has(msg.playerId)) {
            awaitingAction = "ready_for_battle";
          }
        }
        reconnectMsg.awaitingAction = awaitingAction;
        send(ws, reconnectMsg);

        // 通知对方
        const opponentId = msg.playerId === "p1" ? "p2" : "p1";
        sendToPlayer(room, opponentId, { type: "OPPONENT_RECONNECTED" });
        break;
      }

      default: {
        // 其他游戏消息
        if (ws.roomCode && ws.playerId) {
          const room = rooms.get(ws.roomCode);
          if (room) {
            handleGameMessage(room, ws.playerId, msg);
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (ws.roomCode && ws.playerId) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        const slot = room[ws.playerId];
        if (slot && slot.ws === ws) {
          slot.connected = false;
          console.log(`[Room] ${ws.roomCode} ${ws.playerId} 断线`);
          // 通知对方
          const opponentId = ws.playerId === "p1" ? "p2" : "p1";
          sendToPlayer(room, opponentId, { type: "OPPONENT_DISCONNECTED" });
          // 60秒后如果未重连，清理该玩家槽位
          setTimeout(() => {
            const currentRoom = rooms.get(ws.roomCode);
            if (currentRoom) {
              const currentSlot = currentRoom[ws.playerId];
              if (currentSlot && !currentSlot.connected) {
                console.log(`[Room] ${ws.roomCode} ${ws.playerId} 重连超时，清理槽位`);
                currentRoom[ws.playerId] = null;
                // 如果房间空了，删除房间
                if (!currentRoom.p1 && !currentRoom.p2) {
                  rooms.delete(ws.roomCode);
                  console.log(`[Room] ${ws.roomCode} 房间已清理`);
                }
              }
            }
          }, 60000);
        }
      }
    }
  });
});

// 心跳机制
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ============== 启动服务器 ==============
server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`Tagteam UI: http://localhost:${PORT}/\n`);
  console.log(`[Server] WebSocket 服务已启动`);
  console.log(`[Server] 局域网地址: http://192.168.0.64:${PORT}/`);
});
