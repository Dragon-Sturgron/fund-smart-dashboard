import {
  $, activateCurrentNav, cacheHistory, cacheRealtime, escapeHtml, fetchHistoryMany,
  fetchFundNamesMany, fetchRealtimeMany, fmt, getCachedRealtime, initializeCloud, isUsableFundName, money, num,
  parseCodes, prefetchHistory, readLocalState, retryCloudSync, saveAndSync,
  schedulePagePrefetch, setGlobalMessage, setLoading, updateFundMeta, writeLocalState
} from './common.js';

const MAX_FUNDS = 12;
const els = {
  newCode: $('#newFundCode'), newAmount: $('#newHoldingAmount'), newProfit: $('#newHoldingProfit'),
  add: $('#addFundsBtn'), sample: $('#sampleBtn'), recognize: $('#recognizeBtn'),
  syncNow: $('#syncNowBtn'), sync: $('#syncStatus'), message: $('#globalMessage'),
  body: $('#settingsBody'), mobile: $('#mobileSettingsCards'), saveAll: $('#saveAllBtn'),
  clearAll: $('#clearAllBtn'), overlay: $('#loadingOverlay'), loadingText: $('#loadingText'),
  statFundCount: $('#statFundCount'), statHoldingCount: $('#statHoldingCount'),
  statHoldingAmount: $('#statHoldingAmount'), statHoldingProfit: $('#statHoldingProfit')
};

