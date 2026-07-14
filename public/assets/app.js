const $ = (selector) => document.querySelector(selector);
const els = {
  codes: $('#fundCodes'), risk: $('#riskLevel'), interval: $('#refreshInterval'), target: $('#targetReturn'),
  refresh: $('#refreshBtn'), sample: $('#sampleBtn'), clear: $('#clearBtn'), exportBtn: $('#exportBtn'), importInput: $('#importInput'),
  message: $('#globalMessage'), overlay: $('#loadingOverlay'), loadingText: $('#loadingText'),
  body: $('#fundTableBody'), mobile: $('#mobileCards'), positions: $('#positionEditor'), marketStatus: $('#marketStatus'), marketSummary: $('#marketSummary'),
  total: $('#statTotal'), buy: $('#statBuy'), wait: $('#statWait'), sell: $('#statSell'), profit: $('#statProfit'), profitText: $('#statProfitText'), time: $('#statTime'), source: $('#statSource'),
  syncStatus: $('#syncStatus'), syncNow: $('#syncNowBtn')
};

const STORAGE_KEY = 'edgeone-fund-dashboard-v1';
const MAX_FUNDS = 12;
let currentFunds = [];
let autoTimer = null;
let cloudSyncEnabled = false;
let cloudSaveTimer = null;
let pendingCloudState = null;
let cloudSaving = false;

const riskProfiles = {
  conservative: { label: '保守型', buy: 75, hold: 48, reduce: 50, sell: 70 },
  normal: { label: '普通型', buy: 65, hold: 40, reduce: 55, sell: 75 },
  aggressive: { label: '激进型', buy: 58, hold: 35, reduce: 65, sell: 82 }
};

