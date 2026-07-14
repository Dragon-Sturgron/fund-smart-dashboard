import {
  $, activateCurrentNav, cacheRealtime, escapeHtml, fetchRealtimeMany, initializeCloud,
  money, num, parseCodes, prefetchHistory, readLocalState, retryCloudSync,
  saveAndSync, schedulePagePrefetch, setGlobalMessage, setLoading, updateFundMeta,
  writeLocalState
} from './common.js';

const MAX_FUNDS = 12;
const els = {
  newCodes: $('#newFundCodes'), add: $('#addFundsBtn'), sample: $('#sampleBtn'),
  recognize: $('#recognizeBtn'), syncNow: $('#syncNowBtn'), sync: $('#syncStatus'),
  message: $('#globalMessage'), body: $('#settingsBody'), mobile: $('#mobileSettingsCards'),
  saveAll: $('#saveAllBtn'), clearAll: $('#clearAllBtn'), overlay: $('#loadingOverlay'),
  loadingText: $('#loadingText'), statFundCount: $('#statFundCount'),
  statHoldingCount: $('#statHoldingCount'), statPrincipal: $('#statPrincipal'),
  statMissingCount: $('#statMissingCount')
};

function positionFor(state, code) {
  return state.positions?.[code] || { costNav: '', principal: '', planMax: '' };
}

function cleanNumberInput(value) {
  const parsed = Number(value);
  return value === '' || !Number.isFinite(parsed) || parsed < 0 ? '' : String(value);
}

function holdingStatus(position) {
  const cost = num(position.costNav, 0);
  const principal = num(position.principal, 0);
  const planMax = num(position.planMax, 0);
  if (cost > 0 && principal > 0 && planMax > 0) return { label: '持仓完整', tone: 'buy' };
  if (cost > 0 && principal > 0) return { label: '已填写持仓', tone: 'hold' };
  return { label: '未填写', tone: 'hold' };
}

function inputMarkup(code, key, value, placeholder, step) {
  return `<input class="position-input" data-code="${code}" data-pos="${key}" type="number" min="0" step="${step}" value="${escapeHtml(value || '')}" placeholder="${placeholder}">`;
}

function render() {
  const state = readLocalState();
  const codes = parseCodes(state.codes);
  if (!codes.length) {
    els.body.innerHTML = '<tr><td colspan="6" class="table-empty">尚未添加基金代码。</td></tr>';
    els.mobile.innerHTML = '<div class="empty-mobile-card">在上方输入六位基金代码并点击“添加到基金列表”。</div>';
  } else {
    els.body.innerHTML = codes.map(code => {
      const position = positionFor(state, code);
      const status = holdingStatus(position);
      const name = state.fundMeta?.[code]?.name || `基金 ${code}`;
      return `<tr>
        <td><div class="fund-name">${escapeHtml(name)}</div><div class="fund-code">${code}</div></td>
        <td>${inputMarkup(code, 'costNav', position.costNav, '例如 1.2345', '0.0001')}</td>
        <td>${inputMarkup(code, 'principal', position.principal, '例如 10000', '0.01')}</td>
        <td>${inputMarkup(code, 'planMax', position.planMax, '例如 20000', '0.01')}</td>
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
          <label class="field"><span>成本净值</span>${inputMarkup(code, 'costNav', position.costNav, '例如 1.2345', '0.0001')}</label>
          <label class="field"><span>投入本金（元）</span>${inputMarkup(code, 'principal', position.principal, '例如 10000', '0.01')}</label>
          <label class="field"><span>计划最高金额（元）</span>${inputMarkup(code, 'planMax', position.planMax, '例如 20000', '0.01')}</label>
        </div>
        <button class="btn btn-light full-btn danger-outline" data-remove="${code}" type="button">删除这只基金</button>
      </article>`;
    }).join('');
  }
  bindDynamicEvents();
  renderStats(state, codes);
}

function renderStats(state = readLocalState(), codes = parseCodes(state.codes)) {
  const holdings = codes.filter(code => {
    const p = positionFor(state, code);
    return num(p.costNav) > 0 && num(p.principal) > 0;
  });
  const principal = codes.reduce((sum, code) => sum + num(positionFor(state, code).principal, 0), 0);
  els.statFundCount.textContent = String(codes.length);
  els.statHoldingCount.textContent = String(holdings.length);
  els.statPrincipal.textContent = money(principal);
  els.statMissingCount.textContent = String(codes.length - holdings.length);
}

