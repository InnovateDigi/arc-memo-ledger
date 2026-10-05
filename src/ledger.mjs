// Arc Memo Ledger: read an address's USDC payments, with their native memos,
// straight from Arc's public JSON-RPC. Read-only. No dependency, no key, no signature.
//
// Sources for every Arc-specific constant are quoted in VERIFY.md.

import { keccak256, hexToBytes } from './keccak.mjs';

export const VERSION = '0.1.0';

export const NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    key: 'mainnet',
    name: 'Arc Mainnet',
    chainId: 5042,
    rpcUrl: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
  }),
  testnet: Object.freeze({
    key: 'testnet',
    name: 'Arc Testnet',
    chainId: 5042002,
    rpcUrl: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
  }),
});

// The native system emitter logs every explicit USDC movement at 18 decimals.
export const SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
// The ERC-20 view of the same balance (6 decimals). Its Transfer logs repeat
// movements the system emitter already logged, so the ledger never counts them.
export const USDC_ERC20 = '0x3600000000000000000000000000000000000000';
export const MEMO_CONTRACT = '0x5294e9927c3306dcbadb03fe70b92e01ccede505';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const SIGNATURES = Object.freeze({
  transfer: 'Transfer(address,address,uint256)',
  beforeMemo: 'BeforeMemo(uint256)',
  memo: 'Memo(address,address,bytes32,bytes32,bytes,uint256)',
});

// topic0 values are computed here from the documented signatures, not pasted in.
export const TOPICS = Object.freeze({
  transfer: keccak256(SIGNATURES.transfer),
  beforeMemo: keccak256(SIGNATURES.beforeMemo),
  memo: keccak256(SIGNATURES.memo),
});

export const NATIVE_DECIMALS = 18;
// The docs ask log readers to page "in ≤9,999-block chunks".
export const MAX_BLOCKS_PER_QUERY = 9999;
// 550 ms between requests keeps the reader under two requests a second.
export const DEFAULT_MIN_INTERVAL_MS = 550;
// -32014: a load-balanced backend has not imported the block yet; the docs say to retry.
const RETRIABLE_RPC_CODES = new Set([-32014]);

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export class RpcError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------- small helpers

export function normalizeAddress(address) {
  const value = typeof address === 'string' ? address.trim() : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new LedgerError('bad_address', 'An address is 0x followed by 40 hexadecimal characters.');
  }
  return value.toLowerCase();
}

export function normalizeTxHash(hash) {
  const value = typeof hash === 'string' ? hash.trim() : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new LedgerError('bad_hash', 'A transaction hash is 0x followed by 64 hexadecimal characters.');
  }
  return value.toLowerCase();
}

export function addressToTopic(address) {
  return '0x' + '0'.repeat(24) + normalizeAddress(address).slice(2);
}

export function topicToAddress(topic) {
  if (typeof topic !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) {
    throw new LedgerError('bad_topic', 'This topic is not a left-padded address.');
  }
  return '0x' + topic.slice(26).toLowerCase();
}

export function hexToBigInt(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new LedgerError('bad_hex', 'Expected a 0x-prefixed hexadecimal quantity.');
  }
  return hex === '0x' ? 0n : BigInt(hex);
}

export function toHexQuantity(number) {
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new LedgerError('bad_block', 'A block number is a whole number, zero or more.');
  }
  return '0x' + number.toString(16);
}

/**
 * Exact decimal string for an integer amount of base units. BigInt only: no
 * floating point. Trailing zeros are trimmed down to `minFraction` places.
 */
export function formatUnits(value, decimals = NATIVE_DECIMALS, minFraction = 2) {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  let fraction = decimals === 0 ? '' : (absolute % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, '0');
  return (negative ? '-' : '') + whole.toString() + (fraction ? '.' + fraction : '');
}

export function isoTime(seconds) {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}

function abortError() {
  const error = new Error('Cancelled.');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error) {
  return Boolean(error) && error.name === 'AbortError';
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------- decoding logs

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** The first topic of a log in lower case, or '' for a log that has none. */
function topic0(log) {
  return log && Array.isArray(log.topics) && typeof log.topics[0] === 'string' ? log.topics[0].toLowerCase() : '';
}

function logPosition(log) {
  return {
    block: Number(hexToBigInt(log.blockNumber)),
    txHash: log.transactionHash.toLowerCase(),
    logIndex: Number(hexToBigInt(log.logIndex)),
    timestamp: log.blockTimestamp ? Number(hexToBigInt(log.blockTimestamp)) : null,
  };
}

/** Decode one `Transfer(address indexed from, address indexed to, uint256 value)` log. */
export function decodeTransferLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 3 || topic0(log) !== TOPICS.transfer) {
    throw new LedgerError('not_transfer', 'This log is not a Transfer(address,address,uint256) event.');
  }
  if (typeof log.data !== 'string' || log.data.length !== 66) {
    throw new LedgerError('bad_transfer_data', 'A Transfer log carries exactly one 32-byte value.');
  }
  return {
    emitter: log.address.toLowerCase(),
    from: topicToAddress(log.topics[1]),
    to: topicToAddress(log.topics[2]),
    value: hexToBigInt(log.data),
    ...logPosition(log),
  };
}