function hasInputValue(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function normalizePosition(raw = {}) {
  if (hasInputValue(raw.holdingAmount) || hasInputValue(raw.shares)) {
    return {
      ...raw,
      holdingAmount: raw.holdingAmount ?? '',
      holdingProfit: raw.holdingProfit ?? '',
      shares: raw.shares ?? '',
      navAtCalculation: raw.navAtCalculation ?? ''
    };
  }

  // 兼容旧版“成本净值 + 投入本金”数据，避免升级后直接丢失。
  const principal = num(raw.principal, 0);
  const costNav = num(raw.costNav, 0);
  const shares = principal > 0 && costNav > 0 ? principal / costNav : 0;
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

function calculatePosition(holdingAmount, holdingProfit, nav, previous = {}) {
  const amount = num(holdingAmount, 0);
  const profit = num(holdingProfit, 0);
  const usedNav = num(nav, 0);
  const shares = amount > 0 && usedNav > 0 ? amount / usedNav : 0;
  const principal = amount - profit;
  const costNav = shares > 0 && principal > 0 ? principal / shares : 0;
  return {
    ...previous,
    holdingAmount: amount > 0 ? Number(amount.toFixed(2)) : '',
    holdingProfit: hasInputValue(holdingProfit) ? Number(profit.toFixed(2)) : '',
    shares: shares > 0 ? Number(shares.toFixed(6)) : '',
    navAtCalculation: usedNav > 0 ? Number(usedNav.toFixed(6)) : '',
    principal: principal > 0 ? Number(principal.toFixed(2)) : '',
    costNav: costNav > 0 ? Number(costNav.toFixed(6)) : '',
    calculatedAt: new Date().toISOString()
  };
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
  return `<div class="calculated-share"><b>${fmt(shares, 4)}</b><small>按净值 ${fmt(nav, 4)}</small></div>`;
}

function render() {
  const state = readLocalState();
  const codes = parseCodes(state.codes);
  if (!codes.length) {
    els.body.innerHTML = '<tr><td colspan="6" class="table-empty">尚未添加基金代码。</td></tr>';
    els.mobile.innerHTML = '<div class="empty-mobile-card">在上方填写基金代码、持有金额和持有收益后添加。</div>';
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

function updatePositionFromInput(input) {
  const code = input.dataset.code;
  const key = input.dataset.pos;
  const value = key === 'holdingProfit' ? cleanSignedInput(input.value) : cleanPositiveInput(input.value);
  document.querySelectorAll(`input[data-code="${code}"][data-pos="${key}"]`).forEach(item => {
    if (item !== input) item.value = value;
  });

  const state = readLocalState();
  const positions = { ...(state.positions || {}) };
  const previous = positionFor(state, code);
  const nextRaw = { ...previous, [key]: value };
  const nav = calculationNav(previous);
  positions[code] = calculatePosition(nextRaw.holdingAmount, nextRaw.holdingProfit, nav, nextRaw);
  writeLocalState({ positions });
  render();
}

function bindDynamicEvents() {
  document.querySelectorAll('.position-input').forEach(input => {
    input.addEventListener('change', event => updatePositionFromInput(event.currentTarget));
  });
  document.querySelectorAll('[data-remove]').forEach(button => {
    button.addEventListener('click', () => removeFund(button.dataset.remove));
  });
}

function collectPositionsFromInputs() {
  const state = readLocalState();
  const positions = { ...(state.positions || {}) };
  for (const code of parseCodes(state.codes)) {
    const previous = positionFor(state, code);
    const amountInput = document.querySelector(`input[data-code="${code}"][data-pos="holdingAmount"]`);
    const profitInput = document.querySelector(`input[data-code="${code}"][data-pos="holdingProfit"]`);
    const amount = cleanPositiveInput(amountInput?.value ?? previous.holdingAmount ?? '');
    const profit = cleanSignedInput(profitInput?.value ?? previous.holdingProfit ?? '');
    positions[code] = calculatePosition(amount, profit, calculationNav(previous), previous);
  }
  return positions;
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
  const realtime = await fetchRealtimeMany([code]);
  const live = realtime.items[0];
  if (live) {
    cacheRealtime([live]);
    const nav = num(live.estimatedNav, 0) || num(live.previousNav, 0);
    if (nav > 0) return { nav, item: live, source: live.source || '盘中估算' };
  }

  const cached = getCachedRealtime([code])[0];
  if (cached) {
    const nav = num(cached.estimatedNav, 0) || num(cached.previousNav, 0);
    if (nav > 0) return { nav, item: cached, source: '本机行情缓存' };
  }

  const history = await fetchHistoryMany([code]);
  const item = history.items[0];
  const latest = item?.history?.at(-1);
  if (item && num(latest?.nav, 0) > 0) {
    cacheHistory([item]);
    return { nav: num(latest.nav), item, source: item.source || '最新正式净值' };
  }

  const message = realtime.errors[0]?.message || history.errors[0]?.message || '无法获取可用于计算份额的净值';
  throw new Error(message);
}

async function addFund() {
  const code = String(els.newCode.value || '').trim();
  const amountRaw = els.newAmount.value;
  const profitRaw = els.newProfit.value;
  const amount = Number(amountRaw);
  const profit = Number(profitRaw);

  if (!/^\d{6}$/.test(code)) {
    setGlobalMessage(els.message, '请输入正确的六位基金代码。', 'error');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    setGlobalMessage(els.message, '持有金额必须大于 0。', 'error');
    return;
  }
  if (profitRaw === '' || !Number.isFinite(profit)) {
    setGlobalMessage(els.message, '请填写持有收益；没有收益时填写 0，亏损时填写负数。', 'error');
    return;
  }
  if (amount - profit <= 0) {
    setGlobalMessage(els.message, '持有收益不能大于或等于持有金额，否则无法反推有效投入本金。', 'error');
    return;
  }

  const state = readLocalState();
  const existing = parseCodes(state.codes);
  if (!existing.includes(code) && existing.length >= MAX_FUNDS) {
    setGlobalMessage(els.message, '基金列表最多保存 12 只，请先删除一只再添加。', 'error');
    return;
  }

  setLoading(els.overlay, els.loadingText, true, `正在读取基金 ${code} 的最新净值`);
  try {
    const quote = await resolveFundQuote(code);
    const codes = existing.includes(code) ? existing : [...existing, code];
    const positions = { ...(state.positions || {}) };
    positions[code] = calculatePosition(amount, profit, quote.nav, positionFor(state, code));
    saveAndSync({ codes: codes.join('\n'), positions });
    updateFundMeta([{ ...quote.item, code }]);

    els.newCode.value = '';
    els.newAmount.value = '';
    els.newProfit.value = '';
    render();
    const shares = num(positions[code].shares, 0);
    setGlobalMessage(
      els.message,
      `${existing.includes(code) ? '已更新' : '已添加'}基金 ${code}，按净值 ${fmt(quote.nav, 4)} 计算持有份额 ${fmt(shares, 4)}；基金代码将同步到 KV。`,
      'success'
    );
    prefetchHistory([code]);
  } catch (error) {
    setGlobalMessage(els.message, `添加失败：${error.message}。未取得净值时不会生成错误的持有份额。`, 'error');
  } finally {
    setLoading(els.overlay, els.loadingText, false);
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

function saveAll() {
  const positions = collectPositionsFromInputs();
  writeLocalState({ positions });
  render();
  setGlobalMessage(els.message, '持有金额、持有收益和持有份额已保存到当前浏览器；KV 仅保存基金代码。', 'success');
}

function clearAll() {
  if (!window.confirm('确定清空全部基金和个人持仓吗？此操作无法撤销。')) return;
  saveAndSync({ codes: '', positions: {}, fundMeta: {} });
  render();
  setGlobalMessage(els.message, '已清空基金列表与本机个人持仓；基金代码清空状态将同步到 KV。', 'success');
}

els.add.addEventListener('click', addFund);
els.sample.addEventListener('click', () => {
  els.newCode.value = '005827';
  els.newAmount.value = '10500';
  els.newProfit.value = '500';
});
els.recognize.addEventListener('click', () => recognizeNames());
els.syncNow.addEventListener('click', retryCloudSync);
els.saveAll.addEventListener('click', saveAll);
els.clearAll.addEventListener('click', clearAll);

activateCurrentNav();
render();
initializeCloud({ syncStatus: els.sync, message: els.message }).then(async () => {
  render();
  const state = readLocalState();
  const missingNames = parseCodes(state.codes).filter(code => !isUsableFundName(state.fundMeta?.[code]?.name, code));
  if (missingNames.length) await recognizeNames(missingNames, { quiet: true, background: true });
  schedulePagePrefetch('settings');
});
