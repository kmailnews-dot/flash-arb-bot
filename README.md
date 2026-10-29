# flash-arb-bot

An Aave V3 flash-loan arbitrage bot for Arbitrum. It borrows tokens with **zero collateral**,
swaps them across two DEXs in one atomic transaction, and keeps the profit — or, if the trade
isn't profitable, the whole transaction reverts and the loan is undone automatically. Everything
here is designed to run on a schedule via GitHub Actions, so it works with nothing but a phone
and free-tier accounts.

## ⚠️ Read this first

- **This is not a guaranteed money-maker.** Flash-loan arbitrage is a mature, heavily-competed
  space: professional bots with private nodes and MEV infrastructure catch almost every
  meaningful price gap within a block or two. This bot can absolutely find and execute real
  opportunities, but don't expect steady income from it.
- **"$0 upfront" is true for the trade capital, not for gas.** The flash loan itself never
  requires you to hold the borrowed asset — that's the whole point of a flash loan. But
  *submitting the transaction* costs a small amount of ETH in gas, the same as any Arbitrum
  transaction, whether or not the arbitrage succeeds. See "The gas question" below.
- **The scheduled scan is read-only.** The GitHub Actions scan always runs with `DRY_RUN=true`
  and has no access to `PRIVATE_KEY` or `CONTRACT_ADDRESS`; it only logs opportunities. Live
  execution is handled by a separate workflow, so nothing trades until you explicitly configure
  and fund that workflow.
- **Use a burner wallet.** Never put your main wallet's private key into a bot or a CI secret.
  Create a wallet with no funds beyond what you're willing to risk, specifically for this bot.
- This is educational/personal-use software, not audited, and provided with no warranty (see
  [LICENSE](LICENSE)). Review the contract yourself before sending it real funds.

## How it works

1. `FlashArbExecutor.sol` asks Aave V3's Pool for a flash loan of some token — no collateral,
   just a promise to repay it (plus a 0.05% fee) by the end of the transaction.
2. It swaps the borrowed token for an intermediate token on one DEX, then swaps that back to the
   original token on a second DEX.
3. If the round trip didn't produce enough to repay the loan plus your configured minimum profit,
   the `require` guard reverts — which undoes *everything*, including the loan, atomically. You
   only lose the gas for the attempt, never the borrowed capital.
4. If it did clear the bar, the loan + fee are repaid and the surplus is sent to the contract
   owner (you).

Off-chain, a small Node.js scanner (`bot/`) periodically checks live DEX prices, estimates
profit after fees and gas, and calls `startArbitrage` only when a trade looks worthwhile — the
on-chain `require` is the real safety net; the off-chain check just avoids wasting gas on
attempts that clearly won't clear it.

The scheduled GitHub Actions workflow runs this scanner in read-only mode: `DRY_RUN` is
hard-coded to `true` and the job never receives wallet secrets. Live submission is isolated in a
separate, manual-only workflow (`.github/workflows/live.yml`).

Before sending a live transaction, the bot simulates it with `staticCall` and estimates its gas
with `estimateGas`. If the simulation reverts or the estimate exceeds the configurable
`MAX_GAS_LIMIT` (default 1,000,000), the trade is skipped instead of submitted. It also applies
loss guards (chainId, wallet balance, daily gas, circuit breaker) — see "Live-execution loss
guards" below.

## The gas question

I looked into free gas-sponsoring relayers (Gelato Relay, Biconomy, ERC-4337 paymasters, etc.)
so this could be truly $0 end-to-end. None of them work out for this: every one of them requires
*someone* to pre-fund a sponsor balance or paymaster deposit — there's no free-forever tier that
covers arbitrary mainnet contract calls indefinitely. So the honest answer is:

- Fund your burner wallet with a small amount of ETH on Arbitrum — a few dollars covers a large
  number of transaction attempts, since Arbitrum gas is cheap (typically fractions of a cent to
  a few cents per tx).
- The scheduled scan always runs in this mode (`DRY_RUN=true`); for local runs, leave
  `DRY_RUN=true` until you're ready to trade. The bot is fully useful in that mode: you get a live
  log of what it *would* have done and its estimated profit, with zero cost or risk.
- If you'd rather not risk even a few dollars, test everything on **Arbitrum Sepolia** (the
  testnet) first, funded by a free faucet — see the walkthrough below.