/** Decode one `BeforeMemo(uint256 indexed memoIndex)` log. */
export function decodeBeforeMemoLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 2 || topic0(log) !== TOPICS.beforeMemo) {
    throw new LedgerError('not_before_memo', 'This log is not a BeforeMemo(uint256) event.');
  }
  return { memoIndex: hexToBigInt(log.topics[1]), ...logPosition(log) };
}

/**
 * Decode one `Memo(address indexed sender, address indexed target, bytes32 callDataHash,
 * bytes32 indexed memoId, bytes memo, uint256 memoIndex)` log.
 * Data is the ABI encoding of the three non-indexed fields: (bytes32, bytes, uint256).
 */
export function decodeMemoLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length !== 4 || topic0(log) !== TOPICS.memo) {
    throw new LedgerError('not_memo', 'This log is not a Memo(address,address,bytes32,bytes32,bytes,uint256) event.');
  }
  const data = hexToBytes(log.data);
  if (data.length < 128 || data.length % 32 !== 0) {
    throw new LedgerError('bad_memo_data', 'The Memo log data is shorter than its three fields.');
  }
  const word = (index) => {
    let value = 0n;
    for (let i = 0; i < 32; i++) value = (value << 8n) | BigInt(data[index * 32 + i]);
    return value;
  };
  const offset = word(1);
  if (offset % 32n !== 0n || offset < 96n || offset + 32n > BigInt(data.length)) {
    throw new LedgerError('bad_memo_data', 'The Memo log points outside its own data.');
  }
  const start = Number(offset);
  const length = word(start / 32);
  if (BigInt(start) + 32n + length > BigInt(data.length)) {
    throw new LedgerError('bad_memo_data', 'The Memo log declares more memo bytes than it carries.');
  }
  const memoBytes = data.slice(start + 32, start + 32 + Number(length));
  let memoHex = '0x';
  for (const byte of memoBytes) memoHex += byte.toString(16).padStart(2, '0');
  return {
    sender: topicToAddress(log.topics[1]),
    target: topicToAddress(log.topics[2]),
    memoId: log.topics[3].toLowerCase(),
    callDataHash: '0x' + log.data.slice(2, 66).toLowerCase(),
    memoIndex: word(2),
    memoHex,
    ...logPosition(log),
  };
}

/**
 * Show memo bytes as text only when they are strict UTF-8 with no control
 * characters other than tab and line breaks. Anything else is shown as hex.
 */
export function renderMemo(memoHex) {
  const bytes = hexToBytes(memoHex);
  if (bytes.length === 0) return { encoding: 'empty', text: '', hex: '0x' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f￾￿]/.test(text)) {
      return { encoding: 'utf8', text, hex: memoHex.toLowerCase() };
    }
  } catch {
    // not UTF-8: fall through to hex
  }
  return { encoding: 'hex', text: memoHex.toLowerCase(), hex: memoHex.toLowerCase(), readableParts: readableParts(bytes) };
}

/**
 * Runs of four or more printable ASCII characters inside binary memo bytes.
 * Many applications pack a note inside a larger binary memo; this only points
 * at the readable pieces. It does not decode the application's format.
 */
export function readableParts(bytes) {
  const parts = [];
  let run = '';
  const flush = () => {
    const piece = run.trim();
    if (piece.length >= 4) parts.push(piece);
    run = '';
  };
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e) run += String.fromCharCode(byte);
    else flush();
  }
  flush();
  return parts;
}

/**
 * Pick the USDC movements out of a list of logs.
 * The de-duplication rule: only logs from the native system emitter count.
 * An ERC-20 transfer() also emits a 6-decimal Transfer from the ERC-20 contract
 * for the same movement; that second log is ignored, never added.
 */