function clamp(value, min = 0, max = 100) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0)); }
function num(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function fmt(value, digits = 2) { return Number.isFinite(value) ? value.toFixed(digits) : '--'; }
function pct(value, digits = 2) { return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%` : '--'; }
function money(value) { return Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(value) : '--'; }
function escapeHtml(text = '') { return String(text).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function parseCodes(value) { return [...new Set(String(value).split(/[\s,，;；]+/).map(v => v.trim()).filter(v => /^\d{6}$/.test(v)))].slice(0, MAX_FUNDS); }
function average(values) { const valid = values.filter(Number.isFinite); return valid.length ? valid.reduce((a,b)=>a+b,0)/valid.length : 0; }
function standardDeviation(values) { if (values.length < 2) return 0; const avg = average(values); return Math.sqrt(average(values.map(v => (v - avg) ** 2))); }

function readLocalState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}
function loadState() {
  const state = readLocalState();
  els.codes.value = state.codes || '';
  els.risk.value = ['conservative','normal','aggressive'].includes(state.risk) ? state.risk : 'normal';
  els.interval.value = String([0,30,60,120].includes(Number(state.interval)) ? Number(state.interval) : 60);
  els.target.value = num(state.target, 20);
  return state;
}
function getPositions() { return readLocalState().positions || {}; }
function saveState(extra = {}) {
  const previous = readLocalState();
  const state = {
    ...previous,
    codes: parseCodes(els.codes.value).join('\n'),
    risk: els.risk.value,
    interval: num(els.interval.value),
    target: num(els.target.value, 20),
    ...extra,
    localUpdatedAt: new Date().toISOString()
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  queueCloudSave(state);
  return state;
}
function setMessage(text = '', type = '') { els.message.textContent = text; els.message.className = `global-message ${type}`.trim(); }
function setLoading(show, text = '请稍候') { els.overlay.hidden = !show; els.loadingText.textContent = text; }
function setSyncStatus(text, tone = 'pending') {
  if (!els.syncStatus) return;
  els.syncStatus.className = `sync-status ${tone}`;
  els.syncStatus.innerHTML = `<span></span>${escapeHtml(text)}`;
}
function hasMeaningfulState(state) {
  return Boolean(parseCodes(state?.codes || '').length || Object.keys(state?.positions || {}).length);
}
async function requestCloudState(method = 'GET', state) {
  const response = await fetch('/api/config', {
    method,
    headers: { 'Accept': 'application/json', ...(state ? { 'Content-Type': 'application/json' } : {}) },
    body: state ? JSON.stringify(state) : undefined,
    cache: 'no-store'
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.message || `云端存储请求失败（${response.status}）`);
    error.code = payload.code || '';
    throw error;
  }
  return payload;
}
function queueCloudSave(state = readLocalState()) {
  if (!cloudSyncEnabled) return;
  pendingCloudState = state;
  clearTimeout(cloudSaveTimer);
  setSyncStatus('等待同步到 KV', 'pending');
  cloudSaveTimer = setTimeout(flushCloudSave, 900);
}
async function flushCloudSave() {
  if (!cloudSyncEnabled || cloudSaving || !pendingCloudState) return;
  cloudSaving = true;
  clearTimeout(cloudSaveTimer);
  while (pendingCloudState) {
    const state = pendingCloudState;
    pendingCloudState = null;
    setSyncStatus('正在保存到 KV', 'saving');
    try {
      const payload = await requestCloudState('PUT', state);
      const time = payload.updatedAt ? new Date(payload.updatedAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : '';
      setSyncStatus(`KV 已同步${time ? ` · ${time}` : ''}`, 'synced');
    } catch (error) {
      pendingCloudState = state;
      setSyncStatus('KV 同步失败，点击重试', 'error');
      setMessage(error.message || 'KV 同步失败，数据仍已保存在本机。', 'error');
      break;
    }
  }
  cloudSaving = false;
}
async function initializeCloudState() {
  setSyncStatus('正在连接 KV', 'saving');
  try {
    const payload = await requestCloudState('GET');
    cloudSyncEnabled = true;
    if (payload.data) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload.data));
      loadState();
      const time = payload.updatedAt ? new Date(payload.updatedAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : '';
      setSyncStatus(`已从 KV 恢复${time ? ` · ${time}` : ''}`, 'synced');
      return payload.data;
    }
    const local = readLocalState();
    if (hasMeaningfulState(local)) {
      pendingCloudState = local;
      await flushCloudSave();
    } else {
      setSyncStatus('KV 已连接，等待保存', 'synced');
    }
    return local;
  } catch (error) {
    cloudSyncEnabled = false;
    if (error.code === 'KV_NOT_BOUND') setSyncStatus('KV 未绑定，仅本机保存', 'local');
    else setSyncStatus('KV 暂不可用，仅本机保存', 'error');
    return readLocalState();
  }
}

async function fetchFund(code) {
  const response = await fetch(`/api/fund/${code}?t=${Date.now()}`, { headers: { 'Accept': 'application/json' } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.message || `基金 ${code} 数据加载失败`);
  return payload.data;
}

function normalizeHistory(history = []) {
  return history.map(item => ({ date: item.date, nav: num(item.nav, NaN), rate: num(item.rate, NaN) })).filter(item => Number.isFinite(item.nav)).sort((a,b) => a.date.localeCompare(b.date));
}
function returnFrom(series, days) {
  if (series.length < 2) return NaN;
  const end = series.at(-1).nav;
  const start = series[Math.max(0, series.length - 1 - days)].nav;
  return start ? (end / start - 1) * 100 : NaN;
}
function calculateMetrics(raw) {
  const history = normalizeHistory(raw.history);
  if (history.length < 2) throw new Error('历史净值数据不足');
  const estimateValue = num(raw.estimate?.estimatedNav, NaN);
  const latestNav = history.at(-1).nav;
  const hasIntradayEstimate = Number.isFinite(estimateValue);
  const current = hasIntradayEstimate ? estimateValue : latestNav;
  const previous = num(raw.estimate?.previousNav, history.at(-2).nav);
  const reportedRate = num(raw.estimate?.estimatedRate, NaN);
  const dailyChange = hasIntradayEstimate && previous
    ? (current / previous - 1) * 100
    : Number.isFinite(reportedRate)
      ? reportedRate
      : (history.at(-2).nav ? (latestNav / history.at(-2).nav - 1) * 100 : 0);
  const adjusted = [...history];
  if (Number.isFinite(estimateValue)) adjusted.push({ date: raw.estimate?.time || '盘中', nav: estimateValue, rate: dailyChange });

  const last252 = adjusted.slice(-252);
  const last250 = adjusted.slice(-250);
  const max252 = Math.max(...last252.map(x => x.nav));
  const drawdown = max252 ? (max252 - current) / max252 * 100 : 0;
  const ma250 = average(last250.map(x => x.nav));
  const maDeviation = ma250 ? (current / ma250 - 1) * 100 : 0;
  const r20 = returnFrom(adjusted, 20);
  const r60 = returnFrom(adjusted, 60);
  const r120 = returnFrom(adjusted, 120);
  const r250 = returnFrom(adjusted, 250);
  const navs = last252.map(x => x.nav);
  const positionPercentile = navs.length ? navs.filter(v => v <= current).length / navs.length * 100 : 50;
  const dailyReturns = adjusted.slice(-121).map((item, idx, arr) => idx ? item.nav / arr[idx-1].nav - 1 : NaN).filter(Number.isFinite);
  const volatility = standardDeviation(dailyReturns) * Math.sqrt(250) * 100;
  const maxDrawdown = (() => {
    let peak = adjusted[0].nav, maxDd = 0;
    for (const item of adjusted.slice(-750)) { peak = Math.max(peak, item.nav); maxDd = Math.max(maxDd, peak ? (peak - item.nav) / peak * 100 : 0); }
    return maxDd;
  })();
  const performanceScore = clamp(50 + num(r250) * 1.2);
  const drawdownControl = clamp(100 - maxDrawdown * 2.2);
  const dataScore = clamp(history.length / 750 * 100);
  const quality = clamp(performanceScore * .45 + drawdownControl * .35 + dataScore * .20);
  return { history: adjusted, current, previous, dailyChange, drawdown, ma250, maDeviation, r20, r60, r120, r250, positionPercentile, volatility, maxDrawdown, quality };
}

function getPosition(code) { return getPositions()[code] || { costNav: '', principal: '', planMax: '' }; }
function calculateScores(metrics, position) {
  const V = clamp(metrics.positionPercentile);
  const C = 100 - V;
  const A = clamp(metrics.drawdown * 5);
  const T = clamp(100 + metrics.maDeviation * 5);
  const O = clamp((num(metrics.r20) - 5) * 10);
  const sigmaRisk = clamp(metrics.volatility * 2.3);
  const Q = clamp(metrics.quality);
  const cost = num(position.costNav, 0), principal = num(position.principal, 0), planMax = num(position.planMax, 0);
  const shares = cost > 0 ? principal / cost : 0;
  const marketValue = shares * metrics.current;
  const holdingReturn = principal > 0 ? (marketValue / principal - 1) * 100 : NaN;
  const P = planMax > 0 ? marketValue / planMax : 0;
  const W = clamp((P - 1) * 200);
  const target = Math.max(1, num(els.target.value, 20));
  const G = Number.isFinite(holdingReturn) ? clamp(holdingReturn / target * 100) : 0;
  const B = clamp(.30*C + .15*A + .20*T + .20*Q + .15*(100-sigmaRisk) - .15*O);
  const S = clamp(.30*V + .20*O + .25*W + .15*G + .10*sigmaRisk);
  return { V,C,A,T,O,sigmaRisk,Q,P,W,G,B,S,shares,marketValue,holdingReturn,hasHolding: principal > 0 && cost > 0 };
}

function decideAction(metrics, scores) {
  const p = riskProfiles[els.risk.value] || riskProfiles.normal;
  const reasons = [];
  if (metrics.r20 > 12) reasons.push(`近20日上涨 ${fmt(metrics.r20)}%，短期偏热`);
  else if (metrics.r20 < -8) reasons.push(`近20日下跌 ${fmt(Math.abs(metrics.r20))}%，仍需确认止跌`);
  if (metrics.maDeviation < -12) reasons.push(`低于年线 ${fmt(Math.abs(metrics.maDeviation))}%`);
  else if (metrics.maDeviation > 8) reasons.push(`高于年线 ${fmt(metrics.maDeviation)}%，追高风险上升`);
  else reasons.push('年线偏离处于可观察区间');
  if (metrics.drawdown >= 15) reasons.push(`距一年高点回撤 ${fmt(metrics.drawdown)}%`);
  if (scores.Q < 40) reasons.push(`模型质量分仅 ${fmt(scores.Q,0)} 分`);
  if (scores.W >= 40) reasons.push('当前持仓明显超过计划上限');
  if (!Number.isFinite(metrics.r250)) reasons.push('历史数据不足一年，结论可信度降低');

  if (scores.Q < 35 || (metrics.maDeviation < -20 && metrics.r60 < -18)) {
    return { key: 'review', tone: 'hold', signal: '重新评估', title: '暂停加仓并重新评估', detail: '趋势或历史表现明显偏弱，先检查基金经理、策略及对应行业逻辑。', reasons };
  }
  if (scores.hasHolding && scores.S >= p.sell) {
    return { key: 'sell', tone: 'sell', signal: '分批卖出', title: '分批卖出', detail: '建议按 25% 左右分批执行，避免一次性判断最高点。', reasons };
  }
  if (scores.hasHolding && scores.S >= p.reduce) {
    return { key: 'reduce', tone: 'sell', signal: '分批减仓', title: '分批减仓', detail: '建议先减持 10%～25%，让仓位回到计划比例。', reasons };
  }
  if (!scores.hasHolding && scores.S >= p.reduce) {
    return { key: 'pause', tone: 'hold', signal: '暂缓买入', title: '暂缓买入', detail: '位置或短期热度偏高，等待回调或信号降温。', reasons };
  }
  if (scores.B < p.hold) {
    return { key: 'pause', tone: 'hold', signal: '暂缓买入', title: '暂缓买入', detail: '当前买入分较低，不追加新资金，已有仓位继续观察。', reasons };
  }
  if (scores.B < p.buy) {
    return { key: 'hold', tone: 'hold', signal: '持有/分批', title: '已持有继续持有，新资金分批买', detail: '新资金按正常计划的 50%～100%投入，不一次性满仓。', reasons };
  }
  return { key: 'buy', tone: 'buy', signal: '分批买入', title: '分批买入或继续定投', detail: `可按正常定投的 ${scores.B >= 80 ? '1.25～1.5' : '1～1.25'} 倍分批投入，但不得超过计划上限。`, reasons };
}

function sparklineSvg(history, tone = 'hold') {
  const values = history.slice(-90).map(x => x.nav).filter(Number.isFinite);
  if (values.length < 2) return '<span class="muted">数据不足</span>';
  const width = 130, height = 48, min = Math.min(...values), max = Math.max(...values), range = max-min || 1;
  const points = values.map((v,i) => `${(i/(values.length-1)*width).toFixed(1)},${(height-4-(v-min)/range*(height-8)).toFixed(1)}`).join(' ');
  return `<svg class="sparkline ${tone}" viewBox="0 0 ${width} ${height}" role="img" aria-label="近90个交易日走势"><line class="grid" x1="0" y1="24" x2="130" y2="24"></line><polyline points="${points}"></polyline></svg>`;
}
function renderScore(label, value) { return `<div class="score-line"><span>${label}</span><b>${fmt(value,0)}</b></div><div class="score-bar"><i style="width:${clamp(value)}%"></i></div>`; }

function buildFundView(raw) {
  const metrics = calculateMetrics(raw);
  const position = getPosition(raw.code);
  const scores = calculateScores(metrics, position);
  const action = decideAction(metrics, scores);
  return { ...raw, metrics, position, scores, action };
}

function renderPositionEditor() {
  if (!currentFunds.length) { els.positions.className = 'position-editor empty-state-mini'; els.positions.textContent = '刷新基金数据后，可在这里录入每只基金的持仓。'; return; }
  els.positions.className = 'position-editor';
  els.positions.innerHTML = `<table class="position-table"><thead><tr><th>基金</th><th>成本净值/买入均价</th><th>投入本金（元）</th><th>计划最高金额（元）</th><th>估算市值</th><th>估算收益</th></tr></thead><tbody>${currentFunds.map(f => {
    const p=f.position, s=f.scores;
    return `<tr><td>${escapeHtml(f.name)}<div class="fund-code">${f.code}</div></td><td><input data-pos="costNav" data-code="${f.code}" type="number" step="0.0001" min="0" value="${escapeHtml(p.costNav)}" placeholder="例如 1.2345"></td><td><input data-pos="principal" data-code="${f.code}" type="number" step="0.01" min="0" value="${escapeHtml(p.principal)}" placeholder="例如 10000"></td><td><input data-pos="planMax" data-code="${f.code}" type="number" step="0.01" min="0" value="${escapeHtml(p.planMax)}" placeholder="例如 15000"></td><td>${s.hasHolding ? money(s.marketValue) : '--'}</td><td class="${s.holdingReturn >= 0 ? 'error-text' : ''}">${Number.isFinite(s.holdingReturn) ? pct(s.holdingReturn) : '--'}<div class="position-tip">失焦后自动保存并重算</div></td></tr>`;
  }).join('')}</tbody></table>`;
  els.positions.querySelectorAll('input[data-pos]').forEach(input => input.addEventListener('change', onPositionChange));
}
function onPositionChange(event) {
  const code = event.target.dataset.code, field = event.target.dataset.pos;
  const positions = { ...getPositions() };
  positions[code] = { ...(positions[code] || {}), [field]: event.target.value };
  saveState({ positions });
  currentFunds = currentFunds.map(f => buildFundView({ code:f.code, name:f.name, estimate:f.estimate, history:f.history, source:f.source }));
  renderAll(); setMessage('持仓已保存，并将自动同步到 KV。', 'success');
}

function tableRow(f) {
  const m=f.metrics,s=f.scores,a=f.action;
  return `<tr>
    <td><span class="signal-pill ${a.tone}">${a.signal}</span></td>
    <td><div class="fund-name">${escapeHtml(f.name)}</div><div class="fund-code">${f.code}</div><span class="source-tag">${f.estimate?.time ? '盘中估算' : '最新净值'}</span></td>
    <td><div class="change ${m.dailyChange>0?'up':m.dailyChange<0?'down':'flat'}">${pct(m.dailyChange)}</div><div class="nav-value">${fmt(m.current,4)}</div></td>
    <td><div class="action-title">${a.title}</div><div class="action-detail">${a.detail}</div></td>
    <td><div class="score-stack">${renderScore('买入 B',s.B)}${renderScore('卖出 S',s.S)}</div></td>
    <td><div class="metric-list"><div><span>20日：</span><b>${pct(m.r20)}</b></div><div><span>60日：</span><b>${pct(m.r60)}</b></div><div><span>一年：</span><b>${pct(m.r250)}</b></div></div></td>
    <td><div class="metric-list"><div><span>年线偏离：</span><b>${pct(m.maDeviation)}</b></div><div><span>一年回撤：</span><b>${fmt(m.drawdown)}%</b></div><div><span>年化波动：</span><b>${fmt(m.volatility)}%</b></div></div></td>
    <td><ul class="reason-list">${a.reasons.slice(0,4).map(r=>`<li>${escapeHtml(r)}</li>`).join('')}</ul></td>
    <td>${sparklineSvg(m.history,a.tone)}</td>
  </tr>`;
}
function mobileCard(f) {
  const m=f.metrics,s=f.scores,a=f.action;
  return `<article class="mobile-fund-card"><div class="mobile-card-head"><div><div class="fund-name">${escapeHtml(f.name)}</div><div class="fund-code">${f.code}</div></div><div><span class="signal-pill ${a.tone}">${a.signal}</span><div class="change ${m.dailyChange>0?'up':m.dailyChange<0?'down':'flat'}">${pct(m.dailyChange)}</div></div></div>
  <div class="mobile-card-grid"><div class="mobile-metric"><span>当前估算净值</span><b>${fmt(m.current,4)}</b></div><div class="mobile-metric"><span>买入 / 卖出分</span><b>${fmt(s.B,0)} / ${fmt(s.S,0)}</b></div><div class="mobile-metric"><span>近20日</span><b>${pct(m.r20)}</b></div><div class="mobile-metric"><span>一年回撤</span><b>${fmt(m.drawdown)}%</b></div></div>
  <div class="mobile-action"><b>${a.title}</b><p>${a.detail}</p></div><div style="margin-top:12px">${sparklineSvg(m.history,a.tone)}</div></article>`;
}
function renderSummary() {
  const buy = currentFunds.filter(f=>f.action.key==='buy').length;
  const sell = currentFunds.filter(f=>['reduce','sell'].includes(f.action.key)).length;
  const wait = currentFunds.length - buy - sell;
  const totalValue = currentFunds.reduce((sum,f)=>sum+(f.scores.hasHolding?f.scores.marketValue:0),0);
  const totalPrincipal = currentFunds.reduce((sum,f)=>sum+(f.scores.hasHolding?num(f.position.principal):0),0);
  els.total.textContent = currentFunds.length; els.buy.textContent = buy; els.wait.textContent = wait; els.sell.textContent = sell;
  if (totalPrincipal > 0) { const profit=totalValue-totalPrincipal; els.profit.textContent=money(profit); els.profit.style.color=profit>=0?'var(--red)':'var(--green)'; els.profitText.textContent=`估算市值 ${money(totalValue)}`; }
  else { els.profit.textContent='--'; els.profit.style.color=''; els.profitText.textContent='填写持仓后显示'; }
  const avgR20=average(currentFunds.map(f=>f.metrics.r20)), avgO=average(currentFunds.map(f=>f.scores.O));
  let cls='neutral',label='震荡观察',summary='信息分歧较大，按周观察并等待连续信号。';
  if (currentFunds.length) {
    if (avgO>=65 || avgR20>=10) { cls='hot';label='情绪偏热';summary='观察列表近期上涨较快，不宜一次性追入；已有持仓优先检查仓位是否超配。'; }
    else if (buy >= Math.max(1, currentFunds.length/2)) { cls='cool';label='分批区间';summary='多数基金买入分达到当前风险档位，但仍建议分批执行并设置计划仓位上限。'; }
    else if (avgR20>3) { cls='warm';label='继续走强';summary='短期趋势仍偏强，但买点可能不够舒适，新资金应降低单次投入比例。'; }
  }
  els.marketStatus.className=`market-status ${cls}`; els.marketStatus.innerHTML=`<span></span>${label}`; els.marketSummary.textContent=summary;
}
function renderAll() {
  if (!currentFunds.length) { els.body.innerHTML='<tr><td colspan="9" class="table-empty">输入基金代码后点击“刷新数据”。</td></tr>'; els.mobile.innerHTML=''; }
  else { els.body.innerHTML=currentFunds.map(tableRow).join(''); els.mobile.innerHTML=currentFunds.map(mobileCard).join(''); }
  renderPositionEditor(); renderSummary();
}

async function refreshFunds({silent=false}={}) {
  const codes = parseCodes(els.codes.value);
  if (!codes.length) { setMessage('请输入至少一个正确的六位基金代码。','error'); return; }
  els.codes.value = codes.join('\n'); saveState(); if(!silent)setLoading(true,`准备查询 ${codes.length} 只基金`); setMessage('');
  const results=[]; let completed=0;
  const settled = await Promise.allSettled(codes.map(async code => { const data=await fetchFund(code); completed++; if(!silent)els.loadingText.textContent=`已完成 ${completed}/${codes.length}：${code}`; return data; }));
  const errors=[];
  settled.forEach((r,i)=>{ if(r.status==='fulfilled'){ try{results.push(buildFundView(r.value));}catch(e){errors.push(`${codes[i]}：${e.message}`);} } else errors.push(`${codes[i]}：${r.reason?.message||'加载失败'}`); });
  currentFunds=results; renderAll(); const now=new Date(); els.time.textContent=now.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); els.source.textContent=results.length?'实时估算 + 历史净值':'未获取到数据';
  if(errors.length)setMessage(`部分基金加载失败：${errors.join('；')}`,'error'); else setMessage(`已更新 ${results.length} 只基金。建议连续两周处于同一档位再执行操作。`,'success');
  setLoading(false); setupAutoRefresh();
}
function setupAutoRefresh() { clearInterval(autoTimer); const seconds=num(els.interval.value); if(seconds>0&&parseCodes(els.codes.value).length)autoTimer=setInterval(()=>refreshFunds({silent:true}),seconds*1000); }
function clearAll() { currentFunds=[]; els.codes.value=''; saveState({positions:{}}); renderAll(); els.time.textContent='--:--'; els.source.textContent='等待数据'; setMessage('已清空基金列表和持仓配置。','success'); }
function exportConfig() { const state=saveState(); const blob=new Blob([JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url;a.download=`基金决策台配置-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url); }
async function importConfig(file) { try { const data=JSON.parse(await file.text()); localStorage.setItem(STORAGE_KEY,JSON.stringify(data)); loadState(); saveState(); setMessage('配置已导入，并将自动同步到 KV。','success'); if(parseCodes(els.codes.value).length)refreshFunds(); } catch { setMessage('配置文件格式不正确。','error'); } finally { els.importInput.value=''; } }

