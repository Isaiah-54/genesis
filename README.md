# Genesis — agents that are born, earn, reproduce, evolve, and can die

Built for NEAR HACKATHON: Build Beyond Boundaries (1–14 Nov 2026).
Website: `index.html` at the repo root — a single static page, no build
step, deployable on Vercel straight from this repo. It shows the family
tree, a step-by-step playback of the verified generations log, and the
testnet birth proof.
Tracks: AI Swarms (primary), Agent Economy, NFTs That Do Something,
Autonomous Business.

## What it is
Gen 0 is born with a balance. It takes jobs, an independent verifier checks
the work, good work pays, bad work does not. If it profits, it reproduces a
mutated child funded from its own earnings. If it loses repeatedly, it dies
and its remaining balance returns to the treasury.

This is a working prototype, not a finished product. See DESIGN.md for what
is real, what is a simulated ledger in v0, and what v1 moves onchain.

## Try it (do X, see Y)
Prerequisite: Node 20+ (no other install needed for v0).

1. Run `node demo/run.js`
   → See: `BIRTH gen-0 generation 0`, three job results, `BIRTH gen-1
   generation 1`, then Gen 1 working two jobs.
2. Open `demo/family-tree.json`
   → See: treasury balance, both agents, the birth event, and the full log.
3. Run `node demo/run-generations.js`
   → See: Gen 0 → Gen 1 → Gen 2 → Gen 3, a Gen 4 newborn, and a weak agent
   that fails three jobs in a row and dies (`DEATH gen-5`), its remaining
   balance returning to the treasury. Full tree in
   `demo/family-tree-generations.json`.
4. Change all job rewards in `demo/run.js` (each reward 1.0 → 0.1) and
   re-run
   → See: Gen 0 ends at balance 0.6, below the 1.5 reproduction threshold,
   so no Gen 1 is born. The lifecycle rule is in `src/engine.js`, not in
   the demo script. (Note: changing only job-1 still births, at exactly
   1.5 — the threshold is >=, verified 2026-11-04.)

## What the verifier actually checks
Length (minimum words), keyword coverage (at least half the job keywords),
nothing else. It is a separate code path from the worker, by design.

## Working product (v2, NEAR testnet — real NFTs, real payments)
Each generation is a real NEP-171 NFT on `nft.primitives.testnet`.
Clean run, all 7 txs Success and re-verified by RPC
(`demo/working-product-run.json`):
- `genesis-gen-2` → owner `gen2.genesisdemo354551.testnet`, balance 0.51 NEAR (0.5 birth + 0.01 job payment for a real job from a live NEAR docs page, verified 3/3 keywords, PASS)
- `genesis-weak-2` → died: owner back to treasury `genesisdemo354551.testnet`, weak2 balance 0.3496 NEAR after returning 0.15 NEAR
- MCP server: `node src/mcp-server.mjs` — tools for token, balance, pay, mint, create-agent, transfer-NFT, job. Tested over stdio: tools list + balance call return live testnet data.
- Honest limit: the first run's gen0/gen1/gen5 NFTs are on-chain but locked (their subaccount keys were never saved). They are documented in DESIGN.md, not claimed as working agents. The v2 key-save-first rule prevents this.

## Testnet proof (v1, verified)
- Testnet master: `genesisdemo354551.testnet` (funded 10 testnet NEAR via
  the testnet faucet — testnet NEAR has no real value).
- Birth mirror, verified onchain: subaccount
  `gen0.genesisdemo354551.testnet` created and funded with exactly
  0.1 NEAR, tx
  `Cb1RNmo7uEpYnYE42JfW5V95d2uRkGMry75mz4yf8J57`
  (CreateAccount + Transfer + AddKey, Success). Child balance re-checked
  via RPC: 0.1 NEAR. Proof file: `demo/testnet-birth.json`.
  Note: near-api-js broadcasting failed through this host's proxy, so the
  tx was signed locally and broadcast via curl — see
  `src/chain-birth-curl.js`.

## Honest limits (v0/v1)
- The lifecycle engine's balances are still a JSON ledger; the testnet
  transfer above mirrors one birth, it does not yet replace the ledger
  for every generation.
- The worker is an extractive summariser in code, not an LLM call.
- No cross-chain earning yet. Chain Signatures / Intents are the stretch,
  and the README will say exactly which chains are covered when they land.