export function extractTransfers(logs) {
  const seen = new Map();
  for (const log of logs) {
    if (log.removed === true) continue;
    if (!sameAddress(log.address, SYSTEM_EMITTER)) continue;
    if (topic0(log) !== TOPICS.transfer) continue;
    const transfer = decodeTransferLog(log);
    seen.set(transfer.txHash + ':' + transfer.logIndex, transfer);
  }
  return [...seen.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

/**
 * Build memo frames for one transaction from its logs. The docs define the
 * order: BeforeMemo(memoIndex), then the target's events, then Memo(..., memoIndex).
 * A frame therefore spans the log indexes between the two events that share a memoIndex.
 */
export function memoFramesFromLogs(logs) {
  const starts = new Map();
  const frames = [];
  const ordered = logs
    .filter((log) => log.removed !== true && sameAddress(log.address, MEMO_CONTRACT) && topic0(log) !== '')
    .sort((a, b) => Number(hexToBigInt(a.logIndex)) - Number(hexToBigInt(b.logIndex)));
  for (const log of ordered) {
    const first = topic0(log);
    if (first === TOPICS.beforeMemo) {
      const before = decodeBeforeMemoLog(log);
      starts.set(before.memoIndex, before.logIndex);
    } else if (first === TOPICS.memo) {
      const memo = decodeMemoLog(log);
      const start = starts.has(memo.memoIndex) ? starts.get(memo.memoIndex) : null;
      frames.push({ start, end: memo.logIndex, memo });
    }
  }
  return frames;
}

/** The memo frames that enclose a log index, innermost first. */
export function framesAround(frames, logIndex) {
  return frames
    .filter((frame) => frame.start !== null && frame.start < logIndex && logIndex < frame.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
}

function publicMemo(memo) {
  const shown = renderMemo(memo.memoHex);
  return {
    text: shown.text,
    encoding: shown.encoding,
    hex: shown.hex,
    readableParts: shown.readableParts || [],
    memoId: memo.memoId,
    memoIndex: memo.memoIndex.toString(),
    sender: memo.sender,
    target: memo.target,
    callDataHash: memo.callDataHash,
  };
}

// ---------------------------------------------------------------- paging

/** Split an inclusive block range into inclusive chunks of at most `size` blocks. */
export function planChunks(fromBlock, toBlock, size = MAX_BLOCKS_PER_QUERY) {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
    throw new LedgerError('bad_range', 'The first block must be zero or more and not after the last block.');
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BLOCKS_PER_QUERY) {
    throw new LedgerError('bad_chunk', `A chunk is between 1 and ${MAX_BLOCKS_PER_QUERY} blocks.`);
  }
  const chunks = [];
  for (let start = fromBlock; start <= toBlock; start += size) {
    chunks.push([start, Math.min(toBlock, start + size - 1)]);
  }
  return chunks;
}

// ---------------------------------------------------------------- JSON-RPC client

/**
 * A small JSON-RPC client: one request at a time, a minimum gap between
 * requests, and retry with exponential back-off on HTTP 429, HTTP 5xx,
 * network failures and the documented "block not imported yet" error.
 */
export function createRpc({
  rpcUrl,
  fetchImpl = globalThis.fetch,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  maxRetries = 6,
  baseDelayMs = 1500,
  maxDelayMs = 30000,
  sleep = defaultSleep,
  now = () => Date.now(),
  signal,
  userAgent,
  onRetry,
} = {}) {
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl)) {
    throw new LedgerError('bad_rpc', 'The RPC address must start with http:// or https://.');
  }
  if (typeof fetchImpl !== 'function') throw new LedgerError('no_fetch', 'This runtime has no fetch().');

  const headers = { 'content-type': 'application/json' };
  // A browser sends its own User-Agent. Outside a browser the endpoint refuses
  // library defaults, so the reader names itself.
  if (userAgent) headers['user-agent'] = userAgent;

  let queue = Promise.resolve();
  let lastStart = -Infinity;
  let nextId = 1;
  const stats = { requests: 0, retries: 0 };

  async function backOff(attempt, reason, retryAfterSeconds) {
    let delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      delay = Math.min(maxDelayMs, Math.max(delay, retryAfterSeconds * 1000));
    }
    stats.retries++;
    if (onRetry) onRetry({ attempt: attempt + 1, delayMs: delay, reason });
    await sleep(delay, signal);
  }

  async function send(method, params) {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      const wait = lastStart + minIntervalMs - now();
      if (wait > 0) await sleep(wait, signal);
      throwIfAborted(signal);
      lastStart = now();
      stats.requests++;

      let response;
      try {
        response = await fetchImpl(rpcUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
          signal,
        });
      } catch (error) {
        if (isAbortError(error) || (signal && signal.aborted)) throw abortError();
        if (attempt >= maxRetries) throw new RpcError(`Could not reach the RPC: ${error.message}`);
        await backOff(attempt, 'network');
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= maxRetries) {
          throw new RpcError(`The RPC answered HTTP ${response.status} ${maxRetries + 1} times in a row.`, { status: response.status });
        }
        const retryAfter = response.headers && typeof response.headers.get === 'function' ? Number(response.headers.get('retry-after')) : NaN;
        await backOff(attempt, `http_${response.status}`, retryAfter);
        continue;
      }
      if (!response.ok) throw new RpcError(`The RPC answered HTTP ${response.status}.`, { status: response.status });

      let body;
      try {
        body = await response.json();
      } catch {
        throw new RpcError('The RPC answer was not JSON.');
      }
      if (body && body.error) {
        if (RETRIABLE_RPC_CODES.has(body.error.code) && attempt < maxRetries) {
          await backOff(attempt, `rpc_${body.error.code}`);
          continue;
        }
        throw new RpcError(`RPC error ${body.error.code}: ${body.error.message}`, { code: body.error.code });
      }
      if (!body || !('result' in body)) throw new RpcError('The RPC answer had no result.');
      return body.result;
    }
  }

  function call(method, params = []) {
    const result = queue.then(() => send(method, params));
    queue = result.catch(() => {});
    return result;
  }

  return { call, stats, rpcUrl };
}

