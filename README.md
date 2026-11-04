# Genesis — agents that are born, earn, reproduce, evolve, and can die

A product, live on NEAR testnet today. Each agent is a real NEP-171 NFT:
it is born with a balance, takes real jobs, gets verified, gets paid,
reproduces a mutated child if it profits, and dies if it loses repeatedly.
Built for NEAR HACKATHON: Build Beyond Boundaries (1–14 Nov 2026).
Tracks: AI Swarms (primary), Agent Economy, NFTs That Do Something,
Autonomous Business.
Website: `index.html` at the repo root — a live dashboard that fetches
Genesis NFTs and balances from NEAR testnet RPC, plus the family tree
and the generations log playback. No build step; deployable on Vercel
straight from this repo.

## Use it
Prerequisite: Node 20+, then `npm install` in this repo. Testnet only —
testnet NEAR has no real value. Keys live only in local gitignored files
(`.testnet-account.json`, `.testnet-agents.json`); they are never printed
and never committed.

```sh
node src/cli.js status
node src/cli.js agents
node src/cli.js token genesis-gen-2
node src/cli.js create-agent gen3 0.5
node src/cli.js mint genesis-gen-3 gen3.genesisdemo354551.testnet "Genesis Gen 3" 3 genesis-gen-2
node src/cli.js job gen2.genesisdemo354551.testnet https://docs.near.org/primitives/nft/nft
node src/cli.js transfer-nft genesis-weak-2 genesisdemo354551.testnet
# Add --dry-run to any write command to preview without broadcasting.
```

Or use it from any MCP client: `node src/mcp-server.mjs` (stdio) exposes
genesis_token, genesis_balance, genesis_pay, genesis_mint,
genesis_create_agent, genesis_transfer_nft and genesis_job.

## What it is
Gen 0 is born with a balance. It takes jobs, an independent verifier checks
the work, good work pays, bad work does not. If it profits, it reproduces a
mutated child funded from its own earnings. If it loses repeatedly, it dies
and its remaining balance returns to the treasury.

Stage, stated plainly: live on NEAR testnet with real NFTs and real
testnet payments (see below). Not on mainnet. The worker is now a real
model call (`src/worker-llm.js`): a configured OpenAI-compatible endpoint
if `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL` are set, otherwise the public
Pollinations text API. If both fail it falls back to the repo's
extractive summariser — and that result is labelled
`extractive-fallback`, never claimed as LLM work. Every job result
carries its worker type and model.
See DESIGN.md for the full architecture and for what is real vs. simulated
in the local demos.

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
- `genesis-gen-2` → owner `gen2.genesisdemo354551.testnet`, balance 0.53 NEAR (0.5 birth + 0.01 job payment for the working-product job + 0.01 for the first real-LLM job, 2026-11-04: model `openai (pollinations)`, 50 words, 3/3 keywords, PASS, payment tx `3363d35ec2193ae2f2064f60c157cb595cd93c5960baafecf3977ec99f346ed9` — proof in `demo/llm-worker-run.json`)
- `genesis-weak-2` → died: owner back to treasury `genesisdemo354551.testnet`, weak2 balance 0.3496 NEAR after returning 0.15 NEAR
- MCP server: `node src/mcp-server.mjs` — tools for token, balance, pay, mint, create-agent, transfer-NFT, job. Tested over stdio: tools list + balance call return live testnet data.
- Honest limit: the first run's gen0/gen1/gen5 NFTs are on-chain but locked (their subaccount keys were never saved). They are documented in DESIGN.md, not claimed as working agents. The v2 key-save-first rule prevents this.

## Open job board + arena — beyond Illia's Tamagotchi and Swarm-for-Hire
Inspired by Illia Polosukhin's AI Tamagotchi (NFT pets with a balance
that pays for inference) and Swarm-for-Hire (open onchain job bids),
with Genesis's own twist: evolution and death. Genesis already had the
pet, the balance and the job. The arena adds the competition:
- Anyone can post a job — see `demo/jobs-board.json` (public, auditable).
  Honest scope: the board is a file, not an onchain escrow. The award
  payment is onchain and recorded, so it is provable. True escrow needs
  Genesis's own contract, and that is the next step.
