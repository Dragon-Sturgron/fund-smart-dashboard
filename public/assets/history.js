import {
  $, activateCurrentNav, cacheHistory, clamp, escapeHtml, fetchHistoryMany, fmt,
  getCachedHistory, initializeCloud, num, parseCodes, pct, readLocalState,
  schedulePagePrefetch, writeLocalState, setGlobalMessage, updateFundMeta
} from './common.js';

const els = {
  risk: $('#riskLevel'), target: $('#targetReturn'), refresh: $('#refreshBtn'),
  body: $('#historyBody'), mobile: $('#mobileHistoryCards'), message: $('#globalMessage'),
  overlay: $('#loadingOverlay'), loadingText: $('#loadingText'),
  summary: $('#savedFundSummary'), statTotal: $('#statTotal'), statBuy: $('#statBuy'), statWait: $('#statWait'),
  statSell: $('#statSell'), statTime: $('#statTime'), marketStatus: $('#marketStatus'), marketSummary: $('#marketSummary')
};

const riskProfiles = {
  conservative: { label: '保守型', buy: 75, hold: 48, reduce: 50, sell: 70 },
  normal: { label: '普通型', buy: 65, hold: 40, reduce: 55, sell: 75 },
  aggressive: { label: '激进型', buy: 58, hold: 35, reduce: 65, sell: 82 }
};

