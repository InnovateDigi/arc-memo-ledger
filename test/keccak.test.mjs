import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keccak256, sha3_256, hexToBytes, bytesToHex } from '../src/keccak.mjs';
import { TOPICS, SIGNATURES } from '../src/ledger.mjs';
import { fixture } from './helpers.mjs';

test('keccak256 known answers', () => {
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256('hello world'), '0x47173285a8d7341e5e972fc677286384f802f8ef42a5ec5f03bbfa254cb01fad');
  assert.equal(keccak256(new Uint8Array(0)), keccak256(''));
});

test('the Transfer topic0 equals the value printed in the Arc documentation', () => {
  // docs: arc/references/usdc-system-events, row "topic0"
  assert.equal(TOPICS.transfer, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  assert.equal(keccak256(SIGNATURES.transfer), TOPICS.transfer);
});

test('the same sponge with SHA-3 padding matches the platform SHA3-256 at every length around the block size', () => {
  for (let length = 0; length <= 420; length++) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 31 + length * 7) & 0xff;
    assert.equal(sha3_256(bytes), '0x' + createHash('sha3-256').update(bytes).digest('hex'), `length ${length}`);
  }
});

test('keccak256 and SHA3-256 differ (the padding byte matters)', () => {
  assert.notEqual(keccak256('abc'), sha3_256('abc'));
});

test('memo event topics computed from the documented signatures match real mainnet logs', () => {
  const receipt = fixture('receipt_memo_f0a3c947.json').response.result;
  const memoLogs = receipt.logs.filter((log) => log.address === '0x5294e9927c3306dcbadb03fe70b92e01ccede505');
  assert.equal(memoLogs.length, 6);
  const topics = new Set(memoLogs.map((log) => log.topics[0]));
  assert.deepEqual([...topics].sort(), [TOPICS.beforeMemo, TOPICS.memo].sort());
  assert.equal(TOPICS.beforeMemo, '0xb252e055da754c72fbf7542cf424b190808a9b541e912894c5e15b4238c41501');
  assert.equal(TOPICS.memo, '0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4');
});

test('callDataHash of a real memo equals keccak256 of the forwarded calldata', () => {
  // docs: "callDataHash: keccak256 hash of the forwarded target calldata".
  // Real mainnet memo with empty calldata (tx 0x9803e9aa...): the hash of nothing.
  const receipt = fixture('receipt_text_memo.json').exchanges.find((item) => item.method === 'eth_getTransactionReceipt').response.result;
  const memoLog = receipt.logs.find((log) => log.topics[0] === TOPICS.memo);
  assert.equal('0x' + memoLog.data.slice(2, 66), keccak256(''));
  // Real mainnet memo around an ERC-20 transfer (tx 0xf0a3c947...): transfer(address,uint256) calldata.
  const big = fixture('receipt_memo_f0a3c947.json').response.result;
  const erc20 = big.logs[2];
  const memo = big.logs[3];
  const selector = keccak256('transfer(address,uint256)').slice(0, 10);
  const calldata = selector + erc20.topics[2].slice(2) + erc20.data.slice(2);
  assert.equal(keccak256(hexToBytes(calldata)), '0x' + memo.data.slice(2, 66));
});

test('hex helpers', () => {
  assert.equal(bytesToHex(hexToBytes('0x00ff10')), '0x00ff10');
  assert.equal(hexToBytes('0x').length, 0);
  assert.throws(() => hexToBytes('0x0'), TypeError);
  assert.throws(() => hexToBytes('00ff'), TypeError);
  assert.throws(() => hexToBytes('0xzz'), TypeError);
  assert.throws(() => keccak256(42), TypeError);
});
