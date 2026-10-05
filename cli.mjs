#!/usr/bin/env node
// Command line reader: the same module the page uses, for people and agents without a browser.
//   node cli.mjs <address> --hours 24 [--csv|--json] [--testnet]
import { fetchLedger, fetchReceipt, resolveBlockRange, ledgerToCsv, ledgerRows, createRpc, NETWORKS, VERSION, LedgerError, RpcError } from './src/ledger.mjs';

const HELP = `arc-memo-ledger ${VERSION}: USDC payments and memos of an Arc address, read from the chain.

Usage
  node cli.mjs <address> [--hours 24] [--csv | --json] [--testnet]
  node cli.mjs <address> --from-block <n> [--to-block <n>]
  node cli.mjs --tx <transaction hash> [--json] [--testnet]

Options
  --hours <n>        look back this many hours from the newest block (default 24)
  --from-block <n>   first block, inclusive (instead of --hours)
  --to-block <n>     last block, inclusive (default: newest block)
  --csv              print the ledger as CSV
  --json             print the ledger as JSON
  --testnet          read Arc Testnet instead of Arc Mainnet
  --rpc <url>        another JSON-RPC endpoint of the same network
  --no-balance       skip the balance check
  --quiet            no progress on standard error
  --help             this text

Read-only. It never asks for a key or a signature and never sends a transaction.
Exit status: 0 done, 1 error, 2 wrong usage.`;

export function parseArgs(argv) {
  const options = { hours: undefined, format: 'text', network: 'mainnet', checkBalance: true, quiet: false };
  const takesValue = new Set(['--hours', '--from-block', '--to-block', '--rpc', '--tx']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new LedgerError('usage', `${arg} needs a value.`);
      if (arg === '--hours') options.hours = Number(value);
      if (arg === '--from-block') options.fromBlock = Number(value);
      if (arg === '--to-block') options.toBlock = Number(value);
      if (arg === '--rpc') options.rpcUrl = value;
      if (arg === '--tx') options.txHash = value;
    } else if (arg === '--csv') options.format = 'csv';
    else if (arg === '--json') options.format = 'json';
    else if (arg === '--testnet') options.network = 'testnet';
    else if (arg === '--no-balance') options.checkBalance = false;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new LedgerError('usage', `Unknown option ${arg}.`);
    else if (options.address === undefined) options.address = arg;
    else throw new LedgerError('usage', `Unexpected argument ${arg}.`);
  }
  for (const key of ['hours', 'fromBlock', 'toBlock']) {
    if (options[key] !== undefined && !(Number.isFinite(options[key]) && options[key] >= 0)) {
      throw new LedgerError('usage', 'Numbers must be zero or more.');
    }
  }
  if (options.fromBlock !== undefined && options.hours !== undefined) throw new LedgerError('usage', 'Use --hours or --from-block, not both.');
  return options;
}

function memoText(memo) {
  if (!memo) return '';
  if (memo.encoding === 'utf8') return JSON.stringify(memo.text);
  if (memo.encoding === 'empty') return '(empty memo)';
  const bytes = (memo.hex.length - 2) / 2;
  const inside = memo.readableParts && memo.readableParts.length ? `, contains the text ${JSON.stringify(memo.readableParts.join(' | '))}` : '';
  return `hex memo of ${bytes} bytes${inside} (full bytes with --json or --csv)`;
}

