// The page. It keeps nothing: no cookie, no storage. It talks only to the Arc RPC.
import {
  fetchLedger, fetchReceipt, resolveBlockRange, createRpc, ledgerRows, ledgerToCsv, planChunks,
  normalizeAddress, normalizeTxHash, isAbortError, NETWORKS, LedgerError, RpcError, DEFAULT_MIN_INTERVAL_MS,
} from './src/ledger.mjs';

const $ = (id) => document.getElementById(id);

/** Build an element. Children that are strings become text nodes: nothing from the chain is ever parsed as HTML. */
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  node.append(...children);
  return node;
}

let controller = null;
let currentLedger = null;

const selectedNetwork = () => (document.querySelector('input[name="network"]:checked') || {}).value || 'mainnet';
const shorten = (value, head = 8, tail = 6) => (value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value);
const txUrl = (explorer, hash) => `${explorer}/tx/${hash}`;
const addressUrl = (explorer, address) => `${explorer}/address/${address}`;
const outside = (href, text, title) => el('a', { href, title, rel: 'noopener noreferrer', target: '_blank' }, text);

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

function clearError() {
  $('error').hidden = true;
  $('error').textContent = '';
}

function setBusy(busy) {
  $('go').disabled = busy;
  $('progress').hidden = !busy;
  if (!busy) controller = null;
}

function setProgress(percent, text) {
  $('bar').value = Math.max(0, Math.min(100, percent));
  $('status').textContent = text;
}

function explain(error) {
  if (isAbortError(error)) return 'Cancelled. Nothing was changed anywhere: this page only reads.';
  if (error instanceof LedgerError) return error.message;
  if (error instanceof RpcError) return `The Arc RPC did not give a usable answer. ${error.message} Please try again in a minute, or choose a shorter period.`;
  return `Something went wrong: ${error && error.message ? error.message : error}`;
}

function memoNode(memo) {
  if (!memo) return el('span', { class: 'help' }, 'none');
  if (memo.encoding === 'utf8') return el('span', {}, el('span', { class: 'tag' }, 'text'), memo.text);
  if (memo.encoding === 'empty') return el('span', {}, el('span', { class: 'tag' }, 'empty memo'));
  const bytes = (memo.hex.length - 2) / 2;
  const node = el('span', { title: memo.hex }, el('span', { class: 'tag' }, `hex, ${bytes} bytes`), el('span', { class: 'mono' }, shorten(memo.hex, 18, 8)));
  const parts = memo.readableParts || [];
  if (parts.length) node.append(el('span', { class: 'inside' }, ` contains the text: ${parts.join(' · ')}`));
  return node;
}

function cell(label, className, ...children) {
  return el('td', { 'data-label': label, class: className || null }, ...children);
}

function receiptLink(ledger, row) {
  const params = new URLSearchParams({ tx: row.txHash, address: ledger.address });
  if (ledger.network.chainId !== NETWORKS.mainnet.chainId) params.set('network', 'testnet');
  return el('a', { href: `?${params}` }, 'receipt');
}

function rowNode(ledger, row) {
  const explorer = ledger.network.explorer;
  const sign = row.direction === 'in' ? '+' : row.direction === 'out' ? '−' : '';
  const directionText = row.direction === 'in' ? 'In' : row.direction === 'out' ? 'Out' : 'Fee only';
  const kindNote = row.kind === 'mint' ? ' (mint)' : row.kind === 'burn' ? ' (burn)' : '';
  const counterparty = row.counterparty
    ? el('span', {}, outside(addressUrl(explorer, row.counterparty), shorten(row.counterparty), row.counterparty), kindNote)
    : el('span', { class: 'help' }, 'none');
  const node = el('tr', {},
    cell('Time (UTC)', null, row.time.replace('T', ' ').replace('Z', '')),
    cell('Direction', row.direction === 'in' ? 'in' : row.direction === 'out' ? 'out' : null, directionText),
    cell('Amount (USDC)', `num ${row.direction === 'in' ? 'in' : row.direction === 'out' ? 'out' : ''}`.trim(), row.type === 'fee-only' ? '0.00' : sign + row.amount),
    cell('Counterparty', 'mono', counterparty),
    cell('Memo', 'memo', memoNode(row.memo)),
    cell('Fee paid (USDC)', 'num', row.fee || '—'),
    cell('Transaction', 'mono', outside(txUrl(explorer, row.txHash), shorten(row.txHash, 10, 6), row.txHash), ' · ', receiptLink(ledger, row)),
  );
  node.dataset.search = [row.counterparty, row.txHash, row.memo ? row.memo.text : '', row.memo ? row.memo.hex : '', row.memo ? row.memo.memoId : '',
    row.memo ? (row.memo.readableParts || []).join(' ') : '', directionText]
    .join(' ').toLowerCase();
  return node;
}

