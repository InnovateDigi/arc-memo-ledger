import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeTransferLog, decodeMemoLog, decodeBeforeMemoLog, extractTransfers, memoFramesFromLogs, framesAround, renderMemo,
  readableParts, formatUnits, hexToBigInt, addressToTopic, topicToAddress, normalizeAddress, normalizeTxHash, toHexQuantity, isoTime,
  TOPICS, SYSTEM_EMITTER, USDC_ERC20, MEMO_CONTRACT, LedgerError,
} from '../src/ledger.mjs';
import { fixture } from './helpers.mjs';

// Real mainnet receipt, block 24,358,200: three ERC-20 USDC transfers, each wrapped in a memo.
const receipt = fixture('receipt_memo_f0a3c947.json').response.result;
const SENDER = '0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e';

test('decodes a real system Transfer log (18 decimals)', () => {
  const transfer = decodeTransferLog(receipt.logs[1]);
  assert.equal(transfer.emitter, SYSTEM_EMITTER);
  assert.equal(transfer.from, SENDER);
  assert.equal(transfer.to, '0xe874c32569a28b2d0bca07ef25f0ec0b68beedd0');
  assert.equal(transfer.value, 140000000000000000n);
  assert.equal(transfer.block, 24358200);
  assert.equal(transfer.logIndex, 3);
  assert.equal(transfer.timestamp, 1791186997);
  assert.equal(isoTime(transfer.timestamp), '2026-10-05T07:56:37Z');
  assert.equal(formatUnits(transfer.value), '0.14');
});

test('the 6-decimal ERC-20 log repeats the same movement: value x 10^12 is the system value', () => {
  for (const index of [1, 5, 9]) {
    const system = decodeTransferLog(receipt.logs[index]);
    const erc20 = decodeTransferLog(receipt.logs[index + 1]);
    assert.equal(system.emitter, SYSTEM_EMITTER);
    assert.equal(erc20.emitter, USDC_ERC20);
    assert.equal(erc20.from, system.from);
    assert.equal(erc20.to, system.to);
    assert.equal(erc20.value * 10n ** 12n, system.value);
  }
});

test('de-duplication rule: six Transfer logs in the receipt are three movements', () => {
  const allTransferLogs = receipt.logs.filter((log) => log.topics[0] === TOPICS.transfer);
  assert.equal(allTransferLogs.length, 6);
  const transfers = extractTransfers(receipt.logs);
  assert.equal(transfers.length, 3);
  assert.ok(transfers.every((transfer) => transfer.emitter === SYSTEM_EMITTER));
  assert.deepEqual(transfers.map((transfer) => transfer.value), [140000000000000000n, 40000000000000000n, 40000000000000000n]);
  // The same log returned twice (overlapping pages, a retry) is still counted once.
  assert.equal(extractTransfers([...receipt.logs, ...receipt.logs]).length, 3);
  // A log flagged as removed is not counted.
  assert.equal(extractTransfers(receipt.logs.map((log, i) => (i === 1 ? { ...log, removed: true } : log))).length, 2);
});

test('a Transfer from another contract with the same topic is not USDC and is ignored', () => {
  const other = { ...receipt.logs[1], address: '0x1111111111111111111111111111111111111111', logIndex: '0x63' };
  assert.equal(extractTransfers([...receipt.logs, other]).length, 3);
});

test('decodes a real Memo log exactly as the documented event defines it', () => {
  const memo = decodeMemoLog(receipt.logs[3]);
  assert.equal(memo.sender, SENDER);
  assert.equal(memo.target, USDC_ERC20);
  assert.equal(memo.memoId, '0x2a347f30ee846742db4e217cb9eb14c4bca7bdc76664bb3925ee25aeb4b069ad');
  assert.equal(memo.callDataHash, '0x763b3461552ff8126a4935e123f8c95bc7737f86b1a2b2957b2f8110ebbc394a');
  assert.equal(memo.memoIndex, 844n);
  assert.equal((memo.memoHex.length - 2) / 2, 128);
  assert.equal(renderMemo(memo.memoHex).encoding, 'hex');
  assert.equal(decodeBeforeMemoLog(receipt.logs[0]).memoIndex, 844n);
});

test('memo frames: each transfer sits between its BeforeMemo and its Memo', () => {
  const frames = memoFramesFromLogs(receipt.logs);
  assert.deepEqual(frames.map((frame) => [frame.start, frame.end, frame.memo.memoIndex]), [[2, 5, 844n], [6, 9, 845n], [10, 13, 846n]]);
  const transfers = extractTransfers(receipt.logs);
  assert.deepEqual(transfers.map((transfer) => framesAround(frames, transfer.logIndex).map((frame) => frame.memo.memoIndex)), [[844n], [845n], [846n]]);
  assert.deepEqual(framesAround(frames, 1), []);
  assert.deepEqual(framesAround(frames, 5), []);
});

