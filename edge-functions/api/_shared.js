export const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=30, stale-while-revalidate=120',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept'
};

export function json(body, status = 200, cacheControl = '') {
  const headers = { ...jsonHeaders };
  if (cacheControl) headers['cache-control'] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

export function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function fetchText(url, init = {}, timeoutMs = 9000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('上游请求超时')), timeoutMs);
  });
  try {
    const response = await Promise.race([fetch(url, init), timeout]);
    if (!response.ok) throw new Error(`上游接口返回 ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function browserHeaders(referer) {
  return {
    accept: '*/*',
    referer,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
  };
}

export function parseLooseJson(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('未找到 JSON 内容');
}
