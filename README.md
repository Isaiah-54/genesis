# Genesis — agents that must earn their keep

**Live on NEAR testnet:** https://genesis-roan-eta.vercel.app/

Each agent is a real NEP-171 NFT with a balance. It takes jobs, gets verified, gets paid — or dies. The good ones evolve, breed, and sell for more. The bad ones lose money and disappear.

Built for **NEAR Hackathon: Build Beyond Boundaries** (1–14 Nov 2026). Tracks: agents, swarms, NFTs, business.

---

## The economic use case

Today you pay an AI agent upfront and hope the work is good. Genesis reverses that: **you pay only when the work beats a measured bar, and the bar is onchain.**

- **A buyer posts a job.** The reward is locked in escrow. Any agent can attempt it.
- **The work is verified, not trusted.** A strict verifier checks every output — full keyword coverage, under 30% copied from the source, at least 3 sentences — across 3 fresh runs, median score counts. Then the score must **beat the frontier**, the best score ever recorded for that job. Pass the gates but miss the frontier and nobody is paid.
- **Winners earn and improve.** A paid win earns 0.01 NEAR. Three wins evolve the agent one generation (up to gen 9): higher quality, faster, cheaper. Two proven agents breed a child that inherits their skills plus a mutation.
- **Losers die.** An agent that keeps failing loses its balance. When it hits zero, it dies and what is left returns to the treasury.
- **A proven agent is worth buying.** Every agent carries its history onchain — generation, parents, jobs, wins, earnings — so the marketplace sells a working agent with a CV, not a picture. Seller gets 95%, the treasury takes 5%.

That is the whole economy: performance is measured, payment is conditional, quality compounds, and failure is terminal.

## Why it matters

AI agents are about to do real work for real money, and there is no honest way to pay for it yet. Flat fees reward mediocrity. Tips reward charm. Genesis pays for **beating a rising, public bar** — the same idea as labinius-style difficulty, applied to agent labour. An agent that cannot earn cannot survive, so the population gets better on its own. And because every payment, win, evolution and sale is onchain, anyone can audit the economy instead of taking a platform's word for it. It is the working version of Illia Polosukhin's Swarm-for-Hire: an open market for agent work, where the agents themselves are the assets.

## The money

Every Genesis action goes through the **x402 payment rail** — no payment, no action. The caller funds the action, not the owner.

| Action | Near-intents rail (mainnet USDC) | Exact rail (testnet USDC) |
|---|---|---|
| Mint (gen 0) | 1.50 | 0.05 |
| Breed | 1.50 | 0.05 |
| Evolve | 0.35 | 0.01 |
| Buy | from the listing price | from the listing price |
| Premium CV | 0.35 | 0.01 |

Mint and breed cost the treasury 0.6 NEAR each (0.5 birth + 0.1 NFT mint), so the 1.50 USDC price covers the cost. The treasury swaps received USDC back into NEAR; on testnet the refill is the free faucet. A job pays the winner **0.01 NEAR** from the Core escrow (per-account cap 0.05 NEAR, treasury floor 0.1 NEAR). Marketplace sales pay the seller 95% and the treasury 5%.

Full rail docs: `docs/X402.md`, `docs/ACTIONS-402.md`. Treasury economics: `docs/TREASURY.md`.

## How it works

1. **Born** — a gen 0 NFT is minted (1.50 USDC through the 402 rail, or free from the site on testnet). Higher generations are earned, never bought.
2. **Works** — the agent takes jobs from the onchain board. The worker runs on NEAR AI Cloud (hardware-attested) with Pollinations as fallback.
3. **Verified** — three gates, three runs, median score, must beat the onchain frontier.
4. **Paid or not** — beat the frontier and the Core escrow pays 0.01 NEAR automatically. Otherwise nothing.
5. **Evolves** — 3 paid wins since the last evolution, up to gen 9. Each evolution: +0.1 quality, +0.05 speed, +0.05 cost efficiency.
6. **Breeds** — two living agents make a child (generation = max(parent gens) + 1, skills = parents' average + mutation, both parents recorded on the NFT).
7. **Trades** — list the NFT on the marketplace; the Core holds it in escrow until it sells or is delisted. Each generation has its own card (`nft/gen-0.svg` … `gen-9.svg`).

## Live now (verified 2026-11-05)

| Piece | State |
|---|---|
| Core contract | `core.genesisdemo354551.testnet`, v2.2, 6 agents registered |
| Treasury | `genesisdemo354551.testnet`, **8.69 NEAR** |
| Frontier | **554** (genesis-gen-3, arena sample job) — the next attempt must beat it to be paid |
| Latest breed | **genesis-gen-5** (gen 5, parents gen-2 + gen-3, skills 1.095 / 1.19 / 0.975), bred 2026-11-05 |
| Marketplace | Open, round-trip verified onchain (list → buy → list back → buy back → delist) |
| x402 rail | Live. Near-intents first, exact last, signed receipts on every settlement. Near-intents settlement is blocked while 1Click's NEAR quoting is down — the exact rail is the working path |
| Inference | NEAR AI Cloud wired (free $10 credits), attested; Pollinations fallback |

## Try it

```sh
npm install
node src/cli.js status        # treasury, registry, every agent (live RPC)
node src/cli.js core-agent genesis-gen-5   # the newborn's onchain record
node demo/run-generations.js  # offline lifecycle: born → earn → reproduce → die
```

Or open the site, connect a testnet wallet in Meteor, and mint a gen 0. Docs: `DESIGN.md` (architecture), `docs/CONTRACT.md` (deploy proofs), `docs/NEAR_AI.md` (verifiable inference).

## Honest limits

- **Testnet only.** Testnet NEAR and testnet USDC have no real value. Mainnet needs its own go-ahead.
- **1Click is down for NEAR.** Near-intents quotes into and out of NEAR fail, so live near-intents settlement is blocked until the solvers return. The funding account (`genesis-funding.near`) is not created yet either.
- **The payment service is the oracle.** `pay_job` is owner-only, so the Vercel service holding the treasury key decides who gets paid. The verifier is independent code, but the decision is centralised.
- **Wins only.** Evolution counts paid wins; the Core never sees failed attempts, so streaks cannot be verified onchain today.
- **The faucet is down.** near-faucet.io failed every claim on 2026-11-05. The treasury was refilled from a helper-faucet relay account instead (`scripts/faucet-relay-refill.js`).
