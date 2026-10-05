import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchLedger, fetchReceipt, computeBalanceCheck, ledgerRows, ledgerToCsv, csvCell, CSV_COLUMNS, isAbortError, LedgerError,
  SYSTEM_EMITTER, TOPICS, addressToTopic, formatUnits,
} from '../src/ledger.mjs';
import { fixture, replay, fast, jsonResponse } from './helpers.mjs';

// Real sessions recorded from https://rpc.mainnet.arc.io on 5 Oct 2026, blocks 24,353,000 to 24,361,999.
const SENDER = '0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e';
const RECIPIENT = '0xe874c32569a28b2d0bca07ef25f0ec0b68beedd0';
const NOTES = '0x2a05a76b4a2290a63214a32ffe2504d814b348f9';
const RANGE = { fromBlock: 24353000, toBlock: 24361999 };

async function ledgerFrom(name, address, extra = {}) {
  const session = replay(fixture(name), extra.replayOptions);
  const ledger = await fetchLedger({ address, ...RANGE, network: 'mainnet', fetchImpl: session.fetchImpl, ...fast, ...extra.options });
  return { ledger, calls: session.calls };
}

test('ledger of a real sender: payments, memos, fees, totals', async () => {
  const { ledger, calls } = await ledgerFrom('ledger_sender_c541c196.json', SENDER);
  assert.equal(ledger.network.chainId, 5042);
  assert.equal(ledger.address, SENDER);
  assert.deepEqual(ledger.range, { fromBlock: 24353000, toBlock: 24361999, blocks: 9000 });
  assert.equal(ledger.payments.length, 4);
  assert.deepEqual(ledger.payments.map((p) => [p.direction, p.amount, p.counterparty.slice(0, 10), p.block]), [
    ['in', '0.20', '0xe874c325', 24357967],
    ['out', '0.14', '0xe874c325', 24358200],
    ['out', '0.04', '0xccd52402', 24358200],
    ['out', '0.04', '0xe3fc4fd7', 24358200],
  ]);
  assert.equal(ledger.payments[1].time, '2026-10-05T07:56:37Z');
  assert.equal(ledger.payments[1].txHash, '0xf0a3c947b36eaf6a8c09a064454cded790c37a141fccb50821553cbfb34463a4');
  assert.equal(ledger.payments[1].amountBaseUnits, '140000000000000000');
  // memos: the three outgoing payments were each wrapped by the Memo contract
  assert.equal(ledger.payments[0].memo, null);
  assert.deepEqual(ledger.payments.slice(1).map((p) => p.memo.memoIndex), ['844', '845', '846']);
  assert.ok(ledger.payments.slice(1).every((p) => p.memo.encoding === 'hex' && p.memo.sender === SENDER));
  // fees: the incoming payment was sent by someone else; the three-payment transaction is charged once
  assert.deepEqual(ledger.payments.map((p) => p.fee), ['', '0.00281782', '', '']);
  assert.deepEqual(ledger.payments.map((p) => p.sentByAddress), [false, true, true, true]);
  // three more transactions cost a fee but moved no USDC of this address
  assert.equal(ledger.feeOnly.length, 3);
  assert.deepEqual(ledger.feeOnly.map((item) => item.fee), ['0.00118136', '0.00119396', '0.00119396']);
  assert.equal(ledger.totals.in, '0.20');
  assert.equal(ledger.totals.out, '0.22');
  assert.equal(ledger.totals.fees, '0.0063871');
  assert.equal(ledger.totals.net, '-0.0263871');
  assert.equal(ledger.totals.inBaseUnits, '200000000000000000');
  assert.equal(ledger.totals.outBaseUnits, '220000000000000000');
  assert.equal(ledger.totals.feesBaseUnits, '6387100000000000');
  assert.equal(ledger.totals.transactions, 5);
  assert.equal(ledger.rpcRequests, calls.length);
  assert.equal(calls.length, 10);
});

