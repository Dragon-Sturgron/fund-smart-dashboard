const STORAGE_KEY = 'fund-smart-dashboard-v2';
const MAX_FUNDS = 12;

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
export const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
export const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '--';
export const pct = (value, digits = 2) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%` : '--';
export const money = (value) => Number.isFinite(value)
  ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(value)
  : '--';
export const escapeHtml = (text = '') => String(text).replace(/[&<>'"]/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[ch]));

export function parseCodes(value) {
  return [...new Set(String(value || '')
    .split(/[\s,，;；]+/)
    .map(item => item.trim())
    .filter(item => /^\d{6}$/.test(item)))]
    .slice(0, MAX_FUNDS);
}

export function readLocalState() {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (current && typeof current === 'object') return current;
  } catch {}

  // 自动迁移旧版本本地数据。
  for (const oldKey of ['edgeone-fund-dashboard-v1']) {
    try {
      const old = JSON.parse(localStorage.getItem(oldKey) || '{}');
      if (old && typeof old === 'object' && (old.codes || old.positions)) {
        const migrated = { ...old, version: 3 };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch {}
  }
  return {};
}

export function writeLocalState(partial = {}) {
  const state = {
    ...readLocalState(),
    ...partial,
    version: 3,
    localUpdatedAt: new Date().toISOString()
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

export function getFundMeta(code) {
  return readLocalState().fundMeta?.[code] || {};
}

export function updateFundMeta(items = []) {
  const state = readLocalState();
  const fundMeta = { ...(state.fundMeta || {}) };
  for (const item of items) {
    if (!item?.code || !/^\d{6}$/.test(item.code)) continue;
    fundMeta[item.code] = {
      ...(fundMeta[item.code] || {}),
      name: item.name || fundMeta[item.code]?.name || '',
      lastSource: item.source || fundMeta[item.code]?.lastSource || '',
      lastSuccessAt: new Date().toISOString()
    };
  }
  return writeLocalState({ fundMeta });
}

export function setGlobalMessage(element, text = '', tone = '') {
  if (!element) return;
  element.textContent = text;
  element.className = `global-message ${tone}`.trim();
}

export function setLoading(overlay, loadingText, show, text = '请稍候') {
  if (!overlay) return;
  overlay.hidden = !show;
  if (loadingText) loadingText.textContent = text;
}

const NAV_ITEMS = [
  { key: 'realtime', href: '/realtime.html', title: '实时行情页', subtitle: '查看今天涨跌', mark: 'live-mark' },
  { key: 'history', href: '/history.html', title: '历史分析页', subtitle: '计算买卖信号', mark: 'history-mark' },
  { key: 'settings', href: '/settings.html', title: '设置', subtitle: '基金与个人持仓', mark: 'settings-mark' }
];

function ensureTopNavigation() {
  const tabs = $('.page-tabs');
  if (!tabs) return;

  // 修复浏览器或 EdgeOne 边缘缓存混用旧 HTML 与新 CSS 时，
  // 导航只剩两个按钮、第三格显示为空白的问题。
  const currentKeys = $$('[data-nav]', tabs).map(link => link.dataset.nav).join(',');
  const expectedKeys = NAV_ITEMS.map(item => item.key).join(',');
  if (currentKeys !== expectedKeys) {
    tabs.innerHTML = NAV_ITEMS.map(item => `
      <a class="page-tab" data-nav="${item.key}" href="${item.href}" role="tab" aria-selected="false">
        <span class="tab-mark ${item.mark}" aria-hidden="true"></span>
        <span><b>${item.title}</b><small>${item.subtitle}</small></span>
      </a>`).join('');
  }
}

export function activateCurrentNav() {
  ensureTopNavigation();
  const page = document.body.dataset.page;
  $$('[data-nav]').forEach(link => {
    const active = link.dataset.nav === page;
    link.classList.toggle('active', active);
    link.setAttribute('aria-selected', String(active));
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

let cloudSyncEnabled = false;
let cloudSaving = false;
let cloudSaveTimer = null;
let pendingCloudState = null;
let syncElement = null;
let messageElement = null;

function setSyncStatus(text, tone = 'pending') {
  if (!syncElement) return;
  syncElement.className = `sync-status ${tone}`;
  syncElement.innerHTML = `<span></span>${escapeHtml(text)}`;
}

async function requestCloudState(method = 'GET', state) {
  const response = await fetch('/api/config', {
    method,
    headers: {
      Accept: 'application/json',
      ...(state ? { 'Content-Type': 'application/json' } : {})
    },
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

export function queueCloudSave(state = readLocalState()) {
  if (!cloudSyncEnabled) return;
  pendingCloudState = state;
  clearTimeout(cloudSaveTimer);
  setSyncStatus('等待同步到 KV', 'pending');
  cloudSaveTimer = setTimeout(flushCloudSave, 700);
}

export async function flushCloudSave() {
  if (!cloudSyncEnabled || cloudSaving || !pendingCloudState) return;
  cloudSaving = true;
  clearTimeout(cloudSaveTimer);
  while (pendingCloudState) {
    const state = pendingCloudState;
    pendingCloudState = null;
    setSyncStatus('正在保存到 KV', 'saving');
    try {
      const payload = await requestCloudState('PUT', state);
      const time = payload.updatedAt
        ? new Date(payload.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : '';
      setSyncStatus(`KV 已同步${time ? ` · ${time}` : ''}`, 'synced');
    } catch (error) {
      pendingCloudState = state;
      setSyncStatus('KV 同步失败，点击重试', 'error');
      setGlobalMessage(messageElement, error.message || 'KV 同步失败，数据仍已保存在本机。', 'error');
      break;
    }
  }
  cloudSaving = false;
}

export function saveAndSync(partial = {}) {
  const state = writeLocalState(partial);
  queueCloudSave(state);
  return state;
}

export async function initializeCloud({ syncStatus, message } = {}) {
  syncElement = syncStatus || null;
  messageElement = message || null;
  setSyncStatus('正在连接 KV', 'saving');
  try {
    const payload = await requestCloudState('GET');
    cloudSyncEnabled = true;
    if (payload.data) {
      const local = readLocalState();
      // 云端优先，但保留本机可能更新过的新字段。
      const merged = {
        ...local,
        ...payload.data,
        fundMeta: { ...(local.fundMeta || {}), ...(payload.data.fundMeta || {}) },
        positions: { ...(local.positions || {}), ...(payload.data.positions || {}) }
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      const time = payload.updatedAt
        ? new Date(payload.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : '';
      setSyncStatus(`已从 KV 恢复${time ? ` · ${time}` : ''}`, 'synced');
      return merged;
    }
    const local = readLocalState();
    if (parseCodes(local.codes).length || Object.keys(local.positions || {}).length) {
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

export async function retryCloudSync() {
  if (!cloudSyncEnabled) {
    await initializeCloud({ syncStatus: syncElement, message: messageElement });
  }
  pendingCloudState = readLocalState();
  await flushCloudSave();
}

export function loadScript(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const timer = setTimeout(() => finish(new Error('外部数据源响应超时')), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.remove();
      error ? reject(error) : resolve();
    }
    script.async = true;
    script.src = url;
    script.onload = () => finish();
    script.onerror = () => finish(new Error('外部数据源加载失败'));
    document.head.appendChild(script);
  });
}

// fundgz 使用固定 jsonpgz 回调名，必须串行调用，避免多只基金互相覆盖。
let realtimeJsonpQueue = Promise.resolve();
export function fetchRealtimeJsonp(code) {
  const task = () => new Promise((resolve, reject) => {
    const oldCallback = window.jsonpgz;
    let finished = false;
    let script;
    const timer = setTimeout(() => done(new Error('盘中估算接口超时')), 10000);
    function restore() {
      if (oldCallback === undefined) delete window.jsonpgz;
      else window.jsonpgz = oldCallback;
      script?.remove();
      clearTimeout(timer);
    }
    function done(error, data) {
      if (finished) return;
      finished = true;
      restore();
      error ? reject(error) : resolve(data);
    }
    window.jsonpgz = payload => {
      const estimatedNav = num(payload?.gsz, NaN);
      const previousNav = num(payload?.dwjz, NaN);
      done(null, {
        code,
        name: payload?.name || getFundMeta(code).name || `基金 ${code}`,
        previousNav,
        estimatedNav,
        estimatedRate: num(payload?.gszzl, Number.isFinite(estimatedNav) && previousNav ? (estimatedNav / previousNav - 1) * 100 : NaN),
        time: payload?.gztime || payload?.jzrq || '',
        confirmedDate: payload?.jzrq || '',
        source: '浏览器 JSONP · 天天基金盘中估算'
      });
    };
    script = document.createElement('script');
    script.async = true;
    script.src = `https://fundgz.1234567.com.cn/js/${encodeURIComponent(code)}.js?rt=${Date.now()}`;
    script.onerror = () => done(new Error('盘中估算 JSONP 加载失败'));
    document.head.appendChild(script);
  });
  const result = realtimeJsonpQueue.then(task, task);
  realtimeJsonpQueue = result.catch(() => undefined);
  return result;
}

