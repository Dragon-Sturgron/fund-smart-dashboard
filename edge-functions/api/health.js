import { json } from './_shared.js';
export function onRequestGet() {
  return json({ ok: true, service: 'fund-smart-dashboard', version: '2.5.1', time: new Date().toISOString() });
}
