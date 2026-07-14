import { browserHeaders, fetchText, finiteNumber, parseLooseJson } from './_shared.js';

function normalizeHistory(rows = []) {
  const byDate = new Map();
  for (const row of rows) {
    if (row?.date && row.nav !== null && Number.isFinite(Number(row.nav))) {
      byDate.set(row.date, { date: row.date, nav: Number(row.nav), rate: row.rate === null ? null : Number(row.rate) });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function parseEstimate(text, code) {
  const match = text.match(/jsonpgz\((\{[\s\S]*\})\)\s*;?/);
  if (!match) throw new Error('未找到盘中估算内容');
  const data = JSON.parse(match[1]);
  return {
    code,
    name: data.name || `基金 ${code}`,
    previousNav: finiteNumber(data.dwjz),
    estimatedNav: finiteNumber(data.gsz),
    estimatedRate: finiteNumber(data.gszzl),
    time: data.gztime || data.jzrq || '',
    confirmedDate: data.jzrq || '',
    source: 'EdgeOne并行代理 · 天天基金盘中估算'
  };
}

function parseHistoryApi(text) {
  const payload = parseLooseJson(text);
  return (payload?.Data?.LSJZList || []).map(item => ({
    date: item.FSRQ,
    nav: finiteNumber(item.DWJZ),
    rate: finiteNumber(item.JZZZL)
  })).filter(item => item.date && item.nav !== null);
}

function parseDetail(text) {
  const match = text.match(/(?:var\s+)?Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!match) return [];
  return JSON.parse(match[1]).map(item => ({
    date: new Date(Number(item.x)).toISOString().slice(0, 10),
    nav: finiteNumber(item.y),
    rate: finiteNumber(item.equityReturn)
  })).filter(item => item.date && item.nav !== null);
}

function parseName(text) {
  const match = text.match(/var\s+fS_name\s*=\s*["']([^"']+)["']/);
  return match ? match[1] : '';
}

function ensureHistoryResult(code, name, source, rows) {
  const history = normalizeHistory(rows);
  if (history.length < 2) throw new Error(`${source}：历史数据不足`);
  return { code, name: name || `基金 ${code}`, history, source };
}

export async function getRealtimeData(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('基金代码必须是六位数字');
  const target = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const diagnostics = [];
  const attempts = [
    { name: '直接源', url: target, timeout: 5500 },
    { name: 'Jina备用', url: `https://r.jina.ai/http://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`, timeout: 10000 }
  ];
  for (const attempt of attempts) {
    try {
      const text = await fetchText(attempt.url, {
        headers: browserHeaders(`https://fund.eastmoney.com/${code}.html`)
      }, attempt.timeout);
      const data = parseEstimate(text, code);
      data.source = `${data.source} · ${attempt.name}`;
      return data;
    } catch (error) {
      diagnostics.push(`${attempt.name}：${error.message}`);
    }
  }
  const error = new Error('盘中估算数据源暂时不可用');
  error.diagnostics = diagnostics;
  throw error;
}

export async function getHistoryData(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('基金代码必须是六位数字');
  const now = Date.now();
  const historyUrl = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1000&startDate=&endDate=&_=${now}`;
  const detailUrl = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${now}`;
  const diagnostics = [];

  const historyApiTask = (async () => {
    const text = await fetchText(historyUrl, {
      headers: { ...browserHeaders(`https://fundf10.eastmoney.com/jjjz_${code}.html`), accept: 'application/json,text/plain,*/*' }
    }, 7500);
    return ensureHistoryResult(code, '', 'EdgeOne并行代理 · 东方财富历史净值', parseHistoryApi(text));
  })();

  const detailTask = (async () => {
    const text = await fetchText(detailUrl, {
      headers: browserHeaders(`https://fund.eastmoney.com/${code}.html`)
    }, 7500);
    return ensureHistoryResult(code, parseName(text), 'EdgeOne并行代理 · 东方财富详情走势', parseDetail(text));
  })();

  try {
    // 两个公开历史源并行竞争，任意一个先返回有效数据就立即完成。
    return await Promise.any([historyApiTask, detailTask]);
  } catch (aggregateError) {
    for (const reason of aggregateError?.errors || []) diagnostics.push(reason?.message || String(reason));
  }

  try {
    const jinaUrl = `https://r.jina.ai/http://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1000&startDate=&endDate=`;
    const text = await fetchText(jinaUrl, { headers: { accept: 'application/json,text/plain,*/*' } }, 12000);
    return ensureHistoryResult(code, '', 'EdgeOne并行代理 · Jina历史净值备用', parseHistoryApi(text));
  } catch (error) {
    diagnostics.push(error.message);
  }

  const error = new Error('历史净值数据源暂时不可用');
  error.diagnostics = diagnostics;
  throw error;
}