export async function fetchRealtime(code) {
  try {
    return await fetchRealtimeJsonp(code);
  } catch (jsonpError) {
    try {
      const response = await fetch(`/api/realtime/${code}?t=${Date.now()}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.message || `接口返回 ${response.status}`);
      return payload.data;
    } catch (apiError) {
      const error = new Error(`实时数据不可用：${apiError.message || jsonpError.message}`);
      error.details = [jsonpError.message, apiError.message].filter(Boolean);
      throw error;
    }
  }
}

export function fetchHistoryJsonp(code, pageSize = 1000) {
  return new Promise((resolve, reject) => {
    const callback = `__fundHistory_${code}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let script;
    let finished = false;
    const timer = setTimeout(() => done(new Error('历史净值接口超时')), 15000);
    function cleanup() {
      clearTimeout(timer);
      script?.remove();
      try { delete window[callback]; } catch { window[callback] = undefined; }
    }
    function done(error, data) {
      if (finished) return;
      finished = true;
      cleanup();
      error ? reject(error) : resolve(data);
    }
    window[callback] = payload => {
      const rows = (payload?.Data?.LSJZList || []).map(item => ({
        date: item.FSRQ,
        nav: num(item.DWJZ, NaN),
        rate: num(item.JZZZL, NaN)
      })).filter(item => item.date && Number.isFinite(item.nav));
      if (rows.length < 2) return done(new Error('历史净值数据不足'));
      rows.sort((a, b) => a.date.localeCompare(b.date));
      done(null, {
        code,
        name: getFundMeta(code).name || `基金 ${code}`,
        history: rows,
        source: '浏览器 JSONP · 东方财富正式历史净值'
      });
    };
    const query = new URLSearchParams({
      callback,
      fundCode: code,
      pageIndex: '1',
      pageSize: String(pageSize),
      startDate: '',
      endDate: '',
      _: String(Date.now())
    });
    script = document.createElement('script');
    script.async = true;
    script.src = `https://api.fund.eastmoney.com/f10/lsjz?${query.toString()}`;
    script.onerror = () => done(new Error('历史净值 JSONP 加载失败'));
    document.head.appendChild(script);
  });
}

export async function fetchHistory(code) {
  try {
    return await fetchHistoryJsonp(code);
  } catch (jsonpError) {
    try {
      const response = await fetch(`/api/history/${code}?t=${Date.now()}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.message || `接口返回 ${response.status}`);
      return payload.data;
    } catch (apiError) {
      const error = new Error(`历史数据不可用：${apiError.message || jsonpError.message}`);
      error.details = [jsonpError.message, apiError.message].filter(Boolean);
      throw error;
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