## Quick start — entirely from an iPhone

Everything below works from mobile Safari (or the GitHub app) plus GitHub's website. No
terminal, no laptop, no code editing required.

### 1. Get a free Arbitrum RPC URL

Sign up (free tier) at [Alchemy](https://www.alchemy.com/) or [Infura](https://www.infura.io/),
create an app for "Arbitrum One" (mainnet) and, if you want to test on testnet first, "Arbitrum
Sepolia" too. Copy the HTTPS RPC URL for each.

### 2. Create a burner wallet

Install [MetaMask](https://metamask.io/) (or any wallet app), create a **new** wallet you'll use
only for this bot, and export its private key (MetaMask: Account details → Show private key).
Keep this private key out of chat, screenshots, and anywhere public — GitHub Secrets (next
step) is the only place it should go. The scheduled scan workflow deliberately never receives it.

### 3. Set your GitHub repository secrets

In this repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**.
Add these (see [`.env.example`](.env.example) for the exact shape of the JSON ones):

| Secret | Required for | Notes |
| --- | --- | --- |
| `ARBITRUM_RPC_URL` | scanning | from step 1 |
| `ARBITRUM_SEPOLIA_RPC_URL` | testnet deploy | from step 1, only if testing first |
| `PRIVATE_KEY` | deploying / live execution | your burner wallet's key, from step 2; never exposed to the scheduled scan |
| `AAVE_POOL_ADDRESSES_PROVIDER` | deploying | Aave V3 provider for the target network; see step 4 |
| `CONTRACT_ADDRESS` | live execution on Arbitrum One | filled in after you deploy (step 5); not used by the scheduled scan |
| `CONTRACT_ADDRESS_SEPOLIA` | live execution on Arbitrum Sepolia | filled in after the testnet deploy (step 5); not used by the scheduled scan |
| `ETH_USD_ROUTE_JSON` | USD profit filtering | network-specific; see step 4 |
| `PAIRS_CONFIG_JSON` | scanning | see step 4 |
| `ETH_USD_ROUTE_JSON_SEPOLIA` | live execution on Arbitrum Sepolia | required only if you run live.yml against arbitrumSepolia; see step 4 |
| `PAIRS_CONFIG_JSON_SEPOLIA` | live execution on Arbitrum Sepolia | required only if you run live.yml against arbitrumSepolia; see step 4 |

The **Flash arb scan** workflow does not read `DRY_RUN`, `PRIVATE_KEY`, or the contract-address
secrets: it always runs read-only with `DRY_RUN=true` and never receives the wallet secrets. Those
are only needed for deployment and for the separate live-execution workflow.

The deploy workflow reads a single `AAVE_POOL_ADDRESSES_PROVIDER` secret for both targets, so set it
to the Aave provider for the network you are deploying to and change it again before deploying to
the other network.

### 4. Look up current addresses

Contract addresses on Arbitrum can change between protocol versions, so this repo keeps them in
configuration rather than in the bot/contract code — a wrong guess could silently point the bot at
the wrong contract. The addresses below are verified examples from the projects' own docs; re-check
them before deploying:

- **Aave V3 PoolAddressesProvider (Arbitrum)**:
  <https://aave.com/docs/resources/addresses>
- **Uniswap V3 SwapRouter (original) & QuoterV2 (Arbitrum)**:
  <https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments>
- **SushiSwap V2 Router (Arbitrum)** or **Camelot V2 Router** (either works as your V2-style
  leg): check each project's docs/GitHub for their current Arbitrum deployment address.
- **WETH / USDC on Arbitrum**: also listed on the Uniswap/Aave docs pages above.

The executor's `ISwapRouterV3Like` interface matches the **original** Uniswap V3 SwapRouter
(`ExactInputSingleParams` has 8 fields, including `deadline`). On Arbitrum One that router is
`0xE592427A0AEce92De3Edee1F18E0157C05861564`. **SwapRouter02 is incompatible** with this interface:
its `ExactInputSingleParams` has no `deadline` field (SwapRouter02 enforces the deadline through
`multicall(uint256 deadline, bytes[] data)`), so the function selector differs and a call built for
the original SwapRouter would revert.

Use these to fill in `AAVE_POOL_ADDRESSES_PROVIDER`, and the `PAIRS_CONFIG_JSON` /
`ETH_USD_ROUTE_JSON` secrets (templates and field explanations are in
[`.env.example`](.env.example)).

### 5. Deploy the contract

Go to this repo's **Actions** tab → **Deploy FlashArbExecutor** → **Run workflow**. Pick
`arbitrumSepolia` first (free testnet — get test ETH from
[an Arbitrum Sepolia faucet](https://www.alchemy.com/faucets/arbitrum-sepolia) for your burner
wallet before running it), confirm it works, then re-run with `arbitrum` for the real deployment
(this needs a small amount of real ETH in your burner wallet for gas).

Before each run, make sure `AAVE_POOL_ADDRESSES_PROVIDER` is the Aave V3 provider for the selected
network. After the Sepolia run, copy the printed address into `CONTRACT_ADDRESS_SEPOLIA`; after the
Arbitrum One run, copy it into `CONTRACT_ADDRESS`. The scheduled scan does not need either.

Verify a deployment against the current source before enabling live execution:

```bash
CONTRACT_ADDRESS=0xSepoliaAddress npx hardhat run scripts/deploy-live.js --network arbitrumSepolia
CONTRACT_ADDRESS=0xArbitrumOneAddress npx hardhat run scripts/deploy-live.js --network arbitrum
```

The script compares the on-chain runtime bytecode (ignoring immutable slots) against the freshly
compiled `FlashArbExecutor` artifact and exits non-zero if the address still points at an older
version.

### 6. Watch it scan

The **Flash arb scan** workflow runs automatically every ~10 minutes (and you can trigger it by
hand from the Actions tab). It is read-only: `DRY_RUN` is hard-coded to `true` and the job has no
access to `PRIVATE_KEY` or `CONTRACT_ADDRESS`. Check its logs — you'll see every trade size it
checked and any opportunities found, with zero cost or risk.

### 7. Go live (optional, real money)

Live execution lives in [`.github/workflows/live.yml`](.github/workflows/live.yml) and is
manual-only by design: it has a `workflow_dispatch` trigger and no cron. It is the only workflow
that receives `PRIVATE_KEY`. Before trading, it runs `scripts/deploy-live.js` to verify that the
configured contract matches the current `FlashArbExecutor` source, then runs one scan cycle with
`DRY_RUN=false`.

Go to **Actions → Live execution (manual) → Run workflow**, pick the network, and type `EXECUTE`
to confirm. Start on `arbitrumSepolia`; use `arbitrum` only after the testnet deployment and
verification pass. The burner wallet must hold a small amount of ETH on the selected network for
gas.

### Scan history and measurement

Every scan result — one line per pair/trade size, including errors — is appended to a JSONL file
at `SCAN_LOG_PATH` (default `./logs/scans.jsonl`). Each line records `timestamp`, `chainId`,
`pair`, `borrowedToken`, `tradeSize`, `grossProfit` (raw token units as a string),
`grossProfitSymbol`, `grossProfitUsd`, `netProfitUsd`, `gasCostUsd`, `isOpportunity`, and `error`.
Parent directories are created automatically, and a persistence failure is logged as a warning
without stopping the scan. `logs/` is ignored by Git.

The scheduled GitHub Actions runner is ephemeral, so [`scan.yml`](.github/workflows/scan.yml)
uploads the file as the
`scan-log` artifact after every run (90-day retention). Download the artifacts to analyse them
together, or run `npm run scan` on a persistent machine (cron/systemd timer) to keep a single
cumulative file. A quick analysis:

```bash
jq -r 'select(.isOpportunity) | [.timestamp,.pair,.tradeSize,.netProfitUsd] | @tsv' logs/scans.jsonl
```

### Live-execution loss guards

With `DRY_RUN=false`, `maybeExecute` checks the following before submitting, in order:

1. **Circuit breaker** — after `MAX_CONSECUTIVE_FAILURES` (default 5) consecutive failed
   execution attempts, all live attempts are refused for `CIRCUIT_BREAKER_COOLDOWN_MINUTES`
   (default 60). State is persisted in `./logs/circuit_breaker.json`.
2. **Chain ID** — the RPC's chainId must equal `EXPECTED_CHAIN_ID` (default `42161`, Arbitrum One).
   The live workflow sets `421614` automatically when you select `arbitrumSepolia`.
3. **Wallet balance** — refuse if the burner wallet holds more than `MAX_WALLET_BALANCE_ETH`
   (default `0.1` ETH), to cap the blast radius.
4. **Per-transaction gas cap** — the existing `MAX_GAS_LIMIT`.
5. **Daily gas cap** — projected gas cost (`estimateGas × gas price`) plus today's cumulative
   spend must stay below `MAX_DAILY_GAS_ETH` (default `0.01` ETH). The estimate is reserved before
   broadcast and reconciled to the actual receipt cost; the counter is stored in
   `./logs/gas_spent.json` and resets at UTC midnight.

Because GitHub-hosted runners are ephemeral, `live.yml` restores and saves the two guard state
files through the Actions cache (keyed per network) so the limits survive manual runs. Caches can
be evicted after 7 days of inactivity; run the live bot on a persistent host if you need a stronger
guarantee.

Guard skips return `submitted: false` with an explicit `error` (`CHAIN_ID_MISMATCH`,
`WALLET_BALANCE_ABOVE_MAX`, `DAILY_GAS_LIMIT`, `CIRCUIT_BREAKER_OPEN`). If a guard check or the
gas reservation cannot read/write its state, the bot fails closed and sends nothing for that
transaction. A successful trade resets the consecutive-failure counter. The contract's on-chain
`minProfit` logic is unchanged.

## Monitoring

Two lightweight checks surface operational problems in the workflow logs:

- `MIN_WALLET_BALANCE_ETH` (default `0.005`): when a wallet key is configured (live execution),
  the bot checks the gas wallet at the start of each scan and logs a `[BALANCE LOW]` warning if
  the balance is below this threshold. It is an alert only and does not block the run; the
  scheduled scan never receives `PRIVATE_KEY`, so it skips this check.
- `MAX_RPC_ERRORS_PER_SCAN` (default `3`): the bot counts per-quote errors (RPC/quote failures)
  during a scan and logs `[RPC ERRORS] N erreurs sur ce cycle.` when the count is greater than
  this value. Like the balance warning, it is informational and does not stop the scan.

Both messages appear in the Actions run log; the per-result errors are also written to
`SCAN_LOG_PATH` for later analysis.

## Configuring pairs & DEXs

`PAIRS_CONFIG_JSON` is a JSON array — each entry is one borrow/swap/swap-back route to scan,
across chosen trade sizes. Full field reference and a worked example are in
[`.env.example`](.env.example). A couple of things worth knowing:

- The bot can only convert profit into a USD figure (for `MIN_PROFIT_USD` filtering) when the
  borrowed token is WETH (`isWeth: true`) or a USD stablecoin (`isStable: true`). For anything
  else, it skips USD filtering and relies on the raw on-chain profit check instead.
- `ETH_USD_ROUTE_JSON` prices gas in USD by quoting 1 WETH against a stablecoin on a real DEX
  pool — no external price API or key needed. **Its addresses must belong to the network you are
  actually running on.** Mainnet router/token addresses do not exist on Arbitrum Sepolia, so the
  quote returns empty data; the bot now treats that as non-fatal (see below).
- A "V3" leg needs both `router` (the **original** Uniswap V3 SwapRouter used to execute the
  swap) and `quoter` (the separate QuoterV2 contract used only to check prices) — the SwapRouter
  doesn't expose a quoting function itself. Do not use SwapRouter02: its `ExactInputSingleParams`
  has no `deadline` field, so it is incompatible with the executor's `ISwapRouterV3Like` interface.

`PAIRS_CONFIG_JSON` is an array, so you can scan several pairs in the same run — the production
configuration currently uses 7. For example, append this USDC/WBTC route that uses Camelot V2 for
the outbound leg and SushiSwap V2 for the return leg:

```json
{
  "label": "USDC/WBTC via Camelot V2 + SushiSwap V2",
  "borrowedToken": {"address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "decimals": 6, "symbol": "USDC", "isStable": true},
  "intermediateToken": {"address": "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", "decimals": 8, "symbol": "WBTC"},
  "legOut": {"kind": "V2", "router": "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", "tokenOut": "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"},
  "legBack": {"kind": "V2", "router": "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", "tokenOut": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"},
  "tradeSizes": ["10", "50", "100"]
}
```

Example `ETH_USD_ROUTE_JSON` for **Arbitrum One** (SushiSwap V2, WETH → native USDC):

```json
{
  "kind": "V2",
  "router": "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  "weth": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  "usdc": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "usdcDecimals": 6
}
```

If the ETH/USD quote fails for any reason (wrong-network addresses, missing pool, revert), the
bot logs a warning and continues with `ethUsdPrice = null`: the USD filter (`MIN_PROFIT_USD`) is
disabled for that run and opportunities are judged on raw on-chain profit (`grossProfit > 0`)
instead. The contract's own `minProfit` guard still applies on-chain. On Arbitrum Sepolia, leave
`ETH_USD_ROUTE_JSON` unset unless you have a valid Sepolia WETH/stablecoin pool.

## Try it risk-free on a local mock network

If you (or a friend) have a computer handy, you can exercise the entire pipeline — contract,
scanner, and live execution — against fake tokens and fake liquidity, with zero real network
calls and zero real funds:

```bash
npm install
npx hardhat node                                        # terminal 1: local test chain
npx hardhat run scripts/seedLocalMocks.js --network localhost   # terminal 2: deploy + seed mocks
# copy the printed .env values, then:
DRY_RUN=false npm run scan                               # exercises the full on-chain execution path
```

This is also what the test suite (`npm test`) exercises at the unit level — see
`test/FlashArbExecutor.test.js`. The fast suite is **107 passing, 2 pending** (the pending tests
are the optional fork tests below), and CI runs it via
[`ci.yml`](.github/workflows/ci.yml).

**Known local-deployment limitation:** `npx hardhat run scripts/deploy.js --network hardhat` fails
because chainId `31337` has no Aave V3 addresses in `bot/networks.js`. This is a known limitation,
not a bug; use `scripts/seedLocalMocks.js` above for a local mock deployment.

## Fork integration test (optional)

`npm test` only runs the fast unit/integration tests. To exercise the contract against the real
Aave, Uniswap V3 and SushiSwap deployments, pin an Arbitrum block and run:

```bash
ARBITRUM_FORK_BLOCK=<recent-block-number> npm run test:fork
```

The test uses `ARBITRUM_FORK_RPC_URL` if set, otherwise `ARBITRUM_RPC_URL`, deploys
`FlashArbExecutor` with the real Aave `PoolAddressesProvider`, attempts WETH/USDC round trips of
0.01 and 0.1 WETH through SushiSwap V2 + Uniswap V3, and checks that the incompatible SwapRouter02
reverts. Forking an old block normally requires an archive-capable RPC. If `ARBITRUM_FORK_BLOCK`
is unset, or the RPC cannot serve historical state, the suite is skipped with a clear message
instead of failing.

## Configuration reference

See [`.env.example`](.env.example) for every environment variable / secret this project reads,
with inline explanations — RPC URL, `DRY_RUN`, gas and slippage tuning, `MIN_PROFIT_USD`,
`SCAN_LOG_PATH`, the loss-guard limits (`EXPECTED_CHAIN_ID`, `MAX_WALLET_BALANCE_ETH`,
`MAX_DAILY_GAS_ETH`, `MAX_CONSECUTIVE_FAILURES`, `CIRCUIT_BREAKER_COOLDOWN_MINUTES`), the
monitoring thresholds (`MIN_WALLET_BALANCE_ETH`, `MAX_RPC_ERRORS_PER_SCAN`), the fork-test block,
and the `PAIRS_CONFIG_JSON` / `ETH_USD_ROUTE_JSON` shapes.

## Security notes

- `startArbitrage`, `sweepToken`, and `sweepNative` on `FlashArbExecutor` are all
  `onlyOwner` — only the deployer's wallet (your burner wallet) can trigger trades or withdraw
  funds.
- The contract holds no funds between trades in normal operation (profit is forwarded to the
  owner at the end of each successful trade); `sweepToken`/`sweepNative` exist only to recover
  dust left behind by an edge case.
- This contract has **not** been professionally audited. Treat it as a personal/educational
  project, start on testnet, and only risk amounts you're prepared to lose.

## License

[MIT](LICENSE)
