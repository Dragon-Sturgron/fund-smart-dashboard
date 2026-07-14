import { browserHeaders, fetchText, finiteNumber, json, jsonHeaders, parseLooseJson } from '../_shared.js';

function parseHistoryApi(text) {
  const payload = parseLooseJson(text);
  return (payload?.Data?.LSJZList || []).map(item => ({ date: item.FSRQ, nav: finiteNumber(item.DWJZ), rate: finiteNumber(item.JZZZL) })).filter(item => item.date && item.nav !== null);
}
function parseDetail(text) {
  const match = text.match(/(?:var\s+)?Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!match) return [];
  return JSON.parse(match[1]).map(item => ({ date: new Date(Number(item.x)).toISOString().slice(0, 10), nav: finiteNumber(item.y), rate: finiteNumber(item.equityReturn) })).filter(item => item.date && item.nav !== null);
}
function parseName(text) {
  const match = text.match(/var\s+fS_name\s*=\s*["']([^"']+)["']/);
  return match ? match[1] : '';
}
function normalize(rows) {
  const byDate = new Map();
  for (const row of rows) if (row.date && row.nav !== null) byDate.set(row.date, row);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function onRequestGet(context) {
  const code = String(context.params.code || '').trim();
  if (!/^\d{6}$/.test(code)) return json({ ok: false, message: '基金代码必须是六位数字' }, 400);
  const historyUrl = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1000&startDate=&endDate=&_=${Date.now()}`;
  const detailUrl = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
  const diagnostics = [];
  let name = '';
  const attempts = [
    async () => ({ source: 'EdgeOne代理 · 东方财富历史净值', rows: parseHistoryApi(await fetchText(historyUrl, { headers: { ...browserHeaders(`https://fundf10.eastmoney.com/jjjz_${code}.html`), accept: 'application/json,text/plain,*/*' } }, 10000)) }),
    async () => {
      const text = await fetchText(detailUrl, { headers: browserHeaders(`https://fund.eastmoney.com/${code}.html`) }, 10000);
      name = parseName(text);
      return { source: 'EdgeOne代理 · 东方财富详情走势', rows: parseDetail(text) };
    },
    async () => ({ source: 'EdgeOne代理 · Jina历史净值备用', rows: parseHistoryApi(await fetchText(`https://r.jina.ai/http://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1000&startDate=&endDate=`, { headers: { accept: 'application/json,text/plain,*/*' } }, 15000)) })
  ];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      const history = normalize(result.rows);
      if (history.length >= 2) return json({ ok: true, data: { code, name: name || `基金 ${code}`, history, source: result.source } });
      diagnostics.push(`${result.source}：历史数据不足`);
    } catch (error) {
      diagnostics.push(error.message);
    }
  }
  return json({ ok: false, message: '历史净值数据源暂时不可用', diagnostics }, 502);
}

export function onRequestOptions() { return new Response(null, { status: 204, headers: jsonHeaders }); }
