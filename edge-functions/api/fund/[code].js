const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=30, stale-while-revalidate=120',
  'access-control-allow-origin': '*'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

async function fetchText(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`上游接口返回 ${response.status}`);
  return response.text();
}

function parseEstimate(text) {
  const match = text.match(/jsonpgz\((.*)\)\s*;?\s*$/s);
  if (!match) return null;
  const data = JSON.parse(match[1]);
  return {
    name: data.name || '',
    previousNav: Number(data.dwjz),
    estimatedNav: Number(data.gsz),
    estimatedRate: Number(data.gszzl),
    time: data.gztime || ''
  };
}

function parseNameFromDetail(text) {
  const match = text.match(/var\s+fS_name\s*=\s*["']([^"']+)["']/);
  return match ? match[1] : '';
}

export async function onRequestGet(context) {
  const code = String(context.params.code || '').trim();
  if (!/^\d{6}$/.test(code)) return json({ ok: false, message: '基金代码必须是六位数字' }, 400);

  const stamp = Date.now();
  const estimateUrl = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${stamp}`;
  const historyUrl = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=400&startDate=&endDate=`;
  const detailUrl = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${stamp}`;

  const commonHeaders = {
    'accept': '*/*',
    'referer': `https://fund.eastmoney.com/${code}.html`
  };

  const [estimateResult, historyResult, detailResult] = await Promise.allSettled([
    fetchText(estimateUrl, { headers: commonHeaders }),
    fetchText(historyUrl, { headers: { ...commonHeaders, 'accept': 'application/json,text/plain,*/*' } }),
    fetchText(detailUrl, { headers: commonHeaders })
  ]);

  let estimate = null;
  if (estimateResult.status === 'fulfilled') {
    try { estimate = parseEstimate(estimateResult.value); } catch { estimate = null; }
  }

  let history = [];
  if (historyResult.status === 'fulfilled') {
    try {
      const payload = JSON.parse(historyResult.value);
      history = (payload?.Data?.LSJZList || []).map(item => ({
        date: item.FSRQ,
        nav: Number(item.DWJZ),
        rate: item.JZZZL === null || item.JZZZL === '' ? null : Number(item.JZZZL)
      })).filter(item => item.date && Number.isFinite(item.nav));
    } catch { history = []; }
  }

  let fallbackName = '';
  if (detailResult.status === 'fulfilled') fallbackName = parseNameFromDetail(detailResult.value);
  const name = estimate?.name || fallbackName || `基金 ${code}`;

  if (!history.length) {
    return json({ ok: false, message: '未获取到历史净值，请确认基金代码或稍后重试' }, 502);
  }

  return json({
    ok: true,
    data: {
      code,
      name,
      estimate,
      history,
      source: {
        estimate: estimate ? 'fundgz.1234567.com.cn' : null,
        history: 'api.fund.eastmoney.com',
        fetchedAt: new Date().toISOString()
      }
    }
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: jsonHeaders });
}
