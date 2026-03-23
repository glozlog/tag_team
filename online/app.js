import {
  PHASE,
  nowTime,
  parseFighters,
  selfTestFighters,
  createInitialState,
  formatCardLabel,
  buildContextForBattle,
  ensureCardCompiled,
  settleEffects,
  applyDeltas,
  checkWinner,
  enterConstructionIfNeeded,
  beginNextConstructionStep,
  applyConstructionChoice,
} from '../game-engine.mjs';

import {
  escapeHtml,
  headshotUrl,
  headshotImgHtml,
  phaseLabel as phaseLabelBase,
  cardLabel,
  displayCardText as displayCardTextBase,
  cardTitleHtml,
  renderHpGrid,
  renderElfHpGrid,
  renderPowerGrid,
  renderFighter as renderFighterBase,
  positionHpArrows,
  updateFighterDOM,
  renderDeckList as renderDeckListBase,
} from '../shared-ui.mjs';

function createApp() {
  // === WebSocket 客户端 ===
  let ws = null;
  let myPlayerId = null;  // "p1" 或 "p2"
  let roomCode = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 10;

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/`);
    
    ws.onopen = () => {
      console.log('WebSocket 已连接');
      reconnectAttempts = 0;
      updateConnectionStatus("connected");
      // 如果是重连，发送 RECONNECT
      if (roomCode && myPlayerId) {
        wsSend({ type: "RECONNECT", roomId: roomCode, playerId: myPlayerId });
      }
    };
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        console.error("消息解析失败", e);
      }
    };
    
    ws.onclose = () => {
      console.log('WebSocket 断开');
      updateConnectionStatus("reconnecting");
      attemptReconnect();
    };
    
    ws.onerror = (e) => {
      console.error("WebSocket 错误", e);
    };
  }

  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    } else {
      console.warn("WebSocket 未连接，无法发送", data);
    }
  }

  function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log("重连失败，已达最大尝试次数");
      return;
    }
    reconnectAttempts++;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      console.log(`尝试重连 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      connectWebSocket();
    }, 2000);
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "ROOM_CREATED":
        roomCode = msg.code;
        myPlayerId = "p1";
        bothPlayersReady = false;
        console.log(`房间已创建: ${roomCode}`);
        // 更新大厅显示：隐藏操作按钮，显示等待区域和房间码
        if (els.lobbyActions) {
          els.lobbyActions.classList.add("hidden");
        }
        if (els.lobbyWaiting) {
          els.lobbyWaiting.classList.remove("hidden");
          els.roomCodeShow.textContent = roomCode;
        }
        if (els.lobbyStatus) {
          els.lobbyStatus.textContent = "等待对手加入...";
        }
        scheduleRender();
        break;
        
      case "ROOM_JOINED":
        roomCode = msg.code;
        myPlayerId = msg.playerId;
        bothPlayersReady = true;
        console.log(`已加入房间: ${roomCode}, 我是 ${myPlayerId}`);
        // 隐藏操作按钮和等待区域，显示就绪状态
        if (els.lobbyActions) {
          els.lobbyActions.classList.add("hidden");
        }
        if (els.lobbyWaiting) {
          els.lobbyWaiting.classList.add("hidden");
        }
        if (els.lobbyReady) {
          els.lobbyReady.classList.remove("hidden");
        }
        if (els.lobbyStatus) {
          els.lobbyStatus.textContent = "双方已就绪，正在进入游戏...";
        }
        // 请求战士列表并进入英雄选择
        wsSend({ type: "GET_FIGHTER_LIST" });
        scheduleRender();
        break;
        
      case "OPPONENT_JOINED":
        pushLog("对手已加入房间");
        bothPlayersReady = true;
        // 隐藏等待区域，显示就绪状态
        if (els.lobbyWaiting) {
          els.lobbyWaiting.classList.add("hidden");
        }
        if (els.lobbyReady) {
          els.lobbyReady.classList.remove("hidden");
        }
        if (els.lobbyStatus) {
          els.lobbyStatus.textContent = "双方已就绪，正在进入游戏...";
        }
        // 请求战士列表并进入英雄选择
        wsSend({ type: "GET_FIGHTER_LIST" });
        scheduleRender();
        break;
        
      case "FIGHTER_LIST":
        // 保存可用战士列表，供选人界面使用
        if (msg.fighters) {
          data.fighterList = msg.fighters;
        }
        // 收到战士列表后，隐藏大厅面板，进入英雄选择界面
        if (els.lobbyPanel) {
          els.lobbyPanel.classList.add("hidden");
        }
        // 初始化英雄选择状态
        if (!state.setup) {
          state.setup = { step: "pick", p1a: null, p1b: null, p2a: null, p2b: null, p1Built: [], p2Built: [] };
        }
        state.phase = PHASE.SETUP;
        scheduleRender();
        break;
        
      case "FIGHTERS_SELECTED":
        pushLog(`已选择战士: ${msg.fighters.join(', ')}${msg.confirmed ? ' (已确认)' : ''}`);
        break;
        
      case "OPPONENT_CONFIRMED":
        pushLog("对手已确认选择");
        // 更新对手的确认状态
        if (msg.playerId === "p1") {
          if (state.setup) state.setup.p1Confirmed = true;
        } else if (msg.playerId === "p2") {
          if (state.setup) state.setup.p2Confirmed = true;
        }
        scheduleRender();
        break;
        
      case "FIGHTERS_REVEALED":
        pushLog(`双方阵容已揭示，请设置起始顶牌战士`);
        // 保存双方选择，用于排序阶段
        data.revealedFighters = {
          p1: msg.p1Fighters,
          p2: msg.p2Fighters
        };
        // 更新 setup 状态，进入 ordering 阶段（设置起始顺序）
        if (state.setup) {
          state.setup.step = "ordering";
          state.setup.p1a = msg.p1Fighters[0];
          state.setup.p1b = msg.p1Fighters[1];
          state.setup.p2a = msg.p2Fighters[0];
          state.setup.p2b = msg.p2Fighters[1];
        }
        scheduleRender();
        break;
        
      case "ORDER_SET":
        pushLog(`起始顺序已设置: ${msg.topFighter}`);
        // 更新本地状态
        if (state.setup) {
          if (myPlayerId === "p1") {
            state.setup.p1Order = msg.topFighter;
          } else if (myPlayerId === "p2") {
            state.setup.p2Order = msg.topFighter;
          }
        }
        scheduleRender();
        break;
        
      case "OPPONENT_ORDER_SET":
        pushLog(`对手已设置起始顶牌`);
        // 更新对手的顺序状态
        if (state.setup) {
          if (msg.playerId === "p1") {
            state.setup.p1Order = msg.topFighter;
          } else if (msg.playerId === "p2") {
            state.setup.p2Order = msg.topFighter;
          }
        }
        scheduleRender();
        break;
        
      case "GAME_STARTED": {
        const prevShowDecks = state?.showDecks ?? false;
        
        myPlayerId = msg.playerId;
        state = msg.state;
        state.myPlayerId = myPlayerId;
        state.showDecks = prevShowDecks;
        state.compareHold = false;
        bothPlayersReady = true;  // 游戏已开始，双方肯定都准备好了
        
        // 确保大厅面板被隐藏
        if (els.lobbyPanel) {
          els.lobbyPanel.classList.add("hidden");
        }
        
        clearLog();
        pushLog("游戏开始！");
        if (msg.logs) msg.logs.forEach(l => pushLog(l));
        scheduleRender();
        break;
      }
        
      case "STATE_UPDATE": {
        const prevShowDecks = state?.showDecks ?? false;
        const prevCompareHold = state?.compareHold ?? false;
        
        state = msg.state;
        state.myPlayerId = myPlayerId;
        state.showDecks = prevShowDecks;
        state.compareHold = prevCompareHold;
        
        if (msg.logs && msg.logs.length > 0) {
          msg.logs.forEach(l => pushLog(l));
        }
        // 状态更新时重置等待标志
        waitingForOpponent = null;
        // 挂机检测：更新对手活动时间
        lastOpponentActivity = Date.now();
        afkWarningShown = false;
        scheduleRender();
        break;
      }
        
      case "ELF_PICK_NEEDED":
        pushLog("需要选择精灵族的灵");
        scheduleRender();
        break;
        
      case "OPPONENT_READY":
        pushLog("对手已准备，等待你确认...");
        // 挂机检测：更新对手活动时间
        lastOpponentActivity = Date.now();
        afkWarningShown = false;
        break;
        
      case "OPPONENT_ENTER_CONSTRUCTION":
        pushLog("对手已请求进入构筑阶段");
        // 挂机检测：更新对手活动时间
        lastOpponentActivity = Date.now();
        afkWarningShown = false;
        break;
        
      case "OPPONENT_DISCONNECTED":
        pushLog("对手已断线，等待重连...");
        scheduleRender();
        break;
        
      case "OPPONENT_RECONNECTED":
        pushLog("对手已重新连接");
        // 挂机检测：更新对手活动时间
        lastOpponentActivity = Date.now();
        afkWarningShown = false;
        scheduleRender();
        break;
        
      case "RECONNECTED": {
        const prevShowDecks = state?.showDecks ?? false;
        const prevCompareHold = state?.compareHold ?? false;
        
        myPlayerId = msg.playerId;
        // 恢复游戏状态
        if (msg.state) {
          state = msg.state;
          state.myPlayerId = myPlayerId;
          state.showDecks = prevShowDecks;
          state.compareHold = prevCompareHold;
          bothPlayersReady = true;  // 有游戏状态说明双方都已准备好
        }
        // 恢复双方阵容信息
        if (msg.revealedFighters) {
          data.revealedFighters = msg.revealedFighters;
          bothPlayersReady = true;  // 有阵容信息说明双方都已选好
        } else if (msg.p1Fighters && msg.p2Fighters) {
          data.revealedFighters = {
            p1: msg.p1Fighters,
            p2: msg.p2Fighters,
          };
          bothPlayersReady = true;
        }
        // 确保大厅面板被隐藏
        if (els.lobbyPanel) {
          els.lobbyPanel.classList.add("hidden");
        }
        // 重置构筑阶段的本地状态（insertPos等）
        activeInsertDrag = null;
        // 根据等待的操作提示玩家
        if (msg.awaitingAction === "elf_pick") {
          pushLog("重连成功 - 需要选择精灵族的灵");
        } else if (msg.awaitingAction === "ready_for_battle") {
          pushLog("重连成功 - 等待你准备战斗");
        } else if (msg.awaitingAction === "construction") {
          pushLog("重连成功 - 需要完成构筑操作");
        } else if (msg.awaitingAction === "enter_construction") {
          pushLog("重连成功 - 等待进入构筑阶段");
        } else {
          pushLog("重连成功");
        }
        scheduleRender();
        break;
      }
        
      case "ERROR":
        pushLog(`错误: ${msg.error}`);
        break;
        
      default:
        console.log("未知消息:", msg);
    }
  }

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
    gameInterface: document.getElementById("game-interface"),
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
    lobbyPanel: document.getElementById("lobby-panel"),
    lobbyActions: document.getElementById("lobby-actions"),
    lobbyWaiting: document.getElementById("lobby-waiting"),
    lobbyReady: document.getElementById("lobby-ready"),
    roomCodeShow: document.getElementById("room-code-show"),
    lobbyStatus: document.getElementById("lobby-status"),
    btnCreateRoom: document.getElementById("btn-create-room"),
    btnJoinRoom: document.getElementById("btn-join-room"),
    inputRoomCode: document.getElementById("input-room-code"),
    connectionStatus: document.getElementById("connection-status"),
  };

  const data = {
    rulesTxt: "",
    fightersTxt: "",
    cardsTxt: "",
    settlementTxt: "",
    fighterDefs: [],
    fighterList: [],      // 服务端返回的可用战士列表
    revealedFighters: null, // 双方揭示的阵容
  };

  let state = { phase: PHASE.LOADING };
  let renderQueued = false;
  let activeInsertDrag = null;
  let lastOpponentActivity = Date.now();  // 挂机检测：对手最后活动时间
  let afkWarningShown = false;  // 是否已显示挂机提示
  let bothPlayersReady = false;  // 房间是否已有两人
  let waitingForOpponent = null;  // 等待对手操作的类型: "battle" | "construction" | null
  const logLines = [];  // 日志行缓存
  const MAX_LOG_LINES = 1000;  // 日志行数上限

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function updateConnectionStatus(status) {
    const el = els.connectionStatus;
    if (!el) return;
    const dot = el.querySelector(".status-dot");
    const text = el.querySelector(".status-text");
    dot.className = "status-dot";
    if (status === "connected") {
      dot.classList.add("connected");
      text.textContent = "已连接";
    } else if (status === "reconnecting") {
      dot.classList.add("reconnecting");
      text.textContent = "重连中...";
    } else {
      text.textContent = "未连接";
    }
  }

  function renderLobby() {
    const panel = els.lobbyPanel;
    if (!panel) return;
    
    // 默认状态：显示大厅，隐藏游戏界面
    const showLobby = !roomCode || (roomCode && state.phase === PHASE.LOADING) || (roomCode && state.phase === PHASE.SETUP && !bothPlayersReady);
    
    if (showLobby) {
      // 显示大厅面板，隐藏游戏界面
      panel.classList.remove("hidden");
      if (els.gameInterface) els.gameInterface.classList.add("hidden");
    } else if (state.phase === PHASE.SETUP && bothPlayersReady) {
      // 英雄选择阶段：隐藏大厅和游戏界面，只显示英雄选择面板
      panel.classList.add("hidden");
      if (els.gameInterface) els.gameInterface.classList.add("hidden");
    } else {
      // 游戏阶段：隐藏大厅，显示游戏界面
      panel.classList.add("hidden");
      if (els.gameInterface) els.gameInterface.classList.remove("hidden");
    }
    
    // 根据状态显示不同的UI（仅在大厅显示时）
    if (showLobby) {
      if (roomCode && myPlayerId === "p1") {
        if (bothPlayersReady) {
          // 双方已就绪，显示准备状态
          els.lobbyActions?.classList.add("hidden");
          els.lobbyWaiting?.classList.add("hidden");
          els.lobbyReady?.classList.remove("hidden");
        } else {
          // P1创建房间，等待对手
          els.lobbyActions?.classList.add("hidden");
          els.lobbyWaiting?.classList.remove("hidden");
          els.lobbyReady?.classList.add("hidden");
          els.roomCodeShow.textContent = roomCode;
        }
      } else if (roomCode && myPlayerId === "p2") {
        // P2已加入，显示准备状态
        els.lobbyActions?.classList.add("hidden");
        els.lobbyWaiting?.classList.add("hidden");
        els.lobbyReady?.classList.remove("hidden");
      } else {
        // 未加入房间，显示创建/加入按钮
        els.lobbyActions?.classList.remove("hidden");
        els.lobbyWaiting?.classList.add("hidden");
        els.lobbyReady?.classList.add("hidden");
      }
    }
  }

  function pushLog(line) {
    const text = `[${nowTime()}] ${line}`;
    logLines.push(text);
    // 超过上限时清除前半部分
    if (logLines.length > MAX_LOG_LINES) {
      logLines.splice(0, logLines.length - MAX_LOG_LINES / 2);
    }
    els.log.textContent = logLines.join('\n');
    els.log.scrollTop = els.log.scrollHeight;
  }

  function clearLog() {
    logLines.length = 0;
    els.log.textContent = '';
  }

  // 包装函数：封装闭包依赖
  function phaseLabel() {
    return phaseLabelBase(state, PHASE);
  }

  function displayCardText(card) {
    return displayCardTextBase(card, state, PHASE);
  }

  function snapshotFighters() {
    const fighters = [...state.players.p1.fighters, ...state.players.p2.fighters];
    const m = new Map();
    for (const x of fighters) m.set(x.id, { hp: x.hp, power: x.power });
    return m;
  }

  // 包装 renderFighter，添加精灵族选择 UI（线上版特有）
  function renderFighter(f, opts) {
    let elfPickHtml = "";
    const pidForElf = String(f?.id ?? "").split(":")[0];
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
      elfPickHtml = `
        <div class="elf-pick-in-card">
          <div class="elf-pick-hint">${pendingKoIndex != null ? "选择下一位灵" : "选择进入游戏的灵"}（魂=${soul}）</div>
          <div class="elf-pick-row-grid" style="--hp-cells:30">${buttons}</div>
        </div>
      `;
    }
    return renderFighterBase(f, { ...opts, elfPickHtml }, { state, PHASE });
  }

  // 包装 renderDeckList，封装闭包依赖
  function renderDeckList(title, cards) {
    return renderDeckListBase(title, cards, state, PHASE);
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
    if (!p1 && !p2) {
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
    
    // 视角映射：根据 myPlayerId 决定谁的面板在哪个 DOM 容器
    // 如果没有 myPlayerId（单机模式），保持原始 P1左/P2右
    const amP2 = myPlayerId === "p2";
    
    // leftPlayer 渲染到 #player-p1 的 DOM 中
    // rightPlayer 渲染到 #player-p2 的 DOM 中
    const leftPlayer = amP2 ? p2 : p1;
    const rightPlayer = amP2 ? p1 : p2;
    const leftId = amP2 ? "p2" : "p1";
    const rightId = amP2 ? "p1" : "p2";
    
    // 更新玩家标题标签
    const leftLabel = myPlayerId ? (leftId === myPlayerId ? "我" : "对手") : `P1`;
    const rightLabel = myPlayerId ? (rightId === myPlayerId ? "我" : "对手") : `P2`;
    
    const leftHeader = document.querySelector("#player-p1 .player-name");
    const rightHeader = document.querySelector("#player-p2 .player-name");
    if (leftHeader) {
      leftHeader.textContent = leftLabel;
      leftHeader.className = myPlayerId ? (leftId === myPlayerId ? "player-name player-label-self" : "player-name player-label-opponent") : "player-name";
    }
    if (rightHeader) {
      rightHeader.textContent = rightLabel;
      rightHeader.className = myPlayerId ? (rightId === myPlayerId ? "player-name player-label-self" : "player-name player-label-opponent") : "player-name";
    }

    if (!leftPlayer || !rightPlayer) {
      els.p1Fighters.innerHTML = "";
      els.p2Fighters.innerHTML = "";
      return;
    }

    const leftMain = state.phase === PHASE.BATTLE && state.lastFlip ? state.lastFlip[`${leftId}Card`]?.fighterName : null;
    const rightMain = state.phase === PHASE.BATTLE && state.lastFlip ? state.lastFlip[`${rightId}Card`]?.fighterName : null;
    
    // 方案A+C： DOM 复用 - 只更新动态部分，保持头像不变
    const updateOrCreateFighters = (container, fighters, mainName) => {
      const existingEls = new Map();
      container.querySelectorAll(".fighter[data-fighter-id]").forEach((el) => {
        existingEls.set(el.getAttribute("data-fighter-id"), el);
      });
      const currentIds = new Set(fighters.map((f) => f.id));
      // 移除不再存在的战士
      for (const [id, el] of existingEls) {
        if (!currentIds.has(id)) el.remove();
      }
      // 更新或创建战士
      fighters.forEach((f, idx) => {
        const existingEl = existingEls.get(f.id);
        const opts = { isMain: mainName === f.name };
        if (existingEl) {
          // 已存在：增量更新（保持头像不变）
          updateFighterDOM(existingEl, f, opts, { state, PHASE });
          // 确保顺序正确
          if (container.children[idx] !== existingEl) {
            container.insertBefore(existingEl, container.children[idx]);
          }
        } else {
          // 不存在：创建新元素
          const html = renderFighter(f, opts);
          const temp = document.createElement("div");
          temp.innerHTML = html;
          const newEl = temp.firstElementChild;
          if (container.children[idx]) {
            container.insertBefore(newEl, container.children[idx]);
          } else {
            container.appendChild(newEl);
          }
        }
      });
    };
    updateOrCreateFighters(els.p1Fighters, leftPlayer.fighters, leftMain);
    updateOrCreateFighters(els.p2Fighters, rightPlayer.fighters, rightMain);
    // 注意：elf-pick 事件已改为事件委托，在 createApp 初始化时绑定一次

    els.p1BattleCount.textContent = `战斗牌库: ${Array.isArray(leftPlayer.battleDeck) ? leftPlayer.battleDeck.length : (leftPlayer.battleDeck?.length || 0)}`;
    els.p1ConstructCount.textContent = `构筑牌库: ${Array.isArray(leftPlayer.constructionDeck) ? leftPlayer.constructionDeck.length : (leftPlayer.constructionDeck?.length || 0)}`;
    els.p1ResolvedCount.textContent = `已结算: ${Array.isArray(leftPlayer.resolvedPile) ? leftPlayer.resolvedPile.length : (leftPlayer.resolvedPile?.length || 0)}`;
    els.p2BattleCount.textContent = `战斗牌库: ${Array.isArray(rightPlayer.battleDeck) ? rightPlayer.battleDeck.length : (rightPlayer.battleDeck?.length || 0)}`;
    els.p2ConstructCount.textContent = `构筑牌库: ${Array.isArray(rightPlayer.constructionDeck) ? rightPlayer.constructionDeck.length : (rightPlayer.constructionDeck?.length || 0)}`;
    els.p2ResolvedCount.textContent = `已结算: ${Array.isArray(rightPlayer.resolvedPile) ? rightPlayer.resolvedPile.length : (rightPlayer.resolvedPile?.length || 0)}`;

    // 对方牌库显示处理：如果不是数组（服务端过滤后的），显示"不可见"
    const renderDeckListOrHidden = (title, deck, isOpponent) => {
      if (!Array.isArray(deck)) {
        return `<div class="deck-title">${title}</div><div class="deck-list deck-hidden">对方牌库不可见</div>`;
      }
      return renderDeckList(title, deck);
    };
    
    const leftIsOpponent = myPlayerId && leftId !== myPlayerId;
    const rightIsOpponent = myPlayerId && rightId !== myPlayerId;
    
    els.p1Decks.innerHTML =
      renderDeckListOrHidden("战斗牌库（从上到下）", leftPlayer.battleDeck, leftIsOpponent) +
      renderDeckListOrHidden("构筑牌库（从上到下）", leftPlayer.constructionDeck, leftIsOpponent) +
      renderDeckListOrHidden("已结算（从上到下）", leftPlayer.resolvedPile, leftIsOpponent);
    els.p2Decks.innerHTML =
      renderDeckListOrHidden("战斗牌库（从上到下）", rightPlayer.battleDeck, rightIsOpponent) +
      renderDeckListOrHidden("构筑牌库（从上到下）", rightPlayer.constructionDeck, rightIsOpponent) +
      renderDeckListOrHidden("已结算（从上到下）", rightPlayer.resolvedPile, rightIsOpponent);

    els.p1Decks.classList.toggle("hidden", !state.showDecks);
    els.p2Decks.classList.toggle("hidden", !state.showDecks);
    syncRevelationSizing();
    requestAnimationFrame(() => requestAnimationFrame(positionHpArrows));
  }

  function renderBattleReveal() {
    if (!els.battleReveal) return;
    if (state.phase !== PHASE.BATTLE) {
      els.battleReveal.innerHTML = "";
      return;
    }
    // 显示等待对手操作的提示
    if (waitingForOpponent === "battle") {
      els.battleReveal.innerHTML = `
        <div class="battle-reveal-inner">
          <div class="battle-hint waiting">等待对方翻牌并结算...</div>
        </div>
      `;
      return;
    }
    // 异步构筑：不再需要等待对方进入构筑的逻辑
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

  // 拖拽状态对象
  const dragCtx = {
    dragging: null,
    hoverTarget: null,
    startPos: null,
  };

  // 辅助函数：获取战士池和名称列表
  function getPoolAndNames() {
    const pool = new Map(data.fighterDefs.map((f) => [f.name, f]));
    const names = [...data.fighterDefs]
      .slice()
      .sort((a, b) => (Number(a.code) || 0) - (Number(b.code) || 0))
      .map((f) => f.name);
    return { pool, names };
  }

  // 辅助函数：生成卡牌文本
  function getCardText(pool, fighterName) {
    if (fighterName === "郑一嫂") return "船0~7攻击；8~15回复2；20群伤至1；战船+1";
    if (fighterName === "派克帮") return "警在己方：攻击&交警；警在对方：获得警&力量同时+1";
    return pool.get(fighterName)?.deckTextByNo?.get(1) ?? "";
  }

  // 辅助函数：获取卡牌名称
  function getCardName1(pool, fighterName) {
    return pool.get(fighterName)?.deckNameByNo?.get(1) ?? "";
  }

  // 辅助函数：生成设置卡牌HTML
  function setupCardHtml(pool, playerId, fighterName, variant) {
    const text = getCardText(pool, fighterName);
    const n1 = getCardName1(pool, fighterName);
    return `
      <div class="insert-card ${variant}" draggable="false" data-setup="true" data-player="${playerId}" data-name="${fighterName}">
        <div class="insert-title">${fighterName}${n1 ? ` · ${n1}` : "#1"}</div>
        <div class="insert-text">${text}</div>
      </div>
    `;
  }

  // 辅助函数：生成设置面板HTML
  function setupBoardHtml(pool, playerId, built) {
    let html = "";
    const arr = Array.isArray(built) ? built : [];
    html += `<div class="setup-board-slot" data-setup-slot="top" data-player="${playerId}">放到顶</div>`;
    if (arr.length === 0) {
      html += `<div class="setup-board-empty">（空）</div>`;
    } else {
      for (let i = 0; i < arr.length; i++) {
        const name = arr[i];
        const n1 = getCardName1(pool, name);
        html += `
          <div class="deck-card setup-built" draggable="false" data-setup="true" data-player="${playerId}" data-name="${name}">
            <div class="deck-title">${i === 0 ? "顶" : "底"}：${name}${n1 ? ` · ${n1}` : "#1"}</div>
            <div class="deck-text">${getCardText(pool, name)}</div>
          </div>
        `;
      }
    }
    html += `<div class="setup-board-slot" data-setup-slot="bottom" data-player="${playerId}">放到底</div>`;
    return html;
  }

  function renderConstruction() {
    if (state.phase === PHASE.SETUP) {
      els.constructionPanel.innerHTML = "";
      // 检查是否双方都已加入房间
      if (roomCode && !bothPlayersReady) {
        els.constructionPanel.innerHTML = `
          <div class="construction-card">
            <div class="waiting-overlay">
              <div>等待对手加入房间...</div>
              <div style="margin-top: 12px; font-size: 14px; color: #64748b;">房间码: ${roomCode}</div>
            </div>
          </div>
        `;
        return;
      }
      
      const { pool, names } = getPoolAndNames();
      if (names.length < 2) {
        els.constructionPanel.innerHTML = `<div class="construction-card">战士库不足，无法开始游戏</div>`;
        return;
      }
      const setup = state.setup ?? { step: "pick", p1a: null, p1b: null, p2a: null, p2b: null, p1Built: [], p2Built: [] };
      state.setup = setup;
      if (!setup.step) setup.step = "pick";

      if (setup.step === "pick") {
        // 确定当前玩家的阵营
        const amP1 = myPlayerId === "p1";
        const amP2 = myPlayerId === "p2";
        const myLabel = amP1 ? "P1 (我)" : amP2 ? "P2 (我)" : "选择英雄";
        
        // 获取自己的选择状态
        const myPicks = amP1 ? [setup.p1a, setup.p1b] : amP2 ? [setup.p2a, setup.p2b] : [];
        const myPickSet = new Set(myPicks.filter(Boolean));
        const myPickCount = myPickSet.size;
        
        // 检查是否已确认
        const myConfirmed = amP1 ? setup.p1Confirmed : amP2 ? setup.p2Confirmed : false;
        const opponentConfirmed = amP1 ? setup.p2Confirmed : amP2 ? setup.p1Confirmed : false;
        
        const slotLabel = (v, fallback) => {
          if (v) {
            return `<div class="setup-picked" draggable="true" data-setup-pick="picked" data-name="${escapeHtml(v)}">${headshotImgHtml(
                v,
                "setup-headshot"
              )}<div class="setup-fighter-name">${escapeHtml(v)}</div></div>`;
          }
          return `<div class="setup-slot-placeholder">${fallback}</div>`;
        };

        // 所有已被选择的战士（包括自己和对手）
        const pickedByP1 = new Set([setup.p1a, setup.p1b].filter(Boolean));
        const pickedByP2 = new Set([setup.p2a, setup.p2b].filter(Boolean));
        const allPicked = new Set([...pickedByP1, ...pickedByP2]);
        
        const gridNames = names.slice(0, 12);
        const mySlotA = amP1 ? setup.p1a : amP2 ? setup.p2a : null;
        const mySlotB = amP1 ? setup.p1b : amP2 ? setup.p2b : null;
        
        // 检测是否已渲染过 pick 阶段 DOM（用于 DOM 复用）
        const existingCard = els.constructionPanel.querySelector('[data-pick-rendered="true"]');
        
        if (existingCard) {
          // === 增量更新模式 ===
          // 更新 2 个槽位
          const slots = [
            { slot: "a", value: mySlotA, fallback: "空槽1" },
            { slot: "b", value: mySlotB, fallback: "空槽2" },
          ];
          for (const { slot, value, fallback } of slots) {
            const slotEl = existingCard.querySelector(`[data-setup-pick="slot"][data-slot="${slot}"]`);
            if (slotEl) {
              const currentName = slotEl.getAttribute("data-current-fighter") || "";
              if (currentName !== (value || "")) {
                slotEl.innerHTML = slotLabel(value, fallback);
                slotEl.setAttribute("data-current-fighter", value || "");
              }
            }
          }
          
          // 更新 12 个池子格子（只更新状态，不重建 img）
          for (let i = 0; i < 12; i++) {
            const n = gridNames[i] ?? null;
            if (!n) continue;
            const fighterEl = existingCard.querySelector(`[data-setup-pick="fighter"][data-name="${CSS.escape(n)}"]`);
            if (!fighterEl) continue;
            
            const takenByMe = myPickSet.has(n);
            const takenByOther = allPicked.has(n) && !takenByMe;
            const disabled = takenByOther || myConfirmed;
            let title = "";
            if (takenByMe) title = "已选择";
            else if (takenByOther) title = "已被选择";
            
            // 更新 disabled 状态
            if (disabled) {
              fighterEl.classList.add("disabled");
              fighterEl.setAttribute("draggable", "false");
            } else {
              fighterEl.classList.remove("disabled");
              fighterEl.setAttribute("draggable", "true");
            }
            fighterEl.title = title;
          }
          
          // 更新确认按钮状态
          const confirmBtn = document.getElementById("setup-confirm");
          if (confirmBtn) {
            confirmBtn.disabled = myPickCount < 2 || myConfirmed;
            confirmBtn.textContent = myConfirmed ? '已确认' : '确认开始';
          }
          
          // 更新清空按钮状态
          const clearBtn = document.getElementById("setup-clear");
          if (clearBtn) {
            clearBtn.disabled = myConfirmed;
          }
          
          // 更新等待提示
          let waitingHtml = "";
          if (myConfirmed && !opponentConfirmed) {
            waitingHtml = `<div class="waiting-message" style="text-align: center; padding: 16px; color: #f59e0b; background: rgba(245, 158, 11, 0.1); border-radius: 8px; margin-top: 16px;">等待对方选择英雄...</div>`;
          } else if (myConfirmed && opponentConfirmed) {
            waitingHtml = `<div class="waiting-message" style="text-align: center; padding: 16px; color: #22c55e; background: rgba(34, 197, 94, 0.1); border-radius: 8px; margin-top: 16px;">双方已确认，游戏即将开始...</div>`;
          }
          const waitingContainer = existingCard.querySelector('.waiting-container');
          if (waitingContainer) {
            waitingContainer.innerHTML = waitingHtml;
          }
          
          return; // 增量更新完成，直接返回
        }
        
        // === 首次渲染模式 ===
        const poolCells = [];
        for (let i = 0; i < 12; i++) {
          const n = gridNames[i] ?? null;
          if (!n) {
            poolCells.push(`<div class="setup-fighter placeholder"></div>`);
            continue;
          }
          const takenByMe = myPickSet.has(n);
          const takenByOther = allPicked.has(n) && !takenByMe;
          const disabled = takenByOther || myConfirmed;
          let title = "";
          if (takenByMe) title = "已选择";
          else if (takenByOther) title = "已被选择";
          poolCells.push(
            `<div class="setup-fighter${disabled ? " disabled" : ""}" ${title ? `title="${title}"` : ""} draggable="${
              disabled ? "false" : "true"
            }" data-setup-pick="fighter" data-name="${escapeHtml(n)}">${headshotImgHtml(
              n,
              "setup-headshot"
            )}<div class="setup-fighter-name">${escapeHtml(n)}</div></div>`
          );
        }

        // 等待提示
        let waitingHtml = "";
        if (myConfirmed && !opponentConfirmed) {
          waitingHtml = `<div class="waiting-message" style="text-align: center; padding: 16px; color: #f59e0b; background: rgba(245, 158, 11, 0.1); border-radius: 8px; margin-top: 16px;">等待对方选择英雄...</div>`;
        } else if (myConfirmed && opponentConfirmed) {
          waitingHtml = `<div class="waiting-message" style="text-align: center; padding: 16px; color: #22c55e; background: rgba(34, 197, 94, 0.1); border-radius: 8px; margin-top: 16px;">双方已确认，游戏即将开始...</div>`;
        }

        els.constructionPanel.innerHTML = `
          <div class="construction-card" data-pick-rendered="true">
            <div style="text-align: center; margin-bottom: 16px;"><strong>${myLabel}</strong>：请选择 2 位战士</div>
            <div class="setup-pick-grid" style="grid-template-columns: 1fr; max-width: 600px; margin: 0 auto;">
              <div class="setup-side" data-player="${myPlayerId || 'p1'}">
                <div class="setup-side-title">我的选择</div>
                <div class="setup-slots" style="display: flex; gap: 12px; justify-content: center;">
                  <div class="setup-slot" data-setup-pick="slot" data-player="${myPlayerId || 'p1'}" data-slot="a" data-current-fighter="${escapeHtml(mySlotA || '')}">${slotLabel(mySlotA, "空槽1")}</div>
                  <div class="setup-slot" data-setup-pick="slot" data-player="${myPlayerId || 'p1'}" data-slot="b" data-current-fighter="${escapeHtml(mySlotB || '')}">${slotLabel(mySlotB, "空槽2")}</div>
                </div>
              </div>
              <div class="setup-pool setup-pool-grid" data-player="pool" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
                ${poolCells.join("")}
              </div>
            </div>
            <div class="construction-row" style="margin-top: 16px;">
              <button type="button" id="setup-clear" ${myConfirmed ? 'disabled' : ''}>清空</button>
              <div class="spacer"></div>
              <button type="button" id="setup-confirm" ${myPickCount < 2 || myConfirmed ? 'disabled' : ''}>${myConfirmed ? '已确认' : '确认开始'}</button>
            </div>
            <div class="waiting-container">${waitingHtml}</div>
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

        // setup pick 拖拽事件委托（仅绑定一次）
        if (!els.constructionPanel._setupPickDelegated) {
          els.constructionPanel._setupPickDelegated = true;
          
          // slot 的 dragover 事件
          els.constructionPanel.addEventListener("dragover", (ev) => {
            const slot = ev.target.closest('[data-setup-pick="slot"]');
            if (slot) {
              ev.preventDefault();
              const pid = slot.getAttribute("data-player");
              const isMySlot = myPlayerId ? (myPlayerId === pid) : true;
              if (!isMySlot) {
                ev.dataTransfer.dropEffect = "none";
                return;
              }
              slot.classList.add("active");
              ev.dataTransfer.dropEffect = "copy";
              return;
            }
            const pool = ev.target.closest('.setup-pool');
            if (pool) {
              ev.preventDefault();
              pool.classList.add("active");
              ev.dataTransfer.dropEffect = "move";
            }
          });
          
          // slot 和 pool 的 dragleave 事件
          els.constructionPanel.addEventListener("dragleave", (ev) => {
            const slot = ev.target.closest('[data-setup-pick="slot"]');
            if (slot) {
              slot.classList.remove("active");
              return;
            }
            const pool = ev.target.closest('.setup-pool');
            if (pool) {
              pool.classList.remove("active");
            }
          });
          
          // slot 和 pool 的 drop 事件
          els.constructionPanel.addEventListener("drop", (ev) => {
            const slot = ev.target.closest('[data-setup-pick="slot"]');
            if (slot) {
              ev.preventDefault();
              slot.classList.remove("active");
              const pid = slot.getAttribute("data-player");
              const isMySlot = myPlayerId ? (myPlayerId === pid) : true;
              if (!isMySlot) return;
              
              const raw = ev.dataTransfer.getData("text/plain");
              const slotName = slot.getAttribute("data-slot");
              if (!pid || !slotName) return;
              if (raw.startsWith("pick:")) {
                const name = raw.slice("pick:".length);
                const currentSetup = state.setup;
                const oppPicked = pid === "p1" ? new Set([currentSetup.p2a, currentSetup.p2b].filter(Boolean)) : new Set([currentSetup.p1a, currentSetup.p1b].filter(Boolean));
                if (oppPicked.has(name)) {
                  window.alert("对手已选择该战士");
                  scheduleRender();
                  return;
                }
                const key = pid === "p1" ? (slotName === "a" ? "p1a" : "p1b") : slotName === "a" ? "p2a" : "p2b";
                const otherKey = pid === "p1" ? (slotName === "a" ? "p1b" : "p1a") : slotName === "a" ? "p2b" : "p2a";
                const cur = currentSetup[key] ?? null;
                const other = currentSetup[otherKey] ?? null;
                if (other === name) currentSetup[otherKey] = cur;
                currentSetup[key] = name;
                scheduleRender();
                return;
              }
              if (raw.startsWith("slot:")) {
                const parts = raw.split(":");
                if (parts.length !== 4) return;
                const fromPid = parts[1];
                const fromSlot = parts[2];
                const name = parts[3];
                if (fromPid !== pid) return;
                const currentSetup = state.setup;
                const key = pid === "p1" ? (slotName === "a" ? "p1a" : "p1b") : slotName === "a" ? "p2a" : "p2b";
                const otherKey = pid === "p1" ? (slotName === "a" ? "p1b" : "p1a") : slotName === "a" ? "p2b" : "p2a";
                const cur = currentSetup[key] ?? null;
                const other = currentSetup[otherKey] ?? null;
                if (other === name) currentSetup[otherKey] = cur;
                currentSetup[key] = name;
                const fromKey = pid === "p1" ? (fromSlot === "a" ? "p1a" : "p1b") : fromSlot === "a" ? "p2a" : "p2b";
                if (fromSlot !== slotName) currentSetup[fromKey] = null;
                scheduleRender();
              }
              return;
            }
            const pool = ev.target.closest('.setup-pool');
            if (pool) {
              ev.preventDefault();
              pool.classList.remove("active");
              const raw = ev.dataTransfer.getData("text/plain");
              if (!raw.startsWith("slot:")) return;
              const parts = raw.split(":");
              if (parts.length !== 4) return;
              const pid = parts[1];
              const slotName = parts[2];
              const key = pid === "p1" ? (slotName === "a" ? "p1a" : "p1b") : slotName === "a" ? "p2a" : "p2b";
              state.setup[key] = null;
              scheduleRender();
            }
          });
          
          // fighter 的 dragstart 事件
          els.constructionPanel.addEventListener("dragstart", (ev) => {
            const fighter = ev.target.closest('[data-setup-pick="fighter"]');
            if (fighter) {
              if (fighter.classList.contains("disabled") || fighter.classList.contains("placeholder")) {
                ev.preventDefault();
                return;
              }
              const name = fighter.getAttribute("data-name");
              ev.dataTransfer.setData("text/plain", `pick:${name}`);
              ev.dataTransfer.effectAllowed = "copy";
              fighter.classList.add("dragging");
              return;
            }
            const picked = ev.target.closest('[data-setup-pick="picked"]');
            if (picked) {
              const name = picked.getAttribute("data-name");
              const parent = picked.closest('[data-setup-pick="slot"]');
              const pid = parent?.getAttribute("data-player");
              const slotName = parent?.getAttribute("data-slot");
              if (!pid || !slotName || !name) return;
              ev.dataTransfer.setData("text/plain", `slot:${pid}:${slotName}:${name}`);
              ev.dataTransfer.effectAllowed = "move";
              picked.classList.add("dragging");
            }
          });
          
          // fighter 和 picked 的 dragend 事件
          els.constructionPanel.addEventListener("dragend", (ev) => {
            const fighter = ev.target.closest('[data-setup-pick="fighter"]');
            if (fighter) {
              fighter.classList.remove("dragging");
              return;
            }
            const picked = ev.target.closest('[data-setup-pick="picked"]');
            if (picked) {
              picked.classList.remove("dragging");
            }
          });
        }

        const confirm = document.getElementById("setup-confirm");
        confirm.addEventListener("click", () => {
          // 检查是否已选好2个英雄
          const isComplete = myPlayerId 
            ? (myPlayerId === "p1" ? (setup.p1a && setup.p1b) : (setup.p2a && setup.p2b))
            : (setup.p1a && setup.p1b && setup.p2a && setup.p2b);
          if (!isComplete) return;
          
          // 标记自己已确认
          if (myPlayerId === "p1") {
            setup.p1Confirmed = true;
          } else if (myPlayerId === "p2") {
            setup.p2Confirmed = true;
          }
          
          // 发送选人消息到服务器
          const myFighters = myPlayerId === "p2" ? [setup.p2a, setup.p2b] : [setup.p1a, setup.p1b];
          wsSend({
            type: "SELECT_FIGHTERS",
            data: { fighters: myFighters, confirmed: true }
          });
          
          scheduleRender();
        });

        document.getElementById("setup-clear").addEventListener("click", () => {
          // 已确认后不能清空
          const myConfirmed = myPlayerId === "p1" ? setup.p1Confirmed : myPlayerId === "p2" ? setup.p2Confirmed : false;
          if (myConfirmed) return;
          
          // 在线上对战模式下，只清空自己的选择
          if (myPlayerId === "p1") {
            setup.p1a = null;
            setup.p1b = null;
          } else if (myPlayerId === "p2") {
            setup.p2a = null;
            setup.p2b = null;
          } else {
            // 本地模式，清空所有
            setup.p1a = null;
            setup.p1b = null;
            setup.p2a = null;
            setup.p2b = null;
          }
          scheduleRender();
        });
        return;
      }

      // ordering 步骤：设置起始顶牌战士
      if (setup.step === "ordering") {
        const amP1 = myPlayerId === "p1";
        const amP2 = myPlayerId === "p2";
        const myFighters = amP1 ? [setup.p1a, setup.p1b] : amP2 ? [setup.p2a, setup.p2b] : [];
        const myLabel = amP1 ? "P1 (我)" : amP2 ? "P2 (我)" : "设置起始顺序";
        
        // 检查是否已设置起始顺序
        const myOrderSet = amP1 ? setup.p1Order : amP2 ? setup.p2Order : false;
        const opponentOrderSet = amP1 ? setup.p2Order : amP2 ? setup.p1Order : false;
        
        // 生成战士选择卡片
        const fighterCardsHtml = myFighters.map(name => {
          const isSelected = (amP1 && setup.p1Order === name) || (amP2 && setup.p2Order === name);
          return `
            <div class="order-fighter-card ${isSelected ? 'selected' : ''}" data-fighter="${escapeHtml(name)}" style="
              border: 2px solid ${isSelected ? '#22c55e' : '#334155'};
              border-radius: 8px;
              padding: 12px;
              cursor: ${myOrderSet ? 'not-allowed' : 'pointer'};
              background: ${isSelected ? 'rgba(34, 197, 94, 0.1)' : '#1b2230'};
              opacity: ${myOrderSet && !isSelected ? '0.5' : '1'};
            ">
              ${headshotImgHtml(name, "order-headshot")}
              <div style="text-align: center; margin-top: 8px;">${escapeHtml(name)}</div>
              ${isSelected ? '<div style="text-align: center; color: #22c55e; font-size: 12px;">顶牌</div>' : ''}
            </div>
          `;
        }).join('');
        
        // 等待提示
        let waitingHtml = "";
        if (myOrderSet && !opponentOrderSet) {
          waitingHtml = `<div class="waiting-message" style="text-align: center; padding: 16px; color: #f59e0b; background: rgba(245, 158, 11, 0.1); border-radius: 8px; margin-top: 16px;">等待对方设置起始顺序...</div>`;
        } else if (myOrderSet && opponentOrderSet) {
          waitingHtml = `<div class="waiting-message" style="text-align: center; padding: 16px; color: #22c55e; background: rgba(34, 197, 94, 0.1); border-radius: 8px; margin-top: 16px;">双方已设置，游戏即将开始...</div>`;
        }
        
        els.constructionPanel.innerHTML = `
          <div class="construction-card">
            <div style="text-align: center; margin-bottom: 16px;">
              <strong>${myLabel}</strong>：请选择起始顶牌战士
              <div style="font-size: 14px; color: #94a3b8; margin-top: 8px;">（该战士将位于战斗牌库顶部）</div>
            </div>
            <div style="display: flex; gap: 24px; justify-content: center; margin-bottom: 24px;">
              ${fighterCardsHtml}
            </div>
            <div class="construction-row" style="margin-top: 16px;">
              <button type="button" id="order-confirm" ${!setup.p1Order || !setup.p2Order ? 'disabled' : ''} style="margin: 0 auto;">
                ${myOrderSet ? '已设置' : '确认设置'}
              </button>
            </div>
            ${waitingHtml}
          </div>
        `;
        
        // 添加点击事件
        if (!myOrderSet) {
          els.constructionPanel.querySelectorAll('.order-fighter-card').forEach(card => {
            card.addEventListener('click', () => {
              const fighterName = card.getAttribute('data-fighter');
              if (amP1) {
                setup.p1Order = fighterName;
              } else if (amP2) {
                setup.p2Order = fighterName;
              }
              // 发送设置到服务器
              wsSend({
                type: "SET_START_ORDER",
                data: { topFighter: fighterName }
              });
              scheduleRender();
            });
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

      pendingP1.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">本轮待插入（可拖动）</div>` + p1Pending.map((n) => setupCardHtml(pool, "p1", n, "outside setup")).join("");
      pendingP2.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">本轮待插入（可拖动）</div>` + p2Pending.map((n) => setupCardHtml(pool, "p2", n, "outside setup")).join("");
      boardP1.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">战斗牌堆（从上到下）</div>` + setupBoardHtml(pool, "p1", setup.p1Built);
      boardP2.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">战斗牌堆（从上到下）</div>` + setupBoardHtml(pool, "p2", setup.p2Built);

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
            if (ok) scheduleRender();
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
        scheduleRender();
      });

      document.getElementById("setup-start").addEventListener("click", () => {
        // 发送起始顺序到服务器
        const myTopFighter = myPlayerId === "p2" ? setup.p2Built[0] : setup.p1Built[0];
        wsSend({
          type: "SET_START_ORDER",
          data: { topFighter: myTopFighter }
        });
      });
      return;
    }

    if (state.phase !== PHASE.CONSTRUCTION) {
      els.constructionPanel.innerHTML = "";
      return;
    }
    const p1Choice = state.construction.p1;
    const p2Choice = state.construction.p2;

    // 生成选择框 HTML
    function renderDrawnBoxes(playerId, choice) {
      return choice.drawn
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
    }

    // 生成牌堆区域 HTML
    function renderBoardHtml(playerId, choice, player) {
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
      return board;
    }

    function renderChoice(playerId, choice) {
      const player = state.players[playerId];
      const drawnBoxes = renderDrawnBoxes(playerId, choice);
      const insertCard = choice.drawn[choice.insertIndex];
      const placed = Number.isFinite(choice.insertPos);
      const dragging = choice.dragging === true;
      const board = renderBoardHtml(playerId, choice, player);

      const order01 = choice.bottomOrder === "01" ? "selected" : "";
      const order10 = choice.bottomOrder === "10" ? "selected" : "";

      const rest = choice.drawn.filter((_, idx) => idx !== choice.insertIndex);
      const restLabel =
        rest.length === 2 ? `${rest[0].fighterName}#${rest[0].cardNo} / ${rest[1].fighterName}#${rest[1].cardNo}` : "-";

      const canApply = placed ? "" : "disabled";

      return `
        <div class="construction-card" data-player="${playerId}">
          <div><strong>${playerId.toUpperCase()}</strong> 构筑：从构筑牌库顶抽 3 张，选 1 张入战斗牌库</div>
          <div class="construction-row construction-choices-row">${drawnBoxes}</div>
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
            <select data-field="bottomOrder" data-player="${playerId}">
              <option value="01" ${order01}>按剩余显示顺序</option>
              <option value="10" ${order10}>交换顺序</option>
            </select>
            <div style="opacity:0.8;" class="rest-label">剩余：${restLabel}</div>
            <div class="spacer"></div>
            <button type="button" data-action="apply" data-player="${playerId}" ${canApply}>确认该方构筑</button>
          </div>
        </div>
      `;
    }

    function renderDone(playerId) {
      return `
        <div class="construction-card construction-done" data-player="${playerId}">
          <div><strong>${playerId.toUpperCase()}</strong> 构筑：已确认</div>
          <div class="waiting-hint" style="margin-top: 16px; padding: 12px; background: rgba(91, 140, 255, 0.1); border-radius: 8px; text-align: center; color: #94a3b8;">
            等待对方完成构筑....
          </div>
        </div>
      `;
    }

    // 返回 done 状态的内部 HTML（不包含外层 .construction-card div）
    function renderDoneInner(playerId) {
      return `
          <div><strong>${playerId.toUpperCase()}</strong> 构筑：已确认</div>
          <div class="waiting-hint" style="margin-top: 16px; padding: 12px; background: rgba(91, 140, 255, 0.1); border-radius: 8px; text-align: center; color: #94a3b8;">
            等待对方完成构筑....
          </div>
      `;
    }

    function renderPending(playerId) {
      return `
        <div class="construction-card" data-player="${playerId}">
          <div><strong>${playerId.toUpperCase()}</strong> 构筑：对手正在构筑中...</div>
        </div>
      `;
    }

    function renderNotEntered(playerId) {
      return `
        <div class="construction-card" data-player="${playerId}">
          <div style="padding: 12px; color: #64748b; text-align: center;">对手尚未进入构筑</div>
        </div>
      `;
    }

    function renderPanel(pid, choice) {
      if (choice && typeof choice === "object") return renderChoice(pid, choice);
      if (choice === "pending") return renderPending(pid);
      if (choice === "not_entered") return renderNotEntered(pid);
      return renderDone(pid);
    }

    // 增量更新单个玩家的构筑面板
    function updateChoiceIncremental(card, playerId, choice) {
      const player = state.players[playerId];
      const insertCard = choice.drawn[choice.insertIndex];
      const placed = Number.isFinite(choice.insertPos);
      const dragging = choice.dragging === true;

      // 1. 更新选择框的 .selected 类名
      card.querySelectorAll(`.construction-choice[data-player="${playerId}"]`).forEach((el) => {
        const idx = Number(el.getAttribute("data-drawn-idx"));
        el.classList.toggle("selected", idx === choice.insertIndex);
      });

      // 2. 更新 insert-outside 区域（待插入卡和提示）
      const outsideEl = card.querySelector(`.insert-outside[data-player="${playerId}"]`);
      if (outsideEl) {
        const outsideCard = outsideEl.querySelector(".insert-card.outside");
        if (outsideCard) {
          const titleEl = outsideCard.querySelector(".insert-title");
          const textEl = outsideCard.querySelector(".insert-text");
          if (titleEl) titleEl.innerHTML = `待插入：${cardTitleHtml(insertCard)}`;
          if (textEl) textEl.innerHTML = displayCardText(insertCard);
        }
        const hintEl = outsideEl.querySelector(".insert-outside-hint");
        if (hintEl) {
          hintEl.textContent = placed ? "已放置，可拖回撤销/改位置" : "拖动到右侧牌堆插入位置";
        }
      }

      // 3. 更新 insert-board 区域
      const boardEl = card.querySelector(`.insert-board[data-player="${playerId}"]`);
      if (boardEl) {
        boardEl.classList.toggle("dragging", dragging);
        // 重建 board 内容（dropzone + 已放置卡 + deck-card）
        boardEl.innerHTML = renderBoardHtml(playerId, choice, player);
      }

      // 4. 更新 select 和按钮
      const orderEl = card.querySelector(`select[data-field="bottomOrder"][data-player="${playerId}"]`);
      if (orderEl) {
        orderEl.value = choice.bottomOrder || "01";
      }

      const applyBtn = card.querySelector(`button[data-action="apply"][data-player="${playerId}"]`);
      if (applyBtn) {
        applyBtn.disabled = !placed;
      }

      // 5. 更新剩余牌标签
      const rest = choice.drawn.filter((_, idx) => idx !== choice.insertIndex);
      const restLabel = rest.length === 2 ? `${rest[0].fighterName}#${rest[0].cardNo} / ${rest[1].fighterName}#${rest[1].cardNo}` : "-";
      const restLabelEl = card.querySelector(".rest-label");
      if (restLabelEl) {
        restLabelEl.textContent = `剩余：${restLabel}`;
      }
    }

    // 检测是否已渲染过 CONSTRUCTION 阶段 DOM（用于 DOM 复用）
    const existingMarker = els.constructionPanel.querySelector('[data-construction-rendered="true"]');
    
    if (existingMarker) {
      // === 增量更新模式 ===
      const cards = els.constructionPanel.querySelectorAll(".construction-card");
      for (const card of cards) {
        const playerId = card.getAttribute("data-player");
        if (!playerId) continue;
        const choice = state.construction[playerId];
        const isDoneCard = card.classList.contains("construction-done");
        
        if (choice && typeof choice === "object" && isDoneCard) {
          // 需要从 done 状态切换回 choice 状态 - 更新内部 HTML
          const newHtml = renderPanel(playerId, choice);
          const temp = document.createElement("div");
          temp.innerHTML = newHtml;
          const newCard = temp.firstElementChild;
          // 保留 card 节点，只更新内部内容和类名
          card.innerHTML = newCard.innerHTML;
          card.className = newCard.className;
        } else if (!choice && !isDoneCard) {
          // 需要从 choice 状态切换到 done 状态 - 更新内部 HTML
          card.innerHTML = renderDoneInner(playerId);
          card.classList.add("construction-done");
        } else if (choice && typeof choice === "object" && !isDoneCard) {
          // 正常增量更新
          updateChoiceIncremental(card, playerId, choice);
        } else if (typeof choice === "string" && !isDoneCard) {
          // 字符串状态 (pending/not_entered)，更新内部 HTML
          const newHtml = renderPanel(playerId, choice);
          const temp = document.createElement("div");
          temp.innerHTML = newHtml;
          const newCard = temp.firstElementChild;
          card.innerHTML = newCard.innerHTML;
          card.className = newCard.className;
        }
        // 如果 !choice && isDoneCard，无需更新
      }
      return; // 增量更新完成，跳过事件绑定
    }

    // === 首次渲染模式 ===
    const panels = [];
    panels.push(renderPanel("p1", p1Choice));
    panels.push(renderPanel("p2", p2Choice));
    els.constructionPanel.innerHTML = `<div data-construction-rendered="true">${panels.join("")}</div>`;

    // === 事件委托绑定（仅首次渲染时执行） ===
    
    // 辅助函数：计算放置位置
    const computePosForBoard = (ev, boardEl) => {
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

    const computePosByXForBoard = (ev, boardEl) => {
      const rect = boardEl.getBoundingClientRect();
      const x = ev.clientX;
      const y = ev.clientY;
      if (!(x >= rect.left && x <= rect.right)) return null;
      const cards = Array.from(boardEl.querySelectorAll(`.deck-card[data-index]`));
      const endPos = cards.length;
      if (y < rect.top) return 0;
      if (y > rect.bottom) return endPos;
      return computePosForBoard(ev, boardEl);
    };

    // 辅助函数：放置动画
    const animateDrop = (playerId, oldRect) => {
      if (!oldRect) return;
      const dragSelector = `.insert-card[data-player="${playerId}"]`;
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
    };

    // 事件委托：click 事件
    els.constructionPanel.addEventListener("click", (ev) => {
      // 选择框点击
      const choiceEl = ev.target.closest(".construction-choice.selectable");
      if (choiceEl) {
        const playerId = choiceEl.getAttribute("data-player");
        const choice = state.construction?.[playerId];
        if (!choice || typeof choice !== "object") return;
        const nextIdx = Number(choiceEl.getAttribute("data-drawn-idx"));
        if (!Number.isFinite(nextIdx)) return;
        if (choice.insertIndex !== nextIdx) {
          choice.insertIndex = nextIdx;
          choice.insertPos = null;
          choice.previewPos = null;
          choice.dragging = false;
        }
        scheduleRender();
        return;
      }

      // 确认按钮点击
      const applyBtn = ev.target.closest('button[data-action="apply"]');
      if (applyBtn) {
        const playerId = applyBtn.getAttribute("data-player");
        const choice = state.construction?.[playerId];
        if (!choice || typeof choice !== "object" || !Number.isFinite(choice.insertPos)) return;
        wsSend({
          type: "CONSTRUCTION_CHOICE",
          data: {
            insertIndex: choice.insertIndex,
            insertPos: choice.insertPos,
            bottomOrder: choice.bottomOrder || "01"
          }
        });
        return;
      }
    });

    // 事件委托：change 事件
    els.constructionPanel.addEventListener("change", (ev) => {
      const orderEl = ev.target.closest('select[data-field="bottomOrder"]');
      if (orderEl) {
        const playerId = orderEl.getAttribute("data-player");
        const choice = state.construction?.[playerId];
        if (!choice || typeof choice !== "object") return;
        choice.bottomOrder = orderEl.value;
        scheduleRender();
      }
    });

    // 事件委托：dragstart 事件
    els.constructionPanel.addEventListener("dragstart", (ev) => {
      const insertCard = ev.target.closest(".insert-card");
      if (!insertCard) return;
      const playerId = insertCard.getAttribute("data-player");
      const choice = state.construction?.[playerId];
      if (!choice || typeof choice !== "object") return;

      ev.dataTransfer.setData("text/plain", `insert:${playerId}`);
      ev.dataTransfer.effectAllowed = "move";
      insertCard.classList.add("dragging");
      choice.dragging = true;
      choice._dropHandled = false; // 初始化 drop 处理标记
      activeInsertDrag = playerId;

      // 添加全局 dragover/drop 处理器
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
          if (r.pos == null) return;
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
          if (r.pos == null) return;
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          
          choice._dropHandled = true; // 标记 drop 已处理
          const dragSelector = `.insert-card[data-player="${playerId}"]`;
          const card = els.constructionPanel.querySelector(`.construction-card[data-player="${playerId}"]`);
          const oldEl = card?.querySelector(dragSelector);
          const oldRect = oldEl ? oldEl.getBoundingClientRect() : null;
          
          choice.insertPos = r.pos;
          choice.previewPos = null;
          choice.dragging = false;
          activeInsertDrag = null;
          scheduleRender();
          animateDrop(playerId, oldRect);
        };

        choice._globalInsertDragHandlers = { onOver, onDrop };
        document.addEventListener("dragover", onOver, true);
        document.addEventListener("drop", onDrop, true);
      }

      choice.previewPos = Number.isFinite(choice.insertPos) ? choice.insertPos : 0;
      scheduleRender();
    });

    // 事件委托：dragend 事件
    els.constructionPanel.addEventListener("dragend", (ev) => {
      const insertCard = ev.target.closest(".insert-card");
      if (!insertCard) return;
      const playerId = insertCard.getAttribute("data-player");
      const choice = state.construction?.[playerId];
      if (!choice || typeof choice !== "object") return;

      insertCard.classList.remove("dragging");
      choice.dragging = false;
      choice.previewPos = null;
      choice._dropHandled = false; // 清理 drop 处理标记
      activeInsertDrag = null;

      if (choice._globalInsertDragHandlers) {
        document.removeEventListener("dragover", choice._globalInsertDragHandlers.onOver, true);
        document.removeEventListener("drop", choice._globalInsertDragHandlers.onDrop, true);
        choice._globalInsertDragHandlers = null;
      }
      scheduleRender();
    });

    // 事件委托：dragover 事件
    els.constructionPanel.addEventListener("dragover", (ev) => {
      // dropzone 的 dragover
      const zone = ev.target.closest(".dropzone");
      if (zone) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        const playerId = zone.getAttribute("data-player");
        const choice = state.construction?.[playerId];
        if (!choice || typeof choice !== "object") return;
        const pos = Number(zone.getAttribute("data-pos"));
        if (!Number.isFinite(pos)) return;
        if (choice.previewPos !== pos) {
          choice.previewPos = pos;
          choice.dragging = true;
          scheduleRender();
        }
        return;
      }

      // insert-outside 的 dragover
      const outside = ev.target.closest(".insert-outside");
      if (outside) {
        ev.preventDefault();
        outside.classList.add("active");
        ev.dataTransfer.dropEffect = "move";
        const playerId = outside.getAttribute("data-player");
        const choice = state.construction?.[playerId];
        if (!choice || typeof choice !== "object") return;
        if (choice.previewPos !== null) {
          choice.previewPos = null;
          scheduleRender();
        }
        return;
      }

      // insert-board 的 dragover
      const boardEl = ev.target.closest(".insert-board");
      if (boardEl) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        const playerId = boardEl.getAttribute("data-player");
        const choice = state.construction?.[playerId];
        if (!choice || typeof choice !== "object") return;
        const pos = computePosForBoard(ev, boardEl);
        if (choice.previewPos !== pos) {
          choice.previewPos = pos;
          choice.dragging = true;
          scheduleRender();
        }
        return;
      }

      // insert-area 的 dragover
      const insertArea = ev.target.closest(".insert-area");
      if (insertArea) {
        const board = insertArea.querySelector(".insert-board");
        if (!board) return;
        const playerId = board.getAttribute("data-player");
        const choice = state.construction?.[playerId];
        if (!choice || typeof choice !== "object") return;
        const pos = computePosByXForBoard(ev, board);
        if (pos == null) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        if (choice.previewPos !== pos) {
          choice.previewPos = pos;
          choice.dragging = true;
          scheduleRender();
        }
      }
    }, true);

    // 事件委托：dragleave 事件
    els.constructionPanel.addEventListener("dragleave", (ev) => {
      const outside = ev.target.closest(".insert-outside");
      if (outside) {
        outside.classList.remove("active");
      }
    });

    // 事件委托：drop 事件
    els.constructionPanel.addEventListener("drop", (ev) => {
      const raw = ev.dataTransfer.getData("text/plain");
      if (!raw.startsWith("insert:")) return;
      const playerId = raw.slice("insert:".length);
      const choice = state.construction?.[playerId];
      if (!choice || typeof choice !== "object") return;

      // dropzone 的 drop
      const zone = ev.target.closest(".dropzone");
      if (zone && zone.getAttribute("data-player") === playerId) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        choice._dropHandled = true;
        
        const dragSelector = `.insert-card[data-player="${playerId}"]`;
        const card = els.constructionPanel.querySelector(`.construction-card[data-player="${playerId}"]`);
        const oldEl = card?.querySelector(dragSelector);
        const oldRect = oldEl ? oldEl.getBoundingClientRect() : null;
        
        const pos = Number(zone.getAttribute("data-pos"));
        if (!Number.isFinite(pos)) return;
        choice.insertPos = pos;
        choice.previewPos = null;
        choice.dragging = false;
        scheduleRender();
        animateDrop(playerId, oldRect);
        return;
      }

      // insert-board 的 drop
      const boardEl = ev.target.closest(".insert-board");
      if (boardEl && boardEl.getAttribute("data-player") === playerId) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        choice._dropHandled = true;
        
        const dragSelector = `.insert-card[data-player="${playerId}"]`;
        const card = els.constructionPanel.querySelector(`.construction-card[data-player="${playerId}"]`);
        const oldEl = card?.querySelector(dragSelector);
        const oldRect = oldEl ? oldEl.getBoundingClientRect() : null;
        
        const pos = Number.isFinite(choice.previewPos) ? choice.previewPos : computePosForBoard(ev, boardEl);
        choice.insertPos = pos;
        choice.previewPos = null;
        choice.dragging = false;
        scheduleRender();
        animateDrop(playerId, oldRect);
        return;
      }

      // insert-area 的 drop
      const insertArea = ev.target.closest(".insert-area");
      if (insertArea) {
        const board = insertArea.querySelector(".insert-board");
        if (board && board.getAttribute("data-player") === playerId) {
          const pos = computePosByXForBoard(ev, board);
          if (pos == null) return;
          ev.preventDefault();
          ev.stopPropagation();
          ev.stopImmediatePropagation();
          choice._dropHandled = true;
          
          const dragSelector = `.insert-card[data-player="${playerId}"]`;
          const card = els.constructionPanel.querySelector(`.construction-card[data-player="${playerId}"]`);
          const oldEl = card?.querySelector(dragSelector);
          const oldRect = oldEl ? oldEl.getBoundingClientRect() : null;
          
          choice.insertPos = pos;
          choice.previewPos = null;
          choice.dragging = false;
          scheduleRender();
          animateDrop(playerId, oldRect);
          return;
        }
      }

      // insert-outside 的 drop（拖回撤销）
      const outside = ev.target.closest(".insert-outside");
      if (outside && outside.getAttribute("data-player") === playerId) {
        // 检查是否已被其他处理器处理
        if (choice._dropHandled) return;
        
        ev.preventDefault();
        outside.classList.remove("active");
        choice.insertPos = null;
        choice.previewPos = null;
        choice.dragging = false;
        scheduleRender();
      }
    }, true);
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
    // 等待对手时禁用按钮
    const waitBattle = waitingForOpponent === "battle";
    const waitConstruction = waitingForOpponent === "construction";
    els.btnNextBattle.disabled = state.phase !== PHASE.BATTLE || awaiting || pendingEnd || pendingElfPick || waitBattle;
    els.btnEnterConstruction.disabled = !awaiting || pendingEnd || pendingElfPick || waitConstruction;
    els.btnCompare.disabled = !(state.phase === PHASE.BATTLE && state.lastRound);
    els.btnConfirmEnd.disabled = !pendingEnd;
  }

  function render() {
    // 大厅面板控制（由 renderLobby 统一处理）
    renderLobby();
    renderControls();
    renderBattleReveal();
    renderPlayers();
    renderConstruction();
  }

