import { $, activateCurrentNav, initializeCloud, parseCodes, readLocalState, retryCloudSync, saveAndSync, setGlobalMessage } from './common.js';

const els = {
  codes: $('#fundCodes'), save: $('#saveBtn'), sample: $('#sampleBtn'), clear: $('#clearBtn'),
  sync: $('#syncStatus'), syncNow: $('#syncNowBtn'), message: $('#globalMessage'), count: $('#fundCount'), names: $('#savedFunds')
};

function renderState() {
  const state = readLocalState();
  els.codes.value = state.codes || '';
  const codes = parseCodes(state.codes);
  els.count.textContent = String(codes.length);
  els.names.innerHTML = codes.length
    ? codes.map(code => `<span class="code-chip">${state.fundMeta?.[code]?.name || code}<small>${state.fundMeta?.[code]?.name ? code : ''}</small></span>`).join('')
    : '<span class="muted">尚未添加基金</span>';
}
function save() {
  const codes = parseCodes(els.codes.value);
  saveAndSync({ codes: codes.join('\n') });
  renderState();
  setGlobalMessage(els.message, `已保存 ${codes.length} 只基金，实时页和历史页会共用这份列表。`, 'success');
}

els.save.addEventListener('click', save);
els.sample.addEventListener('click', () => { els.codes.value = '005827\n000001\n110022'; save(); });
els.clear.addEventListener('click', () => { els.codes.value = ''; save(); });
els.syncNow.addEventListener('click', retryCloudSync);

activateCurrentNav();
await initializeCloud({ syncStatus: els.sync, message: els.message });
renderState();
