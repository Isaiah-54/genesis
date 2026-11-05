# Actions through the 402 — `/api/agent-action`

Every Genesis onchain action goes through the 402 payment rail.
This is the main purpose of Genesis: mint, trade, breed and evolve
are paid API calls, and no action runs without a verified payment.
See `docs/X402.md` for the two rails, prices, modes and honest
limits.

## Endpoint

`GET` or `POST /api/agent-action` (Vercel serverless).

## Actions

| Action | Parameters | What it does onchain (testnet) |
|---|---|---|
| `mint` | `token_id` (new gen-0 id), `receiver` (owner, default treasury), `title` | Core `birth` (0.05 NEAR) + NFT `nft_mint` (0.1 NEAR). Gen 0 only. |
| `breed` | `token_id` (child id), `parent1`, `parent2`, `receiver` | Core `breed` (0.05 NEAR) + NFT `nft_mint` (0.1 NEAR). Child gen = max(parent gens) + 1. |
| `evolve` | `token_id` | Core `evolve` (gas only). Needs 3 more paid wins since the last evolution, max gen 9. |
| `buy` | `token_id` (listed token), `receiver` | Core `buy_nft` with the listing price in NEAR attached (seller gets 95%, treasury 5%). The NFT goes to the treasury, then to `receiver` if one is given. |

## Flow

1. **Validate first.** The action is checked onchain before any
   payment is offered: the token must be free (mint/breed), both
   parents must be registered and alive (breed), the agent must be
   able to evolve (evolve), the token must be listed (buy). An
   invalid action returns **400** — no payment is ever taken for
   an impossible action.
2. **No payment → 402.** Seven accepts entries: the six
   near-intents entries FIRST (primary rail), the exact entry LAST
   (secondary rail). The same object is in the `Payment-Required`
   header and in the JSON body.
3. **Pay and retry.** Either rail (below). One payment buys
   exactly one action execution.
4. **200 + receipt.** The result (tx hashes, new token id / new
   generation / listing bought) + an ed25519 signed receipt +
   a `PAYMENT-RESPONSE` header.

## Prices

The 402 price is the service fee for executing the action AND the
funding for the underlying NEAR cost — the caller funds the action,
not the treasury owner. Mint and breed each cost the treasury 0.6
NEAR (0.05 birth + 0.1 NFT mint), about $0.38 at NEAR ~$2.50, so their
near-intents price is 0.50 USDC. Evolve costs only gas and buy costs
the listing price, so their prices are unchanged. The treasury swaps
received USDC back into NEAR (see `docs/TREASURY.md` and
`scripts/treasury-sweep.js`); on testnet the refill comes from the
free NEAR testnet faucet, because testnet USDC has no swap route.

| Action | Exact rail (testnet USDC) | Near-intents rail (mainnet USDC) |
|---|---|---|
| mint | 0.05 | 0.50 |
| breed | 0.05 | 0.50 |
| evolve | 0.01 | 0.35 |
| buy | 0.05 fixed demo, or the listing's NEAR price converted by a 1Click dry quote when it works | 0.50, or the dry-quote conversion when it works |

## Exact rail (secondary — works now)

Testnet USDC, free from the Circle faucet
(faucet.circle.com, NEAR Testnet).

```bash
# 1. Ask for the action -> 402 with both rails
curl -s "https://genesis-roan-eta.vercel.app/api/agent-action?action=mint&token_id=genesis-visitor-4"

# 2. Send 0.05 testnet USDC to the treasury with ft_transfer on
#    3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
#    (from your wallet, or with the NEAR CLI)

# 3. Retry with the tx hash -> 200 + receipt
curl -s "https://genesis-roan-eta.vercel.app/api/agent-action?action=mint&token_id=genesis-visitor-4&paymentTx=<tx-hash>&paymentSender=<your-account>.testnet"
```

The tx hash may be 64-hex or base58 (as Nearblocks shows it).
Reusing a tx hash returns 402 (already used).

## Near-intents rail (primary — blocked until 1Click NEAR solvers return)

