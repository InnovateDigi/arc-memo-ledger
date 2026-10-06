# VERIFY: what was checked, against what, and what was not

All chain data below was read from `https://rpc.mainnet.arc.io` (chain id `0x13b2` = 5042)
on 5 October 2026 between 09:20 and 10:00 UTC with read-only JSON-RPC calls. The raw
responses are stored in `test/fixtures/` and replayed by the unit tests. Anyone can repeat
the calls. "Docs" means the first-party pages at https://docs.arc.io :
`/arc/references/usdc-system-events`, `/arc/concepts/transaction-memos`,
`/arc/references/rpc-endpoints`, `/arc/references/contract-addresses`,
`/arc/references/evm-differences`.

## 1. Event layouts

| Event | Signature hashed by this tool | topic0 computed by `src/keccak.mjs` | Evidence |
| :- | :- | :- | :- |
| USDC movement | `Transfer(address,address,uint256)` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` | Equal to the topic0 printed in the docs ("USDC system events") and to the logs of emitter `0xffff...fffe` on mainnet. |
| Memo frame start | `BeforeMemo(uint256)` | `0xb252e055da754c72fbf7542cf424b190808a9b541e912894c5e15b4238c41501` | Equal to topic0 of logs 2, 6 and 10 of tx `0xf0a3c947...` emitted by `0x5294e9927c3306dcbadb03fe70b92e01ccede505`. |
| Memo | `Memo(address,address,bytes32,bytes32,bytes,uint256)` | `0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4` | Equal to topic0 of logs 5, 9 and 13 of the same transaction. |

The docs give the Memo fields, their types and which are indexed in a table, and the order
in the line `Memo(sender, target, callDataHash, memoId, memo, memoIndex)`; they do not
print the signature string. The string above is that order with those types. Two
independent on-chain checks show it is right:

- a different order or type would hash to a different topic0, and the computed topic0 is
  the one on mainnet;
- the decoded `callDataHash` equals `keccak256` of the forwarded calldata, as the docs
  define it, for two real memos: tx `0x9803e9aa...` forwards empty calldata and its
  `callDataHash` is `0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`
  (= keccak256 of nothing); in tx `0xf0a3c947...` the first memo's `callDataHash`
  `0x763b3461552ff8126a4935e123f8c95bc7737f86b1a2b2957b2f8110ebbc394a` equals keccak256 of
  `transfer(address,uint256)` calldata rebuilt from the ERC-20 log beside it.

Both checks are unit tests (`test/keccak.test.mjs`). All 60 `Memo` logs found in blocks
24,278,860 to 24,368,850 decode without error (8 are text, 52 are binary and shown as hex).

The Keccak-256 code is checked three ways: known answers, the docs' own topic0, and the
same sponge with SHA-3 padding against Node's built-in SHA3-256 for every input length
from 0 to 420 bytes.

## 2. Real mainnet transactions, tool output compared with the raw receipt

**A. Three payments with memos in one transaction**
`0xf0a3c947b36eaf6a8c09a064454cded790c37a141fccb50821553cbfb34463a4`, block 24,358,200,
`blockTimestamp 0x6ac35835` = 2026-10-05 07:56:37 UTC.
Raw receipt: `from 0xc541c196...4d0e`, `to 0x522faf9a...47d0` (listed in the docs as
Multicall3From), 12 logs = three groups of BeforeMemo, system Transfer, ERC-20 Transfer,
Memo. System values `0x01f161421c8e0000`, `0x8e1bc9bf040000`, `0x8e1bc9bf040000`
(140000000000000000, 40000000000000000, 40000000000000000 at 18 decimals); ERC-20 values
`0x222e0`, `0x9c40`, `0x9c40` (140000, 40000, 40000 at 6 decimals).
`gasUsed 0x2265b` (140,891) x `effectiveGasPrice 0x4a817c800` (20 gwei) = 2817820000000000.
Tool: 3 payments out, 0.14 / 0.04 / 0.04 USDC to `0xe874c325...`, `0xccd52402...`,
`0xe3fc4fd7...`; memo numbers 844, 845, 846 (128 bytes each, binary, shown as hex); fee
0.00281782 USDC charged once; "3 ERC-20 duplicates ignored". Matches.

**B. A plain native send (no memo)**
`0x2c64e3091ad55022a7bf5045d0f30572aa92c3289c6cbd70fb626097623390f7`, block 24,357,967,
07:54:38 UTC. Raw receipt: one log only, from the system emitter, value
`0x02c68af0bb140000` (200000000000000000); `gasUsed 21000` x `effectiveGasPrice
20000010000` = 420000210000000. Tool: for the recipient `0xc541c196...` one payment in of
0.20 USDC with no fee; for the sender `0xe874c325...` one payment out of 0.20 with fee
0.00042000021 USDC. Matches, and confirms the docs: "A plain native send emits only the
system log."

**C. A payment with a text memo**
`0xbefd3c02d3d3e7ce0ced57b60f7908f8ddbca1f17f38abf0debe4fa40ff94949`, block 24,348,383,
06:33:36 UTC, sent straight to the Memo contract. Raw receipt: BeforeMemo; system
Transfer `0xd951d326...` to `0xf118af31...` value `0x02c68af0bb140000`; ERC-20 Transfer
`0x30d40` (200000 at 6 decimals); Memo. `gasUsed 67828` x `40000000000` = 2713120000000000.
Tool: 0.20 USDC, memo text `testing payment after phase 12`
(`0x74657374696e67207061796d656e74206166746572207068617365203132`), memo number 791,
fee 0.00271312 USDC. Matches.

**D. A memo with no payment**
`0x9803e9aaa5341f12587e7d7cb8ff883ffc81f0315af0957a9300e3fa14ba0779`, block 24,360,267,
08:14:06 UTC. Raw receipt: BeforeMemo and Memo only; `gasUsed 37218` x `22000000000` =
818796000000000. Tool: no USDC movement, memo text `arc nice note`, memo number 847, listed
as a "fee only" row with fee 0.000818796 USDC. Matches.

**E. An ERC-20 log that is not a payment (the de-duplication rule matters)**
`0xab1966bc3dd9e5fa4f7b5fcb03cf4bc34d1c5dacb4c3ffb683ec7b2f5e96b3ac`, block 24,360,280.
Raw receipt: the ERC-20 contract logs `Transfer(0x2a05a76b..., 0x2a05a76b..., 100)`, a
transfer of 0.0001 USDC from an address to itself, wrapped in a memo `Tax pay`. The system
emitter logs nothing, as the docs say ("Self-transfers (from == to) emit no log"). Tool: no
payment, one "fee only" row with the memo and fee 0.001347984 USDC. A reader that counted
ERC-20 logs would report a payment here that changed no balance. The same holds for
zero-value transfers (for example `0x4677de12...`, ERC-20 value 0, no system log).

## 3. Balance check (historical state is served)

`eth_getBalance` at past blocks answered on the public RPC, so the check is built in.

| Address | Blocks | Opening | + in | - out | - fees | = expected | Closing on chain | Result |
| :- | :- | :- | :- | :- | :- | :- | :- | :- |
| `0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e` | 24,353,000 to 24,361,999 | 0.16635212 | 0.20 | 0.22 | 0.0063871 | 0.13996502 | 0.13996502 | reconciled, difference 0 base units |
| same address, last 24 hours on the page | 24,200,068 to 24,370,352 | 0.00 | 0.37 | 0.22 | 0.01003498 | 0.13996502 | 0.13996502 | reconciled |
| `0xe874c32569a28b2d0bca07ef25f0ec0b68beedd0` | 24,353,000 to 24,361,999 | 0.450725354855496 | 0.14 | 0.20 | 0.01247336021 | 0.378251994645496 | 0.378251994645496 | reconciled |
| `0x2a05a76b4a2290a63214a32ffe2504d814b348f9` | 24,353,000 to 24,361,999 | 1.504304367688289957 | 0.00 | 0.00 | 0.009191292 | 1.495113075688289957 | 1.487036787688289957 | **no tick**: 0.008076288 short, reported as the fees of 2 unlisted transactions |

In base units, first row: 166352120000000000 + 200000000000000000 - 220000000000000000
- 6387100000000000 = 139965020000000000, the value `eth_getBalance` returns at block
24,361,999.

The fourth row is the honest limit. The tool found eight transactions sent by that address
(nonces 255 to 258 and 260 to 263, read with `eth_getTransactionByHash` during
development). `eth_getTransactionCount` at blocks 24,352,999 and 24,361,999 shows the
account sent 10 transactions in the range, and `eth_getCode` shows it is not a contract.
So two transactions left no event that names the address; a log reader cannot list them,
and the tool reports the 0.008076288 USDC as "the fees of 2 other transactions that moved
no USDC (not itemised)", with no tick. That those two transactions cost exactly that sum
is an inference from the balance, not something read from their receipts.

## 4. The page and the command line, run for real

- Page, headless Chrome 1280 px and 390 px, served from a local static server
  (`scripts/check-page.mjs`): `?address=0xc541c196...` returned 13 rows (7 payments, 6
  fee-only) from mainnet with the balance tick computed; the filter narrowed 13 rows to 8;
  `?tx=0xf0a3c947...` showed the receipt with 3 payments; no horizontal overflow at either
  width; no console error; document.cookie empty and storage length 0; hosts contacted:
  the local server and `rpc.mainnet.arc.io` only (in the longer run also
  `rpc.testnet.arc.io`, and one `data:` URL, which is not a network request).
- Same browser run, further steps: custom dates (5 Oct 2026, UTC) returned the same 13 rows
  with 41 requests; "Download CSV" and "Download JSON" produced a text/csv file of 15 lines
  and an application/json file; "Cancel" during a 7-day read showed the cancelled message
  and no further request was sent in the next four seconds; a receipt lookup with
  `network=testnet` reached `rpc.testnet.arc.io` from the browser.
- Second address in the browser, `0x2a05a76b...`, last 24 hours (64 requests): 12 fee-only
  rows and the message "the rows account for everything except 0.012114432 USDC ... the fees
  of 3 other transactions this address sent" (transaction counter +15, 12 listed). No tick.
- Independent reference: a separate script (not this project's code) recorded the raw
  system-emitter logs, balances and nonces of two addresses for blocks 24,357,200 to
  24,359,199. `test/reference.test.mjs` checks that this tool's rows match it one for one,
  that both balances agree, and that the itemised fees equal the fees the reference could
  only imply from the balance (4011780000000000 and 4029960210000000 base units).
- `node cli.mjs 0xc541c196... --hours 24` printed the same 13 rows and "RECONCILED".
- `npm run smoke` passed against mainnet.
- `node cli.mjs 0xc541c196... --testnet --hours 1` reached Arc Testnet (the tool checks
  chain id 5042002) and returned an empty ledger for that address.

## 5. UNVERIFIED

- **UNVERIFIED: explorer transaction links.** The docs show links of the form
  `https://explorer.arc.io/address/<address>`; the form `/tx/<hash>` used for transaction
  links is the usual one for this kind of explorer but was not opened.
