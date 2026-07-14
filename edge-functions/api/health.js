import { json } from './_shared.js';
export function onRequestGet() {
  return json({ ok: true, service: 'fund-smart-dashboard', version: '2.4.0', time: new Date().toISOString() });
}