function defaultUserAgent() {
  const inBrowser = typeof document !== 'undefined';
  return inBrowser ? undefined : `Mozilla/5.0 (compatible; arc-memo-ledger/${VERSION}; +https://github.com/InnovateDigi/arc-memo-ledger)`;
}

function resolveNetwork(network, rpcUrl) {
  const chosen = typeof network === 'string' ? NETWORKS[network] : network;
  if (chosen) return { ...chosen, rpcUrl: rpcUrl || chosen.rpcUrl };
  if (network !== undefined && network !== null) throw new LedgerError('bad_network', 'The network is "mainnet" or "testnet".');
  const known = Object.values(NETWORKS).find((item) => item.rpcUrl === rpcUrl);
  return { ...(known || NETWORKS.mainnet), rpcUrl: rpcUrl || NETWORKS.mainnet.rpcUrl };
}

function makeRpc(options, net) {
  if (options.rpc) return options.rpc;
  return createRpc({
    rpcUrl: net.rpcUrl,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    minIntervalMs: options.minIntervalMs,
    maxRetries: options.maxRetries,
    baseDelayMs: options.baseDelayMs,
    sleep: options.sleep,
    now: options.now,
    onRetry: options.onRetry,
    userAgent: options.userAgent === undefined ? defaultUserAgent() : options.userAgent,
  });
}

async function checkChain(rpc, net) {
  const chainId = Number(hexToBigInt(await rpc.call('eth_chainId', [])));
  if (chainId !== net.chainId) {
    throw new LedgerError('wrong_chain', `This RPC is chain ${chainId}, not ${net.name} (chain ${net.chainId}).`);
  }
  return chainId;
}

// ---------------------------------------------------------------- time to block

async function blockTimestamp(rpc, number) {
  const block = await rpc.call('eth_getBlockByNumber', [toHexQuantity(number), false]);
  if (!block || typeof block.timestamp !== 'string') throw new RpcError(`The RPC did not return block ${number}.`);
  return Number(hexToBigInt(block.timestamp));
}

/**
 * The lowest block whose timestamp is at or after `targetSeconds`.
 * Returns head.number + 1 when even the head block is earlier.
 *
 * Block timestamps on Arc never decrease, so the boundary can be searched for.
 * The search interpolates (blocks arrive at a steady pace), aims a few blocks
 * past its estimate on alternate sides so that both ends close in, and uses
 * plain bisection for the last few blocks and whenever an estimate was poor.
 */
export async function findBlockAtOrAfter(rpc, targetSeconds, head) {
  if (head.timestamp < targetSeconds) return head.number + 1;
  if (head.number === 0) return 0;
  let low = 0;
  let lowTime = await blockTimestamp(rpc, 0);
  if (lowTime >= targetSeconds) return 0;
  let high = head.number;
  let highTime = head.timestamp;
  if (high > 1) {
    // On Arc mainnet block 1 came days after block 0. Starting from block 1
    // keeps that pause out of the pace estimate.
    const firstTime = await blockTimestamp(rpc, 1);
    if (firstTime >= targetSeconds) return 1;
    low = 1;
    lowTime = firstTime;
  }
  let lastMoved = null;
  let bisectNext = false;
  while (high - low > 1) {
    const width = high - low;
    const bisect = bisectNext || width <= 16 || highTime === lowTime;
    let probe;
    if (bisect) {
      probe = low + Math.floor(width / 2);
    } else {
      const estimate = low + (width * (targetSeconds - lowTime)) / (highTime - lowTime);
      const pad = Math.max(3, Math.ceil(width * 0.0002));
      probe = Math.round(lastMoved === 'low' ? estimate + pad : lastMoved === 'high' ? estimate - pad : estimate);
    }
    probe = Math.min(high - 1, Math.max(low + 1, probe));
    const time = await blockTimestamp(rpc, probe);
    if (time >= targetSeconds) {
      high = probe;
      highTime = time;
      lastMoved = 'high';
    } else {
      low = probe;
      lowTime = time;
      lastMoved = 'low';
    }
    // An estimate that did not cut the window to a quarter is followed by a
    // plain halving, so the search always ends in a bounded number of requests.
    bisectNext = !bisect && high - low > width / 4;
  }
  return high;
}

