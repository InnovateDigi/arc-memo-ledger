import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFile } from './helpers.mjs';

const html = projectFile('index.html');
const app = projectFile('app.mjs');
const css = projectFile('style.css');
const ledgerSource = projectFile('src/ledger.mjs');
const keccakSource = projectFile('src/keccak.mjs');

test('the page loads nothing from outside: no outside script, style, font or image', () => {
  const sources = [...html.matchAll(/<(script|link|img|iframe|video|audio|source|object|embed)\b[^>]*>/gi)].map((match) => match[0]);
  assert.deepEqual(sources, ['<link rel="stylesheet" href="style.css">', '<script type="module" src="app.mjs">']);
  assert.doesNotMatch(css, /@import|url\(/i);
  assert.doesNotMatch(css, /@font-face/i);
  for (const source of [app, ledgerSource, keccakSource]) {
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of imports) assert.match(specifier, /^\.\.?\//, `relative import expected, got ${specifier}`);
  }
});

test('content security policy: own files plus the two Arc RPC endpoints, nothing else', () => {
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const parts = Object.fromEntries(policy.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(parts['default-src'], ["'none'"]);
  assert.deepEqual(parts['script-src'], ["'self'"]);
  assert.deepEqual(parts['style-src'], ["'self'"]);
  assert.deepEqual(parts['connect-src'], ['https://rpc.mainnet.arc.io', 'https://rpc.testnet.arc.io']);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|\*/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline script');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no inline style');
});

test('no wallet, no key, no cookie, no storage, no analytics, no HTML injection', () => {
  for (const [name, source] of [['app.mjs', app], ['src/ledger.mjs', ledgerSource], ['src/keccak.mjs', keccakSource]]) {
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function',
      'window.ethereum', 'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'eth_requestAccounts', 'eth_accounts', 'privateKey', 'mnemonic', 'sendBeacon', 'serviceWorker']) {
      assert.equal(source.includes(banned), false, `${name} must not contain ${banned}`);
    }
  }
});

test('only read-only JSON-RPC methods appear in the code', () => {
  const allowed = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getCode']);
  const used = new Set();
  for (const source of [app, ledgerSource, projectFile('cli.mjs'), projectFile('scripts/smoke.mjs'), projectFile('scripts/record-fixtures.mjs')]) {
    for (const match of source.matchAll(/\b(eth|net|web3|debug|trace|personal|admin|txpool)_[A-Za-z]+\b/g)) used.add(match[0]);
  }
  assert.ok(used.size >= 5);
  for (const method of used) assert.ok(allowed.has(method), `${method} is not on the read-only list`);
});

test('the page has what the brief asks for', () => {
  for (const id of ['address', 'range', 'from', 'to', 'bar', 'cancel', 'filter', 'csv', 'json', 'rows', 'totals', 'balance', 'receipt', 'error', 'status']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const text of ['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Custom dates', 'Arc Mainnet', 'Arc Testnet', 'Download CSV', 'Download JSON', 'Cancel']) assert.ok(html.includes(text), text);
  assert.match(html, /name="network" value="mainnet" checked/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<html lang="en">/);
  for (const parameter of ["params.get('address')", "params.get('tx')", "params.get('network')"]) assert.ok(app.includes(parameter), parameter);
  assert.match(css, /@media \(max-width: 760px\)/);
  // every form control has a label
  for (const match of html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"/g)) assert.match(html, new RegExp(`<label for="${match[1]}"`), `label for ${match[1]}`);
});

test('no brand or personal identity in any file; the organisation name appears only in the two URLs', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  assert.ok(files.length > 15);
  // The test names the words it looks for without spelling them out in one piece.
  const banned = [['inno', 'vate'].join(''), ['land', 'lord'].join('')];
  const organisation = `${banned[0]}digi`;
  const allowedUrl = new RegExp(`https://(github\\.com/${organisation}/arc-memo-ledger|${organisation}\\.github\\.io/arc-memo-ledger)`, 'gi');
  for (const file of files) {
    const text = readFileSync(file, 'utf8').replace(allowedUrl, '');
    for (const word of banned) assert.equal(text.toLowerCase().includes(word), false, `${file.slice(root.length)} contains "${word}" outside the allowed URLs`);
  }
});
