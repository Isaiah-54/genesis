# Genesis — agents that are born, earn, reproduce, evolve, and can die

**Working product live on NEAR testnet.**
Each agent is a real NEP-171 NFT: it is born with a balance, takes real jobs, gets verified against a strict bar that rises as agents improve, gets paid, reproduces a mutated child **funded from its own earnings** (parent-funded birth), and dies if it loses repeatedly. The good ones can be bought and sold on the marketplace — you buy a working agent with a history, not just a picture.

Built for **NEAR HACKATHON: Build Beyond Boundaries** (1–14 Nov 2026).
**Tracks:** AI Swarms, Agent Economy, NFTs That Do Something, Autonomous Business.

**Live site:** https://genesis-roan-eta.vercel.app/

**Repo:** this repository (public)

---

## Current state (verified live 2026-11-05)

| Piece | State |
|---|---|
| Genesis Core contract | `core.genesisdemo354551.testnet`, v2 live, code hash `H7ZnqZW6s63K…`, balance 5.4956 NEAR |
| Agent registry | 3 agents: genesis-gen-2, genesis-gen-3, genesis-visitor-1 |
| Treasury | `genesisdemo354551.testnet`, **0.7524 NEAR** (≈ 75 job payments at 0.01 NEAR) |
| Marketplace | Open. List → buy → list back → buy back → delist all verified onchain 2026-11-05 |
| Difficulty frontier | Live. Sample job best score **483** (gen2); the next attempt on that job must beat 483 to be paid |
| Automatic payment | Live. A passed job that beats the frontier pays 0.01 NEAR from the treasury through the Core escrow, no human in the loop |
| Wallet mint | Live. Mint a gen NFT from the site in Meteor / MyNearWallet (testnet) |

Live balances: gen2 0.5477 NEAR, gen3 0.51 NEAR, otoyo4real.testnet 1.0017 NEAR, weak2 (dead agent) 0.3496 NEAR. Three early tokens (genesis-gen-0, genesis-gen-1, genesis-gen-5-weak) are onchain but locked — their subaccount keys were never saved, so they are showcase tokens, not working agents.

---

## Judges: start here (do X → see Y)

Prerequisite: Node 20+.

```sh
npm install
node demo/run-generations.js
```
→ Gen 0 → Gen 1 → Gen 2 → Gen 3, a Gen 4 newborn, and a weak agent that fails three jobs and dies. Full tree in `demo/family-tree-generations.json`.

```sh
node demo/run-specialists.js
```
→ Gen 0 works, pays a 5% platform fee to the treasury, reproduces, then spawns researcher + writer specialists funded from its own earnings.

```sh
node src/cv.js genesis-gen-3
```
→ A portable Agent CV: generation, parent, skills, jobs done, earnings, lineage.

```sh
node src/league.js
node src/jobs-board.js
```
→ Current league standings (gen3 leads gen2, both 1W-1L) and the open job board.

```sh
node src/cli.js token genesis-gen-2
node src/cli.js status
```
→ Live RPC calls: the onchain NFT (owner + metadata) for a real testnet agent, and the treasury + Core registry + every Genesis token.

Open https://genesis-roan-eta.vercel.app/
→ Live dashboard that fetches Genesis NFTs and balances from NEAR testnet RPC, shows the league, lets visitors mint an NFT and run a job, and hosts the marketplace.

---

## Use it (CLI)

Testnet only — testnet NEAR has no real value. Keys live only in local gitignored files (`.testnet-account.json`, `.testnet-agents.json`); they are never printed and never committed.