/**
 * Turn a time range into a block range.
 * Give `hours` (the range ends at the newest block) or `fromTime` and `toTime`
 * in Unix seconds (fromTime inclusive, toTime exclusive).
 */
export async function resolveBlockRange(options = {}) {
  const net = resolveNetwork(options.network, options.rpcUrl);
  const rpc = makeRpc(options, net);
  const headNumber = Number(hexToBigInt(await rpc.call('eth_blockNumber', [])));
  const head = { number: headNumber, timestamp: await blockTimestamp(rpc, headNumber) };

  let fromTime;
  let toBlock = head.number;
  if (options.hours !== undefined) {
    if (!(Number(options.hours) > 0)) throw new LedgerError('bad_range', 'The number of hours must be more than zero.');
    fromTime = head.timestamp - Math.round(Number(options.hours) * 3600);
  } else {
    fromTime = Number(options.fromTime);
    const toTime = options.toTime === undefined ? undefined : Number(options.toTime);
    if (!Number.isFinite(fromTime)) throw new LedgerError('bad_range', 'A start time is needed.');
    if (toTime !== undefined) {
      if (!Number.isFinite(toTime) || toTime <= fromTime) throw new LedgerError('bad_range', 'The end must be after the start.');
      toBlock = (await findBlockAtOrAfter(rpc, toTime, head)) - 1;
    }
  }
  const fromBlock = await findBlockAtOrAfter(rpc, fromTime, head);
  if (toBlock < fromBlock) throw new LedgerError('empty_range', 'There is no block in that time range.');
  return { fromBlock, toBlock, headBlock: head.number, headTime: head.timestamp };
}

/**
 * A receipt, asked for up to three times: the public endpoint is load-balanced,
 * and a backend that is a block behind answers null for a very recent transaction.
 */
async function getReceipt(rpc, txHash, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const receipt = await rpc.call('eth_getTransactionReceipt', [txHash]);
    if (receipt) return receipt;
  }
  return null;
}

/**
 * eth_getLogs for one chunk. If the node refuses the query itself (for example
 * because it would return too many logs), the chunk is halved and tried again,
 * down to a single block.
 */
export async function getLogsAdaptive(rpc, filter, fromBlock, toBlock) {
  try {
    return await rpc.call('eth_getLogs', [{ fromBlock: toHexQuantity(fromBlock), toBlock: toHexQuantity(toBlock), ...filter }]);
  } catch (error) {
    if (!(error instanceof RpcError) || error.code === undefined || fromBlock >= toBlock) throw error;
    const middle = fromBlock + Math.floor((toBlock - fromBlock) / 2);
    const lower = await getLogsAdaptive(rpc, filter, fromBlock, middle);
    const upper = await getLogsAdaptive(rpc, filter, middle + 1, toBlock);
    return [...lower, ...upper];
  }
}

// ---------------------------------------------------------------- the ledger

function describeReceipt(receipt, fallbackTimestamp) {
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const frames = memoFramesFromLogs(logs);
  const transfers = extractTransfers(logs).map((transfer) => {
    const around = framesAround(frames, transfer.logIndex);
    return {
      ...transfer,
      memo: around.length ? publicMemo(around[0].memo) : null,
      outerMemos: around.slice(1).map((frame) => publicMemo(frame.memo)),
    };
  });
  const fee = hexToBigInt(receipt.gasUsed) * hexToBigInt(receipt.effectiveGasPrice);
  const timestamps = logs.map((log) => log.blockTimestamp).filter(Boolean);
  return {
    txHash: receipt.transactionHash.toLowerCase(),
    block: Number(hexToBigInt(receipt.blockNumber)),
    timestamp: timestamps.length ? Number(hexToBigInt(timestamps[0])) : fallbackTimestamp ?? null,
    succeeded: receipt.status === '0x1',
    from: receipt.from.toLowerCase(),
    to: receipt.to ? receipt.to.toLowerCase() : null,
    fee,
    transfers,
    memos: frames.map((frame) => publicMemo(frame.memo)),
    // How many 6-decimal ERC-20 logs repeated a movement and were left out.
    duplicateErc20Logs: logs.filter((log) => sameAddress(log.address, USDC_ERC20) && topic0(log) === TOPICS.transfer).length,
  };
}

function kindOf(transfer) {
  if (transfer.from === ZERO_ADDRESS) return 'mint';
  if (transfer.to === ZERO_ADDRESS) return 'burn';
  return 'transfer';
}

