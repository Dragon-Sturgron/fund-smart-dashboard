import {
  $, activateCurrentNav, escapeHtml, fetchRealtime, fmt, initializeCloud,
  parseCodes, pct, readLocalState, retryCloudSync, saveAndSync,
  setGlobalMessage, setLoading, updateFundMeta
} from './common.js';

const els = {
  codes: $('#fundCodes'), interval: $('#refreshInterval'), refresh: $('#refreshBtn'), sample: $('#sampleBtn'),
  clear: $('#clearBtn'), body: $('#realtimeBody'), mobile: $('#mobileRealtimeCards'), message: $('#globalMessage'),
  overlay: $('#loadingOverlay'), loadingText: $('#loadingText'), sync: $('#syncStatus'), syncNow: $('#syncNowBtn'),
  statTotal: $('#statTotal'), statUp: $('#statUp'), statDown: $('#statDown'), statTime: $('#statTime'),
  marketStatus: $('#marketStatus'), marketSummary: $('#marketSummary')
};

let autoTimer = null;
let currentRows = [];

function loadControls() {
  const state = readLocalState();
  els.codes.value = state.codes || '';
  els.interval.value = String([0, 30, 60, 120].includes(Number(state.interval)) ? Number(state.interval) : 60);
}

function saveControls() {
  return saveAndSync({
    codes: parseCodes(els.codes.value).join('\n'),
    interval: Number(els.interval.value) || 0
  });
}

function changeClass(value) {
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

function renderTable(errors = []) {
  if (!currentRows.length && !errors.length) {
    els.body.innerHTML = '<tr><td colspan="8" class="table-empty">输入基金代码后点击“刷新实时行情”。</td></tr>';
    els.mobile.innerHTML = '';
    return;
  }
  const rows = currentRows.map(item => `
    <tr>
      <td><div class="fund-name">${escapeHtml(item.name)}</div><div class="fund-code">${item.code}</div></td>
      <td><div class="change ${changeClass(item.estimatedRate)}">${pct(item.estimatedRate)}</div></td>
      <td><b>${fmt(item.estimatedNav, 4)}</b><div class="fund-code">估算净值</div></td>
      <td><b>${fmt(item.previousNav, 4)}</b><div class="fund-code">上一确认净值</div></td>
      <td>${escapeHtml(item.time || '--')}</td>
      <td><span class="source-tag">${escapeHtml(item.source || '盘中参考')}</span></td>
      <td>${item.estimatedRate >= 2 ? '<span class="signal-pill sell">涨幅偏快</span>' : item.estimatedRate <= -2 ? '<span class="signal-pill buy">跌幅较大</span>' : '<span class="signal-pill hold">正常波动</span>'}</td>
      <td><a class="text-link" href="/history.html#${item.code}">查看历史分析</a></td>
    </tr>`).join('');
  const errorRows = errors.map(item => `<tr class="error-row"><td><div class="fund-code">${item.code}</div></td><td colspan="7"><span class="error-text">${escapeHtml(item.message)}</span></td></tr>`).join('');
  els.body.innerHTML = rows + errorRows;
  els.mobile.innerHTML = currentRows.map(item => `
    <article class="mobile-fund-card">
      <div class="mobile-card-head"><div><div class="fund-name">${escapeHtml(item.name)}</div><div class="fund-code">${item.code}</div></div><div class="change ${changeClass(item.estimatedRate)}">${pct(item.estimatedRate)}</div></div>
      <div class="mobile-card-grid"><div class="mobile-metric"><span>估算净值</span><b>${fmt(item.estimatedNav, 4)}</b></div><div class="mobile-metric"><span>上一净值</span><b>${fmt(item.previousNav, 4)}</b></div><div class="mobile-metric"><span>估算时间</span><b>${escapeHtml(item.time || '--')}</b></div><div class="mobile-metric"><span>状态</span><b>${item.estimatedRate >= 2 ? '涨幅偏快' : item.estimatedRate <= -2 ? '跌幅较大' : '正常波动'}</b></div></div>
      <div class="mobile-action"><b>数据性质</b><p>${escapeHtml(item.source || '盘中估算，仅供参考')}</p></div>
      <a class="btn btn-light full-btn" href="/history.html#${item.code}">查看历史分析</a>
    </article>`).join('');
}

function renderSummary() {
  const up = currentRows.filter(item => item.estimatedRate > 0).length;
  const down = currentRows.filter(item => item.estimatedRate < 0).length;
  els.statTotal.textContent = String(currentRows.length);
  els.statUp.textContent = String(up);
  els.statDown.textContent = String(down);
  els.statTime.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const average = currentRows.length ? currentRows.reduce((sum, item) => sum + (Number.isFinite(item.estimatedRate) ? item.estimatedRate : 0), 0) / currentRows.length : 0;
  els.marketStatus.className = `market-status ${average > 1 ? 'hot' : average < -1 ? 'cool' : 'neutral'}`;
  els.marketStatus.innerHTML = `<span></span>${average > 1 ? '整体偏强' : average < -1 ? '整体偏弱' : '整体平稳'}`;
  els.marketSummary.textContent = currentRows.length
    ? `观察列表平均盘中估算为 ${pct(average)}。实时页只反映当日盘中参考，不直接决定买卖；买卖判断请进入历史分析页。`
    : '刷新后将汇总观察列表的盘中估算表现。';
}

async function refreshRealtime({ silent = false } = {}) {
  const codes = parseCodes(els.codes.value);
  if (!codes.length) {
    setGlobalMessage(els.message, '请先输入至少一个六位基金代码。', 'error');
    return;
  }
  saveControls();
  if (!silent) setLoading(els.overlay, els.loadingText, true, `准备读取 ${codes.length} 只基金`);
  const rows = [];
  const errors = [];
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (!silent) els.loadingText.textContent = `正在读取 ${index + 1}/${codes.length}：${code}`;
    try {
      rows.push(await fetchRealtime(code));
    } catch (error) {
      errors.push({ code, message: error.message || '加载失败' });
    }
  }
  currentRows = rows;
  updateFundMeta(rows);
  saveAndSync({ fundMeta: readLocalState().fundMeta });
  renderTable(errors);
  renderSummary();
  if (errors.length) {
    setGlobalMessage(els.message, `部分基金加载失败：${errors.map(item => `${item.code}：${item.message}`).join('；')}`, 'error');
  } else {
    setGlobalMessage(els.message, `实时行情已更新，共 ${rows.length} 只。`, 'success');
  }
  setLoading(els.overlay, els.loadingText, false);
}

function resetAutoTimer() {
  clearInterval(autoTimer);
  const seconds = Number(els.interval.value) || 0;
  if (seconds > 0) autoTimer = setInterval(() => refreshRealtime({ silent: true }), seconds * 1000);
}

els.refresh.addEventListener('click', () => refreshRealtime());
els.sample.addEventListener('click', () => { els.codes.value = '005827\n000001\n110022'; saveControls(); refreshRealtime(); });
els.clear.addEventListener('click', () => { els.codes.value = ''; currentRows = []; saveControls(); renderTable(); renderSummary(); setGlobalMessage(els.message, '已清空观察列表。', 'success'); });
els.interval.addEventListener('change', () => { saveControls(); resetAutoTimer(); });
els.codes.addEventListener('change', saveControls);
els.syncNow.addEventListener('click', retryCloudSync);

activateCurrentNav();
await initializeCloud({ syncStatus: els.sync, message: els.message });
loadControls();
resetAutoTimer();
if (parseCodes(els.codes.value).length) refreshRealtime();
