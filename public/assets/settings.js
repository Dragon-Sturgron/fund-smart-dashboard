import {
  $, activateCurrentNav, cacheHistory, cacheRealtime, escapeHtml, fetchHistoryMany,
  fetchFundNamesMany, fetchRealtimeMany, fmt, getCachedRealtime, initializeCloud, isUsableFundName, money, num,
  parseCodes, prefetchHistory, readLocalState, retryCloudSync, saveAndSync,
  schedulePagePrefetch, setGlobalMessage, setLoading, updateFundMeta, writeLocalState
} from './common.js';

const MAX_FUNDS = 12;
const els = {
  newCode: $('#newFundCode'), newAmount: $('#newHoldingAmount'), newProfit: $('#newHoldingProfit'),
  openAdd: $('#openAddModalBtn'), add: $('#addFundsBtn'), addContinue: $('#addAndContinueBtn'), closeAdd: $('#closeAddModalBtn'), cancelAdd: $('#cancelAddModalBtn'),
  addModal: $('#addFundModal'), addModalMessage: $('#addModalMessage'), recognize: $('#recognizeBtn'), syncNow: $('#syncNowBtn'),
  sync: $('#syncStatus'), message: $('#globalMessage'), body: $('#settingsBody'),
  mobile: $('#mobileSettingsCards'), saveAll: $('#saveAllBtn'), clearAll: $('#clearAllBtn'),
  overlay: $('#loadingOverlay'), loadingText: $('#loadingText'), statFundCount: $('#statFundCount'),
  statHoldingCount: $('#statHoldingCount'), statHoldingAmount: $('#statHoldingAmount'),
  statHoldingProfit: $('#statHoldingProfit')
};

let lastFocusedElement = null;
const dirtyPositionCodes = new Set();
let liveHoldingTimer = null;
let liveHoldingRefreshing = false;
let lastLiveHoldingRefreshAt = 0;

function clearAddForm() {
  els.newCode.value = '';
  els.newAmount.value = '';
  els.newProfit.value = '';
}

function openAddModal() {
  lastFocusedElement = document.activeElement;
  clearAddForm();
  setGlobalMessage(els.addModalMessage);
  els.addModal.hidden = false;
  els.addModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => els.newCode.focus());
}

function closeAddModal() {
  if (els.addModal.hidden) return;
  els.addModal.hidden = true;
  els.addModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
}