function mirrorAndSavePosition(input) {
  const code = input.dataset.code;
  const key = input.dataset.pos;
  const value = cleanNumberInput(input.value);
  document.querySelectorAll(`input[data-code="${code}"][data-pos="${key}"]`).forEach(item => {
    if (item !== input) item.value = value;
  });
  const state = readLocalState();
  const positions = { ...(state.positions || {}) };
  positions[code] = { ...(positions[code] || {}), [key]: value };
  writeLocalState({ positions });
  renderStats(readLocalState());
}

function bindDynamicEvents() {
  document.querySelectorAll('.position-input').forEach(input => {
    input.addEventListener('change', event => mirrorAndSavePosition(event.currentTarget));
  });
  document.querySelectorAll('[data-remove]').forEach(button => {
    button.addEventListener('click', () => removeFund(button.dataset.remove));
  });
}

function collectPositionsFromInputs() {
  const state = readLocalState();
  const positions = { ...(state.positions || {}) };
  for (const code of parseCodes(state.codes)) {
    positions[code] = { ...(positions[code] || {}) };
    for (const key of ['costNav', 'principal', 'planMax']) {
      const input = document.querySelector(`input[data-code="${code}"][data-pos="${key}"]`);
      positions[code][key] = cleanNumberInput(input?.value ?? positions[code][key] ?? '');
    }
  }
  return positions;
}

async function recognizeNames(codes = parseCodes(readLocalState().codes), { quiet = false } = {}) {
  if (!codes.length) {
    setGlobalMessage(els.message, '当前没有可识别的基金代码。', 'error');
    return;
  }
  setLoading(els.overlay, els.loadingText, true, `正在并行识别 ${codes.length} 只基金`);
  const { items: success, errors } = await fetchRealtimeMany(codes);
  const failed = errors.map(item => item.code);
  if (success.length) {
    cacheRealtime(success);
    updateFundMeta(success);
  }
  render();
  setLoading(els.overlay, els.loadingText, false);
  if (!quiet || failed.length) {
    if (failed.length) setGlobalMessage(els.message, `已识别 ${success.length} 只，${failed.length} 只暂未识别名称；代码仍已正常保存。`, 'error');
    else setGlobalMessage(els.message, `基金名称识别完成，共 ${success.length} 只。`, 'success');
  }
}

async function addFunds() {
  const incoming = parseCodes(els.newCodes.value);
  if (!incoming.length) {
    setGlobalMessage(els.message, '请输入至少一个正确的六位基金代码。', 'error');
    return;
  }
  const state = readLocalState();
  const existing = parseCodes(state.codes);
  const combined = [...new Set([...existing, ...incoming])].slice(0, MAX_FUNDS);
  const actuallyAdded = combined.filter(code => !existing.includes(code));
  saveAndSync({ codes: combined.join('\n') });
  els.newCodes.value = '';
  render();
  if (!actuallyAdded.length) {
    setGlobalMessage(els.message, '输入的基金代码已经在列表中。', 'success');
    return;
  }
  const truncated = existing.length + incoming.length > MAX_FUNDS;
  setGlobalMessage(els.message, `已添加 ${actuallyAdded.length} 只基金${truncated ? '；列表最多保留12只' : ''}，基金代码将自动同步到 KV。`, 'success');
  await recognizeNames(actuallyAdded, { quiet: true });
  prefetchHistory(actuallyAdded);
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
  setGlobalMessage(els.message, '个人持仓已保存到当前浏览器；KV 仅保存基金代码。', 'success');
}

function clearAll() {
  if (!window.confirm('确定清空全部基金和个人持仓吗？此操作无法撤销。')) return;
  saveAndSync({ codes: '', positions: {}, fundMeta: {} });
  render();
  setGlobalMessage(els.message, '已清空基金列表与本机个人持仓；基金代码清空状态将同步到 KV。', 'success');
}

els.add.addEventListener('click', addFunds);
els.sample.addEventListener('click', () => { els.newCodes.value = '005827\n000001\n110022'; });
els.recognize.addEventListener('click', () => recognizeNames());
els.syncNow.addEventListener('click', retryCloudSync);
els.saveAll.addEventListener('click', saveAll);
els.clearAll.addEventListener('click', clearAll);

activateCurrentNav();
render();
initializeCloud({ syncStatus: els.sync, message: els.message }).then(() => render());
schedulePagePrefetch('settings');