test('balance check on real data: opening + in - out - fees = closing, to the last unit', async () => {
  const { ledger } = await ledgerFrom('ledger_sender_c541c196.json', SENDER);
  const check = ledger.balanceCheck;
  assert.equal(check.available, true);
  assert.equal(check.openingBlock, 24352999);
  assert.equal(check.closingBlock, 24361999);
  assert.equal(check.openingBaseUnits, '166352120000000000');
  assert.equal(check.closingBaseUnits, '139965020000000000');
  assert.equal(BigInt(check.openingBaseUnits) + 200000000000000000n - 220000000000000000n - 6387100000000000n, BigInt(check.closingBaseUnits));
  assert.equal(check.differenceBaseUnits, '0');
  assert.equal(check.reconciled, true);

  const second = await ledgerFrom('ledger_recipient_e874c325.json', RECIPIENT);
  assert.equal(second.ledger.totals.in, '0.14');
  assert.equal(second.ledger.totals.out, '0.20');
  assert.equal(second.ledger.totals.fees, '0.01247336021');
  assert.equal(second.ledger.balanceCheck.reconciled, true);
  assert.equal(second.ledger.payments.find((p) => p.direction === 'in').memo.memoIndex, '844');
});

test('a real address whose rows do not add up: the remainder is reported as the fees of 2 unlisted transactions, never a tick', async () => {
  const { ledger } = await ledgerFrom('ledger_textmemo_2a05a76b.json', NOTES);
  // Its ERC-20 logs are transfers to itself: the system emitter logs nothing, so no payment is counted.
  assert.equal(ledger.payments.length, 0);
  assert.equal(ledger.feeOnly.length, 8);
  assert.deepEqual(ledger.feeOnly.map((item) => (item.memo ? item.memo.text : null)), [null, 'arc nice note', 'Tax pay', null, null, 'arc nice note', 'Tax pay', null]);
  assert.equal(ledger.balanceCheck.available, true);
  assert.equal(ledger.balanceCheck.reconciled, false);
  assert.equal(ledger.balanceCheck.differenceBaseUnits, '-8076288000000000');
  assert.equal(ledger.balanceCheck.difference, '-0.008076288');
  // Real nonces: the account sent 10 transactions in these blocks, 8 are listed, 2 left no event naming it.
  assert.equal(ledger.balanceCheck.sentByNonce, 10);
  assert.equal(ledger.balanceCheck.sentFound, 8);
  assert.equal(ledger.balanceCheck.sentNotFound, 2);
  assert.equal(ledger.balanceCheck.isContract, false);
  assert.equal(ledger.balanceCheck.explanation, 'unlisted_fees');
  assert.equal(ledger.balanceCheck.unlistedFees, '0.008076288');
});

test('the queries: filtered by indexed topic, within the block limit, read-only methods only', async () => {
  const { calls } = await ledgerFrom('ledger_sender_c541c196.json', SENDER);
  const methods = calls.map((call) => call.request.method);
  assert.deepEqual(methods.slice(0, 3), ['eth_chainId', 'eth_getLogs', 'eth_getLogs']);
  const [named, received] = [calls[1].request.params[0], calls[2].request.params[0]];
  assert.deepEqual(named.topics, [null, addressToTopic(SENDER)]);
  assert.equal('address' in named, false);
  assert.deepEqual(received.topics, [TOPICS.transfer, null, addressToTopic(SENDER)]);
  assert.equal(received.address, SYSTEM_EMITTER);
  for (const filter of [named, received]) assert.ok(Number(BigInt(filter.toBlock)) - Number(BigInt(filter.fromBlock)) + 1 <= 9999);
  const allowed = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getCode']);
  for (const method of methods) assert.ok(allowed.has(method), method);
  assert.ok(calls.every((call) => call.url === 'https://rpc.mainnet.arc.io' && call.headers['user-agent'] === 'test-agent'));
});

test('no tick without a computed check: unavailable historical state is reported, not assumed', async () => {
  const { ledger } = await ledgerFrom('ledger_sender_c541c196.json', SENDER, { replayOptions: { drop: (item) => item.method === 'eth_getBalance' } });
  assert.equal(ledger.balanceCheck.available, false);
  assert.match(ledger.balanceCheck.reason, /did not serve a historical balance/);
  assert.equal('reconciled' in ledger.balanceCheck, false);
  assert.equal(ledger.totals.fees, '0.0063871');
  const skipped = await ledgerFrom('ledger_sender_c541c196.json', SENDER, { options: { checkBalance: false } });
  assert.equal(skipped.ledger.balanceCheck.available, false);
  assert.equal(skipped.calls.some((call) => call.request.method === 'eth_getBalance'), false);
});

