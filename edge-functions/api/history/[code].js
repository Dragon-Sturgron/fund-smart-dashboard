import { json, jsonHeaders } from '../_shared.js';
import { getHistoryData } from '../_fund-data.js';

export async function onRequestGet(context) {
  const code = String(context.params.code || '').trim();
  if (!/^\d{6}$/.test(code)) return json({ ok: false, message: '基金代码必须是六位数字' }, 400);
  try {
    return json({ ok: true, data: await getHistoryData(code) }, 200, 'public, max-age=900, stale-while-revalidate=86400');
  } catch (error) {
    return json({ ok: false, message: error.message, diagnostics: error.diagnostics || [] }, 502);
  }
}

export function onRequestOptions() { return new Response(null, { status: 204, headers: jsonHeaders }); }