test('nested memo frames come back innermost first', () => {
  const at = (log, index) => ({ ...log, logIndex: '0x' + index.toString(16) });
  const withIndex = (log, memoIndex) => ({ ...log, data: log.data.slice(0, 2 + 64 * 2) + memoIndex.toString(16).padStart(64, '0') + log.data.slice(2 + 64 * 3) });
  const before = (memoIndex) => ({ ...receipt.logs[0], topics: [TOPICS.beforeMemo, '0x' + memoIndex.toString(16).padStart(64, '0')] });
  const logs = [
    at(before(7), 0), at(before(8), 1), at(receipt.logs[1], 2), at(withIndex(receipt.logs[3], 8), 3), at(withIndex(receipt.logs[3], 7), 4),
  ];
  const frames = memoFramesFromLogs(logs);
  assert.deepEqual(framesAround(frames, 2).map((frame) => frame.memo.memoIndex), [8n, 7n]);
});

test('a Memo event without its BeforeMemo is kept but attached to nothing', () => {
  const frames = memoFramesFromLogs([receipt.logs[1], receipt.logs[3]]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].start, null);
  assert.deepEqual(framesAround(frames, 3), []);
});

test('all 60 real Memo logs recorded from mainnet decode; 8 are text', () => {
  const recorded = fixture('memo_logs_recent.json');
  assert.equal(recorded.logs.length, 60);
  const shown = recorded.logs.map((log) => {
    assert.equal(log.address, MEMO_CONTRACT);
    assert.equal(log.topics[0], TOPICS.memo);
    return renderMemo(decodeMemoLog(log).memoHex);
  });
  assert.equal(shown.filter((memo) => memo.encoding === 'utf8').length, 8);
  assert.equal(shown.filter((memo) => memo.encoding === 'hex').length, 52);
  const texts = shown.filter((memo) => memo.encoding === 'utf8').map((memo) => memo.text);
  assert.ok(texts.includes('Tax pay'));
  assert.ok(texts.includes('Invoice 001'));
  assert.ok(texts.includes('arc nice note'));
});

test('memo text rule: strict UTF-8 without control characters, otherwise hex', () => {
  const hex = (text) => '0x' + Buffer.from(text, 'utf8').toString('hex');
  assert.deepEqual(renderMemo(hex('Invoice 001')), { encoding: 'utf8', text: 'Invoice 001', hex: hex('Invoice 001') });
  assert.equal(renderMemo(hex('café ☕ 請求書')).text, 'café ☕ 請求書');
  assert.equal(renderMemo(hex('line one\nline two\ttabbed')).encoding, 'utf8');
  assert.deepEqual(renderMemo('0x'), { encoding: 'empty', text: '', hex: '0x' });
  assert.deepEqual(renderMemo('0xff'), { encoding: 'hex', text: '0xff', hex: '0xff', readableParts: [] });
  assert.equal(renderMemo('0xc3').encoding, 'hex', 'a cut-off multi-byte character is not text');
  assert.equal(renderMemo('0x4100').encoding, 'hex', 'a NUL byte is not shown as text');
  assert.equal(renderMemo('0x1b5b316d').encoding, 'hex', 'an escape sequence is not shown as text');
  assert.equal(renderMemo('0xC3A9').hex, '0xc3a9');
});

test('malformed logs are refused, never guessed', () => {
  const memoLog = receipt.logs[3];
  assert.throws(() => decodeTransferLog(memoLog), LedgerError);
  assert.throws(() => decodeTransferLog({ ...receipt.logs[1], data: '0x01' }), LedgerError);
  assert.throws(() => decodeTransferLog({ ...receipt.logs[1], topics: receipt.logs[1].topics.slice(0, 2) }), LedgerError);
  assert.throws(() => decodeMemoLog(receipt.logs[1]), LedgerError);
  assert.throws(() => decodeMemoLog({ ...memoLog, data: memoLog.data.slice(0, 2 + 64 * 3) }), LedgerError);
  // offset pointing outside the data
  const badOffset = memoLog.data.slice(0, 66) + 'f'.repeat(64) + memoLog.data.slice(130);
  assert.throws(() => decodeMemoLog({ ...memoLog, data: badOffset }), LedgerError);
  // declared length longer than the data
  const badLength = memoLog.data.slice(0, 2 + 64 * 3) + '0'.repeat(60) + 'ffff' + memoLog.data.slice(2 + 64 * 4);
  assert.throws(() => decodeMemoLog({ ...memoLog, data: badLength }), LedgerError);
  assert.throws(() => decodeBeforeMemoLog(memoLog), LedgerError);
});

