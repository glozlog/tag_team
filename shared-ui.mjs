/**
 * 共享 UI 渲染模块
 * 被 online/app.js 和根目录 app.js 共同使用
 */

export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function headshotKey(name) {
  const n = String(name ?? "");
  if (n === "玛曼布丽吉特") return "玛曼";
  return n;
}

export function headshotUrl(name) {
  const key = headshotKey(name);
  return `headshots/${encodeURIComponent(key)}.png`;
}

export function headshotImgHtml(name, className) {
  const url = headshotUrl(name);
  const cls = className ? String(className) : "headshot";
  // decoding="async" 防止图片解码阻塞主线程
  // fetchpriority="low" 降低头像加载优先级，优先加载游戏数据
  return `<img class="${escapeHtml(cls)}" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" fetchpriority="low" onerror="this.style.display='none'">`;
}

export function phaseLabel(state, PHASE) {
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

export function cardLabel(card) {
  if (!card) return "-";
  const n = card.cardName ? String(card.cardName).trim() : "";
  return n ? `${card.fighterName}·${n}` : `${card.fighterName}#${card.cardNo}`;
}

export function displayCardText(card, state, PHASE) {
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

export function cardTitleHtml(card) {
  if (!card) return "-";
  const n = card.cardName ? String(card.cardName).trim() : "";
  return `${escapeHtml(card.fighterName)}${n ? ` · ${escapeHtml(n)}` : `#${card.cardNo}`}`;
}

export function renderHpGrid(f, overlay, opts) {
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

export function renderElfHpGrid(f, shownHp, overlay) {
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

export function renderPowerGrid(f, overlay) {
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

/**
 * 渲染战士卡片
 * @param {Object} f - 战士对象
 * @param {Object} opts - 选项 { isMain: boolean, elfPickHtml: string }
 * @param {Object} ctx - 上下文 { state, PHASE }
 */
export function renderFighter(f, opts, ctx) {
  const elfPickHtml = opts?.elfPickHtml ?? "";
  const { state, PHASE } = ctx;
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
  // 方案A+C：添加 data-fighter-id 用于 DOM 复用
  return `
    <div class="fighter${isMain ? " fighter-main" : ""}" data-fighter-id="${escapeHtml(f.id)}">
      <div class="fighter-marks">
        ${policeMark}
        ${flameMark}
        ${ningMark}
        ${guardMark}
        ${golemBlockMark}
      </div>
      <div class="fighter-top">
        ${headshot}
        <div class="fighter-name">${f.name}</div>
        ${soulMark}
        ${isKo ? `<div class="ko-badge">KO!</div>` : ""}
      </div>
      <div class="fighter-dynamic">
        ${hpHtml}
        ${powerHtml}
        ${elfPickHtml}
        ${revBar}
        ${shipBar}
        ${rageBar}
        ${planBar}
        ${snakeBar}
      </div>
    </div>
  `;
}

export function positionHpArrows() {
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

/**
 * 方案A+C：增量更新战士 DOM
 * 只更新动态部分（状态标记、HP、力量等），保持头像不变
 * @param {HTMLElement} el - 已存在的战士 DOM 元素
 * @param {Object} f - 战士对象
 * @param {Object} opts - 选项 { isMain: boolean, elfPickHtml: string }
 * @param {Object} ctx - 上下文 { state, PHASE }
 */
export function updateFighterDOM(el, f, opts, ctx) {
  if (!el || !f) return;
  const { state, PHASE } = ctx;
  const isMain = opts?.isMain === true;
  const elfPickHtml = opts?.elfPickHtml ?? "";

  // 更新 main 样式
  el.classList.toggle("fighter-main", isMain);

  // 更新状态标记区域
  const marksContainer = el.querySelector(".fighter-marks");
  if (marksContainer) {
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
    marksContainer.innerHTML = policeMark + flameMark + ningMark + guardMark + golemBlockMark;
  }

  // 更新魂标记和KO标记
  const topContainer = el.querySelector(".fighter-top");
  if (topContainer) {
    // 更新魂标记
    let soulMarkEl = topContainer.querySelector(".soul-mark");
    if (f.name === "精灵族") {
      const soulVal = Math.max(0, Number(f?.elf?.soul) || 0);
      if (soulMarkEl) {
        soulMarkEl.textContent = `魂${soulVal}`;
      } else {
        const nameEl = topContainer.querySelector(".fighter-name");
        if (nameEl) {
          nameEl.insertAdjacentHTML("afterend", `<div class="soul-mark">魂${soulVal}</div>`);
        }
      }
    } else if (soulMarkEl) {
      soulMarkEl.remove();
    }
    // 更新KO标记
    function isKoNow(fx) {
      if (fx?.koByFlame === true) return true;
      if (fx?.name === "精灵族") return fx?.elf?.gameKo === true;
      if (Array.isArray(fx.koLines) && fx.koLines.length > 0) {
        return fx.koLines.includes(Number(fx.hp) || 0);
      }
      return Number(fx.hp) <= Number(fx.koLine);
    }
    const isKo = isKoNow(f);
    let koBadge = topContainer.querySelector(".ko-badge");
    if (isKo && !koBadge) {
      topContainer.insertAdjacentHTML("beforeend", `<div class="ko-badge">KO!</div>`);
    } else if (!isKo && koBadge) {
      koBadge.remove();
    }
  }

  // 更新动态区域（HP、力量、特殊条等）
  const dynamicContainer = el.querySelector(".fighter-dynamic");
  if (dynamicContainer) {
    const lastRound = state.lastRound;
    const comparing = state.compareHold === true && lastRound?.before?.has(f.id);
    const base = comparing ? lastRound.before.get(f.id) : null;
    const shownHp = base ? base.hp : f.hp;
    const shownPower = base ? base.power : f.power;

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

    // 构建特殊条
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

    dynamicContainer.innerHTML = hpHtml + powerHtml + elfPickHtml + revBar + shipBar + rageBar + planBar + snakeBar;
  }
}