function battleTurn() {
    if (!state || state.phase !== PHASE.BATTLE) return;
    if (state.awaitingConstruction) return;
    if (state.pendingGameOver) return;
    wsSend({ type: "READY_FOR_BATTLE" });
  }

  function enterConstructionNow() {
    if (state.phase !== PHASE.BATTLE) return;
    if (!state.awaitingConstruction) return;
    if (state.pendingGameOver) return;
    wsSend({ type: "ENTER_CONSTRUCTION" });
  }

  function confirmEndNow() {
    wsSend({ type: "CONFIRM_GAME_OVER" });
  }

  function newGame() {
    if (data.fighterDefs.length < 2) return;
    const names = data.fighterDefs.map((f) => f.name);
    state = {
      phase: PHASE.SETUP,
      showDecks: false,
      setup: { step: "pick", p1a: null, p1b: null, p2a: null, p2b: null, p1Built: [], p2Built: [] },
      lastFlip: null,
      lastRound: null,
      awaitingConstruction: false,
      pendingGameOver: null,
      compareHold: false,
    };
    clearLog();
    pushLog(`新开一局：进入初始化选择`);
    render();
  }

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
    updateConnectionStatus("disconnected");
    render();
    data.rulesTxt = await loadText("/规则.txt");
    data.fightersTxt = await loadText("/战士库.txt");
    data.cardsTxt = await loadText("/卡牌词条.txt");
    data.settlementTxt = await loadText("/结算过程与示例.txt");
    data.fighterDefs = parseFighters(data.fightersTxt);
    for (const w of selfTestFighters(data.fighterDefs)) pushLog(`[自检] ${w}`);
    wireRulesDialog();
    // 启动 WebSocket 连接
    connectWebSocket();
    // 不再自动调用 newGame()，等待房间就绪后由服务器触发英雄选择
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
    newGame();
  });
  els.btnToggleDecks.addEventListener("click", () => {
    state.showDecks = !state.showDecks;
    scheduleRender();
  });
  els.btnOpenRules.addEventListener("click", () => {
    els.rulesDialog.showModal();
  });
  els.btnOpenLog.addEventListener("click", () => {
    els.logDialog.showModal();
  });
  els.btnNextBattle.addEventListener("click", () => {
    if (!state || state.phase !== PHASE.BATTLE) return;
    if (state.awaitingConstruction) return;
    if (state.pendingGameOver) return;
    wsSend({ type: "READY_FOR_BATTLE" });
    waitingForOpponent = "battle";
    scheduleRender();
  });
  els.btnEnterConstruction.addEventListener("click", () => {
    if (!state || state.phase !== PHASE.BATTLE) return;
    if (!state.awaitingConstruction) return;
    if (state.pendingGameOver) return;
    wsSend({ type: "ENTER_CONSTRUCTION" });
    // 异步构筑：不需要等待对方，服务端会立即进入构筑阶段
    scheduleRender();
  });
  els.btnConfirmEnd.addEventListener("click", () => {
    wsSend({ type: "CONFIRM_GAME_OVER" });
  });
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

  // 创建房间
  els.btnCreateRoom.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushLog("未连接到服务器，请等待连接...");
      return;
    }
    console.log("正在创建房间...");
    wsSend({ type: "CREATE_ROOM" });
  });

  // 加入房间
  els.btnJoinRoom.addEventListener("click", () => {
    const code = els.inputRoomCode.value.trim().toUpperCase();
    if (code.length !== 4) {
      pushLog("请输入4位房间码");
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushLog("未连接到服务器，请等待连接...");
      return;
    }
    console.log("正在加入房间:", code);
    wsSend({ type: "JOIN_ROOM", code });
  });

  // 回车也可以加入房间
  els.inputRoomCode.addEventListener("keypress", (e) => {
    if (e.key === "Enter") els.btnJoinRoom.click();
  });

  // 挂机检测：构筑阶段5分钟无对手活动则显示提示
  const AFK_TIMEOUT = 5 * 60 * 1000;  // 5分钟
  setInterval(() => {
    // 只在构筑阶段检测
    if (state?.phase !== PHASE.CONSTRUCTION) {
      afkWarningShown = false;
      return;
    }
    const elapsed = Date.now() - lastOpponentActivity;
    if (elapsed >= AFK_TIMEOUT && !afkWarningShown) {
      afkWarningShown = true;
      pushLog("对手似乎在挂机...");
      scheduleRender();
    }
  }, 30000);  // 每30秒检查一次

  // 精灵族选择事件委托（仅绑定一次）
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-elf-pick]");
    if (!btn) return;
    const raw = btn.getAttribute("data-elf-pick") || "";
    const [pid, idxStr] = raw.split(":");
    const idx = Number(idxStr);
    const player = state.players?.[pid];
    const elf = player?.fighters?.find?.((x) => x?.name === "精灵族");
    if (!elf || !elf.elf) return;
    const dead = Array.isArray(elf.elf.dead) ? elf.elf.dead : [false, false, false];
    if (!Number.isFinite(idx) || idx < 0 || idx > 2) return;
    const pendingKoIndex = Number.isFinite(elf.elf.pendingKoIndex) ? Number(elf.elf.pendingKoIndex) : null;
    if (dead[idx] === true) return;
    if (pendingKoIndex === idx) return;
    const spirit = elf.elf.spirits?.[idx];
    const maxHp = Number(spirit?.maxHp) || 0;
    if (maxHp <= 0) return;
    // 发送精灵族灵选择消息到服务器
    wsSend({
      type: "ELF_PICK",
      data: { spiritIndex: idx }
    });
  });
  init().catch((e) => {
    state.phase = PHASE.SETUP;
    render();
    pushLog(`初始化失败：${e?.message ?? String(e)}`);
  });
}

createApp();
