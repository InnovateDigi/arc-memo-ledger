// Records real JSON-RPC exchanges into test/fixtures/ so the unit tests can replay them offline.
// Usage: node scripts/record-fixtures.mjs   (read-only; under two requests a second)
import { writeFileSync } from 'node:fs';
import { fetchLedger, fetchReceipt, createRpc, NETWORKS, MEMO_CONTRACT, TOPICS, decodeMemoLog, renderMemo } from '../src/ledger.mjs';

const UA = 'Mozilla/5.0 (compatible; arc-memo-ledger-fixtures/0.1; +https://github.com/InnovateDigi/arc-memo-ledger)';
const out = (name) => new URL('../test/fixtures/' + name, import.meta.url);

function recorder() {
  const exchanges = [];
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    const text = await response.text();
    const request = JSON.parse(init.body);
    if (response.status === 200) exchanges.push({ method: request.method, params: request.params, response: JSON.parse(text) });
    return new Response(text, { status: response.status, headers: response.headers });
  };
  return { exchanges, fetchImpl };
}

async function recordLedger(name, address, fromBlock, toBlock) {
  const { exchanges, fetchImpl } = recorder();
  const ledger = await fetchLedger({ address, fromBlock, toBlock, network: 'mainnet', fetchImpl, userAgent: UA });
  writeFileSync(out(name), JSON.stringify({ recordedAt: new Date().toISOString(), rpcUrl: NETWORKS.mainnet.rpcUrl, address, fromBlock, toBlock, exchanges }, null, 1) + '\n');
  console.log(name, 'requests', ledger.rpcRequests, 'feeOnly', ledger.totals.feeOnlyTransactions, 'payments', ledger.totals.payments, 'in', ledger.totals.in, 'out', ledger.totals.out, 'fees', ledger.totals.fees, 'balance', JSON.stringify(ledger.balanceCheck));
  return ledger;
}

// The window of the independent reference (test/fixtures/independent_reference.json), which a separate script produced.
await recordLedger('window_sender_c541c196.json', '0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e', 24357200, 24359199);
await recordLedger('window_recipient_e874c325.json', '0xe874c32569a28b2d0bca07ef25f0ec0b68beedd0', 24357200, 24359199);
if (process.env.ONLY === 'window') process.exit(0);

const FROM = 24353000, TO = 24361999;
await recordLedger('ledger_sender_c541c196.json', '0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e', FROM, TO);
await recordLedger('ledger_recipient_e874c325.json', '0xe874c32569a28b2d0bca07ef25f0ec0b68beedd0', FROM, TO);
await recordLedger('ledger_textmemo_2a05a76b.json', '0x2a05a76b4a2290a63214a32ffe2504d814b348f9', FROM, TO);

// Look for a memo that is plain text, to have a real fixture for the text path.
const rpc = createRpc({ rpcUrl: NETWORKS.mainnet.rpcUrl, userAgent: UA });
const head = 24368850; // pinned: the head block when the fixtures were first recorded
const memoLogs = [];
for (let end = head; end > head - 80000; end -= 9999) {
  const params = [{ fromBlock: '0x' + Math.max(0, end - 9998).toString(16), toBlock: '0x' + end.toString(16), address: MEMO_CONTRACT, topics: [TOPICS.memo] }];
  const logs = await rpc.call('eth_getLogs', params);
  memoLogs.push(...logs);
}
const kinds = {};
let textLog = null;
for (const log of memoLogs) {
  const shown = renderMemo(decodeMemoLog(log).memoHex);
  kinds[shown.encoding] = (kinds[shown.encoding] || 0) + 1;
  if (shown.encoding === 'utf8' && !textLog) textLog = log;
}
console.log('memo logs in blocks 24278860 to', head, ':', memoLogs.length, JSON.stringify(kinds));
writeFileSync(out('memo_logs_recent.json'), JSON.stringify({ recordedAt: new Date().toISOString(), headBlock: head, method: 'eth_getLogs', fromBlock: 24278860, toBlock: head, note: 'Memo events emitted by the Memo contract in blocks 24278860 to 24368850 (nine eth_getLogs pages)', logs: memoLogs }, null, 1) + '\n');
if (textLog) {
  console.log('text memo tx', textLog.transactionHash, JSON.stringify(renderMemo(decodeMemoLog(textLog).memoHex).text));
  const { exchanges, fetchImpl } = recorder();
  const receipt = await fetchReceipt({ txHash: textLog.transactionHash, network: 'mainnet', fetchImpl, userAgent: UA });
  writeFileSync(out('receipt_text_memo.json'), JSON.stringify({ recordedAt: new Date().toISOString(), txHash: textLog.transactionHash, exchanges }, null, 1) + '\n');
  console.log(JSON.stringify(receipt, null, 1));
}

// A payment with a plain-text memo, sent straight to the Memo contract.
{
  const txHash = '0xbefd3c02d3d3e7ce0ced57b60f7908f8ddbca1f17f38abf0debe4fa40ff94949';
  const { exchanges, fetchImpl } = recorder();
  const receipt = await fetchReceipt({ txHash, network: 'mainnet', fetchImpl, userAgent: UA });
  writeFileSync(out('receipt_text_memo_payment.json'), JSON.stringify({ recordedAt: new Date().toISOString(), txHash, exchanges }, null, 1) + '\n');
  console.log('text memo payment', receipt.movements[0].amount, JSON.stringify(receipt.movements[0].memo.text));
}

// The raw receipt of the three-payment memo transaction, on its own, for the decoding tests.
{
  const txHash = '0xf0a3c947b36eaf6a8c09a064454cded790c37a141fccb50821553cbfb34463a4';
  const { exchanges, fetchImpl } = recorder();
  await fetchReceipt({ txHash, network: 'mainnet', fetchImpl, userAgent: UA });
  writeFileSync(out('receipt_memo_f0a3c947.json'), JSON.stringify(exchanges.find((item) => item.method === 'eth_getTransactionReceipt'), null, 2) + '\n');
}
