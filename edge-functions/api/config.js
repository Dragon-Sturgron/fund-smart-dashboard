const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type'
};
const KV_KEY = 'fund_dashboard_state_v3';
const LEGACY_KEYS = ['fund_dashboard_state_v2'];
const MAX_FUNDS = 12;
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers }); }
function getKv(context) { return context?.env?.FUND_KV || globalThis.FUND_KV || null; }
function parseCodes(value) { return [...new Set(String(value || '').split(/[\s,，;；]+/).map(item => item.trim()).filter(item => /^\d{6}$/.test(item)))].slice(0, MAX_FUNDS); }
function numberInRange(value, min, max, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function sanitizeState(input) {
  const codes = parseCodes(input?.codes);
  const allowedCodes = new Set(codes);
  const positions = {};
  if (input?.positions && typeof input.positions === 'object') {
    for (const [code, position] of Object.entries(input.positions)) {
      if (!allowedCodes.has(code) || !position || typeof position !== 'object') continue;
      positions[code] = {};
      for (const field of ['costNav', 'principal', 'planMax']) {
        const value = position[field];
        const parsed = Number(value);
        positions[code][field] = value === '' || value === null || value === undefined ? '' : Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : '';
      }
    }
  }
  const fundMeta = {};
  if (input?.fundMeta && typeof input.fundMeta === 'object') {
    for (const code of codes) {
      const meta = input.fundMeta[code];
      if (!meta || typeof meta !== 'object') continue;
      fundMeta[code] = {
        name: String(meta.name || '').slice(0, 80),
        lastSource: String(meta.lastSource || '').slice(0, 120),
        lastSuccessAt: String(meta.lastSuccessAt || '').slice(0, 40)
      };
    }
  }
  return {
    version: 3,
    codes: codes.join('\n'),
    risk: ['conservative', 'normal', 'aggressive'].includes(input?.risk) ? input.risk : 'normal',
    interval: [0, 30, 60, 120].includes(Number(input?.interval)) ? Number(input.interval) : 60,
    target: numberInRange(input?.target, 1, 200, 20),
    positions,
    fundMeta,
    updatedAt: new Date().toISOString()
  };
}
function missingKv() { return json({ ok: false, code: 'KV_NOT_BOUND', message: '未绑定KV，请将命名空间变量名设置为 FUND_KV。' }, 503); }
export async function onRequestGet(context) {
  const kv = getKv(context); if (!kv) return missingKv();
  try {
    let data = await kv.get(KV_KEY, { type: 'json' });
    if (!data) {
      for (const key of LEGACY_KEYS) {
        const legacy = await kv.get(key, { type: 'json' });
        if (legacy) { data = sanitizeState(legacy); await kv.put(KV_KEY, JSON.stringify(data)); break; }
      }
    }
    return json({ ok: true, data: data || null, updatedAt: data?.updatedAt || null });
  } catch (error) { return json({ ok: false, code: 'KV_READ_FAILED', message: `读取KV失败：${error?.message || '未知错误'}` }, 500); }
}
export async function onRequestPut(context) {
  const kv = getKv(context); if (!kv) return missingKv();
  try {
    const input = await context.request.json();
    const state = sanitizeState(input);
    await kv.put(KV_KEY, JSON.stringify(state));
    return json({ ok: true, data: state, updatedAt: state.updatedAt });
  } catch (error) { return json({ ok: false, code: 'KV_WRITE_FAILED', message: `写入KV失败：${error?.message || '请求格式错误'}` }, 500); }
}
export async function onRequestDelete(context) {
  const kv = getKv(context); if (!kv) return missingKv();
  try { await kv.delete(KV_KEY); return json({ ok: true }); }
  catch (error) { return json({ ok: false, code: 'KV_DELETE_FAILED', message: `清理KV失败：${error?.message || '未知错误'}` }, 500); }
}
export function onRequestOptions() { return new Response(null, { status: 204, headers }); }