function hasInputValue(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function roundHalfUp(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function normalizePosition(raw = {}) {
  if (hasInputValue(raw.holdingAmount) || hasInputValue(raw.shares)) {
    return {
      ...raw,
      holdingAmount: raw.holdingAmount ?? '',
      holdingProfit: raw.holdingProfit ?? '',
      shares: num(raw.shares, 0) > 0 ? roundHalfUp(num(raw.shares, 0), 2) : '',
      navAtCalculation: raw.navAtCalculation ?? ''
    };
  }

  // 兼容旧版“成本净值 + 投入本金”数据，避免升级后直接丢失。
  const principal = num(raw.principal, 0);
  const costNav = num(raw.costNav, 0);
  const shares = principal > 0 && costNav > 0 ? roundHalfUp(principal / costNav, 2) : 0;
  return {
    ...raw,
    holdingAmount: principal > 0 ? principal : '',
    holdingProfit: principal > 0 ? 0 : '',
    shares: shares > 0 ? shares : '',
    navAtCalculation: costNav > 0 ? costNav : ''
  };
}

function positionFor(state, code) {
  return normalizePosition(state.positions?.[code] || {});
}

function cleanPositiveInput(value) {
  if (value === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? String(value) : '';
}

function cleanSignedInput(value) {
  if (value === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(value) : '';
}

function calculationNav(position) {
  const direct = num(position.navAtCalculation, 0);
  if (direct > 0) return direct;
  const amount = num(position.holdingAmount, 0);
  const shares = num(position.shares, 0);
  if (amount > 0 && shares > 0) return amount / shares;
  return num(position.costNav, 0);
}

function calculatePosition(holdingAmount, holdingProfit, nav, previous = {}, quoteMeta = {}) {
  const amount = num(holdingAmount, 0);
  const profit = num(holdingProfit, 0);
  const usedNav = num(nav, 0);
  const shares = amount > 0 && usedNav > 0 ? roundHalfUp(amount / usedNav, 2) : 0;
  const principal = amount - profit;
  const costNav = shares > 0 && principal > 0 ? principal / shares : 0;
  return {
    ...previous,
    holdingAmount: amount > 0 ? Number(amount.toFixed(2)) : '',
    holdingProfit: hasInputValue(holdingProfit) ? Number(profit.toFixed(2)) : '',
    shares: shares > 0 ? roundHalfUp(shares, 2) : '',
    navAtCalculation: usedNav > 0 ? Number(usedNav.toFixed(6)) : '',
    principal: principal > 0 ? Number(principal.toFixed(2)) : '',
    costNav: costNav > 0 ? Number(costNav.toFixed(6)) : '',
    calculatedAt: new Date().toISOString(),
    shareBasis: quoteMeta.shareBasis || previous.shareBasis || '',
    navSource: quoteMeta.navSource || previous.navSource || ''
  };
}

function principalFor(position = {}) {
  const stored = num(position.principal, 0);
  if (stored > 0) return stored;
  const amount = num(position.holdingAmount, 0);
  const profit = num(position.holdingProfit, 0);
  const derived = amount - profit;
  return derived > 0 ? derived : 0;
}

function liveNavForQuote(item = {}) {
  const estimated = num(item.estimatedNav, 0);
  if (estimated > 0) return { nav: estimated, source: '盘中估算净值' };
  const confirmed = num(item.previousNav, 0);
  if (confirmed > 0) return { nav: confirmed, source: '上一确认净值' };
  return { nav: 0, source: '' };
}

function applyLiveQuoteToPosition(position = {}, item = {}) {
  const shares = num(position.shares, 0);
  const principal = principalFor(position);
  const quote = liveNavForQuote(item);
  if (!(shares > 0) || !(principal > 0) || !(quote.nav > 0)) return position;

  const holdingAmount = roundHalfUp(shares * quote.nav, 2);
  const holdingProfit = roundHalfUp(holdingAmount - principal, 2);
  return {
    ...position,
    principal: Number(principal.toFixed(2)),
    holdingAmount,
    holdingProfit,
    liveNav: Number(quote.nav.toFixed(6)),
    liveRate: Number.isFinite(Number(item.estimatedRate)) ? Number(item.estimatedRate) : '',
    liveUpdatedAt: new Date().toISOString(),
    liveQuoteTime: item.time || '',
    liveSource: quote.source
  };
}

function positionChanged(left = {}, right = {}) {
  return num(left.holdingAmount, 0) !== num(right.holdingAmount, 0)
    || num(left.holdingProfit, 0) !== num(right.holdingProfit, 0)
    || num(left.liveNav, 0) !== num(right.liveNav, 0)
    || String(left.liveQuoteTime || '') !== String(right.liveQuoteTime || '');
}

function updatePositionInputsInDom(code, position) {
  document.querySelectorAll(`input[data-code="${code}"][data-pos="holdingAmount"]`).forEach(input => {
    input.value = position.holdingAmount ?? '';
  });
  document.querySelectorAll(`input[data-code="${code}"][data-pos="holdingProfit"]`).forEach(input => {
    input.value = position.holdingProfit ?? '';
  });
}

function holdingStatus(position) {
  const amount = num(position.holdingAmount, 0);
  const shares = num(position.shares, 0);
  if (amount > 0 && shares > 0 && hasInputValue(position.holdingProfit)) return { label: '份额已计算', tone: 'buy' };
  if (amount > 0) return { label: '待计算份额', tone: 'hold' };
  return { label: '未填写', tone: 'hold' };
}

function inputMarkup(code, key, value, placeholder, { signed = false } = {}) {
  const min = signed ? '' : ' min="0"';
  return `<input class="position-input" data-code="${code}" data-pos="${key}" type="number"${min} step="0.01" value="${escapeHtml(value ?? '')}" placeholder="${placeholder}">`;
}

function shareMarkup(position) {
  const shares = num(position.shares, 0);
  const nav = calculationNav(position);
  if (!(shares > 0)) return '<span class="muted">待计算</span>';
  return `<div class="calculated-share"><b>${fmt(shares, 2)}</b><small>按确认净值 ${fmt(nav, 4)}</small></div>`;
}

function render() {
  const state = readLocalState();
  const codes = parseCodes(state.codes);
  if (!codes.length) {
    els.body.innerHTML = '<tr><td colspan="6" class="table-empty">尚未添加基金代码。</td></tr>';
    els.mobile.innerHTML = '<div class="empty-mobile-card">点击“新增基金”，填写基金代码、持有金额和持有收益后添加。</div>';
  } else {
    els.body.innerHTML = codes.map(code => {
      const position = positionFor(state, code);
      const status = holdingStatus(position);
      const name = state.fundMeta?.[code]?.name || `基金 ${code}`;
      return `<tr>
        <td><div class="fund-name">${escapeHtml(name)}</div><div class="fund-code">${code}</div></td>
        <td>${inputMarkup(code, 'holdingAmount', position.holdingAmount, '例如 10500')}</td>
        <td>${inputMarkup(code, 'holdingProfit', position.holdingProfit, '例如 500 或 -300', { signed: true })}</td>
        <td>${shareMarkup(position)}</td>
        <td><span class="signal-pill ${status.tone}">${status.label}</span></td>
        <td><button class="btn btn-light btn-small danger-outline" data-remove="${code}" type="button">删除</button></td>
      </tr>`;
    }).join('');

    els.mobile.innerHTML = codes.map(code => {
      const position = positionFor(state, code);
      const status = holdingStatus(position);
      const name = state.fundMeta?.[code]?.name || `基金 ${code}`;
      return `<article class="mobile-fund-card mobile-settings-card">
        <div class="mobile-card-head"><div><div class="fund-name">${escapeHtml(name)}</div><div class="fund-code">${code}</div></div><span class="signal-pill ${status.tone}">${status.label}</span></div>
        <div class="settings-mobile-fields">
          <label class="field"><span>持有金额（元）</span>${inputMarkup(code, 'holdingAmount', position.holdingAmount, '例如 10500')}</label>
          <label class="field"><span>持有收益（元）</span>${inputMarkup(code, 'holdingProfit', position.holdingProfit, '例如 500 或 -300', { signed: true })}</label>
          <div class="mobile-calculated-field"><span>持有份额</span>${shareMarkup(position)}</div>
        </div>
        <button class="btn btn-light full-btn danger-outline" data-remove="${code}" type="button">删除这只基金</button>
      </article>`;
    }).join('');
  }
  bindDynamicEvents();
  renderStats(state, codes);
}

function renderStats(state = readLocalState(), codes = parseCodes(state.codes)) {
  const positions = codes.map(code => positionFor(state, code));
  const holdings = positions.filter(position => num(position.holdingAmount) > 0 && num(position.shares) > 0);
  const holdingAmount = positions.reduce((sum, position) => sum + num(position.holdingAmount, 0), 0);
  const holdingProfit = positions.reduce((sum, position) => sum + num(position.holdingProfit, 0), 0);
  els.statFundCount.textContent = String(codes.length);
  els.statHoldingCount.textContent = String(holdings.length);
  els.statHoldingAmount.textContent = money(holdingAmount);
  els.statHoldingProfit.textContent = money(holdingProfit);
  els.statHoldingProfit.classList.toggle('text-red', holdingProfit > 0);
  els.statHoldingProfit.classList.toggle('text-green', holdingProfit < 0);
}

function syncPositionInput(input) {
  const code = input.dataset.code;
  const key = input.dataset.pos;
  const value = key === 'holdingProfit' ? cleanSignedInput(input.value) : cleanPositiveInput(input.value);
  document.querySelectorAll(`input[data-code="${code}"][data-pos="${key}"]`).forEach(item => {
    if (item !== input) item.value = value;
  });
}

function bindDynamicEvents() {
  document.querySelectorAll('.position-input').forEach(input => {
    // 表格与手机卡片互相同步输入值，但不提前计算份额。
    // 只有点击“保存全部持仓”后，才重新读取确认净值并统一计算。
    input.addEventListener('input', event => {
      const current = event.currentTarget;
      syncPositionInput(current);
      dirtyPositionCodes.add(current.dataset.code);
    });
  });
  document.querySelectorAll('[data-remove]').forEach(button => {
    button.addEventListener('click', () => removeFund(button.dataset.remove));
  });
}

function collectPositionDraftsFromInputs() {
  const state = readLocalState();
  const drafts = {};
  for (const code of parseCodes(state.codes)) {
    const previous = positionFor(state, code);
    const amountInput = document.querySelector(`input[data-code="${code}"][data-pos="holdingAmount"]`);
    const profitInput = document.querySelector(`input[data-code="${code}"][data-pos="holdingProfit"]`);
    drafts[code] = {
      previous,
      amount: cleanPositiveInput(amountInput?.value ?? previous.holdingAmount ?? ''),
      profit: cleanSignedInput(profitInput?.value ?? previous.holdingProfit ?? '')
    };
  }
  return drafts;
}

async function refreshLiveHoldings({ silent = true, codes = null } = {}) {
  if (liveHoldingRefreshing || document.hidden) return;
  const state = readLocalState();
  const requestedCodes = codes ? parseCodes(codes.join(',')) : parseCodes(state.codes);
  const targets = requestedCodes.filter(code => {
    const position = positionFor(state, code);
    return !dirtyPositionCodes.has(code)
      && num(position.shares, 0) > 0
      && principalFor(position) > 0;
  });
  if (!targets.length) return;

  liveHoldingRefreshing = true;
  try {
    const realtime = await fetchRealtimeMany(targets);
    if (realtime.items.length) {
      cacheRealtime(realtime.items);
      updateFundMeta(realtime.items);
    }

    const latestState = readLocalState();
    const positions = { ...(latestState.positions || {}) };
    const changedCodes = [];
    for (const item of realtime.items) {
      if (dirtyPositionCodes.has(item.code)) continue;
      const previous = positionFor(latestState, item.code);
      const next = applyLiveQuoteToPosition(previous, item);
      if (positionChanged(previous, next)) {
        positions[item.code] = next;
        changedCodes.push(item.code);
      }
    }

    if (changedCodes.length) {
      const nextState = writeLocalState({ positions });
      if (dirtyPositionCodes.size === 0) {
        render();
      } else {
        for (const code of changedCodes) updatePositionInputsInDom(code, positionFor(nextState, code));
        renderStats(nextState, parseCodes(nextState.codes));
      }
    }
    lastLiveHoldingRefreshAt = Date.now();

    if (!silent) {
      if (realtime.errors.length) {
        setGlobalMessage(
          els.message,
          `盘中持仓已更新 ${realtime.items.length} 只，${realtime.errors.length} 只暂时失败。持有金额与持有收益将按实时估算继续自动变化。`,
          'error'
        );
      } else {
        setGlobalMessage(
          els.message,
          `已按盘中估算更新 ${realtime.items.length} 只基金的持有金额和持有收益；页面打开期间每 60 秒自动刷新。`,
          'success'
        );
      }
    }
  } finally {
    liveHoldingRefreshing = false;
  }
}

function startLiveHoldingAutoRefresh() {
  clearInterval(liveHoldingTimer);
  liveHoldingTimer = setInterval(() => refreshLiveHoldings({ silent: true }), 60 * 1000);
}

async function recognizeNames(codes = parseCodes(readLocalState().codes), { quiet = false, background = false } = {}) {
  const state = readLocalState();
  const targets = parseCodes(codes.join(',')).filter(code => !isUsableFundName(state.fundMeta?.[code]?.name, code));
  if (!targets.length) {
    if (!quiet) setGlobalMessage(els.message, '当前基金名称均已识别。', 'success');
    return;
  }
  if (!background) setLoading(els.overlay, els.loadingText, true, `正在并行识别 ${targets.length} 只基金名称`);
  try {
    const names = await fetchFundNamesMany(targets);
    const success = [...names.items];
    const found = new Set(success.map(item => item.code));
    const remaining = targets.filter(code => !found.has(code));

    // 名称专用接口不可用时，再使用盘中行情接口兜底。
    let realtimeErrors = [];
    if (remaining.length) {
      const realtime = await fetchRealtimeMany(remaining);
      for (const item of realtime.items) {
        if (isUsableFundName(item?.name, item?.code)) {
          success.push(item);
          found.add(item.code);
        }
      }
      realtimeErrors = realtime.errors;
      if (realtime.items.length) cacheRealtime(realtime.items);
    }

    if (success.length) updateFundMeta(success);
    render();
    const failed = targets.filter(code => !found.has(code));
    if (!quiet || failed.length) {
      if (failed.length) {
        const detail = [...names.errors, ...realtimeErrors]
          .filter(item => failed.includes(item.code))
          .map(item => `${item.code}：${item.message}`)
          .join('；');
        setGlobalMessage(els.message, `已识别 ${success.length} 只，${failed.length} 只暂未识别名称${detail ? `（${detail}）` : ''}。`, 'error');
      } else {
        setGlobalMessage(els.message, `基金名称识别完成，共 ${success.length} 只。`, 'success');
      }
    }
  } finally {
    if (!background) setLoading(els.overlay, els.loadingText, false);
  }
}

async function resolveFundQuote(code) {
  // 持有金额在基金平台盘中通常仍按“上一确认净值”展示。
  // 盘中估算净值会不断变化，不能用于反推固定持有份额。
  const realtime = await fetchRealtimeMany([code]);
  const live = realtime.items[0];
  if (live) {
    cacheRealtime([live]);
    const confirmedNav = num(live.previousNav, 0);
    if (confirmedNav > 0) {
      return {
        nav: confirmedNav,
        item: live,
        source: '上一确认净值',
        shareBasis: 'confirmed-nav'
      };
    }
  }

  const cached = getCachedRealtime([code])[0];
  if (cached) {
    const confirmedNav = num(cached.previousNav, 0);
    if (confirmedNav > 0) {
      return {
        nav: confirmedNav,
        item: cached,
        source: '本机缓存的上一确认净值',
        shareBasis: 'confirmed-nav'
      };
    }
  }

  const history = await fetchHistoryMany([code]);
  const item = history.items[0];
  const latest = item?.history?.at(-1);
  if (item && num(latest?.nav, 0) > 0) {
    cacheHistory([item]);
    return {
      nav: num(latest.nav),
      item,
      source: '最新正式净值',
      shareBasis: 'confirmed-nav'
    };
  }

  const message = realtime.errors[0]?.message || history.errors[0]?.message || '无法获取可用于计算份额的确认净值';
  throw new Error(message);
}

async function addFund({ keepOpen = false } = {}) {
  const code = String(els.newCode.value || '').trim();
  const amountRaw = els.newAmount.value;
  const profitRaw = els.newProfit.value;
  const amount = Number(amountRaw);
  const profit = Number(profitRaw);

  if (!/^\d{6}$/.test(code)) {
    setGlobalMessage(els.addModalMessage, '请输入正确的六位基金代码。', 'error');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    setGlobalMessage(els.addModalMessage, '持有金额必须大于 0。', 'error');
    return;
  }
  if (profitRaw === '' || !Number.isFinite(profit)) {
    setGlobalMessage(els.addModalMessage, '请填写持有收益；没有收益时填写 0，亏损时填写负数。', 'error');
    return;
  }
  if (amount - profit <= 0) {
    setGlobalMessage(els.addModalMessage, '持有收益不能大于或等于持有金额，否则无法反推有效投入本金。', 'error');
    return;
  }

  const state = readLocalState();
  const existing = parseCodes(state.codes);
  if (!existing.includes(code) && existing.length >= MAX_FUNDS) {
    setGlobalMessage(els.addModalMessage, '基金列表最多保存 12 只，请先删除一只再添加。', 'error');
    return;
  }

  setLoading(els.overlay, els.loadingText, true, `正在读取基金 ${code} 的确认净值`);
  try {
    const quote = await resolveFundQuote(code);
    const codes = existing.includes(code) ? existing : [...existing, code];
    const positions = { ...(state.positions || {}) };
    const basePosition = calculatePosition(amount, profit, quote.nav, positionFor(state, code), { shareBasis: quote.shareBasis, navSource: quote.source });
    positions[code] = applyLiveQuoteToPosition(basePosition, quote.item || {});
    saveAndSync({ codes: codes.join('\n'), positions });
    updateFundMeta([{ ...quote.item, code }]);

    clearAddForm();
    render();
    const shares = num(positions[code].shares, 0);
    const actionText = existing.includes(code) ? '已更新' : '已添加';
    const successText = `${actionText}基金 ${code}，按${quote.source} ${fmt(quote.nav, 4)} 计算持有份额 ${fmt(shares, 2)}；持有金额和持有收益已按盘中估算自动更新，基金代码将同步到 KV。`;
    setGlobalMessage(els.message, successText, 'success');

    if (keepOpen) {
      const reachedLimit = codes.length >= MAX_FUNDS;
      setGlobalMessage(
        els.addModalMessage,
        reachedLimit ? `${successText} 当前已达到 ${MAX_FUNDS} 只基金上限。` : `${successText} 可继续填写下一只基金。`,
        'success'
      );
      requestAnimationFrame(() => els.newCode.focus());
    } else {
      closeAddModal();
    }
    prefetchHistory([code]);
  } catch (error) {
    setGlobalMessage(els.addModalMessage, `添加失败：${error.message}。未取得确认净值时不会生成错误的持有份额。`, 'error');
  } finally {
    setLoading(els.overlay, els.loadingText, false);
  }
}

function normalizeStoredSharePrecision() {
  const state = readLocalState();
  const positions = { ...(state.positions || {}) };
  let changed = false;

  for (const code of parseCodes(state.codes)) {
    const current = positions[code];
    if (!current) continue;
    const shares = num(current.shares, 0);
    if (!(shares > 0)) continue;
    const rounded = roundHalfUp(shares, 2);
    if (shares !== rounded) {
      positions[code] = { ...current, shares: rounded };
      changed = true;
    }
  }

  if (changed) writeLocalState({ positions });
  return changed;
}

async function repairLegacyShareCalculations() {
  const state = readLocalState();
  const codes = parseCodes(state.codes).filter(code => {
    const position = positionFor(state, code);
    return num(position.holdingAmount, 0) > 0
      && num(position.shares, 0) > 0
      && position.shareBasis !== 'confirmed-nav';
  });
  if (!codes.length) return;

  const positions = { ...(state.positions || {}) };
  const repaired = [];
  const failed = [];

  await Promise.all(codes.map(async code => {
    try {
      const quote = await resolveFundQuote(code);
      const previous = positionFor(state, code);
      positions[code] = calculatePosition(
        previous.holdingAmount,
        previous.holdingProfit,
        quote.nav,
        previous,
        { shareBasis: quote.shareBasis, navSource: quote.source }
      );
      repaired.push(code);
    } catch (error) {
      failed.push({ code, message: error.message });
    }
  }));

  if (repaired.length) {
    writeLocalState({ positions });
    render();
    setGlobalMessage(
      els.message,
      `已按上一确认净值自动修正 ${repaired.length} 只基金的持有份额。`,
      'success'
    );
  }
  if (failed.length && !repaired.length) {
    setGlobalMessage(
      els.message,
      `暂时无法修正份额：${failed.map(item => `${item.code}：${item.message}`).join('；')}`,
      'error'
    );
  }
}

function removeFund(code) {
  const state = readLocalState();
  const name = state.fundMeta?.[code]?.name || code;
  if (!window.confirm(`确定删除“${name}”吗？该基金的个人持仓也会一并删除。`)) return;
  const codes = parseCodes(state.codes).filter(item => item !== code);
  const positions = { ...(state.positions || {}) };
  const fundMeta = { ...(state.fundMeta || {}) };
  delete positions[code];
  delete fundMeta[code];
  saveAndSync({ codes: codes.join('\n'), positions, fundMeta });
  render();
  setGlobalMessage(els.message, `已删除基金 ${code}。`, 'success');
}

async function saveAll() {
  const state = readLocalState();
  const codes = parseCodes(state.codes);
  const drafts = collectPositionDraftsFromInputs();
  const positions = { ...(state.positions || {}) };
  const validationErrors = [];
  const targets = [];
  const clearedCodes = [];

  for (const code of codes) {
    if (!dirtyPositionCodes.has(code)) continue;
    const { previous, amount, profit } = drafts[code];
    const amountNumber = Number(amount);
    const profitNumber = Number(profit);

    if (amount === '' && profit === '') {
      positions[code] = calculatePosition('', '', 0, previous);
      clearedCodes.push(code);
      continue;
    }
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      validationErrors.push(`${code}：持有金额必须大于 0`);
      continue;
    }
    if (profit === '' || !Number.isFinite(profitNumber)) {
      validationErrors.push(`${code}：请填写持有收益，没有收益时填写 0`);
      continue;
    }
    if (amountNumber - profitNumber <= 0) {
      validationErrors.push(`${code}：持有收益不能大于或等于持有金额`);
      continue;
    }
    targets.push({ code, previous, amount: amountNumber, profit: profitNumber });
  }

  if (validationErrors.length) {
    setGlobalMessage(els.message, `保存失败：${validationErrors.join('；')}。`, 'error');
    return;
  }
  if (!targets.length && !clearedCodes.length) {
    setGlobalMessage(els.message, '没有检测到需要保存的持仓修改。盘中持有金额和持有收益会自动更新，无需重复点击保存。', 'success');
    return;
  }

  els.saveAll.disabled = true;
  setLoading(els.overlay, els.loadingText, true, `正在保存 ${targets.length + clearedCodes.length} 只基金的持仓基准`);
  try {
    const results = await Promise.all(targets.map(async target => {
      try {
        const quote = await resolveFundQuote(target.code);
        const basePosition = calculatePosition(
          target.amount,
          target.profit,
          quote.nav,
          target.previous,
          { shareBasis: quote.shareBasis, navSource: quote.source }
        );
        return {
          ok: true,
          code: target.code,
          position: applyLiveQuoteToPosition(basePosition, quote.item || {}),
          quote
        };
      } catch (error) {
        return { ok: false, code: target.code, message: error.message };
      }
    }));

    const success = results.filter(item => item.ok);
    const failed = results.filter(item => !item.ok);
    for (const item of success) {
      positions[item.code] = item.position;
      dirtyPositionCodes.delete(item.code);
    }
    for (const code of clearedCodes) dirtyPositionCodes.delete(code);

    writeLocalState({ positions });
    render();

    if (failed.length) {
      setGlobalMessage(
        els.message,
        `已保存 ${success.length + clearedCodes.length} 只基金；${failed.length} 只失败：${failed.map(item => `${item.code}：${item.message}`).join('；')}。失败基金保留待保存状态。`,
        'error'
      );
    } else {
      setGlobalMessage(
        els.message,
        `已保存 ${success.length + clearedCodes.length} 只基金的持仓基准。持有份额保持两位小数，持有金额与持有收益已按盘中估算更新，并会每 60 秒继续自动变化。`,
        'success'
      );
    }
  } finally {
    els.saveAll.disabled = false;
    setLoading(els.overlay, els.loadingText, false);
  }
}

function clearAll() {
  if (!window.confirm('确定清空全部基金和个人持仓吗？此操作无法撤销。')) return;
  saveAndSync({ codes: '', positions: {}, fundMeta: {} });
  render();
  setGlobalMessage(els.message, '已清空基金列表与本机个人持仓；基金代码清空状态将同步到 KV。', 'success');
}

els.openAdd.addEventListener('click', openAddModal);
els.closeAdd.addEventListener('click', closeAddModal);
els.cancelAdd.addEventListener('click', closeAddModal);
els.add.addEventListener('click', () => addFund());
els.addContinue.addEventListener('click', () => addFund({ keepOpen: true }));
els.recognize.addEventListener('click', () => recognizeNames());
els.syncNow.addEventListener('click', retryCloudSync);
els.saveAll.addEventListener('click', saveAll);
els.clearAll.addEventListener('click', clearAll);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !els.addModal.hidden) closeAddModal();
  if (event.key === 'Enter' && !els.addModal.hidden && document.activeElement !== els.add) {
    event.preventDefault();
    addFund();
  }
});

activateCurrentNav();
normalizeStoredSharePrecision();
render();
initializeCloud({ syncStatus: els.sync, message: els.message }).then(async () => {
  render();
  const state = readLocalState();
  const missingNames = parseCodes(state.codes).filter(code => !isUsableFundName(state.fundMeta?.[code]?.name, code));
  if (missingNames.length) await recognizeNames(missingNames, { quiet: true, background: true });
  await repairLegacyShareCalculations();
  await refreshLiveHoldings({ silent: false });
  startLiveHoldingAutoRefresh();
  schedulePagePrefetch('settings');
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastLiveHoldingRefreshAt > 30 * 1000) {
    refreshLiveHoldings({ silent: true });
  }
});
window.addEventListener('focus', () => {
  if (Date.now() - lastLiveHoldingRefreshAt > 30 * 1000) refreshLiveHoldings({ silent: true });
});
