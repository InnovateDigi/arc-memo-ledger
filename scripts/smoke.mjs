// Live check against Arc mainnet for a small, fixed range (about 10 requests, under two a second).
// Not part of CI: it needs the network. Run with: npm run smoke
import assert from 'node:assert/strict';
import { fetchLedger, fetchReceipt } from '../src/ledger.mjs';

const ADDRESS = '0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e';
const ledger = await fetchLedger({ address: ADDRESS, fromBlock: 24353000, toBlock: 24361999, network: 'mainnet' });
console.log(`payments ${ledger.totals.payments}, in ${ledger.totals.in}, out ${ledger.totals.out}, fees ${ledger.totals.fees}, requests ${ledger.rpcRequests}`);
console.log('balance check', JSON.stringify(ledger.balanceCheck));
assert.equal(ledger.network.chainId, 5042);
assert.equal(ledger.totals.payments, 4);
assert.equal(ledger.totals.inBaseUnits, '200000000000000000');
assert.equal(ledger.totals.outBaseUnits, '220000000000000000');
assert.equal(ledger.totals.feesBaseUnits, '6387100000000000');
assert.equal(ledger.balanceCheck.available, true);
assert.equal(ledger.balanceCheck.reconciled, true);

const receipt = await fetchReceipt({ txHash: '0xf0a3c947b36eaf6a8c09a064454cded790c37a141fccb50821553cbfb34463a4', network: 'mainnet' });
assert.equal(receipt.movements.length, 3);
assert.equal(receipt.memos.length, 3);
console.log('smoke test passed against Arc mainnet');
