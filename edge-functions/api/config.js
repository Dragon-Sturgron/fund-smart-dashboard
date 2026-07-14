const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

const KV_KEY = 'fund_dashboard_codes_v1';
const LEGACY_KEYS = ['fund_dashboard_state_v3', 'fund_dashboard_state_v2'];
const MAX_FUNDS = 12;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function getKv(context) {
  return context?.env?.FUND_KV || globalThis.FUND_KV || null;
}

function parseCodes(value) {
  return [...new Set(String(value || '')
    .split(/[\s,，;；]+/)
    .map(item => item.trim())
    .filter(item => /^\d{6}$/.test(item)))]
    .slice(0, MAX_FUNDS);
}

function sanitizeState(input, preserveUpdatedAt = false) {
  return {
    version: 1,
    codes: parseCodes(input?.codes).join('\n'),
    updatedAt: preserveUpdatedAt && input?.updatedAt
      ? String(input.updatedAt).slice(0, 40)
      : new Date().toISOString()
  };
}

function missingKv() {
  return json({
    ok: false,
    code: 'KV_NOT_BOUND',
    message: '未绑定 KV，请将命名空间变量名设置为 FUND_KV。'
  }, 503);
}

async function removeLegacyData(kv) {
  await Promise.all(LEGACY_KEYS.map(key => kv.delete(key).catch(() => undefined)));
}

export async function onRequestGet(context) {
  const kv = getKv(context);
  if (!kv) return missingKv();
  try {
    let data = await kv.get(KV_KEY, { type: 'json' });
    if (data) {
      data = sanitizeState(data, true);
      await kv.put(KV_KEY, JSON.stringify(data));
      await removeLegacyData(kv);
      return json({ ok: true, data, updatedAt: data.updatedAt });
    }

    for (const key of LEGACY_KEYS) {
      const legacy = await kv.get(key, { type: 'json' });
      if (!legacy) continue;
      data = sanitizeState(legacy);
      await kv.put(KV_KEY, JSON.stringify(data));
      await removeLegacyData(kv);
      return json({ ok: true, data, updatedAt: data.updatedAt, migrated: true });
    }

    return json({ ok: true, data: null, updatedAt: null });
  } catch (error) {
    return json({ ok: false, code: 'KV_READ_FAILED', message: `读取 KV 失败：${error?.message || '未知错误'}` }, 500);
  }
}

export async function onRequestPut(context) {
  const kv = getKv(context);
  if (!kv) return missingKv();
  try {
    const input = await context.request.json();
    const state = sanitizeState(input);
    await kv.put(KV_KEY, JSON.stringify(state));
    await removeLegacyData(kv);
    return json({ ok: true, data: state, updatedAt: state.updatedAt });
  } catch (error) {
    return json({ ok: false, code: 'KV_WRITE_FAILED', message: `写入 KV 失败：${error?.message || '请求格式错误'}` }, 500);
  }
}

export async function onRequestDelete(context) {
  const kv = getKv(context);
  if (!kv) return missingKv();
  try {
    await Promise.all([kv.delete(KV_KEY), ...LEGACY_KEYS.map(key => kv.delete(key))]);
    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, code: 'KV_DELETE_FAILED', message: `清理 KV 失败：${error?.message || '未知错误'}` }, 500);
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers });
}