test('progress is reported and a cancel stops the run', async () => {
  const seen = [];
  await ledgerFrom('ledger_sender_c541c196.json', SENDER, { options: { onProgress: (p) => seen.push(`${p.phase} ${p.done}/${p.total}`) } });
  assert.deepEqual(seen, ['logs 1/1', 'receipts 1/5', 'receipts 2/5', 'receipts 3/5', 'receipts 4/5', 'receipts 5/5', 'balance 0/2', 'balance 2/2']);

  const controller = new AbortController();
  const session = replay(fixture('ledger_sender_c541c196.json'));
  const run = fetchLedger({
    address: SENDER, ...RANGE, network: 'mainnet', fetchImpl: session.fetchImpl, ...fast, signal: controller.signal,
    onProgress: (p) => { if (p.phase === 'receipts' && p.done === 2) controller.abort(); },
  });
  await assert.rejects(run, isAbortError);
  assert.equal(session.calls.length, 5, 'no request after the cancel');
});

test('refuses the wrong chain, a bad address and a bad range before reading anything else', async () => {
  const wrongChain = async (url, init) => jsonResponse({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: '0x1' });
  await assert.rejects(fetchLedger({ address: SENDER, ...RANGE, fetchImpl: wrongChain, ...fast }), (error) => error instanceof LedgerError && error.code === 'wrong_chain');
  await assert.rejects(fetchLedger({ address: '0x123', ...RANGE, ...fast }), (error) => error.code === 'bad_address');
  const session = replay(fixture('ledger_sender_c541c196.json'));
  await assert.rejects(fetchLedger({ address: SENDER, fromBlock: 10, toBlock: 5, fetchImpl: session.fetchImpl, ...fast }), (error) => error.code === 'bad_range');
  await assert.rejects(fetchLedger({ address: SENDER, ...RANGE, network: 'elsewhere', ...fast }), (error) => error.code === 'bad_network');
});

test('receipt view of one real transaction with a text memo', async () => {
  const recorded = fixture('receipt_text_memo.json');
  const receipt = await fetchReceipt({ txHash: recorded.txHash, network: 'mainnet', fetchImpl: replay(recorded).fetchImpl, ...fast });
  assert.equal(receipt.succeeded, true);
  assert.equal(receipt.block, 24360267);
  assert.equal(receipt.time, '2026-10-05T08:14:06Z');
  assert.equal(receipt.sender, NOTES);
  assert.equal(receipt.fee, '0.000818796');
  assert.equal(receipt.movements.length, 0);
  assert.equal(receipt.memos[0].text, 'arc nice note');
  assert.equal(receipt.memos[0].encoding, 'utf8');
  await assert.rejects(fetchReceipt({ txHash: '0x' + '1'.repeat(64), network: 'mainnet', fetchImpl: async (url, init) => jsonResponse({ jsonrpc: '2.0', id: 1, result: JSON.parse(init.body).method === 'eth_chainId' ? '0x13b2' : null }), ...fast }), (error) => error.code === 'not_found');
});

test('receipt view of the three-payment memo transaction: three movements, three ERC-20 duplicates ignored', async () => {
  const session = replay(fixture('ledger_sender_c541c196.json'));
  const receipt = await fetchReceipt({ txHash: '0xf0a3c947b36eaf6a8c09a064454cded790c37a141fccb50821553cbfb34463a4', network: 'mainnet', fetchImpl: session.fetchImpl, ...fast });
  assert.equal(receipt.movements.length, 3);
  assert.equal(receipt.duplicateErc20LogsIgnored, 3);
  assert.deepEqual(receipt.movements.map((m) => m.amount), ['0.14', '0.04', '0.04']);
  assert.deepEqual(receipt.movements.map((m) => m.memo.memoIndex), ['844', '845', '846']);
  assert.equal(receipt.feeBaseUnits, (140891n * 20000000000n).toString());
  assert.equal(formatUnits(BigInt(receipt.feeBaseUnits)), receipt.fee);
});

