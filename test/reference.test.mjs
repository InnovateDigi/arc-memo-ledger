import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLedger, extractTransfers, memoFramesFromLogs, framesAround, TOPICS, SYSTEM_EMITTER, MEMO_CONTRACT } from '../src/ledger.mjs';
import { fixture, replay, fast } from './helpers.mjs';

// An independent reference: a separate script (not this project's code) read the raw logs,
// balances and nonces for two addresses over blocks 24,357,200 to 24,359,199 of Arc mainnet.
const reference = fixture('independent_reference.json');

test('the reference agrees on the constants', () => {
  assert.equal(reference.transfer_topic0, TOPICS.transfer);
  assert.equal(reference.system_emitter.toLowerCase(), SYSTEM_EMITTER);
  assert.equal(reference.memo_contract.toLowerCase(), MEMO_CONTRACT);
});

for (const [role, recording] of [['payment_sender', 'window_sender_c541c196.json'], ['payment_recipient', 'window_recipient_e874c325.json']]) {
  test(`rows match the independent reference one for one: ${role}`, async () => {
    const expected = reference.addresses[role];
    const session = replay(fixture(recording));
    const ledger = await fetchLedger({ address: expected.address, fromBlock: reference.fromBlock, toBlock: reference.toBlock, network: 'mainnet', fetchImpl: session.fetchImpl, ...fast });

    const fromLog = (direction) => (log) => ({
      direction,
      id: `${log.transactionHash}:${Number(BigInt(log.logIndex))}`,
      amountBaseUnits: BigInt(log.data).toString(),
      counterparty: '0x' + log.topics[direction === 'out' ? 2 : 1].slice(26),
    });
    const byId = (a, b) => a.id.localeCompare(b.id);
    const wanted = [...expected.out_logs.map(fromLog('out')), ...expected.in_logs.map(fromLog('in'))].sort(byId);
    const got = ledger.payments.map((p) => ({ direction: p.direction, id: `${p.txHash}:${p.logIndex}`, amountBaseUnits: p.amountBaseUnits, counterparty: p.counterparty })).sort(byId);
    assert.deepEqual(got, wanted);
    assert.equal(ledger.payments.filter((p) => p.direction === 'out').length, expected.out_count);
    assert.equal(ledger.payments.filter((p) => p.direction === 'in').length, expected.in_count);
    assert.equal(ledger.totals.outBaseUnits, expected.sum_out_native_units);
    assert.equal(ledger.totals.inBaseUnits, expected.sum_in_native_units);

    // Balances at both ends, and the fees the reference could only imply from them:
    // this reader finds and itemises the transactions behind that figure.
    assert.equal(BigInt(ledger.balanceCheck.openingBaseUnits), BigInt(expected.balance_before));
    assert.equal(BigInt(ledger.balanceCheck.closingBaseUnits), BigInt(expected.balance_after));
    assert.equal(ledger.totals.feesBaseUnits, expected.implied_fees_native_units);
    assert.equal(ledger.balanceCheck.reconciled, true);
    const sentListed = new Set([...ledger.payments.filter((p) => p.sentByAddress).map((p) => p.txHash), ...ledger.feeOnly.map((item) => item.txHash)]).size;
    assert.equal(sentListed, Number(BigInt(expected.nonce_after) - BigInt(expected.nonce_before)), 'every transaction the nonce counts is listed');
  });
}

test('the reference receipt with three memo payments decodes to three movements, each in its own memo frame', () => {
  const logs = reference.memo_tx_receipt.logs;
  const transfers = extractTransfers(logs);
  const frames = memoFramesFromLogs(logs);
  assert.equal(transfers.length, 3);
  assert.equal(frames.length, 3);
  assert.deepEqual(transfers.map((transfer) => framesAround(frames, transfer.logIndex).map((frame) => frame.memo.memoIndex)), [[844n], [845n], [846n]]);
  assert.deepEqual(transfers.map((transfer) => transfer.value), [140000000000000000n, 40000000000000000n, 40000000000000000n]);
});