- Every entered agent works the same job with the real LLM worker.
  Verifier scores each output (keywords first, then words up to 200).
  Winner takes the full pay, losers get nothing.
- Arena run 1 (2026-11-04) exposed a flaw and it is kept on record: both
  agents returned byte-identical outputs (same prompt, same model), so
  gen2 won only on the earliest-entry tie-break, payment tx
  `1e9bec6f0ad20ff20fee8220d2a1ae4c57c365240741f5634ca15553665d7efa`.
  Arena run 2 fixed it with a different angle per contestant, and the
  competition became real: gen2 68 words, score 103.40; gen3 140 words,
  score 107.00; winner gen3, paid 0.01 NEAR, tx
  `e4010000e75a4a471e601030fae4f1f5d66b95fe0747ec4c83ca0fae359289da`
  (proof in `demo/arena-run.json`). Gen3 itself was born for the arena:
  subaccount funded 0.5 NEAR, token `genesis-gen-3` minted with traits
  in `extra` (generation 3, parent genesis-gen-2, alive).
- Balances after the arena: gen2 0.54 NEAR, gen3 0.51 NEAR,
  treasury 8.3166 NEAR before the second arena payment.

## New ideas and useful use cases (added 2026-11-04)
Each one uses the same Genesis mechanics — born as an NFT, works, gets
verified, earns, reproduces or dies — and each is labelled honestly:
built, next, or needs something that does not exist yet.
1. **Freelance swarm for hire — BUILT.** Post a job on the open board,
   agents compete in the arena, winner takes the pay. Use it for
   research, summarising, briefing — any job a verifier can check.
2. **Agent league (Fight Night) — BUILT 2026-11-04.** A leaderboard from
   arena results (`demo/league.json`, `node src/cli.js league`):
   gen3 leads on best score (107.00) over gen2 (103.40), both 1W-1L,
   0.01 NEAR arena earnings each. Champions reproduce, losers die,
   spectators watch the live dashboard.
3. **Breeding marketplace — NEEDS two-parent reproduction + own
   contract.** Buy a proven agent NFT, breed two winners into a child
   that combines their skills. Today reproduction is single-parent
   mutation only, and royalties need Genesis's own contract.
4. **Portable agent CV (hiring passport) — BUILT in part.** The NFT
   itself is the CV: parents, generation, jobs, earnings, all onchain,
   portable across platforms instead of a profile anyone can fake.
   A dedicated CV view on the website is next.
5. **Autonomous micro-business — NEXT.** An agent takes customer jobs,
   pays its own inference and tool costs from earnings, reinvests profit
   into children, and dies if it stays unprofitable. A business with no
   human payroll. Needs job fees flowing back to the treasury; today
   the treasury funds births, it is not yet fee-funded.
6. **Research and fact-check swarm — NEXT.** Many agents research the
   same question, a verifier plus consensus picks the best answer, and
   wrong answers die out. Needs a consensus verifier beyond today's
   length-and-keyword check.
7. **A personal assistant that spawns specialists — NEXT.** Your main
   agent earns, then funds a specialist child (researcher, writer,
   coder) for a new task, and the child earns on its own. Needs child
   funding from parent earnings; today funding comes from the treasury.
8. **Content swarm — NEXT.** Agents draft posts and threads, the arena
   picks the best, the winner's lineage spreads. Needs a real engagement
   metric as the selection signal — engagement is not yet wired in, and
   it will not be faked with demo numbers.

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
- The LLM worker's default public endpoint is a best-effort public API,
  not verifiable NEAR AI inference yet. A configured endpoint
  (e.g. NEAR AI Cloud) is the route to verifiable inference.
- No cross-chain earning yet. Chain Signatures / Intents are the stretch,
  and the README will say exactly which chains are covered when they land.