- **UNVERIFIED: how far back the public RPC serves historical balances.** It answered without
  error at block 24,200,067 (about a day back). A read at block 1 also returned without
  error, but with a zero balance, which proves little. If a read fails the page says the
  check was not done.
- **UNVERIFIED: that the sender always pays the fee.** The tool charges
  `gasUsed x effectiveGasPrice` to the receipt's `from`. That reconciled exactly in the
  three ranges above; sponsored transactions, if Arc has them, were not examined.
- **UNVERIFIED: nested memos on real data.** The docs describe nested memo frames; none was
  found on mainnet, so that path is tested with logs built from the real layouts.
- **UNVERIFIED: testnet with data.** Only an empty testnet ledger was read. The older
  testnet events from before its "Zero5" upgrade are not read at all.
- **UNVERIFIED: long ranges.** The longest run was 24 hours (60 requests). The 7-day and
  30-day figures in the README are arithmetic, not measurements.
- **UNVERIFIED: other RPC providers.** Only `rpc.mainnet.arc.io` and `rpc.testnet.arc.io`
  were used. The log query without a contract address worked there; another provider may
  refuse it.
- **UNVERIFIED: HTTP 429 from the live endpoint.** The built-in pace never triggered one,
  so the retry path is covered by unit tests with a simulated 429 only. In the second pass
  (section 6) a burst of 30 requests with the pause switched off was also answered without
  a 429, so there is still no live example.

