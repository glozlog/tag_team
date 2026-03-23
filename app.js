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
  startConstructionForPlayer,
  beginNextConstructionStep,
  applyConstructionChoice,
} from './game-engine.mjs';

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
} from './shared-ui.mjs';

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

  // 包装 renderFighter，本地版需要 elfPickHtml 支持精灵族选灵
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
    updateOrCreateFighters(els.p1Fighters, p1.fighters, p1Main);
    updateOrCreateFighters(els.p2Fighters, p2.fighters, p2Main);
    // 注意：elf-pick 事件已改为事件委托，在 createApp 初始化时绑定一次

    els.p1BattleCount.textContent = `战斗牌库: ${p1.battleDeck.length}`;
    els.p1ConstructCount.textContent = `构筑牌库: ${p1.constructionDeck.length}`;
    els.p1ResolvedCount.textContent = `已结算: ${p1.resolvedPile.length}`;
    els.p2BattleCount.textContent = `战斗牌库: ${p2.battleDeck.length}`;
    els.p2ConstructCount.textContent = `构筑牌库: ${p2.constructionDeck.length}`;
    els.p2ResolvedCount.textContent = `已结算: ${p2.resolvedPile.length}`;

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
    syncRevelationSizing();
    requestAnimationFrame(() => requestAnimationFrame(positionHpArrows));
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

  // Pick阶段渲染 - DOM复用版本
  function renderConstructionPick(setup, pool, names) {
    const pickedByP1 = new Set([setup.p1a, setup.p1b].filter(Boolean));
    const pickedByP2 = new Set([setup.p2a, setup.p2b].filter(Boolean));
    const gridNames = names.slice(0, 12);
    
    // 辅助函数：生成槽位内部 HTML
    const slotLabel = (v, fallback) =>
      v
        ? `<div class="setup-picked" draggable="true" data-setup-pick="picked" data-name="${escapeHtml(v)}">${headshotImgHtml(
            v,
            "setup-headshot"
          )}<div class="setup-fighter-name">${escapeHtml(v)}</div></div>`
        : `<div class="setup-slot-placeholder">${fallback}</div>`;
    
    // 检测是否已渲染过 pick 阶段 DOM（用于 DOM 复用）
    const existingCard = els.constructionPanel.querySelector('[data-pick-rendered="true"]');
    
    if (existingCard) {
      // === 增量更新模式 ===
      // 更新 4 个槽位
      const slots = [
        { player: "p1", slot: "a", value: setup.p1a, fallback: "空槽1" },
        { player: "p1", slot: "b", value: setup.p1b, fallback: "空槽2" },
        { player: "p2", slot: "a", value: setup.p2a, fallback: "空槽1" },
        { player: "p2", slot: "b", value: setup.p2b, fallback: "空槽2" },
      ];
      for (const { player, slot, value, fallback } of slots) {
        const slotEl = existingCard.querySelector(`[data-setup-pick="slot"][data-player="${player}"][data-slot="${slot}"]`);
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
        
        const takenBy = pickedByP1.has(n) ? "p1" : pickedByP2.has(n) ? "p2" : null;
        const disabled = takenBy != null;
        const title = takenBy === "p1" ? "已被P1选择" : takenBy === "p2" ? "已被P2选择" : "";
        
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
        confirmBtn.disabled = !(setup.p1a && setup.p1b && setup.p2a && setup.p2b);
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
      <div class="construction-card" data-pick-rendered="true">
        <div><strong>初始化</strong>：拖拽选择双方各 2 位战士</div>
        <div class="setup-pick-grid">
          <div class="setup-side" data-player="p1">
            <div class="setup-side-title"><strong>P1</strong></div>
            <div class="setup-slots">
              <div class="setup-slot" data-setup-pick="slot" data-player="p1" data-slot="a" data-current-fighter="${escapeHtml(setup.p1a || '')}">${slotLabel(setup.p1a, "空槽1")}</div>
              <div class="setup-slot" data-setup-pick="slot" data-player="p1" data-slot="b" data-current-fighter="${escapeHtml(setup.p1b || '')}">${slotLabel(setup.p1b, "空槽2")}</div>
            </div>
          </div>
          <div class="setup-pool setup-pool-grid" data-player="pool">
            ${poolCells.join("")}
          </div>
          <div class="setup-side" data-player="p2">
            <div class="setup-side-title"><strong>P2</strong></div>
            <div class="setup-slots">
              <div class="setup-slot" data-setup-pick="slot" data-player="p2" data-slot="a" data-current-fighter="${escapeHtml(setup.p2a || '')}">${slotLabel(setup.p2a, "空槽1")}</div>
              <div class="setup-slot" data-setup-pick="slot" data-player="p2" data-slot="b" data-current-fighter="${escapeHtml(setup.p2b || '')}">${slotLabel(setup.p2b, "空槽2")}</div>
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

    // 缓存DOM元素
    const cachedEls = {
      slots: els.constructionPanel.querySelectorAll('[data-setup-pick="slot"]'),
      fighters: els.constructionPanel.querySelectorAll('[data-setup-pick="fighter"]'),
      picked: els.constructionPanel.querySelectorAll('[data-setup-pick="picked"]'),
      pools: els.constructionPanel.querySelectorAll('.setup-pool'),
      confirm: document.getElementById("setup-confirm"),
      clear: document.getElementById("setup-clear"),
    };

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

    // 使用事件委托处理 slot 的拖放事件
    els.constructionPanel.addEventListener("dragover", (ev) => {
      const slot = ev.target.closest('[data-setup-pick="slot"]');
      const poolEl = ev.target.closest('.setup-pool');
      if (slot) {
        ev.preventDefault();
        slot.classList.add("active");
        ev.dataTransfer.dropEffect = "copy";
      } else if (poolEl) {
        ev.preventDefault();
        poolEl.classList.add("active");
        ev.dataTransfer.dropEffect = "move";
      }
    });

    els.constructionPanel.addEventListener("dragleave", (ev) => {
      const slot = ev.target.closest('[data-setup-pick="slot"]');
      const poolEl = ev.target.closest('.setup-pool');
      if (slot) slot.classList.remove("active");
      if (poolEl) poolEl.classList.remove("active");
    });

    els.constructionPanel.addEventListener("drop", (ev) => {
      const slot = ev.target.closest('[data-setup-pick="slot"]');
      const poolEl = ev.target.closest('.setup-pool');
      
      if (slot) {
        ev.preventDefault();
        slot.classList.remove("active");
        const raw = ev.dataTransfer.getData("text/plain");
        const pid = slot.getAttribute("data-player");
        const slotId = slot.getAttribute("data-slot");
        if (!pid || !slotId) return;
        if (raw.startsWith("pick:")) {
          const name = raw.slice("pick:".length);
          const ok = setSlot(pid, slotId, name);
          if (!ok) {
            window.alert("对手已选择该战士");
            scheduleRender();
            return;
          }
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
          setSlot(pid, slotId, name);
          const fromKey = pid === "p1" ? (fromSlot === "a" ? "p1a" : "p1b") : fromSlot === "a" ? "p2a" : "p2b";
          if (fromSlot !== slotId) setup[fromKey] = null;
          scheduleRender();
        }
      } else if (poolEl) {
        ev.preventDefault();
        poolEl.classList.remove("active");
        const raw = ev.dataTransfer.getData("text/plain");
        if (!raw.startsWith("slot:")) return;
        const parts = raw.split(":");
        if (parts.length !== 4) return;
        const pid = parts[1];
        const slotId = parts[2];
        const key = pid === "p1" ? (slotId === "a" ? "p1a" : "p1b") : slotId === "a" ? "p2a" : "p2b";
        setup[key] = null;
        scheduleRender();
      }
    });

    // 使用事件委托处理 dragstart/dragend
    els.constructionPanel.addEventListener("dragstart", (ev) => {
      const fighter = ev.target.closest('[data-setup-pick="fighter"]');
      const picked = ev.target.closest('[data-setup-pick="picked"]');
      
      if (fighter) {
        if (fighter.classList.contains("disabled") || fighter.classList.contains("placeholder")) {
          ev.preventDefault();
          return;
        }
        const name = fighter.getAttribute("data-name");
        ev.dataTransfer.setData("text/plain", `pick:${name}`);
        ev.dataTransfer.effectAllowed = "copy";
        fighter.classList.add("dragging");
        dragCtx.dragging = fighter;
      } else if (picked) {
        const name = picked.getAttribute("data-name");
        const parent = picked.closest('[data-setup-pick="slot"]');
        const pid = parent?.getAttribute("data-player");
        const slot = parent?.getAttribute("data-slot");
        if (!pid || !slot || !name) return;
        ev.dataTransfer.setData("text/plain", `slot:${pid}:${slot}:${name}`);
        ev.dataTransfer.effectAllowed = "move";
        picked.classList.add("dragging");
        dragCtx.dragging = picked;
      }
    });

    els.constructionPanel.addEventListener("dragend", (ev) => {
      if (dragCtx.dragging) {
        dragCtx.dragging.classList.remove("dragging");
        dragCtx.dragging = null;
      }
    });

    cachedEls.confirm.disabled = !(setup.p1a && setup.p1b && setup.p2a && setup.p2b);
    cachedEls.confirm.addEventListener("click", () => {
      if (!(setup.p1a && setup.p1b && setup.p2a && setup.p2b)) return;
      setup.step = "build";
      setup.p1Built = [setup.p1a, setup.p1b].filter(Boolean);
      setup.p2Built = [setup.p2a, setup.p2b].filter(Boolean);
      scheduleRender();
    });

    cachedEls.clear.addEventListener("click", () => {
      setup.p1a = null;
      setup.p1b = null;
      setup.p2a = null;
      setup.p2b = null;
      scheduleRender();
    });
  }

  // Build阶段拖拽系统
  function setupBuildDragSystem(setup, pool, pendingP1, boardP1, pendingP2, boardP2) {
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
  }

  // Build阶段渲染
  function renderConstructionBuild(setup, pool) {
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

    // 缓存DOM元素
    const cachedEls = {
      pendingP1: document.getElementById("setup-pending-p1"),
      boardP1: document.getElementById("setup-board-p1"),
      pendingP2: document.getElementById("setup-pending-p2"),
      boardP2: document.getElementById("setup-board-p2"),
      backBtn: document.getElementById("setup-back"),
      startBtn: document.getElementById("setup-start"),
    };

    cachedEls.pendingP1.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">本轮待插入（可拖动）</div>` + p1Pending.map((n) => setupCardHtml(pool, "p1", n, "outside setup")).join("");
    cachedEls.pendingP2.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">本轮待插入（可拖动）</div>` + p2Pending.map((n) => setupCardHtml(pool, "p2", n, "outside setup")).join("");
    cachedEls.boardP1.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">战斗牌堆（从上到下）</div>` + setupBoardHtml(pool, "p1", setup.p1Built);
    cachedEls.boardP2.innerHTML = `<div style="opacity:0.8;margin-bottom:8px;">战斗牌堆（从上到下）</div>` + setupBoardHtml(pool, "p2", setup.p2Built);

    // 初始化拖拽系统
    setupBuildDragSystem(setup, pool, cachedEls.pendingP1, cachedEls.boardP1, cachedEls.pendingP2, cachedEls.boardP2);

    cachedEls.startBtn.disabled = setup.p1Built.length !== 2 || setup.p2Built.length !== 2;

    cachedEls.backBtn.addEventListener("click", () => {
      setup.step = "pick";
      setup.p1Built = [];
      setup.p2Built = [];
      scheduleRender();
    });

    cachedEls.startBtn.addEventListener("click", () => {
      const picksByPlayer = { p1: [setup.p1a, setup.p1b], p2: [setup.p2a, setup.p2b] };
      const startTopByPlayer = { p1: setup.p1Built[0], p2: setup.p2Built[0] };
      state = createInitialState(pool, picksByPlayer, startTopByPlayer);
      clearLog();
      pushLog(`新开一局：P1 ${picksByPlayer.p1.join(" / ")}；P2 ${picksByPlayer.p2.join(" / ")}`);
      pushLog(`起手顺序：P1 顶为 ${formatCardLabel(state.players.p1.battleDeck[0])}；P2 顶为 ${formatCardLabel(state.players.p2.battleDeck[0])}`);
      scheduleRender();
    });
  }

  // 构筑阶段入口函数
  function renderConstruction() {
    // 对于非 CONSTRUCTION 阶段，清空面板
    if (state.phase === PHASE.SETUP) {
      els.constructionPanel.innerHTML = "";
      const { pool, names } = getPoolAndNames();
      if (names.length < 2) {
        els.constructionPanel.innerHTML = `<div class="construction-card">战士库不足，无法开始游戏</div>`;
        return;
      }
      const setup = state.setup ?? { step: "pick", p1a: null, p1b: null, p2a: null, p2b: null, p1Built: [], p2Built: [] };
      state.setup = setup;
      if (!setup.step) setup.step = "pick";

      if (setup.step === "pick") {
        renderConstructionPick(setup, pool, names);
        return;
      }
      
      // build 步骤
      renderConstructionBuild(setup, pool);
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
          <div><strong>${playerId.toUpperCase()}</strong> 构筑：已确认，等待另一方</div>
        </div>
      `;
    }

    // 返回 done 状态的内部 HTML（不包含外层 .construction-card div）
    function renderDoneInner(playerId) {
      return `<div><strong>${playerId.toUpperCase()}</strong> 构筑：已确认，等待另一方</div>`;
    }

    // 本地版 renderPanel 函数（简化版，不处理 pending/not_entered）
    function renderPanel(pid, choice) {
      if (choice && typeof choice === "object") return renderChoice(pid, choice);
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
          const newHtml = renderChoice(playerId, choice);
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
        }
        // 如果 !choice && isDoneCard，无需更新
      }
      return; // 增量更新完成，跳过事件绑定
    }

    // === 首次渲染模式 ===
    const panels = [];
    panels.push(p1Choice ? renderChoice("p1", p1Choice) : renderDone("p1"));
    panels.push(p2Choice ? renderChoice("p2", p2Choice) : renderDone("p2"));
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
        if (!choice) return;
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
        if (!choice || !Number.isFinite(choice.insertPos)) return;
        const beforeSnapshot = snapshotFighters();
        applyConstructionChoice(state, playerId, pushLog);
        const afterSnapshot = snapshotFighters();
        let changed = false;
        for (const [id, a] of afterSnapshot.entries()) {
          const b = beforeSnapshot.get(id);
          if (!b) continue;
          if ((a.hp ?? 0) !== (b.hp ?? 0) || (a.power ?? 0) !== (b.power ?? 0)) {
            changed = true;
            break;
          }
        }
        if (changed) state.lastIntermissionEffect = { before: beforeSnapshot, after: afterSnapshot };
        const w = checkWinner(state);
        if (w) {
          state.phase = PHASE.GAME_OVER;
          state.winner = w;
          const isKoNow = (f) => {
            if (f?.koByFlame === true) return true;
            if (f?.name === "精灵族") return f?.elf?.gameKo === true;
            return Array.isArray(f.koLines) && f.koLines.length > 0 ? f.koLines.includes(Number(f.hp) || 0) : Number(f.hp) <= Number(f.koLine);
          };
          const p1KO = state.players.p1.fighters.some(isKoNow);
          const p2KO = state.players.p2.fighters.some(isKoNow);
          const resLine = w === "draw" ? `平局` : w === "p1" ? `P1 胜 / P2 败` : `P2 胜 / P1 败`;
          pushLog(`游戏结束：${resLine}（P1 ${p1KO ? "KO" : "未KO"}，P2 ${p2KO ? "KO" : "未KO"}）`);
        } else if (!state.construction.p1 && !state.construction.p2) {
          state.phase = PHASE.BATTLE;
          state.awaitingConstruction = false;
          state.round += 1;
          state.turn = 1;
          state.lastFlip = null;
          state.lastRound = null;
          state.compareHold = false;
          pushLog(`构筑完成：回到战斗阶段`);
        }
        scheduleRender();
        return;
      }
    });

    // 事件委托：change 事件
    els.constructionPanel.addEventListener("change", (ev) => {
      const orderEl = ev.target.closest('select[data-field="bottomOrder"]');
      if (orderEl) {
        const playerId = orderEl.getAttribute("data-player");
        const choice = state.construction?.[playerId];
        if (!choice) return;
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
      if (!choice) return;

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
      if (!choice) return;

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
        if (!choice) return;
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
        if (!choice) return;
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
        if (!choice) return;
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
        if (!choice) return;
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
      if (!choice) return;

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

  function battleTurn() {
    if (state.phase !== PHASE.BATTLE) return;
    if (state.awaitingConstruction) return;
    if (state.pendingGameOver) return;

    const processElfRoundEnd = (playerId) => {
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
    };
    const p1 = state.players.p1;
    const p2 = state.players.p2;
    if (Array.isArray(state.pendingDoubleQueue) && state.pendingDoubleQueue.length > 0) {
      const pid = state.pendingDoubleQueue.shift();
      const lf = state.lastFlip;
      const p1Card = lf?.p1Card;
      const p2Card = lf?.p2Card;
      if (!pid || !p1Card || !p2Card) {
        state.pendingDoubleQueue = [];
        scheduleRender();
        return;
      }
      state.lastIntermissionEffect = null;
      const beforeSnapshot = snapshotFighters();
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
        state,
        settlement.hpDelta,
        settlement.powerDelta,
        beforeSnapshot,
        lf?.guardAtStartById,
        settlement?.blockActiveByPlayerId ?? null,
        settlement?.blockInnerByPlayerId ?? null
      );
      for (const line of applied?.log ?? []) pushLog(line);
      const hpTraceById = applied?.hpTraceById ?? new Map();
      const planEvents = [...(settlement.planEvents ?? []), ...(applied?.planEvents ?? [])];
      if (settlement?.removeBothCardsFromGame === true) {
        pushLog(`移除游戏：P1 ${formatCardLabel(p1Card)} / P2 ${formatCardLabel(p2Card)}`);
        p1.resolvedPile = p1.resolvedPile.filter((c) => c !== p1Card);
        p2.resolvedPile = p2.resolvedPile.filter((c) => c !== p2Card);
      }
      const afterSnapshot = snapshotFighters();
      const guardBlocked = new Set([...(settlement?.guardBlockedByPlayerId ?? []), ...(applied?.guardBlockedByPlayerId ?? [])]);
      const flipTriggered = settlement?.flipTriggeredByCardId && typeof settlement.flipTriggeredByCardId[Symbol.iterator] === "function" ? new Set(settlement.flipTriggeredByCardId) : new Set();
      state.lastRound = { round: state.round, turn: state.turn, before: beforeSnapshot, after: afterSnapshot, hpTraceById, planEvents, guardBlockedByPlayerId: guardBlocked, flipTriggeredByCardId: flipTriggered };
      for (const [id, a] of afterSnapshot.entries()) {
        const b = beforeSnapshot.get(id);
        if (!b) continue;
        const dh = (a.hp ?? 0) - (b.hp ?? 0);
        const dp = (a.power ?? 0) - (b.power ?? 0);
        if (dh === 0 && dp === 0) continue;
        const f = [...state.players.p1.fighters, ...state.players.p2.fighters].find((x) => x.id === id);
        const name = f?.name ?? id;
        const pid2 = String(id).split(":")[0];
        const who = pid2 === "p2" ? "P2" : "P1";
        const parts = [];
        if (dh !== 0) parts.push(`HP ${dh > 0 ? "+" : ""}${dh}`);
        if (dp !== 0) parts.push(`力量 ${dp > 0 ? "+" : ""}${dp}`);
        pushLog(`结算变化：${who} ${name}（${parts.join("，")}）`);
      }

      if (!state.pendingDoubleQueue.length) {
        if (state.pendingElfPickByPlayer) {
          processElfRoundEnd("p1");
          processElfRoundEnd("p2");
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
        state.pendingGameOver = w;
        const koP1 = p1KO ? "KO" : "未KO";
        const koP2 = p2KO ? "KO" : "未KO";
        const resLine = w === "draw" ? `平局` : w === "p1" ? `P1 胜 / P2 败` : `P2 胜 / P1 败`;
        pushLog(`游戏结束！${resLine}（P1 ${koP1}，P2 ${koP2}；点击"确认结束"进入结束结算）`);
        scheduleRender();
        return;
      }
    
      if (!state.pendingDoubleQueue.length) {
        if (p1.battleDeck.length === 0 && p2.battleDeck.length === 0) {
          state.awaitingConstruction = true;
          pushLog(`战斗牌库结算完：点击"进入构筑"进入构筑阶段`);
          scheduleRender();
          return;
        }
        state.turn += 1;
      }
      scheduleRender();
      return;
    }

    if (state.pendingElfPickByPlayer?.p1 || state.pendingElfPickByPlayer?.p2) return;
    if (p1.battleDeck.length === 0 || p2.battleDeck.length === 0) return;
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
    const beforeSnapshot = snapshotFighters();
    const p1Card = p1.battleDeck.shift();
    const p2Card = p2.battleDeck.shift();
    state.lastFlip = {
      round: state.round,
      turn: state.turn,
      p1Card,
      p2Card,
      p1FlippedAtStart: p1Card?.flipped === true,
      p2FlippedAtStart: p2Card?.flipped === true,
    };
    // 方案E优化：不再直接调用 renderBattleReveal()，统一由 scheduleRender() 触发
    // 避免同一帧内重复渲染
    scheduleRender();
    pushLog(`翻牌（轮次${state.round}回合${state.turn}）：P1 ${formatCardLabel(p1Card)} / P2 ${formatCardLabel(p2Card)}`);

    const ctx = buildContextForBattle(p1, p2, p1Card, p2Card);
    state.lastFlip.guardAtStartById = new Map([...p1.fighters, ...p2.fighters].map((f) => [f.id, f?.guard === true]));
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
      state,
      settlement.hpDelta,
      settlement.powerDelta,
      beforeSnapshot,
      state.lastFlip.guardAtStartById,
      settlement?.blockActiveByPlayerId ?? null,
      settlement?.blockInnerByPlayerId ?? null
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
    const afterSnapshot = snapshotFighters();
    const guardBlocked = new Set([...(settlement?.guardBlockedByPlayerId ?? []), ...(applied?.guardBlockedByPlayerId ?? [])]);
    const flipTriggered = settlement?.flipTriggeredByCardId && typeof settlement.flipTriggeredByCardId[Symbol.iterator] === "function" ? new Set(settlement.flipTriggeredByCardId) : new Set();
    state.lastRound = { round: state.round, turn: state.turn, before: beforeSnapshot, after: afterSnapshot, hpTraceById, planEvents, guardBlockedByPlayerId: guardBlocked, flipTriggeredByCardId: flipTriggered };
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

    if (plannedDoubleQueue.length) {
      state.pendingDoubleQueue = plannedDoubleQueue;
      scheduleRender();
      return;
    }

    if (state.pendingElfPickByPlayer) {
      processElfRoundEnd("p1");
      processElfRoundEnd("p2");
    }

    function isKoNow(fx) {
      if (fx?.koByFlame === true) return true;
      if (fx?.name === "精灵族") return fx?.elf?.gameKo === true;
      if (Array.isArray(fx.koLines) && fx.koLines.length > 0) {
        return fx.koLines.includes(Number(fx.hp) || 0);
      }
      return Number(fx.hp) <= Number(fx.koLine);
    }
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
      state.pendingGameOver = w;
      const koP1 = p1KO ? "KO" : "未KO";
      const koP2 = p2KO ? "KO" : "未KO";
      const resLine =
        w === "draw" ? `平局` : w === "p1" ? `P1 胜 / P2 败` : `P2 胜 / P1 败`;
      pushLog(`游戏结束！${resLine}（P1 ${koP1}，P2 ${koP2}；点击"确认结束"进入结束结算）`);
      scheduleRender();
      return;
    }
  
    if (p1.battleDeck.length === 0 && p2.battleDeck.length === 0) {
      state.awaitingConstruction = true;
      pushLog(`战斗牌库结算完：点击"进入构筑"进入构筑阶段`);
      scheduleRender();
      return;
    }
  
    state.turn += 1;
    scheduleRender();
  }

  function enterConstructionNow() {
    if (state.phase !== PHASE.BATTLE) return;
    if (!state.awaitingConstruction) return;
    if (state.pendingGameOver) return;
    const entered = enterConstructionIfNeeded(state, pushLog);
    state.awaitingConstruction = false;
    if (entered) beginNextConstructionStep(state, pushLog);
    scheduleRender();
  }

  function confirmEndNow() {
    if (state.phase !== PHASE.BATTLE) return;
    if (!state.pendingGameOver) return;
    state.phase = PHASE.GAME_OVER;
    state.winner = state.pendingGameOver;
    state.pendingGameOver = null;
    scheduleRender();
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
    render();
    data.rulesTxt = await loadText("/规则.txt");
    data.fightersTxt = await loadText("/战士库.txt");
    data.cardsTxt = await loadText("/卡牌词条.txt");
    data.settlementTxt = await loadText("/结算过程与示例.txt");
    data.fighterDefs = parseFighters(data.fightersTxt);
    for (const w of selfTestFighters(data.fighterDefs)) pushLog(`[自检] ${w}`);
    wireRulesDialog();
    newGame();
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
  els.btnNextBattle.addEventListener("click", battleTurn);
  els.btnEnterConstruction.addEventListener("click", enterConstructionNow);
  els.btnConfirmEnd.addEventListener("click", confirmEndNow);
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

  // 精灵族选择事件委托（仅绑定一次）
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-elf-pick]");
    if (!btn) return;
    const raw = btn.getAttribute("data-elf-pick") || "";
    const [pid, idxStr] = raw.split(":");
    const idx = Number(idxStr);
    const player = state.players?.[pid];
    const oppId = pid === "p1" ? "p2" : "p1";
    const elf = player?.fighters?.find?.((x) => x?.name === "精灵族");
    if (!elf || !elf.elf) return;
    const dead = Array.isArray(elf.elf.dead) ? elf.elf.dead : [false, false, false];
    if (!Number.isFinite(idx) || idx < 0 || idx > 2) return;
    const pendingKoIndex = Number.isFinite(elf.elf.pendingKoIndex) ? Number(elf.elf.pendingKoIndex) : null;
    if (dead[idx] === true) return;
    if (pendingKoIndex === idx) return;
    const wasKoPick = pendingKoIndex != null;
    if (pendingKoIndex != null) {
      dead[pendingKoIndex] = true;
      elf.elf.pendingKoIndex = null;
    }
    const spirit = elf.elf.spirits?.[idx];
    const maxHp = Number(spirit?.maxHp) || 0;
    if (maxHp <= 0) return;
    elf.elf.dead = dead;
    elf.elf.active = idx;
    elf.elf.pendingPick = false;
    elf.hp = maxHp;
    elf.maxHp = maxHp;
    elf.hpRules = Array.isArray(spirit?.hpRules) ? spirit.hpRules : [];
    state.pendingElfPickByPlayer[pid] = false;
    pushLog(`灵：${pid.toUpperCase()} 选择灵${idx + 1}（HP=${maxHp}，魂=${Number(elf.elf.soul) || 0}）`);
    const enterEffects = (elf.hpRules ?? []).filter((r) => r?.hp === elf.hp && r.stop !== true).flatMap((r) => r.effects ?? []);
    if (enterEffects.length) {
      const other = player.fighters.find((x) => x.id !== elf.id);
      const opp = state.players[oppId];
      const oppMain = opp?.fighters?.[0];
      const oppSup = opp?.fighters?.[1];
      const startPower = new Map();
      for (const f of [...player.fighters, ...opp.fighters]) startPower.set(f.id, Number(f.power) || 0);
      const ctx = {
        kind: "battle",
        my: { playerId: pid, mainId: elf.id, supportId: other?.id, bothIds: [elf.id, other?.id].filter(Boolean) },
        opp: { playerId: oppId, mainId: oppMain?.id, supportId: oppSup?.id, bothIds: [oppMain?.id, oppSup?.id].filter(Boolean) },
        startPower,
      };
      const settlement = settleEffects({
        ctx,
        myCard: { fighterName: "精灵族", text: "", id: "elf-enter" },
        oppCard: { fighterName: "对手", text: "", id: "elf-enter-opp" },
        myEffects: enterEffects,
        oppEffects: [],
        myPlayer: player,
        oppPlayer: opp,
      });
      const beforeSnapshot = snapshotFighters();
      applyDeltas(state, settlement.hpDelta, settlement.powerDelta, beforeSnapshot, null, null, null);
    }
    if (wasKoPick) {
      state.lastRound = null;
      state.lastIntermissionEffect = null;
      state.compareHold = false;
      state.lastFlip = null;
      scheduleRender();
      battleTurn();
      return;
    }
    scheduleRender();
  });
  init().catch((e) => {
    state.phase = PHASE.SETUP;
    render();
    pushLog(`初始化失败：${e?.message ?? String(e)}`);
  });
}

createApp();
