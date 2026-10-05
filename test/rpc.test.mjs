import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpc, planChunks, getLogsAdaptive, findBlockAtOrAfter, resolveBlockRange, RpcError, LedgerError, isAbortError, MAX_BLOCKS_PER_QUERY } from '../src/ledger.mjs';
import { jsonResponse } from './helpers.mjs';

const ok = (result) => jsonResponse({ jsonrpc: '2.0', id: 1, result });
const rpcFailure = (code, message) => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code, message } });

function scripted(responses) {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  const sleep = async (ms) => { sleeps.push(ms); };
  return { calls, sleeps, fetchImpl, sleep };
}

test('paging planner: chunks are contiguous, inclusive and never larger than the limit', () => {
  assert.equal(MAX_BLOCKS_PER_QUERY, 9999);
  assert.deepEqual(planChunks(5, 5), [[5, 5]]);
  assert.deepEqual(planChunks(0, 9998), [[0, 9998]]);
  assert.deepEqual(planChunks(0, 9999), [[0, 9998], [9999, 9999]]);
  assert.deepEqual(planChunks(100, 130, 10), [[100, 109], [110, 119], [120, 129], [130, 130]]);
  for (const [from, to, size] of [[0, 169411, 9999], [24198942, 24368353, 9999], [7, 1000003, 777], [1, 1, 1]]) {
    const chunks = planChunks(from, to, size);
    assert.equal(chunks[0][0], from);
    assert.equal(chunks.at(-1)[1], to);
    for (let i = 0; i < chunks.length; i++) {
      assert.ok(chunks[i][1] - chunks[i][0] + 1 <= size);
      assert.ok(chunks[i][1] >= chunks[i][0]);
      if (i > 0) assert.equal(chunks[i][0], chunks[i - 1][1] + 1, 'no gap and no overlap');
    }
    assert.equal(chunks.length, Math.ceil((to - from + 1) / size));
  }
  assert.equal(planChunks(24198942, 24368353).length, 17, 'about 24 hours of Arc blocks is 17 requests per query kind');
});

test('paging planner refuses bad ranges and oversized chunks', () => {
  for (const args of [[5, 4], [-1, 4], [1.5, 4], [0, NaN], [0, 10, 0], [0, 10, 10000], [0, 10, 2.5]]) {
    assert.throws(() => planChunks(...args), LedgerError, JSON.stringify(args));
  }
});

test('retry on HTTP 429 with exponential back-off, then success', async () => {
  const net = scripted([new Response('slow down', { status: 429 }), new Response('slow down', { status: 429 }), ok('0x13b2')]);
  const retries = [];
  const rpc = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: net.fetchImpl, sleep: net.sleep, minIntervalMs: 0, onRetry: (info) => retries.push(info) });
  assert.equal(await rpc.call('eth_chainId', []), '0x13b2');
  assert.equal(net.calls.length, 3);
  assert.deepEqual(net.sleeps, [1500, 3000]);
  assert.deepEqual(retries.map((info) => info.reason), ['http_429', 'http_429']);
  assert.deepEqual(rpc.stats, { requests: 3, retries: 2 });
});

test('a Retry-After header is honoured, up to the cap', async () => {
  const net = scripted([new Response('', { status: 429, headers: { 'retry-after': '7' } }), new Response('', { status: 429, headers: { 'retry-after': '9999' } }), ok('0x1')]);
  const rpc = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: net.fetchImpl, sleep: net.sleep, minIntervalMs: 0 });
  assert.equal(await rpc.call('eth_blockNumber', []), '0x1');
  assert.deepEqual(net.sleeps, [7000, 30000]);
});

test('gives up after the allowed number of 429 answers', async () => {
  const net = scripted(Array.from({ length: 10 }, () => new Response('', { status: 429 })));
  const rpc = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: net.fetchImpl, sleep: net.sleep, minIntervalMs: 0, maxRetries: 3 });
  await assert.rejects(rpc.call('eth_chainId', []), (error) => error instanceof RpcError && error.status === 429);
  assert.equal(net.calls.length, 4);
  assert.deepEqual(net.sleeps, [1500, 3000, 6000]);
});

