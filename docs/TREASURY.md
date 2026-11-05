# Genesis treasury economics

The rule (Isaiah, 2026-11-05): **the caller through x402 funds the
action, not the treasury owner.** The treasury owner only needs
answers — the economics must close on their own.

## What an action costs

| Action | Treasury cost | Near-intents price | Exact price |
|---|---|---|---|
| mint | 0.15 NEAR (0.05 birth + 0.1 NFT mint) | 0.30 USDC (subsidised) | 0.05 testnet USDC |
| breed | 0.15 NEAR (0.05 birth + 0.1 NFT mint) | 0.30 USDC (subsidised) | 0.05 testnet USDC |
| evolve | gas only | 0.35 USDC | 0.01 testnet USDC |
| buy | listing price + gas | 0.50, or dry-quote conversion | 0.05, or dry-quote conversion |
| premium CV | — | 0.35 USDC | 0.01 testnet USDC |

Mint and breed are priced at 0.30 USDC for the Hackathon — below the 0.15 NEAR cost at NEAR
~$2.50. **Re-price if NEAR moves materially** — the price is a
constant in `api/agent-action.js` (`INTENTS_PRICES`), not a live
feed. Evolve costs only gas and buy costs the listing price, so
their prices are unchanged. The exact rail is testnet demo money
(free Circle faucet USDC); its prices are unchanged.

## How the loop closes

### Testnet (live now)

The treasury receives testnet USDC on the exact rail. That USDC
cannot become NEAR: the Circle testnet USDC contract
(`3e2210e1…`) is in **no** Ref Finance testnet pool (verified
2026-11-05 across 100 pools), and 1Click is mainnet-only. Testnet
USDC just accumulates as accounting — it is valueless.

The testnet refill is the **free NEAR testnet faucet**
(https://near-faucet.io/, max 2 NEAR per request, no key needed).
Treasury target: 1.2 NEAR (one breed + one more action). One action
needs 0.15 NEAR.

**Fallback when near-faucet.io is down:** the testnet helper
faucet (`helper.testnet.near.org`) funds a NEW account with 10
testnet NEAR. `scripts/faucet-relay-refill.js` creates one such
relay account once (key in `.testnet-faucet-relay.json`, chmod 600,
gitignored) and transfers testnet NEAR from it to the treasury —
nothing from the owner's accounts. The relay keeps its remaining
balance for future refills.

`scripts/treasury-sweep.js` reports the state and whether a refill
is due. It exits 1 when the treasury is below target, so a cron can
alert on it. The faucet claim itself is a browser form fill — the
script prints the exact instruction instead of pretending an API
exists.

```bash
node scripts/treasury-sweep.js            # dry-run report (default)
node scripts/treasury-sweep.js --execute  # same report; on testnet
                                          # changes nothing by design
```

### Mainnet (design, pending)

The near-intents rail delivers real mainnet USDC to the funding
account (`INTENTS_FUNDING_ACCOUNT`, currently unset — the account
`genesis-funding.near` is not created yet). The sweep's mainnet leg:

1. Reads the funding account's mainnet USDC balance.
2. Dry-quotes USDC → wNEAR through 1Click (`EXACT_INPUT`).
3. When the funding key is configured and 1Click NEAR quoting works,
   `--execute` performs the swap, so received USDC becomes the wNEAR
   that funds actions.

Today the leg is report-only: the funding account does not exist and
1Click quoting into/out of NEAR is down (every NEAR pair returns
HTTP 400, last checked 2026-11-05). The sweep passes 1Click's real
error through and never invents a quote. Nothing is faked: until the
account exists and quoting recovers, `--execute` refuses the swap
and says exactly what is missing.

## State (2026-11-05)

- Treasury `genesisdemo354551.testnet`: **9.2015 NEAR** (verified
  live 2026-11-05 ~20:27 WAT) — 9 of the relay's 10 faucet NEAR are
  now in the treasury (2 + 7); covers 57 actions at 0.15 NEAR each.
- Relay `genesisrelay370982.testnet`: ~1 NEAR left (second transfer
  7 NEAR, tx `6Wo2fzmM21DyPmSgapJMhTZy7HtsgT5vgtww5LERRG12`,
  2026-11-05 ~20:27 WAT, on Isaiah's 'transfer 9 out of the 10').
- near-faucet.io is DOWN as of 2026-11-05: 5 failed claims that day
  (2 in the morning, 3 in the evening including after a reload),
  every one ending in the same generic server-side "ERROR — There
  was an error", no captcha, no rate-limit message. Retry it later;
  the relay is the working fallback meanwhile.
- Treasury testnet USDC: 0.07 (includes 0.05 from the visitor-4
  mint via the 402 rail and 0.01 premium) — accounting only, no swap
  route.
- Funding account: not created. `OPERATION_TOKEN_SECRET` not set in
  Vercel. Live near-intents settlement stays blocked on 1Click.