test('CSV cells: commas, quotes, line breaks, and no spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
  assert.equal(csvCell('line one\r\nline two'), '"line one\r\nline two"');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+44 20 7946 0000'), "'+44 20 7946 0000");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@SUM(A1:A9)'), "'@SUM(A1:A9)");
  assert.equal(csvCell('\t=1+1'), "'\t=1+1");
  assert.equal(csvCell('\r=1+1'), '"\'\r=1+1"');
  assert.equal(csvCell('=HYPERLINK("http://x.example","pay")'), '"\'=HYPERLINK(""http://x.example"",""pay"")"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(24358200), '24358200');
  assert.equal(csvCell('0.14'), '0.14');
  assert.equal(csvCell('0xabc'), '0xabc');
});

test('CSV of a real ledger: header, one line per row, CRLF, hostile memos neutralised', async () => {
  const { ledger } = await ledgerFrom('ledger_sender_c541c196.json', SENDER);
  const csv = ledgerToCsv(ledger);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines.at(-1), '');
  assert.equal(lines.length - 2, ledgerRows(ledger).length);
  assert.equal(ledgerRows(ledger).length, 7);
  assert.ok(lines.every((line) => line === '' || line.split(',').length === CSV_COLUMNS.length), 'no stray commas in real rows');
  const paid = lines.find((line) => line.includes(',out,') && line.includes('0xe874c32569a28b2d0bca07ef25f0ec0b68beedd0'));
  assert.ok(paid.startsWith('2026-10-05T07:56:37Z,24358200,0xf0a3c947b36eaf6a8c09a064454cded790c37a141fccb50821553cbfb34463a4,3,out,'));
  assert.ok(paid.includes(',0.14,0.00281782,'));
  assert.ok(paid.endsWith('https://explorer.arc.io/tx/0xf0a3c947b36eaf6a8c09a064454cded790c37a141fccb50821553cbfb34463a4'));
  assert.ok(lines.some((line) => line.includes(',fee only,')));

  const hostile = structuredClone(ledger);
  hostile.payments[1].memo = { ...hostile.payments[1].memo, encoding: 'utf8', text: '=cmd|\' /C calc\'!A0, "quoted"\nsecond line' };
  const out = ledgerToCsv(hostile);
  assert.ok(out.includes('"\'=cmd|\' /C calc\'!A0, ""quoted""\nsecond line"'));
  assert.equal(out.split('\r\n').length, lines.length, 'the line break stays inside its quoted cell');
});

test('rows are merged oldest first and fee-only rows carry no amount', async () => {
  const { ledger } = await ledgerFrom('ledger_sender_c541c196.json', SENDER);
  const rows = ledgerRows(ledger);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].block > rows[i - 1].block || (rows[i].block === rows[i - 1].block && rows[i].logIndex > rows[i - 1].logIndex));
  assert.deepEqual(rows.map((row) => row.type), ['fee-only', 'fee-only', 'fee-only', 'payment', 'payment', 'payment', 'payment']);
  assert.ok(rows.filter((row) => row.type === 'fee-only').every((row) => row.amount === '0.00' && row.fee !== ''));
  // the fee column adds up to the fee total exactly
  const sum = rows.reduce((total, row) => total + (row.feeBaseUnits ? BigInt(row.feeBaseUnits) : 0n), 0n);
  assert.equal(sum.toString(), ledger.totals.feesBaseUnits);
});

test('a real payment with a text memo, compared with its raw receipt', async () => {
  const recorded = fixture('receipt_text_memo_payment.json');
  const raw = recorded.exchanges.find((item) => item.method === 'eth_getTransactionReceipt').response.result;
  const receipt = await fetchReceipt({ txHash: recorded.txHash, network: 'mainnet', fetchImpl: replay(recorded).fetchImpl, ...fast });
  assert.equal(receipt.block, 24348383);
  assert.equal(receipt.time, '2026-10-05T06:33:36Z');
  assert.equal(receipt.to, '0x5294e9927c3306dcbadb03fe70b92e01ccede505');
  assert.equal(receipt.movements.length, 1);
  const [payment] = receipt.movements;
  assert.equal(payment.amount, '0.20');
  assert.equal(payment.amountBaseUnits, BigInt(raw.logs[1].data).toString());
  assert.equal(BigInt(raw.logs[2].data) * 10n ** 12n, BigInt(raw.logs[1].data), 'the ERC-20 log repeats the same 0.20');
  assert.equal(payment.from, '0xd951d3264ab6aa83f4ead247e35f96f140304b93');
  assert.equal(payment.to, '0xf118af312c8d4bb37a1ab3f67a86d1c3ab6f86bb');
  assert.equal(payment.memo.text, 'testing payment after phase 12');
  assert.equal(payment.memo.encoding, 'utf8');
  assert.equal(payment.memo.memoIndex, '791');
  assert.deepEqual(payment.memo.readableParts, []);
  assert.equal(receipt.feeBaseUnits, (BigInt(raw.gasUsed) * BigInt(raw.effectiveGasPrice)).toString());
  assert.equal(receipt.fee, '0.00271312');
  assert.equal(receipt.duplicateErc20LogsIgnored, 1);
});

