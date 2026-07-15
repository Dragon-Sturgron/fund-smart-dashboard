const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

const KV_KEY = 'fund_dashboard_portfolio_v1';
const LEGACY_KEYS = [
  'fund_dashboard_codes_v1',
  'fund_dashboard_state_v3',
  'fund_dashboard_state_v2'
];
const MAX_FUNDS = 12;
const DAILY_UPDATE_TIME = '00:00';

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

function finite(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}


function roundHalfUp(value, digits = 2) {
  const number = finite(value);
  if (number === null) return '';
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function cleanText(value, maxLength = 80) {
  return value === null || value === undefined ? '' : String(value).slice(0, maxLength);
}

function sanitizePosition(raw = {}) {
  const amountNumber = finite(raw.holdingAmount);
  const profitNumber = finite(raw.holdingProfit);
  const sharesNumber = finite(raw.shares);
  const amount = amountNumber !== null && amountNumber >= 0 ? roundHalfUp(amountNumber, 2) : '';
  const profit = profitNumber !== null ? roundHalfUp(profitNumber, 2) : '';
  const shares = sharesNumber !== null && sharesNumber > 0 ? roundHalfUp(sharesNumber, 2) : '';
  const derivedPrincipal = amount !== '' && profit !== '' ? roundHalfUp(amount - profit, 2) : '';
  const principalNumber = finite(raw.principal);
  const principal = principalNumber !== null && principalNumber > 0
    ? roundHalfUp(principalNumber, 2)
    : derivedPrincipal !== '' && derivedPrincipal > 0 ? derivedPrincipal : '';
  const costNavNumber = finite(raw.costNav);
  const costNav = costNavNumber !== null && costNavNumber > 0
    ? roundHalfUp(costNavNumber, 6)
    : principal !== '' && shares !== '' && shares > 0 ? roundHalfUp(principal / shares, 6) : '';
  const liveNavNumber = finite(raw.liveNav);

  return {
    holdingAmount: amount,
    holdingProfit: profit,
    shares,
    principal,
    costNav,
    calculatedAt: cleanText(raw.calculatedAt, 40),
    shareBasis: shares !== '' ? 'manual-shares' : '',
    navSource: shares !== '' ? '用户填写实际份额' : '',
    liveNav: liveNavNumber !== null && liveNavNumber > 0 ? roundHalfUp(liveNavNumber, 6) : '',
    liveUpdatedAt: cleanText(raw.liveUpdatedAt, 40),
    liveQuoteTime: cleanText(raw.liveQuoteTime, 40),
    liveSource: cleanText(raw.liveSource, 40)
  };
}

function sanitizePositions(input, codes) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const positions = {};
  for (const code of codes) {
    if (!Object.prototype.hasOwnProperty.call(source, code)) continue;
    positions[code] = sanitizePosition(source[code]);
  }
  return positions;
}

function sanitizeDailyUpdate(input = {}) {
  const lastDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input?.lastDate || ''))
    ? String(input.lastDate)
    : '';
  return {
    time: DAILY_UPDATE_TIME,
    lastDate,
    lastAt: cleanText(input?.lastAt, 40)
  };
}

function sanitizeState(input, preserveUpdatedAt = false) {
  const codes = parseCodes(input?.codes);
  return {
    version: 2,
    codes: codes.join('\n'),
    positions: sanitizePositions(input?.positions, codes),
    dailyUpdate: sanitizeDailyUpdate(input?.dailyUpdate),
    updatedAt: preserveUpdatedAt && input?.updatedAt
      ? cleanText(input.updatedAt, 40)
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