function totalBox(label, value) {
  return el('div', {}, el('dt', {}, label), el('dd', {}, value));
}

function balanceNode(ledger) {
  const check = ledger.balanceCheck;
  const box = $('balance');
  box.replaceChildren();
  box.className = 'balance';
  if (!check.available) {
    box.append(el('p', {}, el('strong', {}, 'Balance check not done. '), check.reason));
    return;
  }
  const sum = `${check.opening} + ${ledger.totals.in} − ${ledger.totals.out} − ${ledger.totals.fees} = ${check.expectedClosing}`;
  if (check.reconciled) {
    box.classList.add('ok');
    box.append(
      el('p', {}, el('strong', {}, '✓ Balance check passed, to the last unit.')),
      el('p', { class: 'sum' }, `Opening balance + payments in − payments out − fees = closing balance: ${sum} USDC.`),
      el('p', { class: 'help' }, `Both balances were read from the chain: ${check.opening} USDC at block ${check.openingBlock} and ${check.closing} USDC at block ${check.closingBlock}.`),
    );
  } else if (check.explanation === 'unlisted_fees') {
    const count = check.sentNotFound;
    const others = `${count} other transaction${count === 1 ? '' : 's'}`;
    box.classList.add('info');
    box.append(
      el('p', {}, el('strong', {}, `Balance check: the rows account for everything except ${check.unlistedFees} USDC.`)),
      el('p', { class: 'sum' }, `That is the fees of ${others} this address sent in the period that moved no USDC (not itemised). ${sum} USDC from the rows; the chain says ${check.closing} USDC.`),
      el('p', { class: 'help' }, `The address's transaction counter rose by ${check.sentByNonce} between blocks ${check.openingBlock} and ${check.closingBlock}; ${check.sentFound} of those transactions are listed above. The others left no event that names the address (a call that failed, for example), so a reader of events cannot list them.`),
    );
  } else {
    box.classList.add('warn');
    const why = check.isContract
      ? 'This address is a contract, so its balance can change in ways that events do not show.'
      : check.sentNotFound === 0
        ? 'Every transaction this address sent in the period is listed, so unlisted fees are not the cause. Block rewards, for example, are not logged.'
        : 'The cause could not be established from the chain data this page reads.';
    box.append(
      el('p', {}, el('strong', {}, `Balance check: ${check.difference} USDC not explained.`)),
      el('p', { class: 'sum' }, `The rows add up to ${sum} USDC, but the chain says the closing balance is ${check.closing} USDC.`),
      el('p', { class: 'help' }, why),
    );
  }
}

function applyFilter() {
  const needle = $('filter').value.trim().toLowerCase();
  let shown = 0;
  let total = 0;
  for (const row of $('rows').children) {
    if (!row.dataset.search && row.dataset.search !== '') continue;
    total++;
    const match = needle === '' || row.dataset.search.includes(needle);
    row.hidden = !match;
    if (match) shown++;
  }
  $('shown').textContent = total === 0 ? '' : needle === ''
    ? `${total} row${total === 1 ? '' : 's'}, oldest first. Downloads contain every row.`
    : `Showing ${shown} of ${total} rows. Downloads contain every row, not only the ones shown.`;
}

function renderLedger(ledger) {
  currentLedger = ledger;
  const rows = ledgerRows(ledger);
  $('result-title').textContent = `Ledger of ${ledger.address}`;
  const first = rows.length ? rows[0].time : null;
  $('result-range').textContent = `${ledger.network.name}, blocks ${ledger.range.fromBlock.toLocaleString('en-GB')} to ${ledger.range.toBlock.toLocaleString('en-GB')}`
    + ` (${ledger.range.blocks.toLocaleString('en-GB')} blocks). ${ledger.totals.payments} payment${ledger.totals.payments === 1 ? '' : 's'}`
    + `${ledger.totals.feeOnlyTransactions ? ` and ${ledger.totals.feeOnlyTransactions} fee-only transaction${ledger.totals.feeOnlyTransactions === 1 ? '' : 's'}` : ''}`
    + `${first ? `, from ${first.replace('T', ' ').replace('Z', '')} UTC` : ''}. Read with ${ledger.rpcRequests} requests.`;
  $('totals').replaceChildren(
    totalBox('Payments in', `${ledger.totals.in} USDC`),
    totalBox('Payments out', `${ledger.totals.out} USDC`),
    totalBox('Fees paid', `${ledger.totals.fees} USDC`),
    totalBox('Net change', `${ledger.totals.net} USDC`),
  );
  balanceNode(ledger);
  const body = $('rows');
  body.replaceChildren(...rows.map((row) => rowNode(ledger, row)));
  if (rows.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, 'No USDC payment and no fee found for this address in this period.')));
  }
  $('filter').value = '';
  applyFilter();
  $('result').hidden = false;
}

