import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, ledgerToText, main } from '../cli.mjs';
import { fetchLedger, LedgerError } from '../src/ledger.mjs';
import { fixture, replay, fast } from './helpers.mjs';

const SENDER = '0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e';

test('command line arguments', () => {
  assert.deepEqual(parseArgs([SENDER, '--hours', '24', '--csv']), { hours: 24, format: 'csv', network: 'mainnet', checkBalance: true, quiet: false, address: SENDER });
  const options = parseArgs([SENDER, '--from-block', '10', '--to-block', '20', '--json', '--testnet', '--no-balance', '--quiet', '--rpc', 'https://rpc.example']);
  assert.equal(options.fromBlock, 10);
  assert.equal(options.toBlock, 20);
  assert.equal(options.format, 'json');
  assert.equal(options.network, 'testnet');
  assert.equal(options.checkBalance, false);
  assert.equal(options.rpcUrl, 'https://rpc.example');
  assert.equal(parseArgs(['--tx', '0x' + 'a'.repeat(64)]).txHash, '0x' + 'a'.repeat(64));
  for (const bad of [[SENDER, '--hours'], [SENDER, '--frobnicate'], [SENDER, 'extra'], [SENDER, '--hours', 'many'], [SENDER, '--hours', '2', '--from-block', '5'], [SENDER, '--from-block', '-4']]) {
    assert.throws(() => parseArgs(bad), LedgerError, bad.join(' '));
  }
});

test('help and wrong usage: exit codes and no network', async () => {
  const run = async (argv) => {
    let out = '';
    let err = '';
    const code = await main(argv, { out: (text) => { out += text; }, err: (text) => { err += text; } });
    return { code, out, err };
  };
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /never asks for a key or a signature/);
  assert.equal((await run([])).code, 2);
  const bad = await run([SENDER, '--nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /Unknown option --nope/);
});

test('plain-text ledger from real recorded data', async () => {
  const session = replay(fixture('ledger_sender_c541c196.json'));
  const ledger = await fetchLedger({ address: SENDER, fromBlock: 24353000, toBlock: 24361999, network: 'mainnet', fetchImpl: session.fetchImpl, ...fast });
  const text = ledgerToText(ledger);
  assert.match(text, /Arc Mainnet \(chain 5042\) {2}address 0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e/);
  assert.match(text, /2026-10-05T07:56:37Z {2}out {5} +-0\.14 USDC {2}0xe874c32569a28b2d0bca07ef25f0ec0b68beedd0 {2}fee 0\.00281782/);
  assert.match(text, /payments in {3}0\.20 USDC/);
  assert.match(text, /payments out {2}0\.22 USDC/);
  assert.match(text, /fees paid {5}0\.0063871 USDC/);
  assert.match(text, /balance check {2}RECONCILED: 0\.16635212 \+ 0\.20 - 0\.22 - 0\.0063871 = 0\.13996502 \(to the last unit\)/);

  const unreconciled = structuredClone(ledger);
  unreconciled.balanceCheck = { ...ledger.balanceCheck, reconciled: false, difference: '-0.01', expectedClosing: '0.14996502' };
  assert.match(ledgerToText(unreconciled), /NOT EXPLAINED/);
  assert.doesNotMatch(ledgerToText(unreconciled), /balance check {2}RECONCILED/);
  const unlisted = structuredClone(unreconciled);
  unlisted.balanceCheck = { ...unreconciled.balanceCheck, explanation: 'unlisted_fees', unlistedFees: '0.01', sentNotFound: 2 };
  assert.match(ledgerToText(unlisted), /everything except 0\.01 USDC: the fees of 2 other transaction\(s\)/);
  assert.doesNotMatch(ledgerToText(unlisted), /RECONCILED|NOT EXPLAINED/);
  const unavailable = structuredClone(ledger);
  unavailable.balanceCheck = { available: false, reason: 'no state' };
  assert.match(ledgerToText(unavailable), /balance check not done: no state/);
});