/**
 * Every USDC payment into and out of `address` between two blocks (inclusive),
 * with memos, the fees the address paid, totals and a balance check.
 *
 * @param {object} options
 * @param {string} options.address    account to report on
 * @param {number} options.fromBlock  first block (inclusive)
 * @param {number} [options.toBlock]  last block (inclusive); newest block when omitted
 * @param {string} [options.rpcUrl]   defaults to the chosen network's public RPC
 * @param {'mainnet'|'testnet'} [options.network] defaults to mainnet
 * @param {(progress: object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal] cancels the run
 */
export async function fetchLedger(options = {}) {
  const address = normalizeAddress(options.address);
  const net = resolveNetwork(options.network, options.rpcUrl);
  const rpc = makeRpc(options, net);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal;

  await checkChain(rpc, net);
  let toBlock = options.toBlock;
  if (toBlock === undefined || toBlock === null || toBlock === 'latest') {
    toBlock = Number(hexToBigInt(await rpc.call('eth_blockNumber', [])));
  }
  const fromBlock = options.fromBlock;
  const chunks = planChunks(fromBlock, toBlock, options.chunkSize || MAX_BLOCKS_PER_QUERY);

  // 1. Logs, filtered by indexed topic so only this address's logs come back.
  //    a) any event, from any contract, whose first indexed argument is the address:
  //       USDC it sent, and also approvals, memos and other tokens, which is how
  //       transactions that cost a fee but moved no USDC are found;
  //    b) USDC it received (system emitter, address as the second indexed argument).
  const topic = addressToTopic(address);
  const rawLogs = [];
  for (let i = 0; i < chunks.length; i++) {
    throwIfAborted(signal);
    const [first, last] = chunks[i];
    const named = await getLogsAdaptive(rpc, { topics: [null, topic] }, first, last);
    const received = await getLogsAdaptive(rpc, { address: SYSTEM_EMITTER, topics: [TOPICS.transfer, null, topic] }, first, last);
    for (const log of named) if (log.removed !== true) rawLogs.push(log);
    for (const log of received) if (log.removed !== true) rawLogs.push(log);
    progress({ phase: 'logs', done: i + 1, total: chunks.length, found: rawLogs.length, block: last });
  }
  const transfers = extractTransfers(rawLogs).filter((transfer) => transfer.from === address || transfer.to === address);

  // 2. One receipt per transaction: who sent it, what it cost, and its memo events.
  const firstSeen = new Map();
  for (const log of rawLogs) {
    const position = logPosition(log);
    const known = firstSeen.get(position.txHash);
    if (!known || position.block < known.block || (position.block === known.block && position.logIndex < known.logIndex)) {
      firstSeen.set(position.txHash, position);
    }
  }
  const txHashes = [...firstSeen.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex).map((item) => item.txHash);
  const receipts = new Map();
  for (let i = 0; i < txHashes.length; i++) {
    throwIfAborted(signal);
    const receipt = await getReceipt(rpc, txHashes[i]);
    if (!receipt) throw new RpcError(`The RPC did not return the receipt of ${txHashes[i]}.`);
    receipts.set(txHashes[i], describeReceipt(receipt));
    progress({ phase: 'receipts', done: i + 1, total: txHashes.length, found: transfers.length });
  }

  // 3. Rows.
  const blockTimes = new Map();
  const timeOf = async (block, known) => {
    if (known !== null && known !== undefined) return known;
    if (!blockTimes.has(block)) blockTimes.set(block, await blockTimestamp(rpc, block));
    return blockTimes.get(block);
  };
  const feeCharged = new Set();
  let totalIn = 0n;
  let totalOut = 0n;
  let totalFees = 0n;
  const payments = [];
  for (const transfer of transfers) {
    const receipt = receipts.get(transfer.txHash);
    const inReceipt = receipt.transfers.find((item) => item.logIndex === transfer.logIndex);
    if (!inReceipt || inReceipt.value !== transfer.value) {
      throw new LedgerError('mismatch', `The receipt of ${transfer.txHash} does not contain the transfer the log query returned.`);
    }
    const timestamp = await timeOf(transfer.block, transfer.timestamp ?? receipt.timestamp);
    const direction = transfer.to === address ? 'in' : 'out';
    if (direction === 'in') totalIn += transfer.value;
    else totalOut += transfer.value;

    const sentByAddress = receipt.from === address;
    let fee = null;
    if (sentByAddress && !feeCharged.has(transfer.txHash)) {
      feeCharged.add(transfer.txHash);
      fee = receipt.fee;
      totalFees += fee;
    }
    payments.push({
      time: isoTime(timestamp),
      timestamp,
      block: transfer.block,
      txHash: transfer.txHash,
      logIndex: transfer.logIndex,
      direction,
      counterparty: direction === 'in' ? transfer.from : transfer.to,
      kind: kindOf(transfer),
      amount: formatUnits(transfer.value),
      amountBaseUnits: transfer.value.toString(),
      memo: inReceipt.memo,
      outerMemos: inReceipt.outerMemos,
      sentByAddress,
      // The fee of a transaction is shown once, on its first row, so a column sum is right.
      fee: fee === null ? '' : formatUnits(fee),
      feeBaseUnits: fee === null ? '' : fee.toString(),
    });
  }

  // Transactions the address sent that moved none of its USDC: only a fee was paid.
  const feeOnly = [];
  for (const txHash of txHashes) {
    const receipt = receipts.get(txHash);
    if (receipt.from !== address || feeCharged.has(txHash)) continue;
    feeCharged.add(txHash);
    totalFees += receipt.fee;
    const timestamp = await timeOf(receipt.block, receipt.timestamp);
    feeOnly.push({
      time: isoTime(timestamp),
      timestamp,
      block: receipt.block,
      txHash,
      logIndex: firstSeen.get(txHash).logIndex,
      to: receipt.to,
      succeeded: receipt.succeeded,
      memo: receipt.memos.length ? receipt.memos[0] : null,
      fee: formatUnits(receipt.fee),
      feeBaseUnits: receipt.fee.toString(),
    });
  }

  // 4. Balance check, only when the RPC serves the state at both ends.
  let balanceCheck = { available: false, reason: 'not requested' };
  if (options.checkBalance !== false) {
    progress({ phase: 'balance', done: 0, total: 2, found: payments.length });
    balanceCheck = await computeBalanceCheck(rpc, address, fromBlock, toBlock, { totalIn, totalOut, totalFees, sentFound: feeCharged.size });
    progress({ phase: 'balance', done: 2, total: 2, found: payments.length });
  }

  const firstTime = payments.length ? payments[0].timestamp : null;
  return {
    tool: 'arc-memo-ledger',
    version: VERSION,
    network: { name: net.name, chainId: net.chainId, rpcUrl: net.rpcUrl, explorer: net.explorer },
    address,
    range: { fromBlock, toBlock, blocks: toBlock - fromBlock + 1 },
    generatedAt: new Date().toISOString(),
    unit: 'USDC',
    decimals: NATIVE_DECIMALS,
    payments,
    feeOnly,
    totals: {
      payments: payments.length,
      feeOnlyTransactions: feeOnly.length,
      transactions: new Set([...payments.map((payment) => payment.txHash), ...feeOnly.map((item) => item.txHash)]).size,
      in: formatUnits(totalIn),
      out: formatUnits(totalOut),
      fees: formatUnits(totalFees),
      net: formatUnits(totalIn - totalOut - totalFees),
      inBaseUnits: totalIn.toString(),
      outBaseUnits: totalOut.toString(),
      feesBaseUnits: totalFees.toString(),
      netBaseUnits: (totalIn - totalOut - totalFees).toString(),
      firstPaymentTime: firstTime === null ? null : isoTime(firstTime),
      lastPaymentTime: payments.length ? payments[payments.length - 1].time : null,
    },
    balanceCheck,
    rpcRequests: rpc.stats ? rpc.stats.requests : null,
  };
}

