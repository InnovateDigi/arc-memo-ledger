// Real-browser check of the page (not part of CI): drives a local headless Chrome over the
// DevTools protocol, with no dependency. It loads the page from a local static server, waits
// for a real mainnet ledger, and reports rows, totals, layout width and every host contacted.
//   node scripts/serve.mjs &   then   node scripts/check-page.mjs http://127.0.0.1:8080/ [address]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:8080/';
const address = process.argv[3] || '0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e';
const shots = process.env.SHOTS_DIR || tmpdir();
const prefix = process.env.SHOT_PREFIX || 'arc-memo-ledger';
const chromePath = process.env.CHROME || 'google-chrome';
const profile = mkdtempSync(join(tmpdir(), 'arc-memo-ledger-chrome-'));
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const endpoint = await new Promise((resolve, reject) => {
  let text = '';
  chrome.stderr.on('data', (chunk) => { text += chunk; const m = text.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
  chrome.on('exit', () => reject(new Error('Chrome exited: ' + text.slice(0, 400))));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});
const socket = new WebSocket(endpoint);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 1;
const waiting = new Map();
const requests = [];
const problems = [];
socket.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id && waiting.has(data.id)) { const { resolve, reject } = waiting.get(data.id); waiting.delete(data.id); data.error ? reject(new Error(data.error.message)) : resolve(data.result); return; }
  if (data.method === 'Network.requestWillBeSent') requests.push(data.params.request.url);
  if (data.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text));
  if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') problems.push('console.error: ' + data.params.args.map((a) => a.value || a.description).join(' '));
  if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') problems.push('log: ' + data.params.entry.text);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);
for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await page(`${domain}.enable`);
const evaluate = async (expression) => (await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const size = (width, height, mobile) => page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
const shot = async (name) => { const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); const file = join(shots, name); writeFileSync(file, Buffer.from(data, 'base64')); return file; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = () => evaluate(`JSON.stringify({
  result: !document.getElementById('result').hidden, receipt: !document.getElementById('receipt').hidden,
  error: document.getElementById('error').hidden ? null : document.getElementById('error').textContent,
  status: document.getElementById('status').textContent, bar: document.getElementById('bar').value,
  rows: [...document.querySelectorAll('#rows tr')].filter((r) => r.dataset.search !== undefined).length,
  visibleRows: [...document.querySelectorAll('#rows tr')].filter((r) => r.dataset.search !== undefined && !r.hidden).length,
  totals: [...document.querySelectorAll('#totals div')].map((d) => d.textContent.trim()),
  balance: document.getElementById('balance').textContent.trim().slice(0, 400), balanceClass: document.getElementById('balance').className,
  title: document.getElementById('result-title').textContent, range: document.getElementById('result-range').textContent,
  firstRow: (document.querySelector('#rows tr') || {}).innerText || '', shown: document.getElementById('shown').textContent,
  overflow: document.documentElement.scrollWidth - window.innerWidth, cookies: document.cookie, storage: localStorage.length + sessionStorage.length,
  receiptText: document.getElementById('receipt-body').innerText.slice(0, 900),
})`).then(JSON.parse);
const waitFor = async (test, seconds) => { for (let i = 0; i < seconds; i++) { const s = await state(); if (test(s) || s.error) return s; await sleep(1000); } return state(); };

const report = { base, address };
try {
  await size(1280, 900, false);
  await page('Page.navigate', { url: `${base}?address=${address}` });
  await sleep(1500);
  report.during = await state();
  const done = await waitFor((s) => s.result, 240);
  report.wide = done;
  report.wideShot = await shot(`${prefix}-1280.png`);
  if (process.env.QUICK) throw new Error('QUICK: stopped after the first ledger');
  await evaluate(`(() => { const f = document.getElementById('filter'); f.value = 'e874c325'; f.dispatchEvent(new Event('input')); })()`);
  report.filtered = (await state()).shown;
  await evaluate(`(() => { const f = document.getElementById('filter'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);
  await size(390, 844, true);
  await sleep(500);
  report.narrow = { overflow: (await state()).overflow };
  report.narrowShot = await shot(`${prefix}-390.png`);
  await page('Page.navigate', { url: `${base}?tx=0xf0a3c947b36eaf6a8c09a064454cded790c37a141fccb50821553cbfb34463a4&address=${address}` });
  const receipt = await waitFor((s) => s.receipt, 60);
  report.receipt = { shown: receipt.receipt, error: receipt.error, text: receipt.receiptText, overflow: receipt.overflow };
  report.receiptShot = await shot(`${prefix}-receipt-390.png`);
  // Downloads: capture what the two buttons hand to the browser.
  await size(1280, 900, false);
  await page('Page.navigate', { url: `${base}?address=${address}&from=${process.env.DAY || new Date().toISOString().slice(0, 10)}&to=${process.env.DAY || new Date().toISOString().slice(0, 10)}` });
  const custom = await waitFor((s) => s.result, 240);
  report.customDates = { rows: custom.rows, range: custom.range, totals: custom.totals, balanceClass: custom.balanceClass, error: custom.error };
  await evaluate(`(() => { window.__blobs = []; const make = URL.createObjectURL.bind(URL); URL.createObjectURL = (blob) => { blob.text().then((text) => window.__blobs.push({ type: blob.type, length: text.length, lines: text.split('\\n').length, start: text.slice(0, 90) })); return make(blob); }; document.getElementById('csv').click(); document.getElementById('json').click(); })()`);
  await sleep(800);
  report.downloads = await evaluate('JSON.stringify(window.__blobs)').then(JSON.parse);
  // Cancel: start a 7-day read, cancel after a few seconds, then make sure the requests stop.
  await page('Page.navigate', { url: `${base}?address=${address}&hours=168` });
  await sleep(6000);
  const beforeCancel = requests.length;
  await evaluate(`document.getElementById('cancel').click()`);
  await sleep(500);
  const atCancel = requests.length;
  await sleep(4000);
  const cancelled = await state();
  report.cancel = { requestsBeforeClick: beforeCancel, requestsAtClick: atCancel, requestsFourSecondsLater: requests.length, message: cancelled.error, resultShown: cancelled.result };
  // Testnet from the browser: an unknown transaction is enough to prove the page can reach that endpoint.
  await page('Page.navigate', { url: `${base}?tx=0x${'12'.repeat(32)}&network=testnet` });
  const testnet = await waitFor((s) => s.receipt, 30);
  report.testnet = { message: testnet.error };
  const hosts = {};
  for (const url of requests) { const host = url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:') ? url.split(':')[0] + ':' : new URL(url).host; hosts[host] = (hosts[host] || 0) + 1; }
  report.hostsContacted = hosts;
  report.problems = problems;
} catch (error) {
  report.stopped = error.message;
} finally {
  console.log(JSON.stringify(report, null, 1));
  socket.close();
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* the profile is only a temporary folder */ }
}