test('retries server errors, network failures and the documented -32014; not other errors', async () => {
  const net = scripted([new Response('', { status: 503 }), new TypeError('fetch failed'), rpcFailure(-32014, 'block not imported'), ok('0x2a')]);
  const rpc = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: net.fetchImpl, sleep: net.sleep, minIntervalMs: 0 });
  assert.equal(await rpc.call('eth_blockNumber', []), '0x2a');
  assert.equal(net.calls.length, 4);

  const refused = scripted([rpcFailure(-32012, 'range too large'), ok('0x1')]);
  const second = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: refused.fetchImpl, sleep: refused.sleep, minIntervalMs: 0 });
  await assert.rejects(second.call('eth_getLogs', [{}]), (error) => error instanceof RpcError && error.code === -32012);
  assert.equal(refused.calls.length, 1);

  const forbidden = scripted([new Response('no', { status: 403 }), ok('0x1')]);
  const third = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: forbidden.fetchImpl, sleep: forbidden.sleep, minIntervalMs: 0 });
  await assert.rejects(third.call('eth_chainId', []), (error) => error instanceof RpcError && error.status === 403);
  assert.equal(forbidden.calls.length, 1);

  const notJson = scripted([new Response('<html>', { status: 200 })]);
  const fourth = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: notJson.fetchImpl, sleep: notJson.sleep, minIntervalMs: 0 });
  await assert.rejects(fourth.call('eth_chainId', []), RpcError);
});

test('throttle: requests are sent one at a time, at least the minimum interval apart', async () => {
  let clock = 1000;
  const starts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async () => {
    starts.push(clock);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    clock += 20; // each request takes 20 ms
    inFlight--;
    return ok('0x1');
  };
  const sleep = async (ms) => { clock += ms; };
  const rpc = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl, sleep, now: () => clock, minIntervalMs: 550 });
  await Promise.all(Array.from({ length: 6 }, () => rpc.call('eth_blockNumber', [])));
  assert.equal(maxInFlight, 1);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 550, `gap ${starts[i] - starts[i - 1]}`);
  assert.ok((starts.at(-1) - starts[0]) / 1000 >= 5 * 0.55, 'six requests take at least 2.75 s: fewer than two a second');
});

test('request shape: JSON-RPC 2.0 POST with a User-Agent only when one is given', async () => {
  const net = scripted([ok('0x1'), ok('0x1')]);
  const rpc = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: net.fetchImpl, sleep: net.sleep, minIntervalMs: 0, userAgent: 'agent/1' });
  await rpc.call('eth_getBalance', ['0xabc', '0x1']);
  assert.equal(net.calls[0].init.method, 'POST');
  assert.equal(net.calls[0].init.headers['user-agent'], 'agent/1');
  assert.equal(net.calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual({ ...net.calls[0].body, id: 0 }, { jsonrpc: '2.0', id: 0, method: 'eth_getBalance', params: ['0xabc', '0x1'] });
  const plain = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: net.fetchImpl, sleep: net.sleep, minIntervalMs: 0 });
  await plain.call('eth_chainId');
  assert.equal('user-agent' in net.calls[1].init.headers, false);
  assert.throws(() => createRpc({ rpcUrl: 'ftp://x' }), LedgerError);
});

test('cancel: an aborted signal stops before the next request and during a back-off', async () => {
  const controller = new AbortController();
  const net = scripted([ok('0x1'), ok('0x2')]);
  const rpc = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: net.fetchImpl, sleep: net.sleep, minIntervalMs: 0, signal: controller.signal });
  assert.equal(await rpc.call('eth_blockNumber', []), '0x1');
  controller.abort();
  await assert.rejects(rpc.call('eth_blockNumber', []), isAbortError);
  assert.equal(net.calls.length, 1);

  // real timers: abort while waiting out a 429
  const second = new AbortController();
  const slow = scripted([new Response('', { status: 429 }), ok('0x1')]);
  const waiting = createRpc({ rpcUrl: 'https://rpc.example', fetchImpl: slow.fetchImpl, minIntervalMs: 0, baseDelayMs: 60000, signal: second.signal });
  const pending = waiting.call('eth_blockNumber', []);
  setTimeout(() => second.abort(), 20);
  await assert.rejects(pending, isAbortError);
  assert.equal(slow.calls.length, 1);
});