## 6. Second pass after publication

Done on 5 October 2026 between 10:41 and 10:56 UTC by a separate review run (also an AI
system, not the run that wrote the code), with its own scripts where a comparison is named.

- **The page on its real origin.** `node scripts/check-page.mjs https://innovatedigi.github.io/arc-memo-ledger/`
  in headless Chrome at 10:54 UTC: 13 rows from mainnet for `0xc541c196...` with the
  balance tick (61 requests); the filter; the receipt of `0xf0a3c947...` with 3 payments;
  custom dates (5 Oct 2026: 13 rows, 40 requests); both downloads; Cancel; the testnet
  endpoint; no horizontal overflow at 1280 px or 390 px; no console error; no cookie, no
  storage. Hosts contacted: the page's own host, `rpc.mainnet.arc.io` and
  `rpc.testnet.arc.io`. The served `src/ledger.mjs` and `app.mjs` were byte-identical to
  the files in this repository.
- **A busy address for one hour of chain.** `node cli.mjs 0xf56ed4fb3308d58346a07692320c851936480d33 --hours 1`,
  blocks 24,370,707 to 24,377,801: 382 payments (380 out, 2 in), 397 requests, no retry.
  Balance check passed to the last unit: 21.657138443619203406 + 0.000013856369105107
  - 1.18945144 - 0.1596 = 20.308100859988308513. A separate script that reads the raw
  logs with curl found the same 380 and 2 logs with the same sums (1189451440000000000 and
  13856369105107 base units), the same fees implied by the two balances
  (159600000000000000) and a transaction counter that rose by 380, the number of sent
  transactions listed. Three rows were compared field by field with their raw receipts
  (`0xbfa5c505...` log 3, `0x7125e0af...` log 4, `0xb97a608d...` log 14): direction,
  counterparty, amount, block, time and fee all equal.