/**
 * opening balance + payments in - payments out - fees = closing balance ?
 * Both balances are read from the chain (eth_getBalance at the block before the
 * range and at its last block). If either read fails, the check is reported as
 * unavailable with the RPC's own reason: nothing is assumed.
 */
export async function computeBalanceCheck(rpc, address, fromBlock, toBlock, { totalIn, totalOut, totalFees, sentFound }) {
  if (fromBlock === 0) {
    return { available: false, reason: 'The range starts at block 0, so there is no earlier block to read an opening balance from.' };
  }
  let opening;
  let closing;
  try {
    opening = hexToBigInt(await rpc.call('eth_getBalance', [address, toHexQuantity(fromBlock - 1)]));
    closing = hexToBigInt(await rpc.call('eth_getBalance', [address, toHexQuantity(toBlock)]));
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { available: false, reason: `The RPC did not serve a historical balance: ${error.message}` };
  }
  const expected = opening + totalIn - totalOut - totalFees;
  const difference = closing - expected;
  const check = {
    available: true,
    openingBlock: fromBlock - 1,
    closingBlock: toBlock,
    opening: formatUnits(opening),
    closing: formatUnits(closing),
    expectedClosing: formatUnits(expected),
    difference: formatUnits(difference),
    openingBaseUnits: opening.toString(),
    closingBaseUnits: closing.toString(),
    expectedClosingBaseUnits: expected.toString(),
    differenceBaseUnits: difference.toString(),
    reconciled: difference === 0n,
    explanation: 'reconciled',
  };
  if (difference === 0n) return check;

  // A remainder. The usual cause is a transaction the address sent that left no
  // event naming it (a failed call, for example): it paid a fee that no log shows.
  // The account's nonce says how many transactions it sent, so the number of
  // unlisted ones can be counted even though they cannot be itemised.
  let sentByNonce = null;
  let isContract = null;
  try {
    const before = hexToBigInt(await rpc.call('eth_getTransactionCount', [address, toHexQuantity(fromBlock - 1)]));
    const after = hexToBigInt(await rpc.call('eth_getTransactionCount', [address, toHexQuantity(toBlock)]));
    sentByNonce = Number(after - before);
    const code = await rpc.call('eth_getCode', [address, toHexQuantity(toBlock)]);
    isContract = typeof code === 'string' && code !== '0x';
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  const known = sentByNonce !== null && Number.isSafeInteger(sentFound);
  check.sentFound = Number.isSafeInteger(sentFound) ? sentFound : null;
  check.sentByNonce = sentByNonce;
  check.sentNotFound = known ? sentByNonce - sentFound : null;
  check.isContract = isContract;
  // Only a shortfall, on an ordinary account, with unlisted transactions to
  // account for it, is put down to their fees. Anything else is "not explained".
  const unlistedFees = difference < 0n && known && check.sentNotFound > 0 && isContract === false;
  check.explanation = unlistedFees ? 'unlisted_fees' : 'not_explained';
  check.unlistedFees = unlistedFees ? formatUnits(-difference) : null;
  return check;
}

/** One transaction as a receipt: every USDC movement in it, its memos and its fee. */
export async function fetchReceipt(options = {}) {
  const txHash = normalizeTxHash(options.txHash);
  const net = resolveNetwork(options.network, options.rpcUrl);
  const rpc = makeRpc(options, net);
  await checkChain(rpc, net);
  const receipt = await getReceipt(rpc, txHash);
  if (!receipt) throw new LedgerError('not_found', `No transaction ${txHash} on ${net.name}.`);
  let fallbackTimestamp = null;
  if (!(receipt.logs || []).some((log) => log.blockTimestamp)) {
    fallbackTimestamp = await blockTimestamp(rpc, Number(hexToBigInt(receipt.blockNumber)));
  }
  const described = describeReceipt(receipt, fallbackTimestamp);
  return {
    tool: 'arc-memo-ledger',
    version: VERSION,
    network: { name: net.name, chainId: net.chainId, rpcUrl: net.rpcUrl, explorer: net.explorer },
    txHash,
    succeeded: described.succeeded,
    block: described.block,
    time: described.timestamp === null ? null : isoTime(described.timestamp),
    sender: described.from,
    to: described.to,
    fee: formatUnits(described.fee),
    feeBaseUnits: described.fee.toString(),
    unit: 'USDC',
    movements: described.transfers.map((transfer) => ({
      logIndex: transfer.logIndex,
      from: transfer.from,
      to: transfer.to,
      kind: kindOf(transfer),
      amount: formatUnits(transfer.value),
      amountBaseUnits: transfer.value.toString(),
      memo: transfer.memo,
      outerMemos: transfer.outerMemos,
    })),
    memos: described.memos,
    duplicateErc20LogsIgnored: described.duplicateErc20Logs,
  };
}

// ---------------------------------------------------------------- CSV

/**
 * One CSV cell. Quotes cells that contain a comma, a quote or a line break, and
 * puts an apostrophe in front of cells that a spreadsheet would run as a formula
 * (a leading = + - @, tab or carriage return).
 */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  if (/[",\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
  return text;
}

export const CSV_COLUMNS = Object.freeze([
  'time_utc', 'block', 'tx_hash', 'log_index', 'direction', 'counterparty', 'kind',
  'amount_usdc', 'fee_usdc', 'memo', 'memo_encoding', 'memo_readable_parts', 'memo_hex', 'memo_id', 'explorer_url',
]);

/** Payments and fee-only transactions as one list, oldest first. */
export function ledgerRows(ledger) {
  const rows = [
    ...ledger.payments.map((payment) => ({ ...payment, type: 'payment' })),
    ...(ledger.feeOnly || []).map((item) => ({
      ...item, type: 'fee-only', direction: 'fee only', counterparty: item.to || '', kind: 'fee only', amount: '0.00', amountBaseUnits: '0',
    })),
  ];
  return rows.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

export function ledgerToCsv(ledger) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of ledgerRows(ledger)) {
    lines.push([
      row.time, row.block, row.txHash, row.logIndex, row.direction, row.counterparty, row.kind,
      row.amount, row.fee,
      row.memo ? row.memo.text : '', row.memo ? row.memo.encoding : '', row.memo ? (row.memo.readableParts || []).join(' | ') : '',
      row.memo ? row.memo.hex : '',
      row.memo ? row.memo.memoId : '', `${ledger.network.explorer}/tx/${row.txHash}`,
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