test('adaptive paging: a query the node refuses is halved until it fits', async () => {
  const asked = [];
  const rpc = {
    call: async (method, [filter]) => {
      const from = Number(BigInt(filter.fromBlock));
      const to = Number(BigInt(filter.toBlock));
      asked.push([from, to]);
      if (to - from + 1 > 25) throw new RpcError('RPC error -32005: query returned more than 10000 results', { code: -32005 });
      return [{ from, to }];
    },
  };
  const logs = await getLogsAdaptive(rpc, { topics: [null] }, 0, 99);
  assert.deepEqual(logs, [{ from: 0, to: 24 }, { from: 25, to: 49 }, { from: 50, to: 74 }, { from: 75, to: 99 }]);
  assert.deepEqual(asked[0], [0, 99]);
  // a single block that still fails is an error, and HTTP-level failures are not split
  await assert.rejects(getLogsAdaptive({ call: async () => { throw new RpcError('bad', { code: -32005 }); } }, {}, 7, 7), RpcError);
  let attempts = 0;
  await assert.rejects(getLogsAdaptive({ call: async () => { attempts++; throw new RpcError('HTTP 403', { status: 403 }); } }, {}, 0, 99), RpcError);
  assert.equal(attempts, 1);
});

// A synthetic chain shaped like Arc: a long pause after block 0, about two blocks a second, repeated timestamps.
function chain(length) {
  const times = [1778544000];
  let time = 1778853531;
  for (let i = 1; i < length; i++) {
    times.push(time);
    if (i % 2 === 0) time += 1;
    if (i % 5000 === 0) time += 40; // an occasional stall
  }
  let requests = 0;
  const rpc = {
    call: async (method, params) => {
      requests++;
      if (method === 'eth_blockNumber') return '0x' + (length - 1).toString(16);
      if (method === 'eth_chainId') return '0x13b2';
      const number = Number(BigInt(params[0]));
      return number < length ? { number: params[0], timestamp: '0x' + times[number].toString(16) } : null;
    },
    stats: { get requests() { return requests; } },
  };
  return { times, rpc, head: { number: length - 1, timestamp: times[length - 1] } };
}

test('time to block: finds the first block at or after a time, exactly, in few requests', async () => {
  const { times, rpc, head } = chain(400000);
  const firstAtOrAfter = (target) => times.findIndex((time) => time >= target);
  for (const target of [times[399999] - 86400, times[250000], times[250000] + 1, times[1], times[1] - 5, times[399999], times[123457] - 0, times[5000] + 20]) {
    const before = rpc.stats.requests;
    const found = await findBlockAtOrAfter(rpc, target, head);
    assert.equal(found, firstAtOrAfter(target), `target ${target}`);
    assert.ok(rpc.stats.requests - before <= 20, `used ${rpc.stats.requests - before} requests`);
    if (process.env.SHOW_SEARCH) console.log('search requests', rpc.stats.requests - before);
  }
  assert.equal(await findBlockAtOrAfter(rpc, times[0], head), 0);
  assert.equal(await findBlockAtOrAfter(rpc, 5, head), 0);
  assert.equal(await findBlockAtOrAfter(rpc, head.timestamp + 1, head), head.number + 1);
});

test('resolveBlockRange: hours back from the newest block, or an explicit time window', async () => {
  const { times, rpc } = chain(400000);
  const day = await resolveBlockRange({ rpc, hours: 24 });
  assert.equal(day.toBlock, 399999);
  assert.equal(day.fromBlock, times.findIndex((time) => time >= times[399999] - 86400));
  const window = await resolveBlockRange({ rpc, fromTime: times[100000], toTime: times[200000] });
  assert.equal(window.fromBlock, times.findIndex((time) => time >= times[100000]));
  assert.equal(window.toBlock, times.findIndex((time) => time >= times[200000]) - 1);
  await assert.rejects(resolveBlockRange({ rpc, hours: 0 }), LedgerError);
  await assert.rejects(resolveBlockRange({ rpc, fromTime: 10, toTime: 5 }), LedgerError);
  await assert.rejects(resolveBlockRange({ rpc, fromTime: times[399999] + 100, toTime: times[399999] + 200 }), LedgerError);
});
