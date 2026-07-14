import { browserHeaders, fetchText, finiteNumber, json, jsonHeaders } from '../_shared.js';

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
    source: 'EdgeOne代理 · 天天基金盘中估算'
  };
}

export async function onRequestGet(context) {
  const code = String(context.params.code || '').trim();
  if (!/^\d{6}$/.test(code)) return json({ ok: false, message: '基金代码必须是六位数字' }, 400);
  const target = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  const attempts = [
    { name: '直接源', url: target },
    { name: 'Jina备用', url: `https://r.jina.ai/http://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}` }
  ];
  const diagnostics = [];
  for (const attempt of attempts) {
    try {
      const text = await fetchText(attempt.url, { headers: browserHeaders(`https://fund.eastmoney.com/${code}.html`) }, attempt.name === 'Jina备用' ? 14000 : 8000);
      const data = parseEstimate(text, code);
      data.source = `${data.source} · ${attempt.name}`;
      return json({ ok: true, data });
    } catch (error) {
      diagnostics.push(`${attempt.name}：${error.message}`);
    }
  }
  return json({ ok: false, message: '盘中估算数据源暂时不可用', diagnostics }, 502);
}

export function onRequestOptions() { return new Response(null, { status: 204, headers: jsonHeaders }); }