function download(filename, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStem(ledger) {
  return `arc-ledger-${ledger.address.slice(0, 10)}-blocks-${ledger.range.fromBlock}-${ledger.range.toBlock}`;
}

function readRange() {
  const choice = $('range').value;
  if (choice !== 'custom') return { hours: Number(choice) };
  const from = $('from').value;
  const to = $('to').value;
  if (!from || !to) throw new LedgerError('bad_range', 'Choose both dates, or pick one of the ready-made periods.');
  const fromTime = Date.parse(`${from}T00:00:00Z`) / 1000;
  const toTime = Date.parse(`${to}T00:00:00Z`) / 1000 + 86400;
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) throw new LedgerError('bad_range', 'Those dates could not be read.');
  if (toTime <= fromTime) throw new LedgerError('bad_range', 'The last day must not be before the first day.');
  return { fromTime, toTime };
}

function syncUrl(address, network) {
  const params = new URLSearchParams({ address });
  const choice = $('range').value;
  if (choice === 'custom') {
    params.set('from', $('from').value);
    params.set('to', $('to').value);
  } else if (choice !== '24') {
    params.set('hours', choice);
  }
  if (network !== 'mainnet') params.set('network', network);
  history.replaceState(null, '', `?${params}`);
}

async function showLedger() {
  clearError();
  $('receipt').hidden = true;
  let address;
  let range;
  try {
    address = normalizeAddress($('address').value);
    range = readRange();
  } catch (error) {
    showError(explain(error));
    return;
  }
  const network = selectedNetwork();
  syncUrl(address, network);
  controller = new AbortController();
  const { signal } = controller;
  setBusy(true);
  $('result').hidden = true;
  setProgress(1, 'Finding the first and last block of the period…');
  try {
    const rpc = createRpc({
      rpcUrl: NETWORKS[network].rpcUrl,
      signal,
      onRetry: ({ delayMs }) => { $('status').textContent = `The RPC asked us to slow down. Waiting ${Math.round(delayMs / 1000)} seconds, then carrying on…`; },
    });
    const blocks = await resolveBlockRange({ ...range, network, rpc });
    const pages = planChunks(blocks.fromBlock, blocks.toBlock).length;
    const seconds = Math.ceil((pages * 2 * DEFAULT_MIN_INTERVAL_MS) / 1000);
    const estimate = seconds < 90 ? `about ${seconds} seconds` : `about ${Math.ceil(seconds / 60)} minutes`;
    const ledger = await fetchLedger({
      address, network, rpc, signal, fromBlock: blocks.fromBlock, toBlock: blocks.toBlock,
      onProgress: (progress) => {
        if (progress.phase === 'logs') {
          setProgress(5 + (60 * progress.done) / progress.total, `Reading events: page ${progress.done} of ${progress.total} (${estimate} for this step). ${progress.found} found so far.`);
        } else if (progress.phase === 'receipts') {
          setProgress(65 + (32 * progress.done) / progress.total, `Reading transaction ${progress.done} of ${progress.total}…`);
        } else {
          setProgress(98, 'Checking the balance against the chain…');
        }
      },
    });
    setProgress(100, 'Done.');
    renderLedger(ledger);
  } catch (error) {
    showError(explain(error));
  } finally {
    setBusy(false);
  }
}

function keyValue(list, label, ...value) {
  list.append(el('dt', {}, label), el('dd', {}, ...value));
}

