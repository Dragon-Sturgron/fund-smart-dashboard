const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=30, stale-while-revalidate=120',
  'access-control-allow-origin': '*'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchText(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`上游接口返回 ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseEstimate(text) {
  const match = text.match(/jsonpgz\((.*)\)\s*;?\s*$/s);
  if (!match) return null;
  const data = JSON.parse(match[1]);
  return {
    name: data.name || '',
    previousNav: finiteNumber(data.dwjz),
    estimatedNav: finiteNumber(data.gsz),
    estimatedRate: finiteNumber(data.gszzl),
    time: data.gztime || data.jzrq || ''
  };
}

function parseMobileInfo(text, code) {
  const payload = JSON.parse(text);
  const rows = Array.isArray(payload?.Datas)
    ? payload.Datas
    : Array.isArray(payload?.Data)
      ? payload.Data
      : [];
  const item = rows.find(row => String(row.FCODE || row.Fcode || row.CODE || '') === code) || rows[0];
  if (!item) return null;

  const estimatedNav = finiteNumber(item.GSZ);
  return {
    name: item.SHORTNAME || item.FSHORTNAME || item.NAME || '',
    previousNav: finiteNumber(item.NAV),
    estimatedNav,
    estimatedRate: estimatedNav !== null
      ? finiteNumber(item.GSZZL)
      : finiteNumber(item.NAVCHGRT),
    time: estimatedNav !== null ? (item.GZTIME || item.PDATE || '') : (item.PDATE || ''),
    confirmedNav: finiteNumber(item.NAV),
    confirmedRate: finiteNumber(item.NAVCHGRT),
    confirmedDate: item.PDATE || ''
  };
}

function parseHistoryApi(text) {
  const payload = JSON.parse(text);
  return (payload?.Data?.LSJZList || []).map(item => ({
    date: item.FSRQ,
    nav: finiteNumber(item.DWJZ),
    rate: finiteNumber(item.JZZZL)
  })).filter(item => item.date && item.nav !== null);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAssignedArray(text, variableName) {
  const pattern = new RegExp(`(?:var\\s+)?${escapeRegExp(variableName)}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`);
  const match = text.match(pattern);
  if (!match) return [];
  const data = JSON.parse(match[1]);
  return Array.isArray(data) ? data : [];
}

function formatTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseDetailHistory(text) {
  return extractAssignedArray(text, 'Data_netWorthTrend').map(item => ({
    date: formatTimestamp(item.x),
    nav: finiteNumber(item.y),
    rate: finiteNumber(item.equityReturn)
  })).filter(item => item.date && item.nav !== null);
}

function parseNameFromDetail(text) {
  const match = text.match(/var\s+fS_name\s*=\s*["']([^"']+)["']/);
  return match ? match[1] : '';
}

function parseLooseJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('未找到 JSON 内容');
  }
}

function parseJinaHistory(text) {
  const payload = parseLooseJson(text);
  return (payload?.Data?.LSJZList || []).map(item => ({
    date: item.FSRQ,
    nav: finiteNumber(item.DWJZ),
    rate: finiteNumber(item.JZZZL)
  })).filter(item => item.date && item.nav !== null);
}

function mergeEstimate(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    name: primary.name || secondary.name || '',
    previousNav: primary.previousNav ?? secondary.previousNav,
    estimatedNav: primary.estimatedNav ?? secondary.estimatedNav,
    estimatedRate: primary.estimatedRate ?? secondary.estimatedRate,
    time: primary.time || secondary.time || '',
    confirmedNav: secondary.confirmedNav ?? primary.confirmedNav,
    confirmedRate: secondary.confirmedRate ?? primary.confirmedRate,
    confirmedDate: secondary.confirmedDate || primary.confirmedDate || ''
  };
}

function sortAndDedupeHistory(history) {
  const byDate = new Map();
  for (const item of history) {
    if (!item?.date || item.nav === null || !Number.isFinite(Number(item.nav))) continue;
    byDate.set(item.date, {
      date: item.date,
      nav: Number(item.nav),
      rate: item.rate === null || item.rate === undefined || !Number.isFinite(Number(item.rate))
        ? null
        : Number(item.rate)
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function onRequestGet(context) {
  const code = String(context.params.code || '').trim();
  if (!/^\d{6}$/.test(code)) return json({ ok: false, message: '基金代码必须是六位数字' }, 400);

  const stamp = Date.now();
  const estimateUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${stamp}`;
  const mobileInfoUrl = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=20&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=edgeone&Fcodes=${code}`;
  const historyUrl = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=500&startDate=&endDate=`;
  const detailUrl = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${stamp}`;

  const browserHeaders = {
    accept: '*/*',
    referer: `https://fund.eastmoney.com/${code}.html`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
  };

  const [estimateResult, mobileResult, historyResult, detailResult] = await Promise.allSettled([
    fetchText(estimateUrl, { headers: browserHeaders }),
    fetchText(mobileInfoUrl, { headers: { accept: 'application/json,text/plain,*/*', 'user-agent': 'Dalvik/2.1.0' } }),
    fetchText(historyUrl, { headers: { ...browserHeaders, accept: 'application/json,text/plain,*/*', origin: 'https://fund.eastmoney.com' } }),
    fetchText(detailUrl, { headers: browserHeaders })
  ]);

  let estimate = null;
  let mobileInfo = null;
  let historyFromApi = [];
  let historyFromDetail = [];
  let fallbackName = '';
  const diagnostics = [];

  if (estimateResult.status === 'fulfilled') {
    try { estimate = parseEstimate(estimateResult.value); }
    catch (error) { diagnostics.push(`实时估值解析失败：${error.message}`); }
  } else diagnostics.push(`实时估值不可用：${estimateResult.reason?.message || '请求失败'}`);

  if (mobileResult.status === 'fulfilled') {
    try { mobileInfo = parseMobileInfo(mobileResult.value, code); }
    catch (error) { diagnostics.push(`移动端行情解析失败：${error.message}`); }
  } else diagnostics.push(`移动端行情不可用：${mobileResult.reason?.message || '请求失败'}`);

  if (historyResult.status === 'fulfilled') {
    try { historyFromApi = parseHistoryApi(historyResult.value); }
    catch (error) { diagnostics.push(`历史净值接口解析失败：${error.message}`); }
  } else diagnostics.push(`历史净值接口不可用：${historyResult.reason?.message || '请求失败'}`);

  if (detailResult.status === 'fulfilled') {
    try {
      historyFromDetail = parseDetailHistory(detailResult.value);
      fallbackName = parseNameFromDetail(detailResult.value);
    } catch (error) { diagnostics.push(`详情走势解析失败：${error.message}`); }
  } else diagnostics.push(`详情走势不可用：${detailResult.reason?.message || '请求失败'}`);

  // 只有东方财富的两个直接历史源都不可用时，才通过 Jina Reader 代理原历史接口。
  // 基金吧页面仅用于讨论/舆情，不作为净值数据源。
  let historyFromJina = [];
  if (!historyFromApi.length && !historyFromDetail.length) {
    const target = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=500&startDate=&endDate=`;
    const jinaUrl = `https://r.jina.ai/${target}`;
    try {
      const jinaText = await fetchText(jinaUrl, {
        headers: {
          accept: 'application/json,text/plain,*/*',
          'x-timeout': '10'
        }
      }, 15000);
      historyFromJina = parseJinaHistory(jinaText);
    } catch (error) {
      diagnostics.push(`Jina 历史净值兜底不可用：${error.message}`);
    }
  }

  const candidates = [
    { source: 'api.fund.eastmoney.com', rows: historyFromApi },
    { source: 'fund.eastmoney.com/pingzhongdata', rows: historyFromDetail },
    { source: 'r.jina.ai → api.fund.eastmoney.com', rows: historyFromJina }
  ].filter(item => item.rows.length);

  candidates.sort((a, b) => b.rows.length - a.rows.length);
  const selected = candidates[0] || { source: null, rows: [] };
  const history = sortAndDedupeHistory(selected.rows);
  estimate = mergeEstimate(estimate, mobileInfo);

  // 有些接口的最新确认净值可能比历史数组更新一天，补到历史尾部。
  if (mobileInfo?.confirmedDate && mobileInfo.confirmedNav !== null) {
    const merged = sortAndDedupeHistory([
      ...history,
      {
        date: mobileInfo.confirmedDate,
        nav: mobileInfo.confirmedNav,
        rate: mobileInfo.confirmedRate
      }
    ]);
    history.splice(0, history.length, ...merged);
  }

  const name = estimate?.name || mobileInfo?.name || fallbackName || `基金 ${code}`;

  if (history.length < 2) {
    return json({
      ok: false,
      message: '基金代码有效，但历史净值数据源暂时不可用，请稍后重试',
      diagnostics
    }, 502);
  }

  return json({
    ok: true,
    data: {
      code,
      name,
      estimate,
      history,
      source: {
        estimate: estimate?.estimatedNav !== null && estimate?.estimatedNav !== undefined
          ? (estimateResult.status === 'fulfilled' ? 'fundgz.1234567.com.cn' : 'fundmobapi.eastmoney.com')
          : 'fundmobapi.eastmoney.com',
        history: selected.source,
        historyPoints: history.length,
        fetchedAt: new Date().toISOString()
      }
    }
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: jsonHeaders });
}