- **The reference window, read live.** Both addresses of
  `test/fixtures/independent_reference.json` (blocks 24,357,200 to 24,359,199) were read
  again from mainnet with the command line: rows, sums, both balances and the fees equal
  the reference (8 and 10 requests).
- **The unlisted-fees case, read live.** `0x2a05a76b...`, blocks 24,353,000 to 24,361,999:
  no tick and no error; "the fees of 2 other transaction(s)", 0.008076288 USDC
  (transaction counter +10, 8 listed).
- **Self-transfers and zero values.** Of 3,776 system-emitter logs in blocks 24,377,059 to
  24,377,758, none had the same sender and recipient and none had value 0; all carried
  the topic0 that `src/keccak.mjs` computes for `Transfer`.
- **CSV.** Hostile memo texts starting with `=`, `+`, `-` and `@` were put through
  `ledgerToCsv` and the file parsed back: no cell starts with one of those characters.
- **CI.** The test workflow ran on Node 20, 22 and 24 after the first push: all passed.

## 7. Example link added, 6 October 2026

- The page now has an "Open an example" link under the address box. It opens one address
  on 5 October 2026 (`?address=0xc541c196...&from=2026-10-05&to=2026-10-05`).
- Why: on 6 October the address used in the examples had made no payment for a day, so
  "Last 24 hours" showed an empty ledger for it (0 rows, balance check passed). A fixed
  day does not go empty. The command line examples in the README use a fixed window of
  blocks for the same reason.
- Checked in real headless Chrome on 6 October 2026, on a local copy of these files: the
  link is visible at 1280 px and 390 px with no horizontal overflow; one click showed 13
  rows (7 payments and 6 fee-only transactions) with the balance tick after 37 seconds and
  66 requests, with no console error.
  `node cli.mjs 0xc541c196f38f2a92e87e3835df2a8f68ccdb4d0e --from-block 24353000 --to-block 24361999`
  printed 4 payments and 3 fee-only rows and "RECONCILED".
- UNVERIFIED: how long the public RPC keeps serving the events and balances of 5 October.
  On 6 October it served them about 290,000 blocks back. If it stops, the example will
  show fewer rows or no balance tick.