els.refresh.addEventListener('click',()=>refreshFunds());
els.sample.addEventListener('click',()=>{ els.codes.value='000001\n110022\n161725'; saveState(); setMessage('已填入示例代码，仅用于演示页面，不代表推荐。'); });
els.clear.addEventListener('click',clearAll); els.exportBtn.addEventListener('click',exportConfig); els.importInput.addEventListener('change',e=>e.target.files[0]&&importConfig(e.target.files[0]));
els.syncNow?.addEventListener('click', async () => {
  if (!cloudSyncEnabled) {
    await initializeCloudState();
    if (!cloudSyncEnabled) return setMessage('请先在 EdgeOne 项目中绑定变量名为 FUND_KV 的 KV 命名空间。', 'error');
  }
  pendingCloudState = readLocalState();
  await flushCloudSave();
});
[els.codes,els.risk,els.interval,els.target].forEach(el=>el.addEventListener('change',()=>{saveState();setupAutoRefresh();if(currentFunds.length&&[els.risk,els.target].includes(el)){currentFunds=currentFunds.map(f=>buildFundView({code:f.code,name:f.name,estimate:f.estimate,history:f.history,source:f.source}));renderAll();}}));

async function initializeApp() {
  loadState();
  renderAll();
  await initializeCloudState();
  const initial = loadState();
  renderAll();
  setupAutoRefresh();
  if (parseCodes(els.codes.value).length && initial.autoLoad !== false) refreshFunds({silent:false});
}
initializeApp();