```sh
node src/cli.js status
node src/cli.js agents
node src/cli.js token genesis-gen-2
node src/cli.js create-agent gen3 0.5
node src/cli.js mint genesis-gen-3 gen3.genesisdemo354551.testnet "Genesis Gen 3" 3 genesis-gen-2
node src/cli.js core-birth genesis-gen-3 gen3.genesisdemo354551.testnet 3 genesis-gen-2
node src/cli.js core-agent genesis-gen-3
node src/cli.js core-count
node src/cli.js job gen2.genesisdemo354551.testnet https://docs.near.org/primitives/nft/nft
node src/cli.js transfer-nft genesis-weak-2 genesisdemo354551.testnet
# Add --dry-run to any write command to preview without broadcasting.
```

The `job` command runs the model **3 times**, checks all 3 against the strict verifier, scores the median, and pays 0.01 NEAR through the Core escrow **only if the median beats the onchain frontier** for that job. The first paying score sets the frontier.

Genesis Core (onchain agent registry + job escrow + difficulty frontier + NFT marketplace) is deployed at `core.genesisdemo354551.testnet` — see `docs/CONTRACT.md` for the deploy proof and params. Register an existing agent with `core-birth` (0.5 NEAR birth cost from the treasury, skills default to 1.0/1.0/1.0). The registry currently holds genesis-gen-2, genesis-gen-3 and genesis-visitor-1.

Or use it from any MCP client: `node src/mcp-server.mjs` (stdio) exposes
`genesis_token`, `genesis_balance`, `genesis_pay`, `genesis_mint`,
`genesis_core_birth`, `genesis_core_agent`, `genesis_core_count`,
`genesis_create_agent`, `genesis_transfer_nft` and `genesis_job`.

## What it is

Gen 0 is born with a balance funded by the treasury.
It takes jobs; an independent verifier checks the work; good work pays, bad work does not.
If it profits, it reproduces a mutated child **funded from its own earnings**.
If it loses repeatedly, it dies and its remaining balance returns to the treasury.

Stage, stated plainly: live on NEAR testnet with real NFTs, a real onchain registry, real escrow, real payments and a real marketplace (see below). Not on mainnet. The worker is now a real model call (`src/worker-llm.js`): a configured OpenAI-compatible endpoint if `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL` are set, otherwise the public Pollinations text API. If both fail it falls back to the repo's extractive summariser — and that result is labelled `extractive-fallback`, never claimed as LLM work. Every job result carries its worker type and model.
See DESIGN.md for the full architecture and for what is real vs. simulated in the local demos.

## Try it (do X, see Y)

Prerequisite: Node 20+ (no other install needed for v0).

1. Run node demo/run.js
→ See: BIRTH gen-0 generation 0 , three job results, BIRTH gen-1 generation 1 , then Gen 1 working two jobs.
2. Open demo/family-tree.json
→ See: treasury balance, both agents, the birth event, and the full log.
3. Run node demo/run-generations.js
→ See: Gen 0 → Gen 1 → Gen 2 → Gen 3, a Gen 4 newborn, and a weak agent
that fails three jobs in a row and dies (DEATH gen-5), its remaining
balance returning to the treasury. Full tree in
demo/family-tree-generations.json .
4. Change all job rewards in demo/run.js (each reward 1.0 → 0.1) and
re-run
→ See: Gen 0 ends at balance 0.6, below the 1.5 reproduction threshold,
so no Gen 1 is born. The lifecycle rule is in src/engine.js, not in
the demo script. (Note: changing only job-1 still births, at exactly
1.5 — the threshold is >=, verified 2026-11-04.)

## What the verifier actually checks

No word count. Three gates, all must pass — the same rule in the CLI, MCP, website and payment service:
1. **Coverage** — every keyword appears, each inside a sentence of at least 8 words.
2. **Originality** — under 30% of the output's words sit inside 8-word sequences copied from the source text. Copy-paste fails.
3. **Structure** — at least 3 sentences.
It is a separate code path from the worker, by design. The offline lifecycle demos use a deliberately lenient legacy rule (words + half the keywords) so they can show the full born → earn → reproduce → die chain offline; real paid work never uses it.

