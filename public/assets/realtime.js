import {
  $, activateCurrentNav, cacheRealtime, escapeHtml, fetchRealtimeMany, fmt,
  getCachedRealtime, initializeCloud, parseCodes, pct, readLocalState,
  schedulePagePrefetch, setGlobalMessage, updateFundMeta, writeLocalState
} from './common.js';

const els = {
  interval: $('#refreshInterval'), refresh: $('#refreshBtn'), body: $('#realtimeBody'),
  mobile: $('#mobileRealtimeCards'), message: $('#globalMessage'),
  statTotal: $('#statTotal'), statUp: $('#statUp'), statDown: $('#statDown'),
  statTime: $('#statTime'), marketStatus: $('#marketStatus'), marketSummary: $('#marketSummary')
};

let autoTimer = null;
let currentRows = [];
let refreshing = false;
let queuedRefresh = false;

function getSavedCodes() { return parseCodes(readLocalState().codes); }

function loadControls() {
  const state = readLocalState();
  els.interval.value = String([0, 30, 60, 120].includes(Number(state.interval)) ? Number(state.interval) : 60);
}

function saveControls() { return writeLocalState({ interval: Number(els.interval.value) || 0 }); }
function changeClass(value) { return value > 0 ? 'up' : value < 0 ? 'down' : 'flat'; }

function orderByCodes(items, codes = getSavedCodes()) {
  const order = new Map(codes.map((code, index) => [code, index]));
  return [...items].sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99));
}

function sourceText(item) {
  const source = item.source || '盘中参考';
  return item._fromCache ? `本机秒开缓存 · ${source}` : source;
}

function renderTable(errors = []) {
  if (!currentRows.length && !errors.length) {
    els.body.innerHTML = '<tr><td colspan="8" class="table-empty">请先在“设置”页添加基金代码。</td></tr>';
    els.mobile.innerHTML = '<div class="empty-mobile-card">尚未添加基金，前往<a href="/settings.html">设置页</a>添加。</div>';
    return;
  }
  const rows = currentRows.map(item => `
    <tr>
      <td><div class="fund-name">${escapeHtml(item.name)}</div><div class="fund-code">${item.code}</div></td>
      <td><div class="change ${changeClass(item.estimatedRate)}">${pct(item.estimatedRate)}</div></td>
      <td><b>${fmt(item.estimatedNav, 4)}</b><div class="fund-code">估算净值</div></td>
      <td><b>${fmt(item.previousNav, 4)}</b><div class="fund-code">上一确认净值</div></td>
      <td>${escapeHtml(item.time || '--')}</td>
      <td><span class="source-tag">${escapeHtml(sourceText(item))}</span></td>
      <td>${item.estimatedRate >= 2 ? '<span class="signal-pill sell">涨幅偏快</span>' : item.estimatedRate <= -2 ? '<span class="signal-pill buy">跌幅较大</span>' : '<span class="signal-pill hold">正常波动</span>'}</td>
      <td><a class="text-link" href="/history.html#${item.code}">查看历史分析</a></td>
    </tr>`).join('');
  const errorRows = errors.map(item => `<tr class="error-row"><td><div class="fund-code">${item.code}</div></td><td colspan="7"><span class="error-text">${escapeHtml(item.message)}</span></td></tr>`).join('');
  els.body.innerHTML = rows + errorRows;
  els.mobile.innerHTML = currentRows.map(item => `
    <article class="mobile-fund-card">
      <div class="mobile-card-head"><div><div class="fund-name">${escapeHtml(item.name)}</div><div class="fund-code">${item.code}</div></div><div class="change ${changeClass(item.estimatedRate)}">${pct(item.estimatedRate)}</div></div>
      <div class="mobile-card-grid"><div class="mobile-metric"><span>估算净值</span><b>${fmt(item.estimatedNav, 4)}</b></div><div class="mobile-metric"><span>上一净值</span><b>${fmt(item.previousNav, 4)}</b></div><div class="mobile-metric"><span>估算时间</span><b>${escapeHtml(item.time || '--')}</b></div><div class="mobile-metric"><span>状态</span><b>${item.estimatedRate >= 2 ? '涨幅偏快' : item.estimatedRate <= -2 ? '跌幅较大' : '正常波动'}</b></div></div>
      <div class="mobile-action"><b>数据性质</b><p>${escapeHtml(sourceText(item))}</p></div>
      <a class="btn btn-light full-btn" href="/history.html#${item.code}">查看历史分析</a>
    </article>`).join('');
}

