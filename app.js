import {
  PHASE,
  nowTime,
  formatCardLabel,
  parseFighters,
  selfTestFighters,
} from "./shared/game-logic.js";

import {
  C_CREATE_ROOM, C_JOIN_ROOM, C_PICK_FIGHTERS, C_DECK_ORDER,
  C_ADVANCE_BATTLE, C_ELF_PICK, C_CONSTRUCTION_CHOICE, C_CONFIRM_END,
  S_ROOM_CREATED, S_ROOM_JOINED, S_OPPONENT_JOINED,
  S_OPPONENT_DISCONNECTED, S_OPPONENT_RECONNECTED,
  S_PICKS_LOCKED, S_GAME_START,
  S_WAITING, S_ELF_PICK_NEEDED,
  S_GAME_OVER, S_STATE_SYNC, S_ERROR,
  makeMsg, parseMsg,
} from "./shared/protocol.js";

function createApp() {
  const els = {
    phase: document.getElementById("phase"),
    btnNewGame: document.getElementById("btn-new-game"),
    btnToggleDecks: document.getElementById("btn-toggle-decks"),
    btnOpenRules: document.getElementById("btn-open-rules"),
    btnOpenLog: document.getElementById("btn-open-log"),
    btnNextBattle: document.getElementById("btn-next-battle"),
    btnEnterConstruction: document.getElementById("btn-enter-construction"),
    btnCompare: document.getElementById("btn-compare"),
    btnConfirmEnd: document.getElementById("btn-confirm-end"),
    btnClearLog: document.getElementById("btn-clear-log"),
    battleReveal: document.getElementById("battle-reveal"),
    logDialog: document.getElementById("log-dialog"),
    log: document.getElementById("log"),
    p1Fighters: document.getElementById("p1-fighters"),
    p2Fighters: document.getElementById("p2-fighters"),
    p1BattleCount: document.getElementById("p1-battle-count"),
    p1ConstructCount: document.getElementById("p1-construct-count"),
    p1ResolvedCount: document.getElementById("p1-resolved-count"),
    p2BattleCount: document.getElementById("p2-battle-count"),
    p2ConstructCount: document.getElementById("p2-construct-count"),
    p2ResolvedCount: document.getElementById("p2-resolved-count"),
    p1Decks: document.getElementById("p1-decks"),
    p2Decks: document.getElementById("p2-decks"),
    constructionPanel: document.getElementById("construction-panel"),
    rulesDialog: document.getElementById("rules-dialog"),
    rulesText: document.getElementById("rules-text"),
    // Lobby elements
    lobby: document.getElementById("lobby"),
    lobbyStatus: document.getElementById("lobby-status"),
    btnCreateRoom: document.getElementById("btn-create-room"),
    btnJoinRoom: document.getElementById("btn-join-room"),
    inputRoomCode: document.getElementById("input-room-code"),
    gameLayout: document.getElementById("game-layout"),
    headerSubtitle: document.getElementById("header-subtitle"),
    connectionDot: document.getElementById("connection-dot"),
    disconnectOverlay: document.getElementById("disconnect-overlay"),
    waitingBanner: document.getElementById("waiting-banner"),
  };

  const data = {
    rulesTxt: "",
    fightersTxt: "",
    cardsTxt: "",
    settlementTxt: "",
    fighterDefs: [],
  };

  let state = { phase: PHASE.LOADING };
  let renderQueued = false;
  let activeInsertDrag = null;

  // ─── Online multiplayer state ──────────────────────────────────────────────
  let ws = null;
  let myPlayerId = null; // "p1" or "p2"
  let roomCode = null;
  let clientPhase = "lobby"; // lobby | waiting_join | picking | waiting_picks | ordering | waiting_order | game
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  function oppOf(pid) { return pid === "p1" ? "p2" : "p1"; }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function pushLog(line) {
    const text = `[${nowTime()}] ${line}\n`;
    els.log.textContent += text;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function clearLog() {
    els.log.textContent = "";
  }

  // ─── WebSocket connection ─────────────────────────────────────────────────

  function sendMsg(type, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(makeMsg(type, payload));
    }
  }

  function connectWs(onOpenAction) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.addEventListener("open", () => {
      reconnectDelay = 1000;
      setConnectionStatus("connected");
      if (onOpenAction) onOpenAction();
    });

    ws.addEventListener("message", (ev) => {
      const msg = parseMsg(ev.data);
      if (msg) handleServerMessage(msg);
    });

    ws.addEventListener("close", () => {
      if (clientPhase === "game" || clientPhase === "picking" || clientPhase === "ordering") {
        setConnectionStatus("reconnecting");
        scheduleReconnect();
      } else {
        setConnectionStatus("disconnected");
      }
    });

    ws.addEventListener("error", () => {});
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
      connectWs(() => {
        if (roomCode) sendMsg(C_JOIN_ROOM, { code: roomCode });
      });
    }, reconnectDelay);
  }

  function showWaiting(msg) {
    if (els.waitingBanner) {
      els.waitingBanner.textContent = msg || "";
      els.waitingBanner.classList.toggle("hidden", !msg);
    }
  }

  function hideWaiting() {
    showWaiting(null);
  }

  function showLobby() {
    if (els.lobby) els.lobby.classList.remove("hidden");
    if (els.gameLayout) els.gameLayout.classList.add("hidden");
    clientPhase = "lobby";
  }

  function hideLobby() {
    if (els.lobby) els.lobby.classList.add("hidden");
    if (els.gameLayout) els.gameLayout.classList.remove("hidden");
  }

  function setHeaderInfo(text) {
    if (els.headerSubtitle) els.headerSubtitle.textContent = text;
  }

  function applyViewSwap() {
    // When myPlayerId is "p2", swap left/right so "me" is always on the left
    document.body.classList.toggle("view-swapped", myPlayerId === "p2");
    // Update player name labels
    const p1Label = document.querySelector("#player-p1 .player-name");
    const p2Label = document.querySelector("#player-p2 .player-name");
    if (myPlayerId) {
      if (p1Label) p1Label.textContent = myPlayerId === "p1" ? "我方（P1）" : "对手（P1）";
      if (p2Label) p2Label.textContent = myPlayerId === "p2" ? "我方（P2）" : "对手（P2）";
    } else {
      if (p1Label) p1Label.textContent = "P1";
      if (p2Label) p2Label.textContent = "P2";
    }
  }

  function setConnectionStatus(status) {
    // status: "connected" | "disconnected" | "reconnecting"
    const dot = els.connectionDot;
    if (dot) {
      dot.className = `connection-dot ${status}`;
      dot.title = status === "connected" ? "已连接" : status === "reconnecting" ? "重连中..." : "未连接";
    }
    const overlay = els.disconnectOverlay;
    if (overlay) {
      overlay.classList.toggle("hidden", status !== "reconnecting");
    }
  }

  // ─── State hydration (plain objects → Maps/Sets for rendering) ────────────

  function hydrateState(raw) {
    if (!raw) return raw;
    const s = { ...raw };
    if (s.lastRound) {
      s.lastRound = { ...s.lastRound };
      s.lastRound.before = new Map(Object.entries(s.lastRound.before ?? {}));
      s.lastRound.after = new Map(Object.entries(s.lastRound.after ?? {}));
      s.lastRound.hpTraceById = new Map(Object.entries(s.lastRound.hpTraceById ?? {}));
      s.lastRound.guardBlockedByPlayerId = new Set(s.lastRound.guardBlockedByPlayerId ?? []);
      s.lastRound.flipTriggeredByCardId = new Set(s.lastRound.flipTriggeredByCardId ?? []);
    }
    if (s.lastIntermissionEffect) {
      s.lastIntermissionEffect = { ...s.lastIntermissionEffect };
      s.lastIntermissionEffect.before = new Map(Object.entries(s.lastIntermissionEffect.before ?? {}));
      s.lastIntermissionEffect.after = new Map(Object.entries(s.lastIntermissionEffect.after ?? {}));
    }
    // Ensure deck arrays exist (opponent's hidden decks come as undefined)
    for (const pid of ["p1", "p2"]) {
      if (s.players?.[pid]) {
        s.players[pid].battleDeck = s.players[pid].battleDeck ?? [];
        s.players[pid].constructionDeck = s.players[pid].constructionDeck ?? [];
        s.players[pid].resolvedPile = s.players[pid].resolvedPile ?? [];
      }
    }
    return s;
  }

  // ─── Server message handler ───────────────────────────────────────────────

  function handleServerMessage(msg) {
    switch (msg.type) {
      case S_ROOM_CREATED: {
        roomCode = msg.code;
        myPlayerId = msg.playerId;
        clientPhase = "waiting_join";
        if (els.lobbyStatus) els.lobbyStatus.textContent = `房间码：${roomCode}  等待对手加入...`;
        setHeaderInfo(`房间 ${roomCode} · 你是 ${myPlayerId.toUpperCase()}`);
        applyViewSwap();
        break;
      }
      case S_ROOM_JOINED: {
        roomCode = msg.code;
        myPlayerId = msg.playerId;
        setHeaderInfo(`房间 ${roomCode} · 你是 ${myPlayerId.toUpperCase()}`);
        applyViewSwap();
        // If both players are present, go to picking
        clientPhase = "picking";
        hideLobby();
        hideWaiting();
        state = {
          phase: PHASE.SETUP,
          showDecks: false,
          setup: { step: "pick", myA: null, myB: null },
          lastFlip: null,
          lastRound: null,
          awaitingConstruction: false,
          pendingGameOver: null,
          compareHold: false,
        };
        render();
        break;
      }
      case S_OPPONENT_JOINED: {
        hideWaiting();
        if (clientPhase === "waiting_join") {
          clientPhase = "picking";
          hideLobby();
          state = {
            phase: PHASE.SETUP,
            showDecks: false,
            setup: { step: "pick", myA: null, myB: null },
            lastFlip: null,
            lastRound: null,
            awaitingConstruction: false,
            pendingGameOver: null,
            compareHold: false,
          };
          render();
        }
        break;
      }
      case S_OPPONENT_DISCONNECTED: {
        showWaiting("对手已断开连接，等待重连...");
        break;
      }
      case S_OPPONENT_RECONNECTED: {
        hideWaiting();
        break;
      }
      case S_PICKS_LOCKED: {
        clientPhase = "ordering";
        hideWaiting();
        const myPicks = msg[`${myPlayerId}Picks`] ?? (myPlayerId === "p1" ? msg.p1Picks : msg.p2Picks);
        state.setup = {
          step: "build",
          myPicks: myPicks,
          topName: null,
        };
        render();
        break;
      }
      case S_GAME_START: {
        clientPhase = "game";
        hideWaiting();
        state = hydrateState(msg.state);
        if (Array.isArray(msg.log)) {
          clearLog();
          for (const line of msg.log) els.log.textContent += line + "\n";
        }
        render();
        break;
      }
      case S_STATE_SYNC: {
        hideWaiting();
        if (clientPhase !== "game") {
          // Reconnected mid-game
          clientPhase = "game";
          hideLobby();
        }
        state = hydrateState(msg.state);
        if (Array.isArray(msg.log)) {
          clearLog();
          for (const line of msg.log) els.log.textContent += line + "\n";
          els.log.scrollTop = els.log.scrollHeight;
        }
        render();
        break;
      }
      case S_WAITING: {
        const labels = {
          pick: "等待对方选择战士...",
          order: "等待对方排列起手牌堆...",
          elf_pick: "等待对方选择精灵入场...",
          construction: "等待对方完成构筑...",
        };
        showWaiting(labels[msg.action] || "等待对方操作...");
        break;
      }
      case S_ELF_PICK_NEEDED: {
        // State sync already has pendingElfPickByPlayer set; just ensure render
        hideWaiting();
        render();
        break;
      }
      case S_GAME_OVER: {
        hideWaiting();
        if (msg.state) state = hydrateState(msg.state);
        render();
        break;
      }
      case S_ERROR: {
        window.alert(msg.message || "服务器错误");
        break;
      }
    }
  }

  function phaseLabel() {
    if (state.phase === PHASE.BATTLE) return `战斗轮次 ${state.round} · 回合 ${state.turn}`;
    if (state.phase === PHASE.CONSTRUCTION) return `构筑阶段`;
    if (state.phase === PHASE.GAME_OVER) {
      const isKoNow = (f) => {
        if (f?.koByFlame === true) return true;
        if (f?.name === "精灵族") return f?.elf?.gameKo === true;
        return Array.isArray(f.koLines) && f.koLines.length > 0 ? f.koLines.includes(Number(f.hp) || 0) : Number(f.hp) <= Number(f.koLine);
      };
      const p1KO = state.players?.p1?.fighters?.some(isKoNow) === true;
      const p2KO = state.players?.p2?.fighters?.some(isKoNow) === true;
      const resLine =
        state.winner === "draw" ? `平局` : state.winner === "p1" ? `P1 胜 / P2 败` : state.winner === "p2" ? `P2 胜 / P1 败` : "-";
      return `结束结算：${resLine}（P1 ${p1KO ? "KO" : "未KO"}，P2 ${p2KO ? "KO" : "未KO"}）`;
    }
    if (state.phase === PHASE.SETUP) return `初始化`;
    if (state.phase === PHASE.LOADING) return `加载中`;
    return String(state.phase);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function headshotKey(name) {
    const n = String(name ?? "");
    if (n === "玛曼布丽吉特") return "玛曼";
    return n;
  }

  function headshotUrl(name) {
    const key = headshotKey(name);
    return `headshots/${encodeURIComponent(key)}.png`;
  }

  function headshotImgHtml(name, className) {
    const url = headshotUrl(name);
    const cls = className ? String(className) : "headshot";
    return `<img class="${escapeHtml(cls)}" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.display='none'">`;
  }

  function cardLabel(card) {
    if (!card) return "-";
    const n = card.cardName ? String(card.cardName).trim() : "";
    return n ? `${card.fighterName}·${n}` : `${card.fighterName}#${card.cardNo}`;
  }

  function displayCardText(card) {
    if (!card) return "-";
    const showFlipHint =
      state?.phase === PHASE.BATTLE &&
      state?.lastRound?.round === state?.round &&
      state?.lastRound?.turn === state?.turn &&
      state?.lastRound?.flipTriggeredByCardId?.has?.(card.id) === true;
    if (card.fighterName === "郑一嫂" && Number(card.cardNo) === 1)
      return `船0~7攻击；8~15回复2；20群伤至1；战船+1${showFlipHint ? "（触发翻转）" : ""}`;
    if (card.fighterName === "派克帮" && Number(card.cardNo) === 1)
      return `警在己方：攻击&交警；警在对方：获得警&力量同时+1${showFlipHint ? "（触发翻转）" : ""}`;
    const t = card.text || "";
    let shownFlipped = card.flipped === true;
    const lf = state?.lastFlip;
    if (lf?.p1Card?.id && lf.p1Card.id === card.id) shownFlipped = lf.p1FlippedAtStart === true;
    else if (lf?.p2Card?.id && lf.p2Card.id === card.id) shownFlipped = lf.p2FlippedAtStart === true;
    const idx = t.indexOf("//");
    if (idx >= 0) {
      const before = t.slice(0, idx).trim();
      const after = t.slice(idx + 2).trim();
      if (after) {
        const base = shownFlipped === true ? `${after} // ${before}` : `${before} // ${after}`;
        return `${base}${showFlipHint ? "（触发翻转）" : ""}`;
      }
    }
    return `${t || "-"}${showFlipHint ? "（触发翻转）" : ""}`;
  }

  function cardTitleHtml(card) {
    if (!card) return "-";
    const n = card.cardName ? String(card.cardName).trim() : "";
    return `${escapeHtml(card.fighterName)}${n ? ` · ${escapeHtml(n)}` : `#${card.cardNo}`}`;
  }

  function snapshotFighters() {
    const fighters = [...state.players.p1.fighters, ...state.players.p2.fighters];
    const m = new Map();
    for (const x of fighters) m.set(x.id, { hp: x.hp, power: x.power });
    return m;
  }

  function renderHpGrid(f, overlay, opts) {
    const rulesByHp = new Map((f.hpRules ?? []).map((r) => [r.hp, r.effect]));
    const maxHp = Math.max(1, Number(f.maxHp) || 1);
    const hp = Number(f.hp) || 0;
    const extraLabelCount = f.name === "玛曼布丽吉特" ? 1 : 0;
    const koValuesRaw =
      Array.isArray(f.koLines) && f.koLines.length > 0 ? f.koLines : [Number(f.koLine) || 0];
    const koValues = [...koValuesRaw]
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);
    const extraHead = extraLabelCount + Math.max(1, koValues.length);
    const maxIdx = Math.min(30, maxHp + extraHead);
    const idxForHp = (h) => {
      const v = Number(h);
      if (!Number.isFinite(v)) return extraHead + 1;
      const minKo = koValues[0] ?? 0;
      if (v <= minKo) return extraLabelCount + 1;
      const kIdx = koValues.indexOf(v);
      if (kIdx >= 0) return extraLabelCount + 1 + kIdx;
      const clamped = Math.max(1, Math.min(maxHp, v));
      return extraHead + clamped;
    };
    const slots = Math.max(1, Math.min(30, Number(opts?.cells) || 30));
    const maxIdx2 = Math.min(slots, maxHp + extraHead);
    const currentIdx = Math.max(1, Math.min(maxIdx2, idxForHp(hp)));
    const oldIdxRaw = overlay?.oldHp ?? null;
    const oldIdx =
      oldIdxRaw == null ? null : Math.max(1, Math.min(maxIdx2, idxForHp(Number(oldIdxRaw))));
    const hpDelta = Number(overlay?.hpDelta) || 0;
    const hpPath = Array.isArray(overlay?.hpPath) ? overlay.hpPath : null;
    const showHpDelta = Boolean(overlay?.showHpDelta) && hpDelta !== 0 && oldIdx != null && oldIdx !== currentIdx;
    const hpMoveLabel = showHpDelta ? `${hpDelta > 0 ? "→" : "←"}${Math.abs(hpDelta)}` : "";
    let cells = "";
    for (let i = 1; i <= slots; i++) {
      const enabled = i <= maxHp + extraHead;
      const isCurrent = enabled && i === currentIdx;
      const isKoCell = enabled && i > extraLabelCount && i <= extraHead;
      const filled = enabled && i > extraHead && i - extraHead <= hp;
      const ruleRaw = enabled && i > extraHead ? rulesByHp.get(i - extraHead) : null;
      const rule = ruleRaw ? String(ruleRaw).replaceAll("力量", "力") : null;
      const isOld = showHpDelta && i === oldIdx;
      const classes = `hp-cell${enabled ? "" : " disabled"}${filled ? " filled" : ""}${isCurrent ? " current" : ""}${isOld ? " old" : ""}`;
      let dataHp = "";
      if (f.name === "玛曼布丽吉特" && i === 1) dataHp = "bonus";
      else if (isKoCell) dataHp = `${koValues[i - extraLabelCount - 1] ?? koValues[0] ?? 0}`;
      else if (enabled && i > extraHead) dataHp = `${i - extraHead}`;
      cells += `
        <div class="${classes}" data-hp="${dataHp}">
          ${f.name === "玛曼布丽吉特" && i === 1 ? `<div class="hp-rule">力+1</div>` : ""}
          ${isKoCell ? `<div class="hp-ko">KO</div>` : ""}
          ${isCurrent ? `<div class="hp-cur">HP</div>` : ""}
          ${isOld ? `<div class="hp-move ${hpDelta > 0 ? "hp-move-up" : "hp-move-down"}">${hpMoveLabel}</div>` : ""}
          ${rule ? `<div class="hp-rule">${escapeHtml(rule)}</div>` : ""}
        </div>
      `;
    }
    const arrowHtml =
      f.name === "玛曼布丽吉特"
        ? `<div class="hp-arrow"></div>`
        : "";
    let jumpHtml = "";
    if (f.name === "玛曼布丽吉特" && hpPath && hpPath.length >= 3) {
      const idxNeg2 = hpPath.indexOf(-2);
      const idx4 = hpPath.lastIndexOf(4);
      if (idxNeg2 >= 1 && idx4 > idxNeg2) {
        const fromVal = hpPath[idxNeg2 - 1];
        jumpHtml = `<div class="hp-jump hp-jump-left" data-from="${fromVal}" data-to="bonus"></div><div class="hp-jump hp-jump-right" data-from="bonus" data-to="4"></div>`;
      }
    }
    if (opts?.compact === true) {
      return `
        <div class="hp-grid elf-compact" style="--hp-cells:${slots}">
          ${cells}
          ${arrowHtml}
          ${jumpHtml}
        </div>
      `;
    }
    return `
      <div class="hp-wrap">
        <div class="hp-label">HP</div>
        <div class="hp-grid" style="--hp-cells:${slots}">
          ${cells}
          ${arrowHtml}
          ${jumpHtml}
        </div>
        <div class="hp-num">${hp}/${maxHp}</div>
      </div>
    `;
  }

  function renderElfHpGrid(f, shownHp, overlay) {
    const spirits = Array.isArray(f?.elf?.spirits) ? f.elf.spirits : [];
    const dead = Array.isArray(f?.elf?.dead) ? f.elf.dead : [false, false, false];
    const active = Number.isFinite(f?.elf?.active) ? Number(f.elf.active) : null;
    const activeSpirit = active == null ? null : spirits[active] ?? null;
    const activeMax = Math.max(0, Number(activeSpirit?.maxHp) || 0);
    const hpNow = Math.max(0, Math.min(activeMax, Number(shownHp) || 0));
    const slots = 30;
    let cells = "";
    for (let col = 1; col <= slots; col++) {
      if (col > 18) {
        cells += `<div class="hp-cell disabled" data-hp=""></div>`;
        continue;
      }
      const g = Math.floor((col - 1) / 6);
      const pos = ((col - 1) % 6) + 1;
      const sp = spirits[g] ?? null;
      const spMax = Math.max(0, Number(sp?.maxHp) || 0);
      const isDead = dead[g] === true;
      const isActive = active === g;
      const tag = isDead ? "elf-dead" : isActive ? "elf-active" : "elf-idle";
      const rulesByHp = new Map((sp?.hpRules ?? []).map((r) => [r.hp, r.effect]));

      if (pos === 1) {
        const isCurrent = isActive && hpNow <= 0;
        cells += `
          <div class="hp-cell ${tag}${isCurrent ? " current" : ""}" data-hp="0">
            <div class="hp-ko">KO</div>
            ${isCurrent ? `<div class="hp-cur">HP</div>` : ""}
          </div>
        `;
        continue;
      }

      const hpIndex = pos - 1;
      if (hpIndex > spMax) {
        cells += `<div class="hp-cell placeholder ${tag}" data-hp=""></div>`;
        continue;
      }
      const hpVal = isDead ? 0 : isActive ? hpNow : spMax;
      const filled = hpIndex <= hpVal;
      const isCurrent = isActive && hpVal > 0 && hpIndex === hpVal;
      const ruleRaw = rulesByHp.get(hpIndex) ?? null;
      const rule = ruleRaw ? String(ruleRaw).replaceAll("力量", "力") : null;
      const oldIdxRaw = overlay?.oldHp ?? null;
      const oldHp = isActive && oldIdxRaw != null ? Math.max(0, Math.min(activeMax, Number(oldIdxRaw) || 0)) : null;
      const isOld = isActive && oldHp != null && hpIndex === oldHp && Number(overlay?.hpDelta) !== 0 && oldHp !== hpNow;
      const hpDelta = isActive ? Number(overlay?.hpDelta) || 0 : 0;
      const hpMoveLabel = isOld ? `${hpDelta > 0 ? "→" : "←"}${Math.abs(hpDelta)}` : "";
      const classes = `hp-cell ${tag}${filled ? " filled" : ""}${isCurrent ? " current" : ""}${isOld ? " old" : ""}`;
      cells += `
        <div class="${classes}" data-hp="${hpIndex}">
          ${isCurrent ? `<div class="hp-cur">HP</div>` : ""}
          ${isOld ? `<div class="hp-move ${hpDelta > 0 ? "hp-move-up" : "hp-move-down"}">${hpMoveLabel}</div>` : ""}
          ${rule ? `<div class="hp-rule">${escapeHtml(rule)}</div>` : ""}
        </div>
      `;
    }
    return `
      <div class="hp-wrap">
        <div class="hp-label">HP</div>
        <div class="hp-grid" style="--hp-cells:${slots}">
          ${cells}
        </div>
        <div class="hp-num">${active == null ? "-" : `${hpNow}/${activeMax}`}</div>
      </div>
    `;
  }

  function renderPowerGrid(f, overlay) {
    const slots = 30;
    const powerRaw = Number(f?.power) || 0;
    const power = Math.max(0, powerRaw);
    const filledCount = Math.min(slots, power);
    const over = power > slots;

    const oldPowerRaw = overlay?.oldPower ?? null;
    const oldPower = oldPowerRaw == null ? null : Math.max(0, Number(oldPowerRaw) || 0);
    const powerDelta = Number(overlay?.powerDelta) || 0;
    const showPowerDelta =
      Boolean(overlay?.showPowerDelta) && powerDelta !== 0 && oldPower != null && oldPower !== power;
    const oldIdx = showPowerDelta ? Math.max(1, Math.min(slots, Math.max(1, oldPower))) : null;
    const moveLabel = showPowerDelta ? `${powerDelta > 0 ? "→" : "←"}${Math.abs(powerDelta)}` : "";

    let cells = "";
    for (let i = 1; i <= slots; i++) {
      const filled = i <= filledCount;
      const isOld = showPowerDelta && i === oldIdx;
      const classes = `power-cell${filled ? " filled" : ""}${isOld ? " old" : ""}`;
      cells += `
        <div class="${classes}" data-power="${i}">
          ${isOld ? `<div class="power-move ${powerDelta > 0 ? "power-move-up" : "power-move-down"}">${moveLabel}</div>` : ""}
        </div>
      `;
    }

    return `
      <div class="power-wrap">
        <div class="power-label">力</div>
        <div class="power-grid" style="--hp-cells:${slots}">
          ${cells}
          ${over ? `<div class="power-plus">+</div>` : ""}
        </div>
        <div class="power-num">${power}</div>
      </div>
    `;
  }

  function renderFighter(f, opts) {
    const isMain = opts?.isMain === true;
    function isKoNow(fx) {
      if (fx?.koByFlame === true) return true;
      if (fx?.name === "精灵族") return fx?.elf?.gameKo === true;
      if (Array.isArray(fx.koLines) && fx.koLines.length > 0) {
        return fx.koLines.includes(Number(fx.hp) || 0);
      }
      return Number(fx.hp) <= Number(fx.koLine);
    }
    const isKo = isKoNow(f);
    const policeMark = f.police === true ? `<div class="police-mark">警</div>` : "";
    const flameTotal = (() => {
      const v = f?.flame;
      if (!v || typeof v !== "object") return 0;
      let sum = 0;
      for (const x of Object.values(v)) sum += Number(x) || 0;
      return Math.max(0, Math.min(5, sum));
    })();
    const flameMark = flameTotal > 0 ? `<div class="flame-mark">焰${flameTotal}</div>` : "";
    const ningTotal = (() => {
      const v = f?.ning;
      if (!v || typeof v !== "object") return 0;
      let sum = 0;
      for (const x of Object.values(v)) sum += Number(x) || 0;
      return Math.max(0, Math.min(2, sum));
    })();
    const ningMark = ningTotal > 0 ? `<div class="ning-mark">凝${ningTotal}</div>` : "";
    const guardMark = f.guard === true ? `<div class="guard-mark">护</div>` : "";
    const pidForMark = String(f?.id ?? "").split(":")[0];
    const golemBlockMark =
      f?.name === "魔像" &&
      state?.phase === PHASE.BATTLE &&
      state?.lastRound?.round === state?.round &&
      state?.lastRound?.turn === state?.turn &&
      state?.lastRound?.guardBlockedByPlayerId?.has?.(pidForMark) === true
        ? `<div class="golem-block-mark">魔像抵挡！</div>`
        : "";
    const headshot = headshotImgHtml(f.name, "fighter-headshot");
    const rev = Math.max(0, Math.min(4, Number(f.revelation) || 0));
    const revBar =
      f.name === "贞德"
        ? `
          <div class="revelation-wrap">
            <div class="revelation-label">神示</div>
            <div class="revelation-grid">
              <div class="revelation-cell${rev === 1 ? " active" : ""}"></div>
              <div class="revelation-cell${rev === 2 ? " active" : ""}"><div class="revelation-eff">力+1</div></div>
              <div class="revelation-cell${rev === 3 ? " active" : ""}"></div>
              <div class="revelation-cell${rev === 4 ? " active" : ""}"><div class="revelation-eff">友力+1</div></div>
            </div>
          </div>
        `
        : "";
    const ship = Math.max(0, Math.min(20, Number(f.battleship) || 0));
    let shipCells = "";
    for (let i = 1; i <= 20; i++) {
      shipCells += `<div class="ship-cell${i <= ship ? " filled" : ""}${ship > 0 && i === ship ? " current" : ""}"></div>`;
    }
    const shipBar =
      f.name === "郑一嫂"
        ? `
          <div class="ship-wrap">
            <div class="ship-label">战船</div>
            <div class="ship-grid">${shipCells}</div>
            <div class="ship-num">${ship}/20</div>
          </div>
        `
        : "";
    const rage = Math.max(0, Math.min(7, Number(f.rage) || 0));
    let rageCells = "";
    for (let i = 1; i <= 7; i++) {
      rageCells += `<div class="rage-cell${i <= rage ? " filled" : ""}${rage > 0 && i === rage ? " current" : ""}"></div>`;
    }
    const formLabel = f.bodvarForm === "bear" ? "熊" : "人";
    const rageBar =
      f.name === "博德瓦尔"
        ? `
          <div class="rage-wrap">
            <div class="rage-label">怒</div>
            <div class="rage-grid">${rageCells}</div>
            <div class="rage-num">${formLabel} ${rage}/7</div>
          </div>
        `
        : "";
    const planState = f?.plan;
    const planBar =
      f.name === "米莱狄" && planState
        ? `
          <div class="plan-wrap">
            <div class="plan-label">计划</div>
            <div class="plan-num">未${(planState.available ?? []).length} 已${(planState.ready ?? []).length} 弃${(planState.discard ?? []).length}</div>
          </div>
        `
        : "";
    const snakeFlipMark = f?.snakeFlipMark ?? null;
    const snakeSeq = (() => {
      const cur = (Number(f.snake) || 0) === 1 ? 1 : 0;
      const base = Array.isArray(snakeFlipMark) && snakeFlipMark.length > 0 ? snakeFlipMark.map((v) => ((Number(v) || 0) === 1 ? 1 : 0)) : [cur];
      if (base[base.length - 1] !== cur) base.push(cur);
      return base;
    })();
    const snakeChainHtml = snakeSeq
      .map((v) => `<span class="snake-chip ${v === 1 ? "black" : "white"}"></span>`)
      .join(`<span class="snake-arrow">→</span>`);
    const snakeBar =
      f.name === "靡菲斯特"
        ? `
          <div class="snake-wrap">
            <div class="snake-label">蛇</div>
            <div class="snake-cell"><div class="snake-chain">${snakeChainHtml}</div></div>
          </div>
        `
        : "";
    const lastRound = state.lastRound;
    const comparing = state.compareHold === true && lastRound?.before?.has(f.id);
    const base = comparing ? lastRound.before.get(f.id) : null;
    const shownHp = base ? base.hp : f.hp;
    const shownPower = base ? base.power : f.power;
    const pText = `${shownPower}`;
    const soulMark =
      f.name === "精灵族" ? `<div class="soul-mark">魂${Math.max(0, Number(f?.elf?.soul) || 0)}</div>` : "";
    const pidForElf = String(f?.id ?? "").split(":")[0];
    let elfPickHtml = "";
    if (f.name === "精灵族" && f.elf && state.phase === PHASE.BATTLE && state.pendingElfPickByPlayer?.[pidForElf]) {
      const spirits = Array.isArray(f.elf.spirits) ? f.elf.spirits : [];
      const dead = Array.isArray(f.elf.dead) ? f.elf.dead : [false, false, false];
      const soul = Math.max(0, Number(f?.elf?.soul) || 0);
      const pendingKoIndex = Number.isFinite(f?.elf?.pendingKoIndex) ? Number(f.elf.pendingKoIndex) : null;
      const buttons = [0, 1, 2]
        .map((i) => {
          const sp = spirits[i] ?? null;
          const maxHp = Math.max(0, Number(sp?.maxHp) || 0);
          const d = dead[i] === true || pendingKoIndex === i;
          const colStart = 1 + i * 6;
          return `<button type="button" class="elf-pick-btn${d ? " disabled" : ""}" data-elf-pick="${pidForElf}:${i}" ${
            d ? "disabled" : ""
          } style="grid-column:${colStart} / span 6"><div class="elf-pick-title">灵${i + 1}</div><div class="elf-pick-sub">血量${maxHp}</div></button>`;
        })
        .join("");
      if (myPlayerId && pidForElf !== myPlayerId) {
        // Online: opponent sees waiting message instead of pick buttons
        elfPickHtml = `
          <div class="elf-pick-in-card">
            <div class="elf-pick-hint">等待对方选择精灵入场...</div>
          </div>
        `;
      } else {
        elfPickHtml = `
          <div class="elf-pick-in-card">
            <div class="elf-pick-hint">${pendingKoIndex != null ? "选择下一位灵" : "选择进入游戏的灵"}（魂=${soul}）</div>
            <div class="elf-pick-row-grid" style="--hp-cells:30">${buttons}</div>
          </div>
        `;
      }
    }

    let powerDeltaHtml = "";
    let powerOverlay = null;
    let hpOverlay = null;
    const overlay =
      !comparing && state.phase === PHASE.BATTLE && lastRound?.before?.has(f.id) && lastRound?.after?.has(f.id)
        ? lastRound
        : !comparing &&
            state.lastIntermissionEffect?.before?.has(f.id) &&
            state.lastIntermissionEffect?.after?.has(f.id) &&
            (state.phase === PHASE.CONSTRUCTION || (state.phase === PHASE.BATTLE && !state.lastFlip))
          ? state.lastIntermissionEffect
          : null;

    if (overlay) {
      const b = overlay.before.get(f.id);
      const a = overlay.after.get(f.id);
      const dp = (a.power ?? 0) - (b.power ?? 0);
      const dh = (a.hp ?? 0) - (b.hp ?? 0);
      if (dp !== 0) powerOverlay = { oldPower: b.power, powerDelta: dp, showPowerDelta: true };
      const hpPath = overlay?.hpTraceById?.get?.(f.id) ?? null;
      hpOverlay = { oldHp: b.hp, hpDelta: dh, showHpDelta: true, hpPath };
    }
    let hpHtml = renderHpGrid({ ...f, hp: shownHp }, hpOverlay);
    if (f.name === "精灵族" && f.elf) {
      hpHtml = renderElfHpGrid(f, shownHp, hpOverlay);
    }
    const powerHtml = renderPowerGrid({ ...f, power: shownPower }, powerOverlay);
    return `
      <div class="fighter${isMain ? " fighter-main" : ""}">
        ${policeMark}
        ${flameMark}
        ${ningMark}
        ${guardMark}
        ${golemBlockMark}
        <div class="fighter-top">
          ${headshot}
          <div class="fighter-name">${f.name}</div>
          ${soulMark}
          ${isKo ? `<div class="ko-badge">KO!</div>` : ""}
        </div>
        ${hpHtml}
        ${powerHtml}
        ${elfPickHtml}
        ${revBar}
        ${shipBar}
        ${rageBar}
        ${planBar}
        ${snakeBar}
      </div>
    `;
  }

  function renderDeckList(title, cards) {
    const lines = cards
      .map((c, idx) => `${String(idx + 1).padStart(2, "0")}. ${cardLabel(c)}  ${displayCardText(c)}`)
      .join("\n");
    return `
      <div class="deck-title">${title}</div>
      <div class="deck-list">${lines || "-"}</div>
    `;
  }

  function syncRevelationSizing() {
    const hpCell = els.constructionPanel.querySelector(`.hp-grid .hp-cell:not(.disabled)`) ?? document.querySelector(`.hp-grid .hp-cell:not(.disabled)`);
    if (!hpCell) return;
    const hpGrid = hpCell.closest(".hp-grid");
    if (!hpGrid) return;
    const cellW = hpCell.getBoundingClientRect().width;
    if (!(cellW > 0)) return;
    const revCellW = Math.max(10, Math.floor(cellW * 2));
    document.querySelectorAll(".revelation-grid").forEach((el) => {
      el.style.setProperty("--rev-cell-w", `${revCellW}px`);
    });
  }

  function renderPlayers() {
    if (state.phase === PHASE.LOADING) return;
    const p1 = state.players?.p1;
    const p2 = state.players?.p2;
    if (!p1 || !p2) {
      els.p1Fighters.innerHTML = "";
      els.p2Fighters.innerHTML = "";
      els.p1BattleCount.textContent = `战斗牌库: -`;
      els.p1ConstructCount.textContent = `构筑牌库: -`;
      els.p1ResolvedCount.textContent = `已结算: -`;
      els.p2BattleCount.textContent = `战斗牌库: -`;
      els.p2ConstructCount.textContent = `构筑牌库: -`;
      els.p2ResolvedCount.textContent = `已结算: -`;
      els.p1Decks.innerHTML = "";
      els.p2Decks.innerHTML = "";
      els.p1Decks.classList.add("hidden");
      els.p2Decks.classList.add("hidden");
      return;
    }

    const p1Main = state.phase === PHASE.BATTLE && state.lastFlip ? state.lastFlip.p1Card?.fighterName : null;
    const p2Main = state.phase === PHASE.BATTLE && state.lastFlip ? state.lastFlip.p2Card?.fighterName : null;
    els.p1Fighters.innerHTML = p1.fighters.map((f) => renderFighter(f, { isMain: p1Main === f.name })).join("");
    els.p2Fighters.innerHTML = p2.fighters.map((f) => renderFighter(f, { isMain: p2Main === f.name })).join("");
    document.querySelectorAll(`[data-elf-pick]`).forEach((btn) => {
      btn.addEventListener("click", () => {
        const raw = btn.getAttribute("data-elf-pick") || "";
        const [pid, idxStr] = raw.split(":");
        if (pid !== myPlayerId) return; // can only pick own elf
        const idx = Number(idxStr);
        if (!Number.isFinite(idx) || idx < 0 || idx > 2) return;
        sendMsg(C_ELF_PICK, { spiritIndex: idx });
      });
    });

    const p1bc = p1.battleDeckCount ?? p1.battleDeck.length;
    const p1cc = p1.constructionDeckCount ?? p1.constructionDeck.length;
    const p1rc = p1.resolvedPileCount ?? p1.resolvedPile.length;
    const p2bc = p2.battleDeckCount ?? p2.battleDeck.length;
    const p2cc = p2.constructionDeckCount ?? p2.constructionDeck.length;
    const p2rc = p2.resolvedPileCount ?? p2.resolvedPile.length;
    els.p1BattleCount.textContent = `战斗牌库: ${p1bc}`;
    els.p1ResolvedCount.textContent = `已结算: ${p1rc}`;
    els.p2BattleCount.textContent = `战斗牌库: ${p2bc}`;
    els.p2ResolvedCount.textContent = `已结算: ${p2rc}`;
    if (myPlayerId) {
      // Online: hide opponent's construction deck count
      const myCC = myPlayerId === "p1" ? els.p1ConstructCount : els.p2ConstructCount;
      const oppCC = myPlayerId === "p1" ? els.p2ConstructCount : els.p1ConstructCount;
      myCC.textContent = `构筑牌库: ${myPlayerId === "p1" ? p1cc : p2cc}`;
      oppCC.textContent = `构筑牌库: ?`;
    } else {
      els.p1ConstructCount.textContent = `构筑牌库: ${p1cc}`;
      els.p2ConstructCount.textContent = `构筑牌库: ${p2cc}`;
    }

    if (myPlayerId) {
      // Online mode: only show own decks
      const myEls = myPlayerId === "p1" ? els.p1Decks : els.p2Decks;
      const oppEls = myPlayerId === "p1" ? els.p2Decks : els.p1Decks;
      const my = myPlayerId === "p1" ? p1 : p2;
      myEls.innerHTML =
        renderDeckList("战斗牌库（从上到下）", my.battleDeck) +
        renderDeckList("构筑牌库（从上到下）", my.constructionDeck) +
        renderDeckList("已结算（从上到下）", my.resolvedPile);
      oppEls.innerHTML = `<div class="deck-title">对手牌库内容已隐藏</div>`;
      myEls.classList.toggle("hidden", !state.showDecks);
      oppEls.classList.toggle("hidden", !state.showDecks);
    } else {
      // Offline mode: show both
      els.p1Decks.innerHTML =
        renderDeckList("战斗牌库（从上到下）", p1.battleDeck) +
        renderDeckList("构筑牌库（从上到下）", p1.constructionDeck) +
        renderDeckList("已结算（从上到下）", p1.resolvedPile);
      els.p2Decks.innerHTML =
        renderDeckList("战斗牌库（从上到下）", p2.battleDeck) +
        renderDeckList("构筑牌库（从上到下）", p2.constructionDeck) +
        renderDeckList("已结算（从上到下）", p2.resolvedPile);
      els.p1Decks.classList.toggle("hidden", !state.showDecks);
      els.p2Decks.classList.toggle("hidden", !state.showDecks);
    }
    syncRevelationSizing();
    requestAnimationFrame(() => requestAnimationFrame(positionHpArrows));
  }

  function positionHpArrows() {
    const arrows = document.querySelectorAll(".hp-grid .hp-arrow");
    for (const arrow of arrows) {
      const grid = arrow.parentElement;
      if (!grid) continue;
      const from = grid.querySelector('.hp-cell[data-hp="bonus"]');
      const to = grid.querySelector('.hp-cell[data-hp="4"]');
      if (!from || !to) continue;
      const gridRect = grid.getBoundingClientRect();
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const x1 = fromRect.left - gridRect.left + fromRect.width / 2;
      const x2 = toRect.left - gridRect.left + toRect.width / 2;
      const y = toRect.top - gridRect.top + toRect.height / 2 - 1;
      const left = Math.min(x1, x2);
      const width = Math.abs(x2 - x1);
      const tip = 6;
      arrow.style.setProperty("--arrow-tip", `${tip}px`);
      arrow.style.left = `${left}px`;
      arrow.style.width = `${Math.max(0, width - tip)}px`;
      arrow.style.top = `${y}px`;
    }

    const jumps = document.querySelectorAll(".hp-grid .hp-jump");
    for (const jump of jumps) {
      const grid = jump.parentElement;
      if (!grid) continue;
      const fromKey = jump.getAttribute("data-from");
      const toKey = jump.getAttribute("data-to");
      if (!fromKey || !toKey) continue;
      const from = grid.querySelector(`.hp-cell[data-hp="${fromKey}"]`);
      const to = grid.querySelector(`.hp-cell[data-hp="${toKey}"]`);
      if (!from || !to) continue;
      const gridRect = grid.getBoundingClientRect();
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const x1 = fromRect.left - gridRect.left + fromRect.width / 2;
      const x2 = toRect.left - gridRect.left + toRect.width / 2;
      const left = Math.min(x1, x2);
      const width = Math.abs(x2 - x1);
      const tip = 6;
      const baseY = fromRect.top - gridRect.top + fromRect.height + 4;
      const y = jump.classList.contains("hp-jump-right") ? baseY + 4 : baseY;
      jump.style.setProperty("--arrow-tip", `${tip}px`);
      jump.style.left = `${left}px`;
      jump.style.width = `${Math.max(0, width - tip)}px`;
      jump.style.top = `${y}px`;
    }
  }

  function renderBattleReveal() {
    if (!els.battleReveal) return;
    if (state.phase !== PHASE.BATTLE) {
      els.battleReveal.innerHTML = "";
      return;
    }
    const last = state.lastFlip;
    if (!last) {
      els.battleReveal.innerHTML = `
        <div class="battle-reveal-inner">
          <div class="battle-hint">点击“翻牌并结算”开始本轮次第 ${state.turn} 回合</div>
        </div>
      `;
      return;
    }
    const { p1Card, p2Card, round, turn } = last;
    const planEvents =
      state.lastRound && state.lastRound.round === round && state.lastRound.turn === turn ? state.lastRound.planEvents ?? [] : [];
    const planHtml = (side) => {
      const pid = side === "P2" ? "p2" : "p1";
      const list = planEvents.filter((e) => e?.playerId === pid && e?.kind === "execute");
      if (list.length === 0) return "";
      const items = list
        .map((e) => {
          const source = e.source === "hpRule" ? `HP${e.triggerHp ?? ""}` : "卡";
          const title = `${source}实施`;
          const body = e.result === "empty" ? "无可实施" : String(e.planText ?? "").trim();
          return `<div class="plan-mini"><div class="plan-mini-title">${escapeHtml(title)}</div><div class="plan-mini-body">${escapeHtml(body || "-")}</div></div>`;
        })
        .join("");
      return `<div class="battle-card-plans">${items}</div>`;
    };
    const cardHtml = (side, card) => `
      <div class="battle-card" data-side="${side}">
        <div class="battle-card-top">
          <div class="battle-card-side">${side}</div>
          <div class="battle-card-title">${cardTitleHtml(card)}</div>
        </div>
        <div class="battle-card-body">${displayCardText(card)}</div>
        ${planHtml(side)}
      </div>
    `;
    els.battleReveal.innerHTML = `
      <div class="battle-reveal-inner">
        <div class="battle-round">轮次 ${round} · 回合 ${turn} 翻牌</div>
        <div class="battle-cards">
          ${cardHtml("P1", p1Card)}
          ${cardHtml("P2", p2Card)}
        </div>
      </div>
    `;
  }

  function renderConstruction() {
    els.constructionPanel.innerHTML = "";
    if (state.phase === PHASE.SETUP) {
      const pool = new Map(data.fighterDefs.map((f) => [f.name, f]));
      const names = [...data.fighterDefs]
        .slice()
        .sort((a, b) => (Number(a.code) || 0) - (Number(b.code) || 0))
        .map((f) => f.name);
      if (names.length < 2) {
        els.constructionPanel.innerHTML = `<div class="construction-card">战士库不足，无法开始游戏</div>`;
        return;
      }
      const setup = state.setup ?? { step: "pick", p1a: null, p1b: null, p2a: null, p2b: null, p1Built: [], p2Built: [] };
      state.setup = setup;
      if (!setup.step) setup.step = "pick";

      const cardText = (fighterName) => {
        if (fighterName === "郑一嫂") return "船0~7攻击；8~15回复2；20群伤至1；战船+1";
        if (fighterName === "派克帮") return "警在己方：攻击&交警；警在对方：获得警&力量同时+1";
        return pool.get(fighterName)?.deckTextByNo?.get(1) ?? "";
      };
      const cardName1 = (fighterName) => pool.get(fighterName)?.deckNameByNo?.get(1) ?? "";
      const setupCardHtml = (playerId, fighterName, variant) => {
        const text = cardText(fighterName);
        const n1 = cardName1(fighterName);
        return `
          <div class="insert-card ${variant}" draggable="false" data-setup="true" data-player="${playerId}" data-name="${fighterName}">
            <div class="insert-title">${fighterName}${n1 ? ` · ${n1}` : "#1"}</div>
            <div class="insert-text">${text}</div>
          </div>
        `;
      };

      const setupBoardHtml = (playerId, built) => {
        let html = "";
        const arr = Array.isArray(built) ? built : [];
        html += `<div class="setup-board-slot" data-setup-slot="top" data-player="${playerId}">放到顶</div>`;
        if (arr.length === 0) {
          html += `<div class="setup-board-empty">（空）</div>`;
        } else {
          for (let i = 0; i < arr.length; i++) {
            const name = arr[i];
            const n1 = cardName1(name);
            html += `
              <div class="deck-card setup-built" draggable="false" data-setup="true" data-player="${playerId}" data-name="${name}">
                <div class="deck-title">${i === 0 ? "顶" : "底"}：${name}${n1 ? ` · ${n1}` : "#1"}</div>
                <div class="deck-text">${cardText(name)}</div>
              </div>
            `;
          }
        }
        html += `<div class="setup-board-slot" data-setup-slot="bottom" data-player="${playerId}">放到底</div>`;
        return html;
      };

      if (setup.step === "pick") {
        // ── Online mode: simplified pick UI (own slots only) ──
        if (clientPhase === "picking" || clientPhase === "waiting_picks") {
          const picked = new Set([setup.myA, setup.myB].filter(Boolean));
          const gridNames = names.slice(0, 12);
          const slotLabelOnline = (v, fallback) =>
            v
              ? `<div class="setup-picked" draggable="true" data-my-pick-slot data-name="${escapeHtml(v)}">${headshotImgHtml(v, "setup-headshot")}<div class="setup-fighter-name">${escapeHtml(v)}</div></div>`
              : `<div class="setup-slot-placeholder">${fallback}</div>`;
          const poolCells = [];
          for (let i = 0; i < 12; i++) {
            const n = gridNames[i] ?? null;
            if (!n) { poolCells.push(`<div class="setup-fighter placeholder"></div>`); continue; }
            const disabled = picked.has(n);
            poolCells.push(
              `<div class="setup-fighter${disabled ? " disabled" : ""}" draggable="${!disabled}" data-pick-name="${escapeHtml(n)}">${headshotImgHtml(n, "setup-headshot")}<div class="setup-fighter-name">${escapeHtml(n)}</div></div>`
            );
          }
          const waiting = clientPhase === "waiting_picks";
          els.constructionPanel.innerHTML = `
            <div class="construction-card">
              <div><strong>选择战士</strong>：选择你的 2 位战士</div>
              <div class="setup-pick-grid">
                <div class="setup-side">
                  <div class="setup-side-title"><strong>我方（${myPlayerId?.toUpperCase() ?? "?"}）</strong></div>
                  <div class="setup-slots">
                    <div class="setup-slot" data-my-slot="a">${slotLabelOnline(setup.myA, "空槽1")}</div>
                    <div class="setup-slot" data-my-slot="b">${slotLabelOnline(setup.myB, "空槽2")}</div>
                  </div>
                </div>
                <div class="setup-pool setup-pool-grid">
                  ${poolCells.join("")}
                </div>
              </div>
              <div class="construction-row">
                <button type="button" id="online-pick-clear" ${waiting ? "disabled" : ""}>清空</button>
                <div class="spacer"></div>
                <button type="button" id="online-pick-confirm" ${!waiting && setup.myA && setup.myB ? "" : "disabled"}>${waiting ? "已提交，等待对手..." : "确认选择"}</button>
              </div>
            </div>
          `;
          if (!waiting) {
            els.constructionPanel.querySelectorAll("[data-pick-name]").forEach((el) => {
              el.addEventListener("click", () => {
                if (el.classList.contains("disabled")) return;
                const name = el.getAttribute("data-pick-name");
                if (!setup.myA) setup.myA = name;
                else if (!setup.myB) { if (name !== setup.myA) setup.myB = name; }
                else { if (name !== setup.myA) setup.myB = name; }
                render();
              });
            });
            els.constructionPanel.querySelectorAll("[data-my-slot]").forEach((el) => {
              el.addEventListener("click", () => {
                const slot = el.getAttribute("data-my-slot");
                if (slot === "a") { setup.myA = setup.myB; setup.myB = null; }
                else setup.myB = null;
                render();
              });
            });
            // ── Drag-and-drop: pool fighters → slots ──
            els.constructionPanel.querySelectorAll("[data-pick-name]").forEach((el) => {
              el.addEventListener("dragstart", (ev) => {
                if (el.classList.contains("disabled")) { ev.preventDefault(); return; }
                ev.dataTransfer.setData("text/plain", `fighter:${el.getAttribute("data-pick-name")}`);
                ev.dataTransfer.effectAllowed = "copy";
                el.classList.add("dragging");
              });
              el.addEventListener("dragend", () => el.classList.remove("dragging"));
            });
            // ── Drag-and-drop: picked slot items (for reorder / remove) ──
            els.constructionPanel.querySelectorAll("[data-my-pick-slot]").forEach((el) => {
              el.addEventListener("dragstart", (ev) => {
                const parent = el.closest("[data-my-slot]");
                const slot = parent?.getAttribute("data-my-slot");
                const name = el.getAttribute("data-name");
                if (!slot || !name) { ev.preventDefault(); return; }
                ev.dataTransfer.setData("text/plain", `slot:${slot}:${name}`);
                ev.dataTransfer.effectAllowed = "move";
                el.classList.add("dragging");
              });
              el.addEventListener("dragend", () => el.classList.remove("dragging"));
            });
            // ── Drop targets: slots ──
            els.constructionPanel.querySelectorAll("[data-my-slot]").forEach((el) => {
              el.addEventListener("dragover", (ev) => {
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "copy";
                el.classList.add("active");
              });
              el.addEventListener("dragleave", () => el.classList.remove("active"));
              el.addEventListener("drop", (ev) => {
                ev.preventDefault();
                el.classList.remove("active");
                const raw = ev.dataTransfer.getData("text/plain");
                const targetSlot = el.getAttribute("data-my-slot");
                if (raw.startsWith("fighter:")) {
                  const name = raw.slice("fighter:".length);
                  if (targetSlot === "a") {
                    if (setup.myA && setup.myA !== name) { setup.myB = setup.myA; }
                    setup.myA = name;
                  } else {
                    setup.myB = (name !== setup.myA) ? name : null;
                  }
                } else if (raw.startsWith("slot:")) {
                  const parts = raw.split(":");
                  const fromSlot = parts[1];
                  const name = parts[2];
                  if (fromSlot !== targetSlot) {
                    // swap
                    const tmp = targetSlot === "a" ? setup.myA : setup.myB;
                    if (targetSlot === "a") { setup.myA = name; setup.myB = tmp; }
                    else { setup.myB = name; setup.myA = tmp; }
                  }
                }
                render();
              });
            });
            // ── Drop on pool to remove from slot ──
            const poolEl = els.constructionPanel.querySelector(".setup-pool");
            if (poolEl) {
              poolEl.addEventListener("dragover", (ev) => {
                const raw = ev.dataTransfer.types.includes("text/plain") ? "ok" : "";
                if (!raw) return;
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "move";
              });
              poolEl.addEventListener("drop", (ev) => {
                ev.preventDefault();
                const raw = ev.dataTransfer.getData("text/plain");
                if (!raw.startsWith("slot:")) return;
                const parts = raw.split(":");
                const fromSlot = parts[1];
                if (fromSlot === "a") { setup.myA = setup.myB; setup.myB = null; }
                else setup.myB = null;
                render();
              });
            }

            document.getElementById("online-pick-clear")?.addEventListener("click", () => {
              setup.myA = null; setup.myB = null; render();
            });
            document.getElementById("online-pick-confirm")?.addEventListener("click", () => {
              if (!setup.myA || !setup.myB) return;
              sendMsg(C_PICK_FIGHTERS, { picks: [setup.myA, setup.myB] });
              clientPhase = "waiting_picks";
              render();
            });
          }
          return;
        }

        const slotLabel = (v, fallback) =>
          v
            ? `<div class="setup-picked" draggable="true" data-setup-pick="picked" data-name="${escapeHtml(v)}">${headshotImgHtml(
                v,
                "setup-headshot"
              )}<div class="setup-fighter-name">${escapeHtml(v)}</div></div>`
            : `<div class="setup-slot-placeholder">${fallback}</div>`;

        const pickedByP1 = new Set([setup.p1a, setup.p1b].filter(Boolean));
        const pickedByP2 = new Set([setup.p2a, setup.p2b].filter(Boolean));
        const gridNames = names.slice(0, 12);
        const poolCells = [];
        for (let i = 0; i < 12; i++) {
          const n = gridNames[i] ?? null;
          if (!n) {
            poolCells.push(`<div class="setup-fighter placeholder"></div>`);
            continue;
          }
          const takenBy = pickedByP1.has(n) ? "p1" : pickedByP2.has(n) ? "p2" : null;
          const disabled = takenBy != null;
          const title = takenBy === "p1" ? "已被P1选择" : takenBy === "p2" ? "已被P2选择" : "";
          poolCells.push(
            `<div class="setup-fighter${disabled ? " disabled" : ""}" ${title ? `title="${title}"` : ""} draggable="${
              disabled ? "false" : "true"
            }" data-setup-pick="fighter" data-name="${escapeHtml(n)}">${headshotImgHtml(
              n,
              "setup-headshot"
            )}<div class="setup-fighter-name">${escapeHtml(n)}</div></div>`
          );
        }

        els.constructionPanel.innerHTML = `
          <div class="construction-card">
            <div><strong>初始化</strong>：拖拽选择双方各 2 位战士</div>
            <div class="setup-pick-grid">
              <div class="setup-side" data-player="p1">
                <div class="setup-side-title"><strong>P1</strong></div>
                <div class="setup-slots">
                  <div class="setup-slot" data-setup-pick="slot" data-player="p1" data-slot="a">${slotLabel(setup.p1a, "空槽1")}</div>
                  <div class="setup-slot" data-setup-pick="slot" data-player="p1" data-slot="b">${slotLabel(setup.p1b, "空槽2")}</div>
                </div>
              </div>
              <div class="setup-pool setup-pool-grid" data-player="pool">
                ${poolCells.join("")}
              </div>
              <div class="setup-side" data-player="p2">
                <div class="setup-side-title"><strong>P2</strong></div>
                <div class="setup-slots">
                  <div class="setup-slot" data-setup-pick="slot" data-player="p2" data-slot="a">${slotLabel(setup.p2a, "空槽1")}</div>
                  <div class="setup-slot" data-setup-pick="slot" data-player="p2" data-slot="b">${slotLabel(setup.p2b, "空槽2")}</div>
                </div>
              </div>
            </div>
            <div class="construction-row">
              <button type="button" id="setup-clear">清空</button>
              <div class="spacer"></div>
              <button type="button" id="setup-confirm">确认开始</button>
            </div>
          </div>
        `;

        const setSlot = (pid, slot, name) => {
          const oppPicked = pid === "p1" ? new Set([setup.p2a, setup.p2b].filter(Boolean)) : new Set([setup.p1a, setup.p1b].filter(Boolean));
          if (oppPicked.has(name)) return false;
          const key = pid === "p1" ? (slot === "a" ? "p1a" : "p1b") : slot === "a" ? "p2a" : "p2b";
          const otherKey = pid === "p1" ? (slot === "a" ? "p1b" : "p1a") : slot === "a" ? "p2b" : "p2a";
          const cur = setup[key] ?? null;
          const other = setup[otherKey] ?? null;
          if (other === name) {
            setup[otherKey] = cur;
          }
          setup[key] = name;
          return true;
        };

        const slots = els.constructionPanel.querySelectorAll(`[data-setup-pick="slot"]`);
        slots.forEach((el) => {
          el.addEventListener("dragover", (ev) => {
            ev.preventDefault();
            el.classList.add("active");
            ev.dataTransfer.dropEffect = "copy";
          });
          el.addEventListener("dragleave", () => el.classList.remove("active"));
          el.addEventListener("drop", (ev) => {
            ev.preventDefault();
            el.classList.remove("active");
            const raw = ev.dataTransfer.getData("text/plain");
            const pid = el.getAttribute("data-player");
            const slot = el.getAttribute("data-slot");
            if (!pid || !slot) return;
            if (raw.startsWith("pick:")) {
              const name = raw.slice("pick:".length);
              const ok = setSlot(pid, slot, name);
              if (!ok) {
                window.alert("对手已选择该战士");
                render();
                return;
              }
              render();
              return;
            }
            if (raw.startsWith("slot:")) {
              const parts = raw.split(":");
              if (parts.length !== 4) return;
              const fromPid = parts[1];
              const fromSlot = parts[2];
              const name = parts[3];
              if (fromPid !== pid) return;
              setSlot(pid, slot, name);
              const fromKey = pid === "p1" ? (fromSlot === "a" ? "p1a" : "p1b") : fromSlot === "a" ? "p2a" : "p2b";
              if (fromSlot !== slot) setup[fromKey] = null;
              render();
            }
          });
        });

        els.constructionPanel.querySelectorAll(`[data-setup-pick="fighter"]`).forEach((el) => {
          el.addEventListener("dragstart", (ev) => {
            if (el.classList.contains("disabled") || el.classList.contains("placeholder")) {
              ev.preventDefault();
              return;
            }
            const name = el.getAttribute("data-name");
            ev.dataTransfer.setData("text/plain", `pick:${name}`);
            ev.dataTransfer.effectAllowed = "copy";
            el.classList.add("dragging");
          });
          el.addEventListener("dragend", () => el.classList.remove("dragging"));
        });

        els.constructionPanel.querySelectorAll(`[data-setup-pick="picked"]`).forEach((el) => {
          el.addEventListener("dragstart", (ev) => {
            const name = el.getAttribute("data-name");
            const parent = el.closest(`[data-setup-pick="slot"]`);
            const pid = parent?.getAttribute("data-player");
            const slot = parent?.getAttribute("data-slot");
            if (!pid || !slot || !name) return;
            ev.dataTransfer.setData("text/plain", `slot:${pid}:${slot}:${name}`);
            ev.dataTransfer.effectAllowed = "move";
            el.classList.add("dragging");
          });
          el.addEventListener("dragend", () => el.classList.remove("dragging"));
        });

        els.constructionPanel.querySelectorAll(`.setup-pool`).forEach((poolEl) => {
          poolEl.addEventListener("dragover", (ev) => {
            ev.preventDefault();
            poolEl.classList.add("active");
            ev.dataTransfer.dropEffect = "move";
          });
          poolEl.addEventListener("dragleave", () => poolEl.classList.remove("active"));
          poolEl.addEventListener("drop", (ev) => {
            ev.preventDefault();
            poolEl.classList.remove("active");
            const raw = ev.dataTransfer.getData("text/plain");
            if (!raw.startsWith("slot:")) return;
            const parts = raw.split(":");
            if (parts.length !== 4) return;
            const pid = parts[1];
            const slot = parts[2];
            const key = pid === "p1" ? (slot === "a" ? "p1a" : "p1b") : slot === "a" ? "p2a" : "p2b";
            setup[key] = null;
            render();
          });
        });

        const confirm = document.getElementById("setup-confirm");
        confirm.disabled = !(setup.p1a && setup.p1b && setup.p2a && setup.p2b);
        confirm.addEventListener("click", () => {
          if (!(setup.p1a && setup.p1b && setup.p2a && setup.p2b)) return;
          setup.step = "build";
          setup.p1Built = [setup.p1a, setup.p1b].filter(Boolean);
          setup.p2Built = [setup.p2a, setup.p2b].filter(Boolean);
          render();
        });

        document.getElementById("setup-clear").addEventListener("click", () => {
          setup.p1a = null;
          setup.p1b = null;
          setup.p2a = null;
          setup.p2b = null;
          render();
        });
        return;
      }

      // ── Online mode: deck order UI ──
      if (clientPhase === "ordering" || clientPhase === "waiting_order") {
        const myPicks = setup.myPicks || [];
        const topName = setup.topName || null;
        const waiting = clientPhase === "waiting_order";
        const pickCards = myPicks.map((name) => {
          const n1 = cardName1(name);
          const text = cardText(name);
          const selected = topName === name ? " selected" : "";
          return `
            <div class="construction-choice selectable${selected}" data-top-pick="${escapeHtml(name)}">
              <div class="choice-title">${escapeHtml(name)}${n1 ? ` · ${escapeHtml(n1)}` : "#1"}</div>
              <pre>${escapeHtml(text)}</pre>
            </div>
          `;
        });
        els.constructionPanel.innerHTML = `
          <div class="construction-card">
            <div><strong>构筑起手</strong>：选择哪位战士的 #1 卡牌放在战斗牌堆顶部</div>
            <div class="construction-row">${pickCards.join("")}</div>
            <div class="construction-row">
              <div class="spacer"></div>
              <button type="button" id="online-order-confirm" ${!waiting && topName ? "" : "disabled"}>${waiting ? "已提交，等待对手..." : "确认顺序"}</button>
            </div>
          </div>
        `;
        if (!waiting) {
          els.constructionPanel.querySelectorAll("[data-top-pick]").forEach((el) => {
            el.addEventListener("click", () => {
              setup.topName = el.getAttribute("data-top-pick");
              render();
            });
          });
          document.getElementById("online-order-confirm")?.addEventListener("click", () => {
            if (!setup.topName) return;
            sendMsg(C_DECK_ORDER, { topName: setup.topName });
            clientPhase = "waiting_order";
            render();
          });
        }
        return;
      }

      els.constructionPanel.innerHTML = `
        <div class="construction-card setup-start">
          <div><strong>初始化</strong>：构筑双方起手战斗牌堆（每方 2 张 #1）</div>
          <div class="construction-row" style="gap:16px;">
            <div style="min-width:420px;">
              <div style="margin-top:10px;"><strong>P1</strong>：${escapeHtml(setup.p1a)} / ${escapeHtml(setup.p1b)}</div>
              <div class="construction-row" style="align-items:flex-start;">
                <div style="min-width:110px;">构筑起手牌堆</div>
                <div class="insert-area">
                  <div class="insert-outside" id="setup-pending-p1"></div>
                  <div class="insert-board" id="setup-board-p1"></div>
                </div>
              </div>
            </div>
            <div style="min-width:420px;">
              <div style="margin-top:10px;"><strong>P2</strong>：${escapeHtml(setup.p2a)} / ${escapeHtml(setup.p2b)}</div>
              <div class="construction-row" style="align-items:flex-start;">
                <div style="min-width:110px;">构筑起手牌堆</div>
                <div class="insert-area">
                  <div class="insert-outside" id="setup-pending-p2"></div>
                  <div class="insert-board" id="setup-board-p2"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="construction-row">
            <button type="button" id="setup-back">返回选人</button>
            <div class="spacer"></div>
            <button type="button" id="setup-start">开始对局</button>
          </div>
        </div>
      `;

      const p1All = [setup.p1a, setup.p1b];
      const p2All = [setup.p2a, setup.p2b];
      const p1Pending = p1All.filter((n) => !setup.p1Built.includes(n));
      const p2Pending = p2All.filter((n) => !setup.p2Built.includes(n));

      const pendingP1 = document.getElementById("setup-pending-p1");
      const boardP1 = document.getElementById("setup-board-p1");
      const pendingP2 = document.getElementById("setup-pending-p2");
      const boardP2 = document.getElementById("setup-board-p2");

      pendingP1.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">本轮待插入（可拖动）</div>` + p1Pending.map((n) => setupCardHtml("p1", n, "outside setup")).join("");
      pendingP2.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">本轮待插入（可拖动）</div>` + p2Pending.map((n) => setupCardHtml("p2", n, "outside setup")).join("");
      boardP1.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">战斗牌堆（从上到下）</div>` + setupBoardHtml("p1", setup.p1Built);
      boardP2.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">战斗牌堆（从上到下）</div>` + setupBoardHtml("p2", setup.p2Built);

      const setupDragCardSelector = `.insert-card[data-setup="true"], .deck-card[data-setup="true"]`;
      const mkTag = (el) => {
        if (!el) return "null";
        const tn = String(el.tagName || "").toLowerCase();
        const cls = (el.className || "").toString().split(/\s+/).filter(Boolean).join(".");
        const id = el.id ? `#${el.id}` : "";
        return `${tn}${id}${cls ? "." + cls : ""}`;
      };
      const logDbg = (s) => {
        if ((window.__setupDragDbgCount ?? 0) >= 80) return;
        window.__setupDragDbgCount = (window.__setupDragDbgCount ?? 0) + 1;
        pushLog(`[DBG-SETUP-DRAG] ${s}`);
      };

      const cleanupDrag = () => {
        const ghost = document.getElementById("setup-drag-ghost");
        if (ghost) ghost.remove();
        document.body.classList.remove("setup-dragging");
        boardP1.classList.remove("setup-drop-active");
        boardP2.classList.remove("setup-drop-active");
        pendingP1.classList.remove("setup-drop-active");
        pendingP2.classList.remove("setup-drop-active");
      };

      const applyDrop = (pid, name, over) => {
        if (!pid || !name || !over) return false;
        const key = pid === "p1" ? "p1Built" : "p2Built";
        const arr = [...setup[key]];
        const fromIdx = arr.indexOf(name);
        if (over.kind === "pending") {
          if (fromIdx < 0) return false;
          arr.splice(fromIdx, 1);
          setup[key] = arr;
          return true;
        }
        if (over.kind === "board") {
          const insertPos = Number(over.insertPos);
          if (!Number.isFinite(insertPos)) return false;
          if (fromIdx >= 0) arr.splice(fromIdx, 1);
          if (!arr.includes(name)) {
            const pos = Math.max(0, Math.min(insertPos, arr.length));
            arr.splice(pos, 0, name);
          }
          setup[key] = arr.slice(0, 2);
          return true;
        }
        return false;
      };

      const computeOver = (pid, x, y) => {
        const pt = document.elementFromPoint(x, y);
        if (!pt) return null;
        const slotEl = pt.closest(`.setup-board-slot[data-player="${pid}"]`);
        if (slotEl) {
          const where = slotEl.getAttribute("data-setup-slot");
          const key = pid === "p1" ? "p1Built" : "p2Built";
          const count = Array.isArray(setup[key]) ? setup[key].length : 0;
          return { kind: "board", insertPos: where === "top" ? 0 : count };
        }
        const pendingEl = pt.closest(`#setup-pending-${pid}`);
        if (pendingEl) return { kind: "pending" };
        const boardEl = pt.closest(`#setup-board-${pid}`);
        if (boardEl) {
          const cards = [...boardEl.querySelectorAll(`${setupDragCardSelector}[data-player="${pid}"]`)];
          if (!cards.length) return { kind: "board", insertPos: 0 };
          for (let i = 0; i < cards.length; i++) {
            const r = cards[i].getBoundingClientRect();
            const mid = r.top + r.height / 2;
            if (y < mid) return { kind: "board", insertPos: i };
          }
          return { kind: "board", insertPos: cards.length };
        }
        return null;
      };

      const attachPointerDrag = (el) => {
        el.addEventListener("pointerdown", (ev) => {
          if (ev.button != null && ev.button !== 0) return;
          const cardEl = ev.target?.closest?.(setupDragCardSelector);
          if (!cardEl) return;
          const pid = cardEl.getAttribute("data-player");
          const name = cardEl.getAttribute("data-name");
          if (!pid || !name) return;
          ev.preventDefault();
          try {
            cardEl.setPointerCapture(ev.pointerId);
          } catch {}

          cleanupDrag();
          document.body.classList.add("setup-dragging");

          const rect = cardEl.getBoundingClientRect();
          const ghost = cardEl.cloneNode(true);
          ghost.id = "setup-drag-ghost";
          ghost.style.width = `${Math.max(160, rect.width)}px`;
          ghost.style.left = `${rect.left}px`;
          ghost.style.top = `${rect.top}px`;
          ghost.style.position = "fixed";
          ghost.style.zIndex = "9999";
          ghost.style.pointerEvents = "none";
          ghost.style.opacity = "0.92";
          ghost.style.transform = "scale(1.02)";
          document.body.appendChild(ghost);

          const drag = {
            pid,
            name,
            pointerId: ev.pointerId,
            offX: ev.clientX - rect.left,
            offY: ev.clientY - rect.top,
            over: null,
            moved: false,
          };
          window.__setupPointerDrag = drag;
          logDbg(`PTR start pid=${pid} name=${name} target=${mkTag(ev.target)} card=${mkTag(cardEl)}`);

          const move = (e) => {
            if (!window.__setupPointerDrag || window.__setupPointerDrag.pointerId !== e.pointerId) return;
            const d = window.__setupPointerDrag;
            d.moved = true;
            const nx = e.clientX - d.offX;
            const ny = e.clientY - d.offY;
            ghost.style.left = `${nx}px`;
            ghost.style.top = `${ny}px`;
            const over = computeOver(d.pid, e.clientX, e.clientY);
            d.over = over;
            boardP1.classList.toggle("setup-drop-active", d.pid === "p1" && over?.kind === "board");
            boardP2.classList.toggle("setup-drop-active", d.pid === "p2" && over?.kind === "board");
            pendingP1.classList.toggle("setup-drop-active", d.pid === "p1" && over?.kind === "pending");
            pendingP2.classList.toggle("setup-drop-active", d.pid === "p2" && over?.kind === "pending");
            document.querySelectorAll(`.setup-board-slot[data-player="${d.pid}"]`).forEach((x) => x.classList.remove("active"));
            if (over?.kind === "board") {
              const key = d.pid === "p1" ? "p1Built" : "p2Built";
              const count = Array.isArray(setup[key]) ? setup[key].length : 0;
              const which = Number(over.insertPos) === 0 ? "top" : Number(over.insertPos) >= count ? "bottom" : null;
              if (which) {
                const slot = document.querySelector(`.setup-board-slot[data-player="${d.pid}"][data-setup-slot="${which}"]`);
                if (slot) slot.classList.add("active");
              }
            }
          };
          const up = (e) => {
            if (!window.__setupPointerDrag || window.__setupPointerDrag.pointerId !== e.pointerId) return;
            const d = window.__setupPointerDrag;
            window.__setupPointerDrag = null;
            const ok = applyDrop(d.pid, d.name, d.over);
            logDbg(`PTR end pid=${d.pid} name=${d.name} over=${d.over?.kind ?? "null"} ok=${ok ? "1" : "0"}`);
            cleanupDrag();
            if (ok) render();
          };
          const cancel = (e) => {
            if (!window.__setupPointerDrag || window.__setupPointerDrag.pointerId !== e.pointerId) return;
            window.__setupPointerDrag = null;
            cleanupDrag();
            logDbg(`PTR cancel pid=${pid} name=${name}`);
          };

          cardEl.addEventListener("pointermove", move);
          cardEl.addEventListener(
            "pointerup",
            (e) => {
              cardEl.removeEventListener("pointermove", move);
              up(e);
            },
            { once: true }
          );
          cardEl.addEventListener(
            "pointercancel",
            (e) => {
              cardEl.removeEventListener("pointermove", move);
              cancel(e);
            },
            { once: true }
          );
        });
      };

      els.constructionPanel.querySelectorAll(setupDragCardSelector).forEach((el) => attachPointerDrag(el));

      const startBtn = document.getElementById("setup-start");
      startBtn.disabled = setup.p1Built.length !== 2 || setup.p2Built.length !== 2;

      document.getElementById("setup-back").addEventListener("click", () => {
        setup.step = "pick";
        setup.p1Built = [];
        setup.p2Built = [];
        render();
      });

      document.getElementById("setup-start").addEventListener("click", () => {
        const picksByPlayer = { p1: [setup.p1a, setup.p1b], p2: [setup.p2a, setup.p2b] };
        const startTopByPlayer = { p1: setup.p1Built[0], p2: setup.p2Built[0] };
        state = createInitialState(pool, picksByPlayer, startTopByPlayer);
        clearLog();
        pushLog(`新开一局：P1 ${picksByPlayer.p1.join(" / ")}；P2 ${picksByPlayer.p2.join(" / ")}`);
        pushLog(`起手顺序：P1 顶为 ${formatCardLabel(state.players.p1.battleDeck[0])}；P2 顶为 ${formatCardLabel(state.players.p2.battleDeck[0])}`);
        render();
      });
      return;
    }

    if (state.phase !== PHASE.CONSTRUCTION) return;
    const p1Choice = state.construction.p1;
    const p2Choice = state.construction.p2;

    function renderChoice(playerId, choice) {
      const player = state.players[playerId];
      const drawnBoxes = choice.drawn
        .map((c, idx) => {
          const selected = idx === choice.insertIndex ? " selected" : "";
          return `
            <div class="construction-choice selectable${selected}" data-drawn-idx="${idx}" data-player="${playerId}">
              <div class="choice-title">${cardTitleHtml(c)}</div>
              <pre>${displayCardText(c)}</pre>
            </div>
          `;
        })
        .join("");

      const insertCard = choice.drawn[choice.insertIndex];
      const placed = Number.isFinite(choice.insertPos);
      const dragging = choice.dragging === true;
      const previewPos = Number.isFinite(choice.previewPos) ? choice.previewPos : null;
      const deck = player.battleDeck;

      let board = "";
      for (let i = 0; i <= deck.length; i++) {
        const active = dragging && previewPos === i;
        board += `<div class="dropzone${active ? " active" : ""}" data-player="${playerId}" data-pos="${i}"></div>`;
        if (!dragging && placed && i === choice.insertPos) {
          board += `
            <div class="insert-card in-board placed" draggable="true" data-player="${playerId}">
              <div class="insert-title">已放置：${cardTitleHtml(insertCard)}</div>
              <div class="insert-text">${displayCardText(insertCard)}</div>
            </div>
          `;
        }
        if (i < deck.length) {
          const c = deck[i];
          board += `
            <div class="deck-card" data-index="${i}">
              <div class="deck-title">${cardTitleHtml(c)}</div>
              <div class="deck-text">${displayCardText(c)}</div>
            </div>
          `;
        }
      }

      const order01 = choice.bottomOrder === "01" ? "selected" : "";
      const order10 = choice.bottomOrder === "10" ? "selected" : "";

      const rest = choice.drawn.filter((_, idx) => idx !== choice.insertIndex);
      const restLabel =
        rest.length === 2 ? `${rest[0].fighterName}#${rest[0].cardNo} / ${rest[1].fighterName}#${rest[1].cardNo}` : "-";

      const canApply = placed ? "" : "disabled";

      return `
        <div class="construction-card" data-player="${playerId}">
          <div><strong>${playerId.toUpperCase()}</strong> 构筑：从构筑牌库顶抽 3 张，选 1 张入战斗牌库</div>
          <div class="construction-row">${drawnBoxes}</div>
          <div class="construction-row" style="align-items:flex-start;">
            <div style="min-width:110px;">插入位置</div>
            <div class="insert-area">
              <div class="insert-outside" data-player="${playerId}">
                <div class="insert-card outside" draggable="true" data-player="${playerId}">
                  <div class="insert-title">待插入：${cardTitleHtml(insertCard)}</div>
                  <div class="insert-text">${displayCardText(insertCard)}</div>
                </div>
                <div class="insert-outside-hint">${placed ? "已放置，可拖回撤销/改位置" : "拖动到右侧牌堆插入位置"}</div>
              </div>
              <div class="insert-board${dragging ? " dragging" : ""}" data-player="${playerId}">
                ${board}
              </div>
            </div>
          </div>
          <div class="construction-row">
            <div>剩余 2 张入底顺序</div>
            <select data-field="bottomOrder">
              <option value="01" ${order01}>按剩余显示顺序</option>
              <option value="10" ${order10}>交换顺序</option>
            </select>
            <div style="opacity:0.8;">剩余：${restLabel}</div>
            <div class="spacer"></div>
            <button type="button" data-action="apply" ${canApply}>确认该方构筑</button>
          </div>
        </div>
      `;
    }

    function renderDone(playerId) {
      return `
        <div class="construction-card" data-player="${playerId}">
          <div><strong>${playerId.toUpperCase()}</strong> 构筑：已确认，等待另一方</div>
        </div>
      `;
    }

    const panels = [];
    const p1Active = p1Choice && typeof p1Choice === "object";
    const p2Active = p2Choice && typeof p2Choice === "object";

    if (myPlayerId) {
      // Online mode: only show own construction panel
      const myId = myPlayerId;
      const oppId = myId === "p1" ? "p2" : "p1";
      const myChoice = state.construction[myId];
      const oppChoice = state.construction[oppId];
      const myActive = myChoice && typeof myChoice === "object";
      const oppActive = oppChoice && typeof oppChoice === "object";
      panels.push(myActive ? renderChoice(myId, myChoice) : renderDone(myId));
      panels.push(oppActive
        ? `<div class="construction-card" data-player="${oppId}"><div><strong>${oppId.toUpperCase()}</strong> 构筑：等待对方完成构筑...</div></div>`
        : renderDone(oppId));
    } else {
      // Offline mode: show both panels
      panels.push(p1Active ? renderChoice("p1", p1Choice) : renderDone("p1"));
      panels.push(p2Active ? renderChoice("p2", p2Choice) : renderDone("p2"));
    }
    els.constructionPanel.innerHTML = panels.join("");

    els.constructionPanel.querySelectorAll(".construction-card").forEach((card) => {
      const playerId = card.getAttribute("data-player");
      const choice = state.construction[playerId];
      if (!choice) return;

      const boardEl = card.querySelector(`.insert-board[data-player="${playerId}"]`);
      const computePos = (ev) => {
        const targetCard = ev.target?.closest?.(`.deck-card[data-index]`);
        if (targetCard) {
          const idx = Number(targetCard.getAttribute("data-index"));
          if (Number.isFinite(idx)) {
            const rect = targetCard.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            return ev.clientY < mid ? idx : idx + 1;
          }
        }
        const cards = Array.from(boardEl.querySelectorAll(`.deck-card[data-index]`));
        if (cards.length === 0) return 0;
        for (const el of cards) {
          const idx = Number(el.getAttribute("data-index"));
          if (!Number.isFinite(idx)) continue;
          const rect = el.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          if (ev.clientY < mid) return idx;
        }
        const lastIdx = Number(cards[cards.length - 1].getAttribute("data-index"));
        return Number.isFinite(lastIdx) ? lastIdx + 1 : cards.length;
      };
      const computePosByX = (ev) => {
        const rect = boardEl.getBoundingClientRect();
        const x = ev.clientX;
        const y = ev.clientY;
        if (!(x >= rect.left && x <= rect.right)) return null;
        const cards = Array.from(boardEl.querySelectorAll(`.deck-card[data-index]`));
        const endPos = cards.length;
        if (y < rect.top) return 0;
        if (y > rect.bottom) return endPos;
        return computePos(ev);
      };
      card.querySelectorAll(`.construction-choice.selectable[data-player="${playerId}"]`).forEach((el) => {
        el.addEventListener("click", () => {
          const nextIdx = Number(el.getAttribute("data-drawn-idx"));
          if (!Number.isFinite(nextIdx)) return;
          if (choice.insertIndex !== nextIdx) {
            choice.insertIndex = nextIdx;
            choice.insertPos = null;
            choice.previewPos = null;
            choice.dragging = false;
          }
          render();
        });
      });

      const dragSelector = `.insert-card[data-player="${playerId}"]`;
      card.querySelectorAll(dragSelector).forEach((el) => {
        el.addEventListener("dragstart", (ev) => {
          ev.dataTransfer.setData("text/plain", `insert:${playerId}`);
          ev.dataTransfer.effectAllowed = "move";
          el.classList.add("dragging");
          choice.dragging = true;
          activeInsertDrag = playerId;
          if (!choice._globalInsertDragHandlers) {
            const computePosByXNow = (ev) => {
              const boardNow = els.constructionPanel.querySelector(
                `.construction-card[data-player="${playerId}"] .insert-board[data-player="${playerId}"]`
              );
              if (!boardNow) return { pos: null, reason: "no-board", rect: null };
              const rect = boardNow.getBoundingClientRect();
              const x = ev.clientX;
              const y = ev.clientY;
              const inX = x >= rect.left && x <= rect.right;
              if (!inX) return { pos: null, reason: "x-out", rect, x, y };
              const cards = Array.from(boardNow.querySelectorAll(`.deck-card[data-index]`));
              const endPos = cards.length;
              if (y < rect.top) return { pos: 0, reason: "above", rect, x, y, endPos };
              if (y > rect.bottom) return { pos: endPos, reason: "below", rect, x, y, endPos };
              if (cards.length === 0) return { pos: 0, reason: "empty", rect, x, y, endPos };
              for (const el of cards) {
                const idx = Number(el.getAttribute("data-index"));
                if (!Number.isFinite(idx)) continue;
                const r = el.getBoundingClientRect();
                const mid = r.top + r.height / 2;
                if (y < mid) return { pos: idx, reason: "mid", rect, x, y, endPos };
              }
              const lastIdx = Number(cards[cards.length - 1].getAttribute("data-index"));
              const pos = Number.isFinite(lastIdx) ? lastIdx + 1 : endPos;
              return { pos, reason: "after-last", rect, x, y, endPos };
            };
            const onOver = (e) => {
              if (activeInsertDrag !== playerId) return;
              const r = computePosByXNow(e);
              if (r.pos == null) {
                return;
              }
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (choice.previewPos !== r.pos) {
                choice.previewPos = r.pos;
                choice.dragging = true;
                scheduleRender();
              }
            };
            const onDrop = (e) => {
              if (activeInsertDrag !== playerId) return;
              const r = computePosByXNow(e);
              if (r.pos == null) {
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              const oldEl = card.querySelector(dragSelector);
              const oldRect = oldEl ? oldEl.getBoundingClientRect() : null;
              choice.insertPos = r.pos;
              choice.previewPos = null;
              choice.dragging = false;
              activeInsertDrag = null;
              render();
              if (oldRect) {
                const newEl = els.constructionPanel.querySelector(`.construction-card[data-player="${playerId}"] ${dragSelector}`);
                if (newEl) {
                  const newRect = newEl.getBoundingClientRect();
                  const dx = oldRect.left - newRect.left;
                  const dy = oldRect.top - newRect.top;
                  newEl.style.transition = "transform 0s";
                  newEl.style.transform = `translate(${dx}px, ${dy}px)`;
                  requestAnimationFrame(() => {
                    newEl.style.transition = "transform 160ms ease";
                    newEl.style.transform = "translate(0px, 0px)";
                  });
                  const onEnd = () => {
                    newEl.style.transition = "";
                    newEl.style.transform = "";
                    newEl.removeEventListener("transitionend", onEnd);
                  };
                  newEl.addEventListener("transitionend", onEnd);
                }
              }
            };
            choice._globalInsertDragHandlers = { onOver, onDrop };
            document.addEventListener("dragover", onOver, true);
            document.addEventListener("drop", onDrop, true);
          }
          choice.previewPos = Number.isFinite(choice.insertPos) ? choice.insertPos : 0;
          scheduleRender();
        });
        el.addEventListener("dragend", () => {
          el.classList.remove("dragging");
          choice.dragging = false;
          choice.previewPos = null;
          activeInsertDrag = null;
          if (choice._globalInsertDragHandlers) {
            document.removeEventListener("dragover", choice._globalInsertDragHandlers.onOver, true);
            document.removeEventListener("drop", choice._globalInsertDragHandlers.onDrop, true);
            choice._globalInsertDragHandlers = null;
          }
          scheduleRender();
        });
      });

      const zoneSelector = `.dropzone[data-player="${playerId}"]`;
      card.querySelectorAll(zoneSelector).forEach((zone) => {
        zone.addEventListener("dragover", (ev) => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
          const pos = Number(zone.getAttribute("data-pos"));
          if (!Number.isFinite(pos)) return;
          if (choice.previewPos !== pos) {
            choice.previewPos = pos;
            choice.dragging = true;
            scheduleRender();
          }
        });
        zone.addEventListener("drop", (ev) => {
          ev.preventDefault();
          const raw = ev.dataTransfer.getData("text/plain");
          if (raw !== `insert:${playerId}`) return;
          const oldEl = card.querySelector(dragSelector);
          const oldRect = oldEl ? oldEl.getBoundingClientRect() : null;
          const pos = Number(zone.getAttribute("data-pos"));
          if (!Number.isFinite(pos)) return;
          choice.insertPos = pos;
          choice.previewPos = null;
          choice.dragging = false;
          render();
          if (oldRect) {
            const newEl = els.constructionPanel.querySelector(`.construction-card[data-player="${playerId}"] ${dragSelector}`);
            if (newEl) {
              const newRect = newEl.getBoundingClientRect();
              const dx = oldRect.left - newRect.left;
              const dy = oldRect.top - newRect.top;
              newEl.style.transition = "transform 0s";
              newEl.style.transform = `translate(${dx}px, ${dy}px)`;
              requestAnimationFrame(() => {
                newEl.style.transition = "transform 160ms ease";
                newEl.style.transform = "translate(0px, 0px)";
              });
              const onEnd = () => {
                newEl.style.transition = "";
                newEl.style.transform = "";
                newEl.removeEventListener("transitionend", onEnd);
              };
              newEl.addEventListener("transitionend", onEnd);
            }
          }
        });
      });

      boardEl.addEventListener(
        "dragover",
        (ev) => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
          const raw = ev.dataTransfer.getData("text/plain");
          if (raw !== `insert:${playerId}`) return;
          const pos = computePos(ev);
          if (choice.previewPos !== pos) {
            choice.previewPos = pos;
            choice.dragging = true;
            scheduleRender();
          }
        },
        true
      );

      const insertAreaEl = card.querySelector(`.insert-area`);
      if (insertAreaEl) {
        insertAreaEl.addEventListener(
          "dragover",
          (ev) => {
            const raw = ev.dataTransfer.getData("text/plain");
            if (raw !== `insert:${playerId}`) return;
            const pos = computePosByX(ev);
            if (pos == null) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "move";
            if (choice.previewPos !== pos) {
              choice.previewPos = pos;
              choice.dragging = true;
              scheduleRender();
            }
          },
          true
        );

        insertAreaEl.addEventListener(
          "drop",
          (ev) => {
            const raw = ev.dataTransfer.getData("text/plain");
            if (raw !== `insert:${playerId}`) return;
            const pos = computePosByX(ev);
            if (pos == null) return;
            ev.preventDefault();
            ev.stopPropagation();
            const oldEl = card.querySelector(dragSelector);
            const oldRect = oldEl ? oldEl.getBoundingClientRect() : null;
            choice.insertPos = pos;
            choice.previewPos = null;
            choice.dragging = false;
            render();
            if (oldRect) {
              const newEl = els.constructionPanel.querySelector(`.construction-card[data-player="${playerId}"] ${dragSelector}`);
              if (newEl) {
                const newRect = newEl.getBoundingClientRect();
                const dx = oldRect.left - newRect.left;
                const dy = oldRect.top - newRect.top;
                newEl.style.transition = "transform 0s";
                newEl.style.transform = `translate(${dx}px, ${dy}px)`;
                requestAnimationFrame(() => {
                  newEl.style.transition = "transform 160ms ease";
                  newEl.style.transform = "translate(0px, 0px)";
                });
                const onEnd = () => {
                  newEl.style.transition = "";
                  newEl.style.transform = "";
                  newEl.removeEventListener("transitionend", onEnd);
                };
                newEl.addEventListener("transitionend", onEnd);
              }
            }
          },
          true
        );
      }

      boardEl.addEventListener(
        "drop",
        (ev) => {
          ev.preventDefault();
          const raw = ev.dataTransfer.getData("text/plain");
          if (raw !== `insert:${playerId}`) return;
          const oldEl = card.querySelector(dragSelector);
          const oldRect = oldEl ? oldEl.getBoundingClientRect() : null;
          const pos = Number.isFinite(choice.previewPos) ? choice.previewPos : computePos(ev);
          choice.insertPos = pos;
          choice.previewPos = null;
          choice.dragging = false;
          render();
          if (oldRect) {
            const newEl = els.constructionPanel.querySelector(`.construction-card[data-player="${playerId}"] ${dragSelector}`);
            if (newEl) {
              const newRect = newEl.getBoundingClientRect();
              const dx = oldRect.left - newRect.left;
              const dy = oldRect.top - newRect.top;
              newEl.style.transition = "transform 0s";
              newEl.style.transform = `translate(${dx}px, ${dy}px)`;
              requestAnimationFrame(() => {
                newEl.style.transition = "transform 160ms ease";
                newEl.style.transform = "translate(0px, 0px)";
              });
              const onEnd = () => {
                newEl.style.transition = "";
                newEl.style.transform = "";
                newEl.removeEventListener("transitionend", onEnd);
              };
              newEl.addEventListener("transitionend", onEnd);
            }
          }
        },
        true
      );

      const outside = card.querySelector(`.insert-outside[data-player="${playerId}"]`);
      outside.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        outside.classList.add("active");
        ev.dataTransfer.dropEffect = "move";
        if (choice.previewPos !== null) {
          choice.previewPos = null;
          scheduleRender();
        }
      });
      outside.addEventListener("dragleave", () => {
        outside.classList.remove("active");
      });
      outside.addEventListener("drop", (ev) => {
        ev.preventDefault();
        outside.classList.remove("active");
        const raw = ev.dataTransfer.getData("text/plain");
        if (raw !== `insert:${playerId}`) return;
        choice.insertPos = null;
        choice.previewPos = null;
        choice.dragging = false;
        render();
      });

      const orderEl = card.querySelector(`select[data-field="bottomOrder"]`);
      orderEl.addEventListener("change", () => {
        choice.bottomOrder = orderEl.value;
        render();
      });
      card.querySelector(`button[data-action="apply"]`).addEventListener("click", () => {
        if (!Number.isFinite(choice.insertPos)) return;
        sendMsg(C_CONSTRUCTION_CHOICE, {
          insertIndex: choice.insertIndex,
          insertPos: choice.insertPos,
          bottomOrder: choice.bottomOrder,
        });
      });
    });
  }

  function renderControls() {
    els.phase.textContent = phaseLabel();
    const awaiting = state.phase === PHASE.BATTLE && state.awaitingConstruction === true;
    const pendingEnd = state.phase === PHASE.BATTLE && state.pendingGameOver;
    const pendingElfPick = state.phase === PHASE.BATTLE && (state.pendingElfPickByPlayer?.p1 || state.pendingElfPickByPlayer?.p2);
    if (state.phase === PHASE.BATTLE && Array.isArray(state.pendingDoubleQueue) && state.pendingDoubleQueue.length > 0) {
      els.btnNextBattle.textContent = "结算第二次";
    } else {
      els.btnNextBattle.textContent = "翻牌并结算";
    }
    els.btnNextBattle.disabled = state.phase !== PHASE.BATTLE || awaiting || pendingEnd || pendingElfPick;
    els.btnEnterConstruction.disabled = !awaiting || pendingEnd || pendingElfPick;
    els.btnCompare.disabled = !(state.phase === PHASE.BATTLE && state.lastRound);
    els.btnConfirmEnd.disabled = !pendingEnd;
  }

  function render() {
    renderControls();
    renderBattleReveal();
    renderPlayers();
    renderConstruction();
  }

  // All game logic (battleTurn, construction, confirmEnd) now runs on the server.
  // Client sends messages via sendMsg() and receives state updates via handleServerMessage().

  async function loadText(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch failed: ${url}`);
    return await res.text();
  }

  function wireRulesDialog() {
    const tabs = els.rulesDialog.querySelectorAll("button[data-tab]");
    function setTab(tab) {
      if (tab === "rules") els.rulesText.textContent = data.rulesTxt;
      if (tab === "fighters") els.rulesText.textContent = data.fightersTxt;
      if (tab === "cards") els.rulesText.textContent = data.cardsTxt;
      if (tab === "settlement") els.rulesText.textContent = data.settlementTxt;
    }
    tabs.forEach((btn) => {
      btn.addEventListener("click", () => {
        setTab(btn.getAttribute("data-tab"));
      });
    });
    setTab("rules");
  }

  async function init() {
    state = { phase: PHASE.LOADING };
    render();
    data.rulesTxt = await loadText("/规则.txt");
    data.fightersTxt = await loadText("/战士库.txt");
    data.cardsTxt = await loadText("/卡牌词条.txt");
    data.settlementTxt = await loadText("/结算过程与示例.txt");
    data.fighterDefs = parseFighters(data.fightersTxt);
    for (const w of selfTestFighters(data.fighterDefs)) pushLog(`[自检] ${w}`);
    wireRulesDialog();
    // Show lobby on startup (online mode)
    state.phase = PHASE.SETUP;
    showLobby();
    render();
  }

  // ─── Lobby buttons ────────────────────────────────────────────────────────
  if (els.btnCreateRoom) {
    els.btnCreateRoom.addEventListener("click", () => {
      connectWs(() => sendMsg(C_CREATE_ROOM));
    });
  }
  if (els.btnJoinRoom) {
    els.btnJoinRoom.addEventListener("click", () => {
      const code = els.inputRoomCode?.value?.trim();
      if (!code) { window.alert("请输入房间码"); return; }
      connectWs(() => sendMsg(C_JOIN_ROOM, { code }));
    });
  }

  els.btnNewGame.addEventListener("click", () => {
    const running =
      state?.phase &&
      state.phase !== PHASE.LOADING &&
      state.phase !== PHASE.SETUP &&
      state.phase !== PHASE.GAME_OVER;
    if (running) {
      const ok = window.confirm("游戏正在进行，是否中断并重开？");
      if (!ok) return;
    }
    // Return to lobby
    if (ws) { ws.close(); ws = null; }
    roomCode = null;
    myPlayerId = null;
    clientPhase = "lobby";
    state = { phase: PHASE.SETUP };
    setConnectionStatus("disconnected");
    applyViewSwap();
    showLobby();
    clearLog();
    render();
  });
  els.btnToggleDecks.addEventListener("click", () => {
    state.showDecks = !state.showDecks;
    render();
  });
  els.btnOpenRules.addEventListener("click", () => {
    els.rulesDialog.showModal();
  });
  els.btnOpenLog.addEventListener("click", () => {
    els.logDialog.showModal();
  });
  els.btnNextBattle.addEventListener("click", () => { sendMsg(C_ADVANCE_BATTLE); els.btnNextBattle.disabled = true; });
  els.btnEnterConstruction.addEventListener("click", () => { sendMsg(C_ADVANCE_BATTLE); els.btnEnterConstruction.disabled = true; });
  els.btnConfirmEnd.addEventListener("click", () => sendMsg(C_CONFIRM_END));
  els.btnCompare.addEventListener("pointerdown", (e) => {
    if (els.btnCompare.disabled) return;
    state.compareHold = true;
    try {
      els.btnCompare.setPointerCapture(e.pointerId);
    } catch {}
    renderPlayers();
  });
  els.btnCompare.addEventListener("pointerup", () => {
    if (!state.compareHold) return;
    state.compareHold = false;
    renderPlayers();
  });
  els.btnCompare.addEventListener("pointercancel", () => {
    if (!state.compareHold) return;
    state.compareHold = false;
    renderPlayers();
  });
  window.addEventListener("resize", () => requestAnimationFrame(() => requestAnimationFrame(positionHpArrows)));
  els.btnClearLog.addEventListener("click", (e) => {
    e.preventDefault();
    clearLog();
  });

  init().catch((e) => {
    state.phase = PHASE.SETUP;
    render();
    pushLog(`初始化失败：${e?.message ?? String(e)}`);
  });
}

createApp();