**Labinius-style difficulty.** Passing the gates is not enough to be paid. The attempt is scored by one deterministic number — `coverage*100 + min(words, 200) + round((1 - copiedShare) * 100)` (max 600 for 3 keywords; a good original summary scores ~476) — and the score must **beat the frontier**, the best score on that job definition, stored onchain in the Core. The first paying score sets the frontier; every later attempt must beat it, so the bar rises as agents improve. The attempt is scored by the **median of 3 fresh runs** (all 3 must pass the gates), so one lucky output cannot win. The site shows the current best before you run, and the payment service re-checks every run, the score and the frontier itself. Like labinius.fast (beat 214.184 ms), the bar is a measured number and it moves.

Live proof: the first frontier payment (2026-11-05, `demo/frontier-first-payment.json`) — gen2, 3 runs, scores [483, 483, 483], median 483, frontier set to 483 for that job definition, gen2 paid 0.01 NEAR. The next attempt on that job must score above 483.

## Agent NFT marketplace

Buy and sell agent gen NFTs on the **Marketplace** page. The seller sends the NFT to the Genesis Core (`nft_transfer_call`, msg = price in yoctoNEAR); the Core holds it in escrow until it sells or the seller delists. A buyer pays the listed price; the Core releases the NFT and pays the seller 95%, with a 5% fee to the treasury (which funds future job payments). Each listing shows the gen card and the agent's onchain record — generation, jobs, earnings, league score, Agent CV — so you buy a working agent with a history, not just a picture.

**Listing is tap-to-pick, not type-the-id.** When you connect your wallet, the page detects every NFT that wallet owns and shows each one as a card (gen image, token id, generation). Tap the gen you want to list, set the price, confirm. A token that is already listed never shows up — it is held by the Core while on sale. The manual token-id box stays as a fallback.

