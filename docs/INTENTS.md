# NEAR Intents — fund an agent's inference budget with any token

## What it is

A user funds a Genesis agent's **mainnet** inference budget with any
supported token from any supported chain, through the NEAR Intents
1Click API (`https://1click.chaindefuser.com`). The user picks an
agent, picks the token they are sending, gets a live quote, sends the
source tokens to the 1Click deposit address from their own wallet,
and the solver network settles the swap, delivering wNEAR to the
Genesis mainnet funding account. The agent's page then shows its
inference budget funded via Intents.

This is the flow Illia Polosukhin described for Swarm-for-Hire:
"anyone can add a new agent to the swarm by giving it NEAR (to pay
for inference)". The funded mainnet NEAR is what pays for NEAR AI
inference — the other half of that ask.

## The honest mainnet/testnet split

**NEAR Intents is mainnet-only.** The official FAQ: "There is no
testnet deployment and no plans for one. We recommend testing on
NEAR mainnet using separate dev/test NEAR accounts." Confirmed
independently by Quantus, Openfort, FastNEAR and the Swap SDK docs.

Consequences, stated plainly on the site:

- The swapped value is **mainnet wNEAR**. It cannot enter the
  testnet Core escrow (`core.genesisdemo354551.testnet`). Testnet
  and mainnet are separate networks with separate accounts and
  tokens.
- A real end-to-end "swap → pay for a testnet job / buy a testnet
  NFT" loop is **impossible**. Any design claiming otherwise would
  be fake. This integration does not claim it.
- This funds an agent's **mainnet inference budget**. Testnet jobs
  still pay testnet NEAR from the escrow. The two economies sit side
  by side and never mix.

## What is real vs what is not

- **Real:** the quote (live solver pricing), the deposit address,
  the user's deposit, the solver settlement, the wNEAR delivery to
  the mainnet funding account, the status polling, and the displayed
  budget (read from the 1Click status + the mainnet account
  balance). A judge can do it with $1–2 and verify the receipt on
  the mainnet explorer.
- **Not faked, and not proposed:** no simulated swap, no fake
  "funded" state, no testnet NEAR conjured from a mainnet swap, no
  claim that the funding pays for testnet jobs. If no real swap
  happens, the budget shows 0.
- **Labelled on the page:** "Mainnet — real funds, small amounts.
  This funds the agent's mainnet inference budget. Testnet jobs
  still pay testnet NEAR from the escrow."

## Quoting into NEAR — a live constraint (2026-11-05)

Verified live on 2026-11-05: quoting **into** NEAR-chain assets
was unavailable. Every pair into wNEAR or USDC-on-NEAR (Arbitrum
USDC, Ethereum USDC, Ethereum ETH, Base USDC, Solana USDC, Solana
SOL; 1–100 USDC) returned HTTP 400, "Quoting for this pair is not
available". In the same session, wNEAR → USDC on Ethereum quoted
fine (HTTP 201: 1 wNEAR → 3.620444 USDC, ~19s) and Ethereum USDC →
Solana USDC quoted fine (HTTP 201: 5 USDC → 4.744844 USDC, ~42s).

The quote proxy (`api/intents-quote.js`) passes 1Click's real answer
through — including that error — and never invents a quote. The
widget shows "NEAR Intents could not quote this pair right now" with
the 1Click correlation id. If solvers start quoting into NEAR again,
the widget works with no code change.

## How it works (code)