let currentFunds = [];
let refreshing = false;
let queuedRefresh = false;

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}
function standardDeviation(values) {
  if (values.length < 2) return 0;
  const avg = average(values);
  return Math.sqrt(average(values.map(value => (value - avg) ** 2)));
}
function returnFrom(series, days) {
  if (series.length < 2) return NaN;
  const end = series.at(-1).nav;
  const start = series[Math.max(0, series.length - 1 - days)].nav;
  return start ? (end / start - 1) * 100 : NaN;
}
function getSavedCodes() {
  const state = readLocalState();
  const codes = parseCodes(state.codes);
  const hashCode = location.hash.replace('#', '');
  return /^\d{6}$/.test(hashCode) && !codes.includes(hashCode) ? [hashCode, ...codes].slice(0, 12) : codes;
}
function orderByCodes(items, codes = getSavedCodes()) {
  const order = new Map(codes.map((code, index) => [code, index]));
  return [...items].sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99));
}
function renderSavedSummary() {
  const state = readLocalState();
  const codes = getSavedCodes();
  if (!codes.length) {
    els.summary.innerHTML = '尚未添加基金，请先前往 <a class="text-link" href="/settings.html">设置页</a>。';
    return;
  }
  const names = codes.slice(0, 5).map(code => state.fundMeta?.[code]?.name || code);
  const holdingCount = codes.filter(code => {
    const p = state.positions?.[code] || {};
    return num(p.holdingAmount) > 0 && num(p.shares) > 0;
  }).length;
  els.summary.textContent = `共 ${codes.length} 只基金，已填写 ${holdingCount} 只个人持仓：${names.join('、')}${codes.length > 5 ? ' 等' : ''}`;
}
function loadControls() {
  const state = readLocalState();
  els.risk.value = ['conservative', 'normal', 'aggressive'].includes(state.risk) ? state.risk : 'normal';
  els.target.value = num(state.target, 20);
  renderSavedSummary();
}
function saveControls(extra = {}) {
  return writeLocalState({
    risk: els.risk.value,
    target: Math.max(1, num(els.target.value, 20)),
    ...extra
  });
}
function getPosition(code) {
  const raw = readLocalState().positions?.[code] || {};
  if (raw.holdingAmount !== undefined || raw.shares !== undefined) return raw;
  const principal = num(raw.principal, 0);
  const costNav = num(raw.costNav, 0);
  const shares = principal > 0 && costNav > 0 ? principal / costNav : 0;
  return {
    ...raw,
    holdingAmount: principal || '',
    holdingProfit: principal > 0 ? 0 : '',
    shares: shares || '',
    navAtCalculation: costNav || ''
  };
}
function calculateMetrics(raw) {
  const history = [...raw.history].sort((a, b) => a.date.localeCompare(b.date));
  if (history.length < 2) throw new Error('历史净值数据不足');
  const current = history.at(-1).nav;
  const previous = history.at(-2).nav;
  const dailyChange = previous ? (current / previous - 1) * 100 : 0;
  const last252 = history.slice(-252);
  const last250 = history.slice(-250);
  const max252 = Math.max(...last252.map(item => item.nav));
  const drawdown = max252 ? (max252 - current) / max252 * 100 : 0;
  const ma250 = average(last250.map(item => item.nav));
  const maDeviation = ma250 ? (current / ma250 - 1) * 100 : 0;
  const r20 = returnFrom(history, 20);
  const r60 = returnFrom(history, 60);
  const r120 = returnFrom(history, 120);
  const r250 = returnFrom(history, 250);
  const navs = last252.map(item => item.nav);
  const positionPercentile = navs.length ? navs.filter(value => value <= current).length / navs.length * 100 : 50;
  const dailyReturns = history.slice(-121).map((item, index, array) => index ? item.nav / array[index - 1].nav - 1 : NaN).filter(Number.isFinite);
  const volatility = standardDeviation(dailyReturns) * Math.sqrt(250) * 100;
  let peak = history[0].nav;
  let maxDrawdown = 0;
  for (const item of history.slice(-750)) {
    peak = Math.max(peak, item.nav);
    maxDrawdown = Math.max(maxDrawdown, peak ? (peak - item.nav) / peak * 100 : 0);
  }
  const performanceScore = clamp(50 + num(r250) * 1.2);
  const drawdownControl = clamp(100 - maxDrawdown * 2.2);
  const dataScore = clamp(history.length / 750 * 100);
  const quality = clamp(performanceScore * 0.45 + drawdownControl * 0.35 + dataScore * 0.20);
  return { history, current, previous, dailyChange, drawdown, ma250, maDeviation, r20, r60, r120, r250, positionPercentile, volatility, maxDrawdown, quality };
}
function calculateScores(metrics, position) {
  const V = clamp(metrics.positionPercentile);
  const C = 100 - V;
  const A = clamp(metrics.drawdown * 5);
  const T = clamp(100 + metrics.maDeviation * 5);
  const O = clamp((num(metrics.r20) - 5) * 10);
  const sigmaRisk = clamp(metrics.volatility * 2.3);
  const Q = clamp(metrics.quality);
  const shares = num(position.shares, 0);
  const enteredAmount = num(position.holdingAmount, 0);
  const enteredProfit = num(position.holdingProfit, 0);
  const principal = enteredAmount > 0 ? enteredAmount - enteredProfit : 0;
  const marketValue = shares > 0 ? shares * metrics.current : 0;
  const currentProfit = principal > 0 && marketValue > 0 ? marketValue - principal : enteredProfit;
  const holdingReturn = principal > 0 ? currentProfit / principal * 100 : NaN;
  const target = Math.max(1, num(els.target.value, 20));
  const G = Number.isFinite(holdingReturn) ? clamp(holdingReturn / target * 100) : 0;
  const B = clamp(0.30 * C + 0.15 * A + 0.20 * T + 0.20 * Q + 0.15 * (100 - sigmaRisk) - 0.15 * O);
  // 已移除“计划最高金额”，卖出分改由位置、过热、目标完成度和波动风险共同构成。
  const S = clamp(0.35 * V + 0.25 * O + 0.25 * G + 0.15 * sigmaRisk);
  return {
    V, C, A, T, O, sigmaRisk, Q, G, B, S, shares, principal, marketValue,
    enteredAmount, enteredProfit, currentProfit, holdingReturn,
    hasHolding: shares > 0 && enteredAmount > 0
  };
}
function decideAction(metrics, scores) {
  const profile = riskProfiles[els.risk.value] || riskProfiles.normal;
  const reasons = [];
  if (metrics.r20 > 12) reasons.push(`近20日上涨 ${fmt(metrics.r20)}%，短期偏热`);
  else if (metrics.r20 < -8) reasons.push(`近20日下跌 ${fmt(Math.abs(metrics.r20))}%，仍需确认止跌`);
  else reasons.push(`近20日涨跌 ${pct(metrics.r20)}`);
  if (metrics.maDeviation < -12) reasons.push(`低于年线 ${fmt(Math.abs(metrics.maDeviation))}%`);
  else if (metrics.maDeviation > 8) reasons.push(`高于年线 ${fmt(metrics.maDeviation)}%，追高风险上升`);
  else reasons.push('年线偏离处于可观察区间');
  if (metrics.drawdown >= 15) reasons.push(`距一年高点回撤 ${fmt(metrics.drawdown)}%`);
  if (scores.Q < 40) reasons.push(`历史质量分仅 ${fmt(scores.Q, 0)} 分`);
  if (scores.hasHolding && scores.G >= 100) reasons.push(`持有收益率已达到或超过 ${fmt(Math.max(1, num(els.target.value, 20)), 0)}% 目标`);
  if (!Number.isFinite(metrics.r250)) reasons.push('历史不足一年，结论可信度降低');

  if (scores.Q < 35 || (metrics.maDeviation < -20 && metrics.r60 < -18)) {
    return { key: 'review', tone: 'hold', signal: '重新评估', title: '暂停加仓并重新评估', detail: '趋势或历史表现明显偏弱，先检查基金经理、策略及对应行业逻辑。', reasons };
  }
  if (scores.hasHolding && scores.S >= profile.sell) {
    return { key: 'sell', tone: 'sell', signal: '分批卖出', title: '分批卖出', detail: '建议按约25%分批执行，避免一次性猜最高点。', reasons };
  }
  if (scores.hasHolding && scores.S >= profile.reduce) {
    return { key: 'reduce', tone: 'sell', signal: '分批减仓', title: '分批减仓', detail: '建议先减持10%～25%，分批锁定收益并降低后续波动。', reasons };
  }
  if (!scores.hasHolding && scores.S >= profile.reduce) {
    return { key: 'pause', tone: 'hold', signal: '暂缓买入', title: '暂缓买入', detail: '位置或短期热度偏高，等待回调或信号降温。', reasons };
  }
  if (scores.B < profile.hold) {
    return { key: 'pause', tone: 'hold', signal: '暂缓买入', title: '暂缓买入', detail: '当前买入分较低，不追加新资金，已有仓位继续观察。', reasons };
  }
  if (scores.B < profile.buy) {
    return { key: 'hold', tone: 'hold', signal: '持有/分批', title: '已持有继续持有，新资金分批买', detail: '新资金按正常计划的50%～100%投入，不一次性满仓。', reasons };
  }
  return { key: 'buy', tone: 'buy', signal: '分批买入', title: '分批买入或继续定投', detail: `可按正常定投的${scores.B >= 80 ? '1.25～1.5' : '1～1.25'}倍分批投入，避免一次性追高。`, reasons };
}
function sparkline(history, tone) {
  const values = history.slice(-120).map(item => item.nav).filter(Number.isFinite);
  if (values.length < 2) return '<span class="muted">数据不足</span>';
  const width = 150;
  const height = 52;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1) * width).toFixed(1)},${(height - 4 - (value - min) / range * (height - 8)).toFixed(1)}`).join(' ');
  return `<svg class="sparkline ${tone}" viewBox="0 0 ${width} ${height}" role="img" aria-label="近120个交易日走势"><line class="grid" x1="0" y1="26" x2="150" y2="26"></line><polyline points="${points}"></polyline></svg>`;
}
function renderScore(label, value) {
  return `<div class="score-line"><span>${label}</span><b>${fmt(value, 0)}</b></div><div class="score-bar"><i style="width:${clamp(value)}%"></i></div>`;
}
function buildFund(raw) {
  const metrics = calculateMetrics(raw);
  const position = getPosition(raw.code);
  const scores = calculateScores(metrics, position);
  const action = decideAction(metrics, scores);
  return { ...raw, name: raw.name || `基金 ${raw.code}`, metrics, position, scores, action };
}
function renderResults(errors = []) {
  const tableRows = currentFunds.map(fund => {
    const m = fund.metrics;
    const s = fund.scores;
    const a = fund.action;
    return `<tr>
      <td><span class="signal-pill ${a.tone}">${a.signal}</span></td>
      <td><div class="fund-name">${escapeHtml(fund.name)}</div><div class="fund-code">${fund.code}</div><span class="source-tag">${fund._fromCache ? '本机秒开缓存 · 正式历史净值' : '正式历史净值'}</span></td>
      <td><b>${fmt(m.current, 4)}</b><div class="change ${m.dailyChange > 0 ? 'up' : m.dailyChange < 0 ? 'down' : 'flat'}">${pct(m.dailyChange)}</div></td>
      <td><div class="action-title">${a.title}</div><div class="action-detail">${a.detail}</div></td>
      <td><div class="score-stack">${renderScore('买入 B', s.B)}${renderScore('卖出 S', s.S)}</div></td>
      <td><div class="metric-list"><div><span>20日：</span><b>${pct(m.r20)}</b></div><div><span>60日：</span><b>${pct(m.r60)}</b></div><div><span>一年：</span><b>${pct(m.r250)}</b></div></div></td>
      <td><div class="metric-list"><div><span>年线偏离：</span><b>${pct(m.maDeviation)}</b></div><div><span>一年回撤：</span><b>${fmt(m.drawdown)}%</b></div><div><span>年化波动：</span><b>${fmt(m.volatility)}%</b></div></div></td>
      <td><ul class="reason-list">${a.reasons.slice(0, 4).map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></td>
      <td>${sparkline(m.history, a.tone)}</td>
    </tr>`;
  }).join('');
  const errorRows = errors.map(item => `<tr class="error-row"><td><div class="fund-code">${item.code}</div></td><td colspan="8"><span class="error-text">${escapeHtml(item.message)}</span></td></tr>`).join('');
  els.body.innerHTML = tableRows || errorRows || '<tr><td colspan="9" class="table-empty">请先在“设置”页添加基金代码。</td></tr>';
  if (tableRows && errorRows) els.body.insertAdjacentHTML('beforeend', errorRows);
  els.mobile.innerHTML = currentFunds.map(fund => {
    const m = fund.metrics;
    const s = fund.scores;
    const a = fund.action;
    return `<article class="mobile-fund-card"><div class="mobile-card-head"><div><div class="fund-name">${escapeHtml(fund.name)}</div><div class="fund-code">${fund.code}</div></div><span class="signal-pill ${a.tone}">${a.signal}</span></div>
      <div class="mobile-card-grid"><div class="mobile-metric"><span>最新正式净值</span><b>${fmt(m.current, 4)}</b></div><div class="mobile-metric"><span>买入/卖出分</span><b>${fmt(s.B, 0)} / ${fmt(s.S, 0)}</b></div><div class="mobile-metric"><span>近20日</span><b>${pct(m.r20)}</b></div><div class="mobile-metric"><span>一年回撤</span><b>${fmt(m.drawdown)}%</b></div></div>
      <div class="mobile-action"><b>${a.title}</b><p>${a.detail}</p></div><div class="chart-mobile">${sparkline(m.history, a.tone)}</div></article>`;
  }).join('');
}
function renderSummary() {
  const buy = currentFunds.filter(fund => fund.action.key === 'buy').length;
  const sell = currentFunds.filter(fund => ['reduce', 'sell'].includes(fund.action.key)).length;
  const wait = currentFunds.length - buy - sell;
  els.statTotal.textContent = String(currentFunds.length);
  els.statBuy.textContent = String(buy);
  els.statWait.textContent = String(wait);
  els.statSell.textContent = String(sell);
  els.statTime.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const averageBuy = currentFunds.length ? average(currentFunds.map(fund => fund.scores.B)) : 0;
  const averageSell = currentFunds.length ? average(currentFunds.map(fund => fund.scores.S)) : 0;
  els.marketStatus.className = `market-status ${averageBuy >= 65 ? 'cool' : averageSell >= 60 ? 'hot' : 'neutral'}`;
  els.marketStatus.innerHTML = `<span></span>${averageBuy >= 65 ? '买入机会较多' : averageSell >= 60 ? '减仓风险偏高' : '以观察为主'}`;
  els.marketSummary.textContent = currentFunds.length
    ? `当前平均买入分 ${fmt(averageBuy, 0)}，平均卖出分 ${fmt(averageSell, 0)}。建议每周计算一次，连续两周确认后再执行。`
    : '读取历史净值后，将根据趋势、回撤、波动和个人仓位生成六档操作建议。';
}
function renderAll(errors = []) {
  renderResults(errors);
  renderSummary();
}
function setRefreshBusy(busy) {
  refreshing = busy;
  els.refresh.disabled = busy;
  els.refresh.textContent = busy ? '并行计算中…' : '计算历史信号';
}

async function refreshHistory({ silent = false } = {}) {
  if (refreshing) { queuedRefresh = true; return; }
  const codes = getSavedCodes();
  if (!codes.length) {
    setGlobalMessage(els.message, '尚未添加基金，请先进入设置页添加基金代码。', 'error');
    renderAll();
    return;
  }
  saveControls();
  renderSavedSummary();
  setRefreshBusy(true);
  if (!silent && !currentFunds.length) {
    els.body.innerHTML = `<tr><td colspan="9" class="table-empty">正在并行读取 ${codes.length} 只基金的历史净值……</td></tr>`;
  }
  try {
    const { items, errors } = await fetchHistoryMany(codes);
    if (items.length) {
      cacheHistory(items);
      const fresh = new Map(items.map(item => [item.code, buildFund(item)]));
      const retained = currentFunds.filter(fund => codes.includes(fund.code) && !fresh.has(fund.code));
      currentFunds = orderByCodes([...fresh.values(), ...retained], codes);
      updateFundMeta(items);
    }
    renderAll(errors);
    if (errors.length) setGlobalMessage(els.message, `已并行完成，${items.length} 只成功，${errors.length} 只失败。`, 'error');
    else setGlobalMessage(els.message, `历史信号已并行计算完成，共 ${items.length} 只。`, 'success');
  } finally {
    setRefreshBusy(false);
    if (queuedRefresh) { queuedRefresh = false; queueMicrotask(() => refreshHistory({ silent: true })); }
  }
}

function showCacheImmediately() {
  const codes = getSavedCodes();
  const cached = orderByCodes(getCachedHistory(codes), codes);
  if (!cached.length) return false;
  const valid = [];
  for (const raw of cached) {
    try { valid.push(buildFund(raw)); } catch {}
  }
  if (!valid.length) return false;
  currentFunds = valid;
  renderAll();
  setGlobalMessage(els.message, `已秒开显示 ${valid.length} 只历史分析缓存，正在后台并行校准。`, 'success');
  return true;
}

els.refresh.addEventListener('click', () => refreshHistory());
els.risk.addEventListener('change', () => { saveControls(); if (currentFunds.length) { currentFunds = currentFunds.map(fund => buildFund({ code: fund.code, name: fund.name, history: fund.history, source: fund.source, _fromCache: fund._fromCache, _cachedAt: fund._cachedAt })); renderAll(); } });
els.target.addEventListener('change', () => { saveControls(); if (currentFunds.length) { currentFunds = currentFunds.map(fund => buildFund({ code: fund.code, name: fund.name, history: fund.history, source: fund.source, _fromCache: fund._fromCache, _cachedAt: fund._cachedAt })); renderAll(); } });

activateCurrentNav();
loadControls();
const localSignature = getSavedCodes().join(',');
const hadCache = showCacheImmediately();
if (getSavedCodes().length) refreshHistory({ silent: hadCache });
else renderAll();

// 云端基金代码在后台读取，不阻塞首屏和本机缓存计算。
initializeCloud({ message: els.message }).then(() => {
  loadControls();
  const cloudSignature = getSavedCodes().join(',');
  if (cloudSignature !== localSignature) {
    const cloudHadCache = showCacheImmediately();
    refreshHistory({ silent: cloudHadCache });
  }
});
schedulePagePrefetch('history');