Pay from Ethereum / Arbitrum / Base / Solana in USDC, ETH or SOL.
The server quotes 1Click, verifies the quote signature, issues a
deposit address + HMAC operation token, and settles by polling
1Click status. **Currently blocked:** 1Click quoting into/out of
NEAR is down (verified 2026-11-05 16:08 WAT) — the rail returns
1Click's real error instead of inventing a quote.

```bash
# 1. Ask for the action -> 402 (near-intents entries first)
curl -s "https://genesis-roan-eta.vercel.app/api/agent-action?action=mint&token_id=genesis-visitor-4"

# 2. Quote: base64-encode the x402 v2 payload and send it as
#    ?paymentSignature= (or the PAYMENT-SIGNATURE header)
#    { "x402Version": 2,
#      "accepted": { <the Arbitrum USDC near-intents entry from the 402> },
#      "payload": { "type": "quote", "refundTo": "<your Arbitrum address>" } }
curl -s "https://genesis-roan-eta.vercel.app/api/agent-action?action=mint&token_id=genesis-visitor-4&paymentSignature=<base64>"

# 3. The server answers with a second 402: the quoted entry has
#    payTo = the single-use deposit address, amount = amountIn, and
#    extra.operationToken. Deposit that amount on the origin chain.

# 4. Settle: send the deposit payload
#    { "x402Version": 2,
#      "accepted": { <the quoted entry> },
#      "payload": { "type": "deposit", "operationToken": "<token>",
#                   "depositAddress": "<deposit address>", "txHash": "<origin tx hash>" } }
curl -s "https://genesis-roan-eta.vercel.app/api/agent-action?action=mint&token_id=genesis-visitor-4&paymentSignature=<base64>"
# -> 200 with the minted token + signed receipt (or 402 Retry-After: 5
#    while the deposit is still settling — retry with the same deposit)
```

## Modes

- `mode=live` (default) — real payments, real onchain execution.
- `mode=dry` — near-intents quotes are dry (price preview, no
  deposit address); the exact rail still verifies for real.
- `mode=demo` — everything simulated, no network: a `sim:...`
  payment is accepted and the action returns a simulated result.
  Labelled `simulated: true` everywhere.

```bash
curl -s "https://genesis-roan-eta.vercel.app/api/agent-action?action=mint&token_id=genesis-visitor-4&mode=demo&paymentTx=sim:demo-tx-1&paymentSender=sim-payer.testnet"
```

## The premium CV

`GET /api/agent-premium?token_id=<agent>` uses the same two rails
(near-intents first, exact last, 0.35 mainnet USDC / 0.01 testnet
USDC). The exact rail takes `?paymentTx=&paymentSender=`; the
near-intents rail takes `?paymentSignature=` with the same
quote/deposit dance. See `docs/X402.md`.

## Tests

- `node test/agent-action.cjs` — 49 checks, mocked, no funds:
  402 shape, pre-validation, exact payment / reuse / wrong
  amount / wrong receiver / hex-base58 dedup, near-intents quote
  and deposit flows (mock 1Click, test-signed quotes), tampered
  operation token, 1Click outage, bad quote signature, pending
  settlement, demo mode, buy, split-brain completion (a Core-
  registered agent without an NFT is completable; a mismatched
  receiver is refused), and the premium endpoint's two rails.
- `node test/near-intents-rail.cjs` — 30 checks: quote signature
  verification, operation tokens, receipts, offers builder.
- `node test/x402.cjs` — 11 checks: the premium endpoint's exact
  rail regression suite.

## Live proof

First real action through the rail, 2026-11-05: **mint
genesis-visitor-4** (gen 0, owner gen3) for 0.05 testnet USDC,
HTTP 200 + signed receipt, NFT mint tx
`24Bz5uC9c5FGvojfVb3qXgvXjV2FTSkiNYEPCfF85Npw`. Full proof in
`demo/x402-action-proof.json`. Known gap proven live in the same
run: a replayed payment passed the per-instance dedup on a
different Vercel instance (see `docs/X402.md` — the proper fix
is a shared store).
