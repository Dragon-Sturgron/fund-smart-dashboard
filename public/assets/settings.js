import {
  $, activateCurrentNav, cacheRealtime, escapeHtml,
  fetchFundNamesMany, fetchRealtimeMany, fmt, initializeCloud, isUsableFundName, money, num,
  parseCodes, prefetchHistory, readLocalState, retryCloudSync, saveAndSync,
  schedulePagePrefetch, setGlobalMessage, setLoading, updateFundMeta, writeLocalState
} from './common.js';

const MAX_FUNDS = 12;
const els = {
  newCode: $('#newFundCode'), newAmount: $('#newHoldingAmount'), newProfit: $('#newHoldingProfit'), newShares: $('#newHoldingShares'),
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
  els.newShares.value = '';
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

function calculatePosition(holdingAmount, holdingProfit, sharesValue, previous = {}) {
  const amount = num(holdingAmount, 0);
  const profit = num(holdingProfit, 0);
  const shares = roundHalfUp(num(sharesValue, 0), 2);
  const principal = amount - profit;
  const costNav = shares > 0 && principal > 0 ? principal / shares : 0;
  return {
    ...previous,
    holdingAmount: amount > 0 ? roundHalfUp(amount, 2) : '',
    holdingProfit: hasInputValue(holdingProfit) ? roundHalfUp(profit, 2) : '',
    shares: shares > 0 ? shares : '',
    principal: principal > 0 ? roundHalfUp(principal, 2) : '',
    costNav: costNav > 0 ? Number(costNav.toFixed(6)) : '',
    calculatedAt: new Date().toISOString(),
    shareBasis: shares > 0 ? 'manual-shares' : '',
    navSource: shares > 0 ? '用户填写实际份额' : ''
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
  if (amount > 0 && shares > 0 && hasInputValue(position.holdingProfit)) return { label: '真实份额已保存', tone: 'buy' };
  if (amount > 0) return { label: '待填写实际份额', tone: 'hold' };
  return { label: '未填写', tone: 'hold' };
}

function inputMarkup(code, key, value, placeholder, { signed = false } = {}) {
  const min = signed ? '' : ' min="0"';
  return `<input class="position-input" data-code="${code}" data-pos="${key}" type="number"${min} step="0.01" value="${escapeHtml(value ?? '')}" placeholder="${placeholder}">`;
}

function shareMarkup(code, position) {
  const shares = num(position.shares, 0);
  const value = shares > 0 ? roundHalfUp(shares, 2).toFixed(2) : '';
  const quoteNote = num(position.liveNav, 0) > 0
    ? `盘中金额按${escapeHtml(position.liveSource || '参考净值')} ${fmt(position.liveNav, 4)} 更新`
    : '请填写购买平台显示的实际份额';
  return `<div class="editable-share">
    ${inputMarkup(code, 'shares', value, '例如 47.78')}
    <small>${quoteNote}；份额不会被行情覆盖</small>
  </div>`;
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
        <td>${shareMarkup(code, position)}</td>
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
          <div class="mobile-calculated-field"><span>持有份额</span>${shareMarkup(code, position)}</div>
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
    // 表格与手机卡片互相同步输入值。实际份额由用户直接填写，保存后固定不变。
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
    const sharesInput = document.querySelector(`input[data-code="${code}"][data-pos="shares"]`);
    drafts[code] = {
      previous,
      amount: cleanPositiveInput(amountInput?.value ?? previous.holdingAmount ?? ''),
      profit: cleanSignedInput(profitInput?.value ?? previous.holdingProfit ?? ''),
      shares: cleanPositiveInput(sharesInput?.value ?? previous.shares ?? '')
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

async function addFund({ keepOpen = false } = {}) {
  const code = String(els.newCode.value || '').trim();
  const amountRaw = els.newAmount.value;
  const profitRaw = els.newProfit.value;
  const sharesRaw = els.newShares.value;
  const amount = Number(amountRaw);
  const profit = Number(profitRaw);
  const shares = Number(sharesRaw);

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
  if (!Number.isFinite(shares) || shares <= 0) {
    setGlobalMessage(els.addModalMessage, '请填写基金购买平台显示的实际持有份额。', 'error');
    return;
  }
  if (amount - profit <= 0) {
    setGlobalMessage(els.addModalMessage, '持有收益不能大于或等于持有金额，否则无法得到有效投入本金。', 'error');
    return;
  }

  const state = readLocalState();
  const existing = parseCodes(state.codes);
  if (!existing.includes(code) && existing.length >= MAX_FUNDS) {
    setGlobalMessage(els.addModalMessage, '基金列表最多保存 12 只，请先删除一只再添加。', 'error');
    return;
  }

  setLoading(els.overlay, els.loadingText, true, `正在保存基金 ${code} 的实际持有份额`);
  try {
    const codes = existing.includes(code) ? existing : [...existing, code];
    const positions = { ...(state.positions || {}) };
    positions[code] = calculatePosition(amount, profit, shares, positionFor(state, code));

    try {
      const realtime = await fetchRealtimeMany([code]);
      const item = realtime.items[0];
      if (item) {
        cacheRealtime([item]);
        updateFundMeta([item]);
        positions[code] = applyLiveQuoteToPosition(positions[code], item);
      }
    } catch {
      // 行情失败不影响基金和实际份额保存。
    }

    saveAndSync({ codes: codes.join('\n'), positions });
    clearAddForm();
    render();

    const savedShares = num(positions[code].shares, 0);
    const actionText = existing.includes(code) ? '已更新' : '已添加';
    const successText = `${actionText}基金 ${code}，实际持有份额已固定为 ${fmt(savedShares, 2)}；后续行情只更新持有金额和持有收益。`;
    setGlobalMessage(els.message, successText, 'success');

    if (keepOpen) {
      const reachedLimit = codes.length >= MAX_FUNDS;
      setGlobalMessage(els.addModalMessage, reachedLimit ? `${successText} 当前已达到 ${MAX_FUNDS} 只基金上限。` : `${successText} 可继续填写下一只基金。`, 'success');
      requestAnimationFrame(() => els.newCode.focus());
    } else {
      closeAddModal();
    }

    recognizeNames([code], { quiet: true, background: true });
    prefetchHistory([code]);
  } catch (error) {
    setGlobalMessage(els.addModalMessage, `添加失败：${error.message}`, 'error');
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
  const savedCodes = [];
  const clearedCodes = [];

  for (const code of codes) {
    if (!dirtyPositionCodes.has(code)) continue;
    const { previous, amount, profit, shares } = drafts[code];
    const amountNumber = Number(amount);
    const profitNumber = Number(profit);
    const sharesNumber = Number(shares);

    if (amount === '' && profit === '' && shares === '') {
      positions[code] = calculatePosition('', '', '', previous);
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
    if (!Number.isFinite(sharesNumber) || sharesNumber <= 0) {
      validationErrors.push(`${code}：请填写购买平台显示的实际持有份额`);
      continue;
    }
    if (amountNumber - profitNumber <= 0) {
      validationErrors.push(`${code}：持有收益不能大于或等于持有金额`);
      continue;
    }

    positions[code] = calculatePosition(amountNumber, profitNumber, sharesNumber, previous);
    savedCodes.push(code);
  }

  if (validationErrors.length) {
    setGlobalMessage(els.message, `保存失败：${validationErrors.join('；')}。`, 'error');
    return;
  }
  if (!savedCodes.length && !clearedCodes.length) {
    setGlobalMessage(els.message, '没有检测到需要保存的修改。', 'success');
    return;
  }

  els.saveAll.disabled = true;
  setLoading(els.overlay, els.loadingText, true, `正在保存 ${savedCodes.length + clearedCodes.length} 只基金的实际份额`);
  try {
    for (const code of [...savedCodes, ...clearedCodes]) dirtyPositionCodes.delete(code);
    writeLocalState({ positions });
    render();

    if (savedCodes.length) {
      await refreshLiveHoldings({ silent: true, codes: savedCodes });
    }

    setGlobalMessage(els.message, `已保存 ${savedCodes.length + clearedCodes.length} 只基金。实际持有份额已固定为你填写的数值；持有金额和持有收益已按最新行情重新计算。`, 'success');
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