function renderReceipt(receipt, viewer) {
  const explorer = receipt.network.explorer;
  const body = $('receipt-body');
  const facts = el('dl', { class: 'kv' });
  keyValue(facts, 'Status', receipt.succeeded ? 'Succeeded' : 'Failed (no payment was made)');
  keyValue(facts, 'Network', `${receipt.network.name} (chain ${receipt.network.chainId})`);
  keyValue(facts, 'Time (UTC)', receipt.time ? receipt.time.replace('T', ' ').replace('Z', '') : 'not known');
  keyValue(facts, 'Block', receipt.block.toLocaleString('en-GB'));
  keyValue(facts, 'Transaction', el('span', { class: 'mono' }, outside(txUrl(explorer, receipt.txHash), receipt.txHash)));
  keyValue(facts, 'Sent by', el('span', { class: 'mono' }, outside(addressUrl(explorer, receipt.sender), receipt.sender)));
  keyValue(facts, 'Fee paid by the sender', `${receipt.fee} USDC`);
  body.replaceChildren(facts);

  if (receipt.movements.length === 0) {
    body.append(el('p', {}, 'This transaction moved no USDC.'));
  } else {
    body.append(el('h3', {}, receipt.movements.length === 1 ? 'Payment' : `Payments (${receipt.movements.length})`));
    for (const movement of receipt.movements) {
      const list = el('dl', { class: 'kv' });
      const role = viewer === movement.to ? ' (received by the address you looked up)' : viewer === movement.from ? ' (paid by the address you looked up)' : '';
      keyValue(list, 'Amount', el('strong', {}, `${movement.amount} USDC`), role);
      keyValue(list, 'From', el('span', { class: 'mono' }, movement.kind === 'mint' ? `${movement.from} (mint)` : movement.from));
      keyValue(list, 'To', el('span', { class: 'mono' }, movement.kind === 'burn' ? `${movement.to} (burn)` : movement.to));
      keyValue(list, 'Memo', memoNode(movement.memo));
      if (movement.memo) {
        keyValue(list, 'Memo id', el('span', { class: 'mono' }, movement.memo.memoId));
        keyValue(list, 'Memo number', movement.memo.memoIndex);
        if (movement.memo.encoding === 'hex') keyValue(list, 'Memo bytes', el('span', { class: 'mono' }, movement.memo.hex));
      }
      body.append(list);
    }
  }
  const loose = receipt.memos.filter((memo) => !receipt.movements.some((movement) => movement.memo && movement.memo.memoIndex === memo.memoIndex));
  if (loose.length) {
    body.append(el('h3', {}, 'Memos without a USDC payment'));
    for (const memo of loose) {
      const list = el('dl', { class: 'kv' });
      keyValue(list, 'Memo', memoNode(memo));
      keyValue(list, 'Memo id', el('span', { class: 'mono' }, memo.memoId));
      keyValue(list, 'Called', el('span', { class: 'mono' }, memo.target));
      body.append(list);
    }
  }
  body.append(el('p', { class: 'help' }, `Rebuilt in your browser from the receipt of this transaction, as returned by ${receipt.network.rpcUrl}. Amounts are the native 18-decimal USDC values; nothing is rounded.`));
  $('receipt').hidden = false;
}

async function showReceipt(txHash, network, viewer) {
  clearError();
  $('result').hidden = true;
  controller = new AbortController();
  setBusy(true);
  setProgress(30, 'Reading the transaction…');
  try {
    const receipt = await fetchReceipt({ txHash: normalizeTxHash(txHash), network, signal: controller.signal });
    renderReceipt(receipt, viewer);
  } catch (error) {
    showError(explain(error));
  } finally {
    setBusy(false);
  }
}

function init() {
  const params = new URLSearchParams(location.search);
  const network = params.get('network') === 'testnet' ? 'testnet' : 'mainnet';
  document.querySelector(`input[name="network"][value="${network}"]`).checked = true;

  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 86400 * 1000);
  $('to').value = today.toISOString().slice(0, 10);
  $('from').value = weekAgo.toISOString().slice(0, 10);
  const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (isDay(params.get('from')) && isDay(params.get('to'))) {
    $('from').value = params.get('from');
    $('to').value = params.get('to');
    $('range').value = 'custom';
  } else if (['24', '168', '720'].includes(params.get('hours'))) {
    $('range').value = params.get('hours');
  }
  const toggleCustom = () => {
    const custom = $('range').value === 'custom';
    $('custom-from').hidden = !custom;
    $('custom-to').hidden = !custom;
  };
  toggleCustom();
  $('range').addEventListener('change', toggleCustom);

  $('lookup').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!controller) showLedger();
  });
  $('cancel').addEventListener('click', () => { if (controller) controller.abort(); });
  $('filter').addEventListener('input', applyFilter);
  $('csv').addEventListener('click', () => { if (currentLedger) download(`${fileStem(currentLedger)}.csv`, 'text/csv;charset=utf-8', ledgerToCsv(currentLedger)); });
  $('json').addEventListener('click', () => { if (currentLedger) download(`${fileStem(currentLedger)}.json`, 'application/json', JSON.stringify(currentLedger, null, 2) + '\n'); });

  const address = params.get('address');
  if (address) $('address').value = address;
  const tx = params.get('tx');
  if (tx) {
    let viewer = null;
    try { viewer = address ? normalizeAddress(address) : null; } catch { viewer = null; }
    const back = new URLSearchParams();
    if (viewer) back.set('address', viewer);
    if (network !== 'mainnet') back.set('network', network);
    $('receipt-back').href = [...back].length ? `?${back}` : './';
    showReceipt(tx, network, viewer);
  } else if (address) {
    showLedger();
  }
}

init();
