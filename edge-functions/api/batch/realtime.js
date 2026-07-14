import { json, jsonHeaders } from '../_shared.js';
import { getRealtimeData } from '../_fund-data.js';

function parseCodes(url) {
  const raw = new URL(url).searchParams.get('codes') || '';
  return [...new Set(raw.split(',').map(item => item.trim()).filter(item => /^\d{6}$/.test(item)))].slice(0, 12);
}

export async function onRequestGet(context) {
  const codes = parseCodes(context.request.url);
  if (!codes.length) return json({ ok: false, message: '请提供基金代码' }, 400);
  const settled = await Promise.allSettled(codes.map(code => getRealtimeData(code)));
  const data = [];
  const errors = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') data.push(result.value);
    else errors.push({ code: codes[index], message: result.reason?.message || '加载失败' });
  });
  return json({ ok: true, data, errors, mode: 'parallel-batch' }, 200, errors.length ? 'public, max-age=5' : 'public, max-age=15, stale-while-revalidate=60');
}

export function onRequestOptions() { return new Response(null, { status: 204, headers: jsonHeaders }); }