test('amounts: 18 decimals, exact, BigInt only', () => {
  assert.equal(formatUnits(0n), '0.00');
  assert.equal(formatUnits(1n), '0.000000000000000001');
  assert.equal(formatUnits(10n ** 18n), '1.00');
  assert.equal(formatUnits(1500000000000000000n), '1.50');
  assert.equal(formatUnits(1234567890123456789n), '1.234567890123456789');
  assert.equal(formatUnits(-420000210000000n), '-0.00042000021');
  assert.equal(formatUnits('6387100000000000'), '0.0063871');
  // far beyond what a floating point number can hold exactly
  assert.equal(formatUnits(2n ** 256n - 1n), '115792089237316195423570985008687907853269984665640564039457.584007913129639935');
  assert.equal(formatUnits(123456789012345678901234567890n), '123456789012.34567890123456789');
  assert.equal(formatUnits(140000n, 6), '0.14');
  assert.equal(formatUnits(5n, 0, 0), '5');
  assert.equal(formatUnits(10n ** 18n, 18, 0), '1');
  assert.equal(hexToBigInt('0x01f161421c8e0000'), 140000000000000000n);
  assert.equal(hexToBigInt('0x'), 0n);
  assert.throws(() => hexToBigInt('12'), LedgerError);
  assert.throws(() => hexToBigInt('0xzz'), LedgerError);
});

test('addresses, hashes and quantities', () => {
  assert.equal(normalizeAddress(' 0xC541c196F38F2A92e87E3835dF2a8F68cCDb4d0E '), SENDER);
  assert.equal(addressToTopic(SENDER), receipt.logs[1].topics[1]);
  assert.equal(topicToAddress(receipt.logs[1].topics[1]), SENDER);
  for (const bad of ['', '0x', '0x123', SENDER + '00', 'c541c196f38f2a92e87e3835df2a8f68ccdb4d0e', null, 5, '0xZ541c196f38f2a92e87e3835df2a8f68ccdb4d0e']) {
    assert.throws(() => normalizeAddress(bad), LedgerError);
  }
  assert.throws(() => topicToAddress('0x01' + '0'.repeat(22) + SENDER.slice(2)), LedgerError);
  assert.equal(normalizeTxHash(receipt.transactionHash.toUpperCase().replace('0X', '0x')), receipt.transactionHash);
  assert.throws(() => normalizeTxHash(SENDER), LedgerError);
  assert.equal(toHexQuantity(24358200), '0x173ad38');
  assert.equal(toHexQuantity(0), '0x0');
  for (const bad of [-1, 1.5, NaN, '5']) assert.throws(() => toHexQuantity(bad), LedgerError);
});

test('readable pieces inside a binary memo are pointed out, the bytes stay hex', () => {
  const recorded = fixture('ledger_sender_c541c196.json');
  const receipt = recorded.exchanges.find((item) => item.method === 'eth_getTransactionReceipt' && item.response.result.transactionHash.startsWith('0x4677de12')).response.result;
  const memo = decodeMemoLog(receipt.logs.find((log) => log.topics[0] === TOPICS.memo));
  const shown = renderMemo(memo.memoHex);
  assert.equal(shown.encoding, 'hex');
  assert.deepEqual(shown.readableParts, ['Coffee and pastries']);
  assert.deepEqual(readableParts(Uint8Array.from([0, 0x61, 0x62, 0x63, 0, 0x41, 0x42, 0x43, 0x44, 0x20, 0x45, 0xff, 0x20, 0x20, 0x20, 0x20, 0x20])), ['ABCD E']);
  assert.deepEqual(readableParts(new Uint8Array(64)), []);
});

test('logs without any topic (anonymous events) are skipped, not a crash', () => {
  const anonymous = { ...receipt.logs[1], address: '0x2222222222222222222222222222222222222222', topics: [], logIndex: '0x40' };
  const fromMemo = { ...receipt.logs[0], topics: [], logIndex: '0x41' };
  assert.equal(extractTransfers([...receipt.logs, anonymous, fromMemo]).length, 3);
  assert.equal(memoFramesFromLogs([...receipt.logs, anonymous, fromMemo]).length, 3);
  assert.throws(() => decodeTransferLog(anonymous), LedgerError);
  assert.throws(() => decodeMemoLog(fromMemo), LedgerError);
});