| Piece | What it does |
|---|---|
| `api/intents-quote.js` | Server-side 1Click proxy. Validates input, lists tokens (cached 10 min), POSTs `/v0/quote` with `dry:true` (price preview) or `dry:false` (live quote + deposit address). Injects `ONECLICK_JWT` from env if set. Never exposes the JWT to the browser. |
| `api/intents-status.js` | Polls `GET /v0/status?depositAddress=`, returns SUCCESS / REFUNDED / FAILED + explorer links. On SUCCESS, records the funding in `demo/intents-funding.json` (best-effort — Vercel's filesystem is read-only at runtime, so the durable proof is the 1Click status + mainnet explorer link). |
| `index.html` (#fund-agent) | "Fund an agent" section: agent picker, token picker, amount, refund address, quote display, deposit address + countdown, status. |
| `app.js` | Funding widget logic: fetch quote, render deposit address, poll status every ~15s, render per-agent budget from the funding log + localStorage. |
| `marketplace.html`, `cv.html` | Show "Inference budget funded via Intents: X NEAR (mainnet)" per agent, from the funding log. |
| `demo/intents-funding.json` | The funding log (starts empty; appended on SUCCESS). |

The destination asset is always wNEAR (`nep141:wrap.near`). The
origin asset must be one of the assets 1Click lists (the server
validates it against the live token list on every quote). The
funding recipient is the env var `INTENTS_FUNDING_ACCOUNT` — it
defaults to empty, and a live quote is refused until it is set. No
mainnet account is hardcoded in the repo.

## Fees

- Without a JWT: **0.25%** platform fee, lower rate limits.
- With a JWT (from https://partners.near-intents.org, server-side
  only, `ONECLICK_JWT` in Vercel env): **0.20%**.
- Optional `insured: true` adds 0.02% (not used by this widget).
- A $1 swap can cost ~$1.50+ all-in (origin-chain gas + fee +
  solver spread). The quote shows the all-in cost before commitment.

## Setup (manual steps for Isaiah)

1. **Create the mainnet funding account.** One account to receive
   the wNEAR, e.g. `genesis-funding.near`. It needs ~0.1 NEAR
   minimum to exist. Isaiah's $1 in NEAR (~0.25 NEAR) covers it.
   Create it from the NEAR wallet (mainnet) — do not reuse a
   testnet account.
2. **Set the env var.** In Vercel (project `genesis`), set
   `INTENTS_FUNDING_ACCOUNT` to the funding account id (e.g.
   `genesis-funding.near`). Redeploy (or wait for the next push to
   main — Vercel deploys on push).
3. **(Optional) Partner JWT.** Sign up at
   https://partners.near-intents.org, get a JWT, and set
   `ONECLICK_JWT` in Vercel env (server-side only, never in the
   repo). The widget works without it at 0.25%.

## How to test (small, real)

1. On the live site, open the "Fund an agent" section.
2. Pick an agent (e.g. genesis-gen-3), pick USDC on Arbitrum,
   enter 1, press "Get quote" — a dry quote is a price preview,
   no funds can move.
3. Enter your refund address (your address on the origin chain),
   press "Get live quote" — you get a deposit address and a
   30-minute deadline.
4. Send the tokens to the deposit address from your own wallet.
5. Watch the status poll to SUCCESS, with the mainnet explorer
   link to the wNEAR delivery. The agent's budget updates on the
   page and on its CV.
6. If quoting into NEAR is still unavailable, the widget says so
   with the 1Click error — that is the real answer, not a bug in
   the widget. Try again later, or try a different pair.

## What is NOT built (Tier 2, stretch)

- `record_funding` on the Core contract (a `record_funding`
  method + Core v2.3 redeploy) so the funding is recorded onchain
  on testnet. Not required for the demo; the funding record is
  the 1Click status + mainnet explorer link.
- Per-agent mainnet subaccounts. One shared funding account plus
  per-agent attribution (quote sessionId + funding log) is enough.

## Sources

- https://docs.near-intents.org (1Click Swap API; Request a swap
  quote; Swap SDK; FAQ — "no testnet deployment and no plans for
  one")
- https://1click.chaindefuser.com/v0/tokens (called live
  2026-11-05)
- Quantus `near-intents-swaps.md`; Openfort `recipes-hub/near-intents`;
  FastNEAR `js.fastnear.com/intents`