export function ledgerToText(ledger) {
  const lines = [];
  lines.push(`${ledger.network.name} (chain ${ledger.network.chainId})  address ${ledger.address}`);
  lines.push(`blocks ${ledger.range.fromBlock} to ${ledger.range.toBlock} (${ledger.range.blocks} blocks)`);
  lines.push('');
  for (const row of ledgerRows(ledger)) {
    const sign = row.direction === 'in' ? '+' : row.direction === 'out' ? '-' : ' ';
    lines.push(`${row.time}  ${row.direction.padEnd(8)} ${(sign + row.amount).padStart(14)} USDC  ${row.counterparty}  fee ${row.fee || '-'}  ${memoText(row.memo)}`);
    lines.push(`    ${ledger.network.explorer}/tx/${row.txHash}`);
  }
  if (ledger.payments.length + ledger.feeOnly.length === 0) lines.push('No USDC payment and no fee found for this address in this range.');
  lines.push('');
  lines.push(`payments in   ${ledger.totals.in} USDC`);
  lines.push(`payments out  ${ledger.totals.out} USDC`);
  lines.push(`fees paid     ${ledger.totals.fees} USDC`);
  lines.push(`net change    ${ledger.totals.net} USDC`);
  const check = ledger.balanceCheck;
  if (!check.available) lines.push(`balance check not done: ${check.reason}`);
  else if (check.reconciled) lines.push(`balance check  RECONCILED: ${check.opening} + ${ledger.totals.in} - ${ledger.totals.out} - ${ledger.totals.fees} = ${check.closing} (to the last unit)`);
  else if (check.explanation === 'unlisted_fees') lines.push(`balance check  the rows account for everything except ${check.unlistedFees} USDC: the fees of ${check.sentNotFound} other transaction(s) this address sent that moved no USDC (not itemised). Rows add up to ${check.expectedClosing}, the chain says ${check.closing}.`);
  else lines.push(`balance check  NOT EXPLAINED: the chain says ${check.closing}, the rows add up to ${check.expectedClosing}, difference ${check.difference} USDC (see README, "What it cannot see")`);
  return lines.join('\n') + '\n';
}

export async function main(argv, io = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.err(`${error.message}\n\n${HELP}\n`);
    return 2;
  }
  if (options.help || (!options.address && !options.txHash)) {
    io.out(HELP + '\n');
    return options.help ? 0 : 2;
  }
  const log = options.quiet ? () => {} : (text) => io.err(text + '\n');
  try {
    const net = NETWORKS[options.network];
    const rpc = createRpc({
      rpcUrl: options.rpcUrl || net.rpcUrl,
      userAgent: `Mozilla/5.0 (compatible; arc-memo-ledger/${VERSION}; +https://github.com/InnovateDigi/arc-memo-ledger)`,
      onRetry: ({ attempt, delayMs, reason }) => log(`  the RPC asked us to slow down (${reason}); retry ${attempt} in ${Math.round(delayMs / 1000)} s`),
    });
    if (options.txHash) {
      const receipt = await fetchReceipt({ txHash: options.txHash, network: options.network, rpcUrl: options.rpcUrl, rpc });
      io.out(JSON.stringify(receipt, null, 2) + '\n');
      return 0;
    }
    let { fromBlock, toBlock } = options;
    if (fromBlock === undefined) {
      const range = await resolveBlockRange({ hours: options.hours === undefined ? 24 : options.hours, network: options.network, rpcUrl: options.rpcUrl, rpc });
      fromBlock = range.fromBlock;
      toBlock = range.toBlock;
    }
    log(`reading ${net.name}${toBlock === undefined ? ` from block ${fromBlock}` : ` blocks ${fromBlock} to ${toBlock}`} ...`);
    const ledger = await fetchLedger({
      address: options.address, fromBlock, toBlock, network: options.network, rpcUrl: options.rpcUrl, rpc, checkBalance: options.checkBalance,
      onProgress: (p) => { if (p.phase !== 'balance' && (p.done === p.total || p.done % 10 === 0)) log(`  ${p.phase} ${p.done}/${p.total}`); },
    });
    if (options.format === 'json') io.out(JSON.stringify(ledger, null, 2) + '\n');
    else if (options.format === 'csv') io.out(ledgerToCsv(ledger));
    else io.out(ledgerToText(ledger));
    return 0;
  } catch (error) {
    if (error instanceof LedgerError || error instanceof RpcError) io.err(`Error: ${error.message}\n`);
    else io.err(`Error: ${error && error.stack ? error.stack : error}\n`);
    return error instanceof LedgerError && error.code === 'usage' ? 2 : 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly || (process.argv[1] && process.argv[1].endsWith('cli.mjs'))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