function renderSummary() {
  const up = currentRows.filter(item => item.estimatedRate > 0).length;
  const down = currentRows.filter(item => item.estimatedRate < 0).length;
  els.statTotal.textContent = String(currentRows.length);
  els.statUp.textContent = String(up);
  els.statDown.textContent = String(down);
  const latestCacheTime = Math.max(0, ...currentRows.map(item => Number(item._cachedAt) || 0));
  els.statTime.textContent = currentRows.length
    ? new Date(latestCacheTime || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '--:--';
  const average = currentRows.length ? currentRows.reduce((sum, item) => sum + (Number.isFinite(item.estimatedRate) ? item.estimatedRate : 0), 0) / currentRows.length : 0;
  els.marketStatus.className = `market-status ${average > 1 ? 'hot' : average < -1 ? 'cool' : 'neutral'}`;
  els.marketStatus.innerHTML = `<span></span>${currentRows.length ? (average > 1 ? '整体偏强' : average < -1 ? '整体偏弱' : '整体平稳') : '等待加载'}`;
  els.marketSummary.textContent = currentRows.length
    ? `观察列表平均盘中估算为 ${pct(average)}。页面先显示本机缓存，再由 EdgeOne 并行刷新全部基金。`
    : '刷新后将汇总观察列表的盘中估算表现。';
}

function setRefreshBusy(busy) {
  refreshing = busy;
  els.refresh.disabled = busy;
  els.refresh.textContent = busy ? '并行刷新中…' : '刷新实时行情';
}

async function refreshRealtime({ silent = false } = {}) {
  if (refreshing) { queuedRefresh = true; return; }
  const codes = getSavedCodes();
  if (!codes.length) {
    currentRows = [];
    renderTable();
    renderSummary();
    setGlobalMessage(els.message, '尚未添加基金，请先进入设置页添加基金代码。', 'error');
    return;
  }
  setRefreshBusy(true);
  if (!silent && !currentRows.length) {
    els.body.innerHTML = `<tr><td colspan="8" class="table-empty">正在并行读取 ${codes.length} 只基金，结果会一次返回……</td></tr>`;
  }
  try {
    const { items, errors } = await fetchRealtimeMany(codes);
    if (items.length) {
      cacheRealtime(items);
      const fresh = new Map(items.map(item => [item.code, item]));
      const retained = currentRows.filter(item => codes.includes(item.code) && !fresh.has(item.code));
      currentRows = orderByCodes([...items, ...retained], codes);
      updateFundMeta(items);
    }
    renderTable(errors);
    renderSummary();
    if (errors.length) setGlobalMessage(els.message, `已并行完成，${items.length} 只成功，${errors.length} 只失败。`, 'error');
    else setGlobalMessage(els.message, `实时行情已并行更新，共 ${items.length} 只。`, 'success');
  } finally {
    setRefreshBusy(false);
    if (queuedRefresh) { queuedRefresh = false; queueMicrotask(() => refreshRealtime({ silent: true })); }
  }
}

function showCacheImmediately() {
  const codes = getSavedCodes();
  const cached = orderByCodes(getCachedRealtime(codes), codes);
  if (!cached.length) return false;
  currentRows = cached;
  renderTable();
  renderSummary();
  setGlobalMessage(els.message, `已秒开显示 ${cached.length} 只缓存数据，正在后台并行更新。`, 'success');
  return true;
}

function resetAutoTimer() {
  clearInterval(autoTimer);
  const seconds = Number(els.interval.value) || 0;
  if (seconds > 0) autoTimer = setInterval(() => refreshRealtime({ silent: true }), seconds * 1000);
}

els.refresh.addEventListener('click', () => refreshRealtime());
els.interval.addEventListener('change', () => { saveControls(); resetAutoTimer(); });

activateCurrentNav();
loadControls();
resetAutoTimer();
const localSignature = getSavedCodes().join(',');
const hadCache = showCacheImmediately();
if (getSavedCodes().length) refreshRealtime({ silent: hadCache });
else { renderTable(); renderSummary(); }

// KV 读取不再阻塞页面首屏；本机数据先显示，云端基金列表在后台合并。
initializeCloud({ message: els.message }).then(() => {
  const cloudSignature = getSavedCodes().join(',');
  if (cloudSignature !== localSignature) {
    showCacheImmediately();
    refreshRealtime({ silent: true });
  }
});
schedulePagePrefetch('realtime');