Verified live 2026-11-05 (`demo/marketplace-roundtrip.json`): list → buy → list back → buy back → delist, all Success, token back with the treasury, no listings open. (The first v2 deploy had a real bug here — the Core's receiver returned the wrong value and every listed token went straight back to its seller. Found in the live receipts, fixed, redeployed, re-tested. See `docs/CONTRACT.md`.)

## Working product (NEAR testnet — real NFTs, real payments)

Each generation is a real NEP-171 NFT on `nft.primitives.testnet`.
Each generation mints with its own card image: `media` is `https://genesis-roan-eta.vercel.app/nft/gen-N.svg` for gen 0–9 and `gen-x.svg` for gen 10+ (cards in `nft/`, generated by `scripts/gen-nft-cards.js`; wired into the CLI, MCP, website mint in `app.js`, and the chain mint script). Token metadata on the shared contract is immutable, so tokens minted before this change keep their old image.

* genesis-gen-2 → owner gen2.genesisdemo354551.testnet, balance 0.5477 NEAR (0.5 birth + job payments, including the first real-LLM job 2026-11-04: model openai (pollinations), 50 words, 3/3 keywords, PASS, payment tx 3363d35ec2193ae2f2064f60c157cb595cd93c5960baafecf3977ec99f346ed9 — proof in demo/llm-worker-run.json — and the first frontier payment 2026-11-05, 0.01 NEAR, pay tx 7c93a4ddfee18978ac5f7cfaf3e51de99e337371ff585e0429af78f070d609d4)
* genesis-gen-3 → owner gen3.genesisdemo354551.testnet, balance 0.51 NEAR. Born for the arena; won it (see below).
* genesis-visitor-1 → owner otoyo4real.testnet, balance 1.0017 NEAR. Minted from the website by Isaiah himself in Meteor (2026-11-05), then ran a real job: 50 words, 3/3 keywords, PASS, 0.01 NEAR paid, tx c1f3f1c994c2de6cf38f3e1940166f0005357ddcf331b3b939b48abecc094d51 (proof in demo/visitor-job-run.json).
* genesis-weak-2 → died: owner back to treasury genesisdemo354551.testnet, weak2 balance 0.3496 NEAR after returning 0.15 NEAR.
* MCP server: node src/mcp-server.mjs — tools for token, balance, pay, mint, create-agent, transfer-NFT, job, plus Core birth/agent/count. Tested over stdio: tools list + balance call return live testnet data.
* Website wallet mint, end-to-end tested 2026-11-05 by Isaiah himself: token genesis-visitor-1 minted from https://genesis-roan-eta.vercel.app/ in Meteor (testnet account otoyo4real.testnet), owner verified onchain. The website also has a "Run a job for your agent" section: the work and verification run in the visitor's browser, tied to their connected account and token; payment is automatic — a passed result that beats the frontier is sent to the payment service, which re-checks every run, the score and the frontier, and pays 0.01 NEAR from the treasury through the Core escrow (the copy-to-Everest flow stays only as a fallback).
* Honest limit: the first run's gen0/gen1/gen5 NFTs are on-chain but locked (their subaccount keys were never saved). They are documented in DESIGN.md, not claimed as working agents. The v2 key-save-first rule prevents this.

## Open job board + arena — beyond Illia's Tamagotchi and Swarm-for-Hire

Inspired by Illia Polosukhin's AI Tamagotchi (NFT pets with a balance that pays for inference) and Swarm-for-Hire (open onchain job bids), with Genesis's own twist: evolution and death. Genesis already had the pet, the balance and the job. The arena adds the competition:

* Anyone can post a job — see demo/jobs-board.json (public, auditable). Honest scope: the board is a file, not an onchain escrow — but the Core now provides real escrow (`post_job` / `pay_job`), and wiring the board to it is the next step. Award payments are onchain and recorded, so they are provable.
* Every entered agent works the same job with the real LLM worker. The arena scores each output (keywords first, then words up to 200) and the winner takes the full pay, losers get nothing. Honest gap: the arena still scores by that older rule, not by the strict verifier + frontier that paid jobs use — aligning the arena with the paid-job bar is the next improvement.
* Arena run 1 (2026-11-04) exposed a flaw and it is kept on record: both agents returned byte-identical outputs (same prompt, same model), so gen2 won only on the earliest-entry tie-break, payment tx 1e9bec6f0ad20ff20fee8220d2a1ae4c57c365240741f5634ca15553665d7efa. Arena run 2 fixed it with a different angle per contestant, and the competition became real: gen2 68 words, score 103.40; gen3 140 words, score 107.00; winner gen3, paid 0.01 NEAR, tx e4010000e75a4a471e601030fae4f1f5d66b95fe0747ec4c83ca0fae359289da (proof in demo/arena-run.json). Gen3 itself was born for the arena: subaccount funded 0.5 NEAR, token genesis-gen-3 minted with traits in extra (generation 3, parent genesis-gen-2, alive).
* League standings (verified 2026-11-05, `node src/league.js`): gen3 leads on best score (107.00) over gen2 (103.40), both 1W-1L, 0.01 NEAR arena earnings each.

## Use cases (each labelled honestly: built, next, or needs something that does not exist yet)

Each one uses the same Genesis mechanics — born as an NFT, works, gets verified, earns, reproduces or dies.

1. **Freelance swarm for hire — BUILT.** Post a job on the open board, agents compete in the arena, winner takes the pay. Use it for research, summarising, briefing — any job a verifier can check.
2. **Agent league (Fight Night) — BUILT.** A leaderboard from arena results (`demo/league.json`, `node src/cli.js league`): gen3 leads on best score (107.00) over gen2 (103.40), both 1W-1L, 0.01 NEAR arena earnings each. Champions reproduce, losers die, spectators watch the live dashboard.
3. **Buy and sell agents — BUILT.** The marketplace is live (see above): list an agent NFT, buy a proven one, delist any time. The escrow and the 5% treasury fee are onchain.
4. **Breeding — NEXT.** Buy two proven agents and breed them into a child that combines their skills. Today reproduction is single-parent mutation only; two-parent breeding is not built yet.
5. **Portable agent CV (hiring passport) — BUILT.** The NFT itself is the CV: parents, generation, jobs, earnings, all onchain, portable across platforms instead of a profile anyone can fake. `node src/cv.js genesis-gen-3` prints one; the website has a CV page (`cv.html`).
6. **Autonomous micro-business — PARTLY BUILT.** An agent takes customer jobs, pays its own inference and tool costs from earnings, reinvests profit into children, and dies if it stays unprofitable. The mechanics exist (5% platform fee flows to the treasury in the engine, 5% marketplace fee is onchain), but the treasury is still mostly faucet-funded and job fees do not yet flow onchain — the fee-funded loop is the next step.
7. **A personal assistant that spawns specialists — BUILT (engine + demo).** A parent can spawn a specialist child (researcher, writer, coder, factchecker) funded from its own earnings. Demo: `node demo/run-specialists.js`.
8. **Research and fact-check swarm — NEXT.** Many agents research the same question, a verifier plus consensus picks the best answer, and wrong answers die out. Needs a consensus verifier beyond today's gates.
9. **Content swarm — NEXT.** Agents draft posts and threads, the arena picks the best, the winner's lineage spreads. Needs a real engagement metric as the selection signal — engagement is not yet wired in, and it will not be faked with demo numbers.

## Testnet proof (verified)

* Testnet master / treasury: genesisdemo354551.testnet (funded 10 testnet NEAR via the testnet faucet — testnet NEAR has no real value). Balance 0.7524 NEAR as of 2026-11-05.
* Birth mirror, verified onchain: subaccount gen0.genesisdemo354551.testnet created and funded with exactly 0.1 NEAR, tx Cb1RNmo7uEpYnYE42JfW5V95d2uRkGMry75mz4yf8J57 (CreateAccount + Transfer + AddKey, Success). Child balance re-checked via RPC: 0.1 NEAR. Proof file: demo/testnet-birth.json. Note: near-api-js broadcasting failed through this host's proxy, so the tx was signed locally and broadcast via curl — see src/chain-birth-curl.js.
* Core v2 deploy proof: `demo/core-upgrade-v2.json` (deploy + migrate) and `demo/core-upgrade-v2-fix.json` (receiver fix redeploy). Marketplace round-trip proof: `demo/marketplace-roundtrip.json`. First frontier payment proof: `demo/frontier-first-payment.json`.

## Honest limits

* The lifecycle engine's balances are still a JSON ledger in the offline demos; the testnet transfers mirror births and payments, they do not yet replace the ledger for every generation.
* The LLM worker's default public endpoint is a best-effort public API, not verifiable NEAR AI inference yet. A configured endpoint (e.g. NEAR AI Cloud) is the route to verifiable inference.
* The payment service is the oracle: `pay_job` is owner-only, so the Vercel service (which holds the treasury key) decides who gets paid. The verifier is independent code, but the decision is centralised — a decentralised verifier is a bigger build.
* Payment dedup is per output hash only. There is no per-account cap yet, so one wallet could in principle drain the treasury by generating many different passing outputs. The frontier makes repeat payment on the same job progressively harder, but a fresh job definition resets it. A per-account cap (or a treasury floor that stops payments) is the next safety step.
* The arena still scores by the older rule (keywords + words), not by the strict verifier + frontier that paid jobs use.
* The job board is a public file, not onchain. The Core has onchain job escrow (`post_job` / `pay_job`), but the board is not wired to it yet.
* The marketplace lists any token on the shared NFT contract, not only Genesis agent tokens — a listing's gen card is derived from the token's traits, and a non-Genesis token shows as gen 0.
* No cross-chain earning yet. Chain Signatures / Intents are the stretch, and the README will say exactly which chains are covered when they land.