test('a receipt that a lagging backend does not have yet is asked for again', async () => {
  const recorded = fixture('receipt_text_memo_payment.json');
  const session = replay(recorded);
  let withheld = 2;
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_getTransactionReceipt' && withheld > 0) {
      withheld--;
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: null });
    }
    return session.fetchImpl(url, init);
  };
  const receipt = await fetchReceipt({ txHash: recorded.txHash, network: 'mainnet', fetchImpl, ...fast });
  assert.equal(receipt.movements[0].amount, '0.20');
  assert.equal(withheld, 0);
});

test('a remainder is put down to unlisted fees only when the nonce shows unlisted transactions on an ordinary account', async () => {
  const address = '0x' + 'ab'.repeat(20);
  const fakeRpc = ({ opening, closing, nonceBefore, nonceAfter, code = '0x', failNonce = false }) => {
    const methods = [];
    return {
      methods,
      call: async (method, params) => {
        methods.push(method);
        if (method === 'eth_getBalance') return '0x' + (params[1] === '0x63' ? opening : closing).toString(16);
        if (method === 'eth_getTransactionCount') {
          if (failNonce) throw new Error('no state');
          return '0x' + (params[1] === '0x63' ? nonceBefore : nonceAfter).toString(16);
        }
        if (method === 'eth_getCode') return code;
        throw new Error('unexpected ' + method);
      },
    };
  };
  const sums = { totalIn: 500n, totalOut: 200n, totalFees: 30n, sentFound: 3 };
  const run = (options) => { const rpc = fakeRpc(options); return computeBalanceCheck(rpc, address, 100, 200, sums).then((check) => ({ check, methods: rpc.methods })); };

  const exact = await run({ opening: 1000n, closing: 1270n, nonceBefore: 5, nonceAfter: 8 });
  assert.equal(exact.check.reconciled, true);
  assert.equal(exact.check.explanation, 'reconciled');
  assert.deepEqual(exact.methods, ['eth_getBalance', 'eth_getBalance'], 'no extra request when the sums match');

  const unlisted = await run({ opening: 1000n, closing: 1250n, nonceBefore: 5, nonceAfter: 10 });
  assert.equal(unlisted.check.reconciled, false);
  assert.equal(unlisted.check.explanation, 'unlisted_fees');
  assert.equal(unlisted.check.sentByNonce, 5);
  assert.equal(unlisted.check.sentFound, 3);
  assert.equal(unlisted.check.sentNotFound, 2);
  assert.equal(unlisted.check.differenceBaseUnits, '-20');
  assert.equal(unlisted.check.unlistedFees, '0.00000000000000002');

  const allListed = await run({ opening: 1000n, closing: 1250n, nonceBefore: 5, nonceAfter: 8 });
  assert.equal(allListed.check.explanation, 'not_explained');
  assert.equal(allListed.check.sentNotFound, 0);
  const contract = await run({ opening: 1000n, closing: 1250n, nonceBefore: 5, nonceAfter: 10, code: '0x6080' });
  assert.equal(contract.check.explanation, 'not_explained');
  assert.equal(contract.check.isContract, true);
  const surplus = await run({ opening: 1000n, closing: 1300n, nonceBefore: 5, nonceAfter: 10 });
  assert.equal(surplus.check.explanation, 'not_explained', 'extra money is never explained by fees');
  const noNonce = await run({ opening: 1000n, closing: 1250n, failNonce: true });
  assert.equal(noNonce.check.explanation, 'not_explained');
  assert.equal(noNonce.check.sentNotFound, null);
  assert.equal(noNonce.check.unlistedFees, null);
});
