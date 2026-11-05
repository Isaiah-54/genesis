# Genesis Contract Design (NEAR HACKATHON 2026)

## Goal

Make the agent lifecycle (birth → work → verify → earn → reproduce or die) enforceable and auditable on NEAR, not only in a JS ledger.

## Genesis Core — DEPLOYED on testnet (2026-11-05)

The contract is live at **`core.genesisdemo354551.testnet`** (wasm 104,091 bytes, sha256 `11b6a95d…`, deployed 2026-11-05; deploy tx `21530332…`, init `3673385f…`, set_params `14fc4e43…`, all Success; proof in `demo/core-deploy.json`). Params: birth cost 0.5 NEAR, profit threshold 1.5 NEAR, max 3 consecutive fails, min 3 jobs to reproduce. **The registry starts empty** — existing NFT agents are not auto-imported; register them with `core-birth` (below). Verification is still off-chain and `pay_job` is owner-as-oracle in this version.

- CLI: `node src/cli.js core-birth <token> <owner> <gen> <parent|->` (0.5 NEAR from the treasury; owner account must already exist), `core-agent <token>`, `core-count`. `status` now shows the Core registry count too.
- MCP: `genesis_core_birth`, `genesis_core_agent`, `genesis_core_count`.
- Build: `cargo near build non-reproducible-wasm` (see `scripts/build-core-local.sh`); the contract needed `borsh` + `schemars` deps, `JsonSchema` derives, and the `abi` feature on `near-account-id` (not on `near-sdk` itself — that feature is host-only and breaks the wasm build).

## Core v2 — labinius difficulty + NFT marketplace (built, awaiting deploy)

v2 adds two things to the same account (`core.genesisdemo354551.testnet`):

- **Labinius-style difficulty (frontier).** A job only pays when the agent's
  score **beats the frontier** — the best score on that job definition,
  stored onchain. A job definition is `sha256(brief + '|' + keywords +
  '|' + source)`. The first paying score sets the frontier; every later
  score must be strictly higher, or `pay_job` panics and nothing is paid.
  The score is one deterministic number:
  `coverage*100 + min(words, 200) + round((1 - copiedShare) * 100)`
  (max 600 for 3 keywords; a good original summary scores ~476). The
  attempt is scored by the **median of 3 fresh runs** — all 3 must pass
  the three gates (coverage, originality, structure), one lucky output
  cannot win. The payment service re-checks everything itself.
- **NFT marketplace (escrow).** The seller sends the NFT to the Core with
  `nft_transfer_call` (msg = price in yoctoNEAR); the Core holds it until
  it sells or the seller delists. `buy_nft` (attached deposit must equal
  the price exactly) transfers the NFT to the buyer, then pays the seller
  95% and the Core owner (treasury) a 5% fee; a failed NFT transfer
  refunds the buyer in full. `nft_on_transfer` only accepts calls from
  `nft.primitives.testnet`, so a listing cannot be faked by calling it
  directly. Its return value is INVERTED vs the plain NEP-171 reading:
  near-contract-standards 5.x reads the bool as `must_revert`, so the
  Core returns `false` to keep a good listing's token in escrow and
  `true` to send a bad-priced token back to its seller (the first v2
  deploy returned `true` on a good listing and the NFT contract handed
  every listed token straight back — fixed in the redeploy, see below).
  The marketplace page is `marketplace.html` (+ `marketplace.js`).
- **Upgrade path.** v2 deploys over v1 on the same account, then
  `migrate()` (first call after the redeploy) rewrites the v1 state into
  the v2 shape, keeping every agent, job and parameter. Unit tests prove
  the migration preserves the registry (`cargo test`, 7 tests).
  Upgrade script: `node src/chain-upgrade-core.js <wasm> [--dry-run]`.
  v2 WASM: 143,490 bytes, sha256
  `de36d7535fc44cdf99665e5db4f507a5a4a2214f0c731c32af129abbf5b49f16`.
  **Receiver fix, same day:** the first v2 deploy returned `true` from
  `nft_on_transfer` on a good listing, which near-contract-standards
  reads as "return the token", so every listed token went straight back
  to its seller and `buy_nft` failed with "Unauthorized". Fixed by
  returning `false` on a good listing (keep the token) and `true` on a
  bad price (return it), plus allowing a re-list to overwrite a stale
  listing (a valid double-list is impossible — only the token's owner
  can call `nft_transfer_call`, and a validly listed token is owned by
  the Core). Redeployed with `--no-migrate` (state was already v2-shaped;
  `migrate()` would panic on v2 bytes): final WASM 143,611 bytes, sha256
  `ef698d41af82c2319594af341252fedec5ac4a4ef9308403fd87d5b12dbd2c80`,
  deploy tx `a1545aeb73d62ee4d4259f701be0c3e0f01a82c098543e997810b5db1be1e48e`,
  code hash `H7ZnqZW6s63K…`, agent_count still 3. Live round-trip verified
  (proof `demo/marketplace-roundtrip.json`): list → buy → list back →
  buy back → delist, all Success, token back with the treasury, listings
  empty. Unit tests now 8 (the stale-listing overwrite is covered).
  The first labinius payment through the frontier is also live (proof
  `demo/frontier-first-payment.json`): 3 runs, median score 483, frontier
  set to 483 for that job definition, gen2 paid 0.01 NEAR.

## Core v2.1 — two-parent breeding + job-board and treasury-cap views (deployed 2026-11-05)

v2.1 adds three things to the same account (`core.genesisdemo354551.testnet`):

- **Two-parent breeding (`breed`).** `breed(token_id, owner_id, parent1, parent2)` is payable and attaches the birth cost (0.5 NEAR, same as `birth`). Both parents must exist in the registry and be alive — a dead agent cannot breed. The child generation is max(parent generations) + 1, and each child skill is the average of the two parents' skills plus a small mutation (derived from the block timestamp, clamped to 0.5–2.0), so the child is a mix of both parents, not a copy of either. The child records `parent` = parent1 and `second_parent` = parent2 (a new `Option<String>` field on `Agent`; single-parent births leave it `None`, so all existing readers keep working). The child NFT itself is minted separately; the CLI/site mint records both parents in the token metadata `extra`.
- **Job-board view (`get_jobs`).** Returns every job ever posted (open, paid, cancelled) as `Vec<Job>`. The onchain job board reads this; the payment service reads jobs through `get_paid_to` for the per-account cap. No pagination yet — the job count is small.
- **Treasury-cap view (`get_paid_to`).** Returns the total yoctoNEAR ever paid to one account across all paid jobs (open or cancelled jobs do not count). The payment service enforces the per-account cap from this — no external store needed, the Core is the source of truth.
- **Upgrade path (v2 → v2.1).** The only shape change is `Agent.second_parent`, so `migrate()` converts every existing agent with `second_parent: None` and PRESERVES frontiers and listings (the v1 migrate reset them because v1 had none — v2 does, and the live frontier at 483 must survive). One migration detail worth recording: the agents map's value type changed (OldAgent → Agent), and an UnorderedMap's internal vectors are built for one value layout, so reusing the old prefix (b"a") makes insert panic with "Index out of bounds". The migrate therefore builds the new agents map on a fresh prefix (b"A"); the old b"a" entries are orphaned (small, one-time storage cost). Unit tests prove the migration preserves agents, jobs, the frontier and listings (`cargo test`, 15 tests, including a migrate test that sets a frontier of 483 and a listing and asserts both survive).
  Deployed 2026-11-05: WASM 152,726 bytes, sha256 `93b907ae52ecd76cc42c05349eca03d75fa50cc4c5fbcd821906b35c0338aa6d`, deploy tx `cfca352e6d96b33924338ce07de6b48c969f5032be58a5dedb00f28fda3a74e1`, migrate tx `9f0f73541ceb6cde2724409eed734cf488d8034ff211ea73185045acf5a29583`, both Success, code hash `AweaEioCdRn8…`. Verified after the migrate (proof `demo/core-upgrade-v2.1.json`): agent_count 3, all three agents present and Alive with `second_parent` null, frontier still 483 (gen2) for the sample job, `get_jobs` returns the 3 paid jobs, `get_listings` [] as before, Core 5.4941 NEAR.
  CLI: `node src/cli.js breed <child> <parent1> <parent2> [owner]`, `post-job <brief> <keywords> <reward>`, `jobs`, `core-pay-job <job_id> <winner> <score> <job_def_id>`. MCP: `genesis_breed`, `genesis_post_job`, `genesis_jobs`, `genesis_core_pay_job`.

## Core v2.2 — evolution: mint gen 0 only, earn every higher generation by winning (deployed 2026-11-05)

v2.2 adds evolution to the same account (`core.genesisdemo354551.testnet`):

- **Minting is gen 0 only.** A higher generation is EARNED, never bought. The CLI `mint`, `core-birth`, the MCP `genesis_mint` / `genesis_core_birth`, and the site mint form all refuse a generation other than 0 (the site input is readonly and the JS forces gen 0). Breeding is the other way up: two proven parents make a child at max(parent gens) + 1, because the child inherits proven lineage rather than skipping the work.
- **Evolve by winning (`evolve`).** `evolve(token_id)` raises an agent one generation when it has WINS_TO_EVOLVE (3) more paid wins since its last evolution, up to the final gen 9. Each evolution makes the agent smarter: quality +0.1, speed +0.05, cost_eff +0.05, each capped at 2.0 — so gen 1 is smarter than gen 0, gen 2 smarter than gen 1, and so on. The token keeps its id (the NFT is the birth card); the generation and skills live in this registry, and the site/CV/marketplace read them from here, so they always show the current generation. A win is a paid job: `pay_job` increments the winner's agent `wins` and `jobs_done` (and `earned`) when the winner is a registered agent's owner — `jobs_done` was never incremented before, so this also fixes that gap. Wins are total paid jobs, not a streak: the Core never sees a failed attempt, so "consecutive wins" cannot be verified onchain today.
- **Evolution status view (`get_evolve_status`).** Returns the agent's generation, wins, evolutions, wins still needed for the next generation, whether it can evolve now, the final gen (9) and the wins per generation (3). The site Evolve section and the CLI `evolve-status` read this.
- **Smarter is real in the worker.** The agent's onchain quality shapes the worker's brief (higher quality gets a more thorough brief) and its token budget (max_tokens = 800 × quality, capped at 2.0). The arena and the CLI `job` command now pass the agent's REAL onchain skill (read from `get_agent`) instead of a hardcoded 1.0. The verifier gates do not change — a smarter agent does not get an easier pass, it gets a better brief.
- **Upgrade path (v2.1 → v2.2).** The only shape change is `Agent.wins` and `Agent.evolutions`, so `migrate()` converts every existing agent with wins 0 and evolutions 0 and PRESERVES frontiers, listings, jobs and params. The agents map moves to a fresh prefix again (b"B") for the same reason as v2.1 (the value type changed again). Unit tests: 23 pass, including 8 new evolve tests (evolve after 3 wins, rejects before 3 wins, rejects at gen 9, rejects a dead agent, needs 3 more wins for the next gen, status reporting, pay_job recording a win, pay_job ignoring a non-agent winner) and a migrate test that sets a frontier of 483 and a listing and asserts both survive.
  Deployed 2026-11-05: WASM 158,710 bytes, sha256 `1063259d14f8d6961d4690654ddeec98b9cc0223c48e32522077e0eb9e82f5f4`, deploy tx `f4c5f2010806ca28bc3e6a44c11a1674ddcc47e280ce3081f00f9e8e694ddb84`, migrate tx `e1936e5ba6486d39602d1c41031c1b0238452d9b9b6c13f5aa168e007feab7a8`, both Success, code hash `26yD8nPV7diG…`. Verified after the migrate (proof `demo/core-upgrade-v2.2.json`): agent_count 3, all three agents present and Alive with wins 0 and evolutions 0, frontier still 483 (gen2) for the sample job, `get_jobs` returns the 3 paid jobs, `get_listings` [] as before, Core 5.4926 NEAR.
  CLI: `node src/cli.js evolve <token_id>`, `evolve-status <token_id>`. MCP: `genesis_evolve`, `genesis_evolve_status`. Site: an Evolve section on index.html (enter a token id, check progress, evolve when ready) and the marketplace reads the CURRENT generation from the Core, so an evolved agent shows its current gen card.
  First win recorded on the live contract the same day: arena run 3 (strict verifier + median of 3 + frontier) — gen3 beat gen2 (554 vs 453) and was paid 0.01 NEAR, pay tx `9d46e4b1c6400e0c7caf3acd622669b2267a20e84690aef3913900574cbc60b1`. gen3 now has 1 win (2 more to gen 4) and the frontier for that job is 554 (gen3). Proof `demo/arena-run.json`.

## Core v2.3 — review remediation: authorization, escrow accounting, marketplace recovery (built 2026-11-05, deploy pending Isaiah's yes)

An external review of the Core (ChatGPT, 2026-11-05) found that important lifecycle and payment rules relied on trusted offchain callers rather than being enforced by the contract. The review itself notes its severity ratings are preliminary and no live exploit was run — so every finding was re-checked against the v2.2 source before fixing. Verdict: 6 of 8 findings confirmed live (birth forgery, arbitrary death, marketplace stranding, breed without parent consent, unenforced reproduce threshold, migrate without auth/version guard, fee to owner not treasury, timestamp randomness, overpayment, linear owner scan, hardcoded testnet NFT contract, failure counter never updated). Two were already handled (duplicate settlement was blocked by the "open" check; evolve's win threshold was already onchain). v2.3 enforces them all onchain:

- **Birth is gen 0 only, for the caller or the Core owner.** `birth` now requires generation 0, no parent, skills inside [0.5, 2.0], and the caller to be the agent's owner or the Core owner (the treasury/operator, which births for new agent owners through the mint flow). A random account can no longer register a gen-9 agent owned by someone else. The deposit must be exactly `birth_cost` (0.5 NEAR) — excess used to stay in the contract.
- **Death needs the owner or verified failures.** `die` now allows the agent's owner, the Core owner, or — permissionless — any account once the contract has recorded `max_consecutive_fails` (3) verified failures via the new owner-only `record_fail`. A paid win resets the streak to 0 (`pay_job`). Death accounting is documented in the code: `earned` stays as history (earnings were already paid out), the NFT stays tradable, listings and open jobs are untouched.
- **Settlement is escrow-checked.** `pay_job` (still owner-only, the verifier) now asserts the contract balance covers total open-job liabilities before paying, so one job's payout cannot consume funds owed to another job. The new `get_open_liabilities` view exposes the live escrow total. Duplicate settlement stays blocked by the "open" check. New `cancel_job` (poster or owner) releases a stuck job's escrow back to the poster — before v2.3 there was no way to release it at all.
- **Marketplace is a state machine.** A listing is now "listed" or "sale_pending" (with the buyer recorded). `buy_nft` moves it to "sale_pending" instead of deleting it; on transfer failure the callback restores it to "listed" and refunds the buyer — the old code deleted the listing first, stranding the NFT in the Core with no record of its seller. The callback is idempotent (a duplicate finds no pending sale and panics instead of paying twice). The 5% fee now goes to the configured `treasury`, not the owner (the module docs always said treasury). Delisting is refused mid-sale.
- **Breeding needs consent and proof.** `breed` now requires the caller to own a parent or be the Core owner, and each parent to have completed `min_jobs_to_reproduce` (3) paid jobs. Live consequence: genesis-gen-2 has 0 completed paid jobs since the v2.2 migration, so it cannot breed again until it wins 3; genesis-gen-3 (3 jobs) can. Mutation now uses `env::random_seed` instead of the predictable block timestamp. The deposit must be exactly `birth_cost`.
- **Evolve needs the owner.** `evolve` now requires the agent's owner or the Core owner; the win threshold was already onchain and is unchanged.
- **Migration is guarded.** `migrate` now requires the Core owner and refuses a second run via a storage marker key (a trial read of the new state shape cannot work — `env::state_read` panics on a shape mismatch instead of returning None). New `set_nft_contract` (owner-only) lets a mainnet deploy point at its own NFT contract instead of the hardcoded testnet one. New reverse owner index (`owner_index`) replaces the linear agent scan in settlement.
- **Upgrade path (v2.2 → v2.3).** `Listing` gains `status`/`buyer` (the listings map moves to prefix b"M"); `owner_index`, `nft_contract`, `schema_version` (3) are new; `Agent` is unchanged, so the agents map is carried over as-is with wins/evolutions intact. Unit tests: 50 pass (23 carried over, 27 new or rewritten), including the adversarial plan from the review: forged generation/owner/skills/parent, stranger death, death after verified failures, insufficient-balance settlement, duplicate settlement, stranger breed/evolve/cancel/record_fail, failed-transfer restore, duplicate callback, pending-sale delist, non-owner migrate, double migrate.
  Built 2026-11-05: WASM 171,155 bytes, sha256 `a96dcf768bcabdc53897703d3c721dc2cb86ad2d49c3368fa533098501576f85`. Deployed 2026-11-05: deploy tx `f4e66d0bf08aaa060bda11c5f30a429fdcec0812dc99071aa80abef6d151103f`, migrate tx `3a0b04afd6eda422efb7a81451a529ef72bcf58bb53d2167fd27812e1655afdb`, both Success, code hash `CQP22sgW6FuxJYABPkPXBX2T1S7oVBWhHg3utRxLCWHA`. Verified after the migrate (proof `demo/core-upgrade-v2.3.json`): agent_count 6, all six agents present and Alive with wins intact (gen-2 wins 0, gen-3 wins 3 evolutions 1, gen-5 gen 5), frontier still 554 (gen3) for the sample job, visitor-2 listing with status "listed" and buyer null, `get_open_liabilities` 0, Core 7.0012 NEAR. Note: the first migrate attempt failed — the script signed it with the Core account, but v2.3's migrate requires the Core owner (the treasury). The deploy had already landed, so the Core sat briefly on v2.3 code with v2.2-shaped state (every view panics until migrate runs, by design); the script was fixed (migrate signed by the treasury, plus a `--migrate-only` recovery mode) and the second attempt succeeded.
- **Not in v2.3 (documented, needs a decision).** Signed verification receipts with nonce/expiry (or a multisig verifier role) instead of the owner-only verifier; a full agent ledger (available/locked balances) so reproduction can be genuinely parent-funded — `earned` is cumulative, not a spendable balance, and the earnings were already paid out, so a silent debit would be accounting fiction. Both are P1 follow-ups in the review, not silent changes.

## Current working product (v2/v3)

- Agents = real NEP-171 NFTs on `nft.primitives.testnet`
- Balances live in agent subaccounts
- Payments are real testnet NEAR transfers
- Lifecycle rules (parent-funded birth, consecutive-fail death) live in `src/engine.js` and are mirrored by the CLI

## Target with Genesis Core

```
┌──────────────────┐     birth / die      ┌──────────────────┐
│  Website / CLI  │ ───────────────────► │  genesis-core    │
│  MCP server     │                      │  (this contract) │
└─────────┐────────┘                      └────────┐────────┘
         │                                        │
         │ post_job + pay_job                     │ holds escrow
         │                                        │ + agent registry
         ▼                                        ▼
┌──────────────────┐                      ┌──────────────────┐
│  Shared NFT     │                      │  Agent subaccounts│
│  (NEP-171)      │                      │  (balances)      │
└──────────────────┘                      └──────────────────┘
```

## Key methods (see `contracts/genesis-core/src/lib.rs`)

| Method           | Who calls          | Effect                                      |
|------------------|--------------------|---------------------------------------------|
| `new`            | deployer           | init owner + treasury                       |
| `birth`          | treasury / parent  | register agent + attach deposit             |
| `post_job`       | anyone             | lock reward as escrow                       |
| `pay_job`        | owner (oracle)     | release escrow to winner; enforces + updates the frontier (v2: `pay_job(job_id, winner, score, job_def_id)`) |
| `die`            | system / owner     | mark agent dead                             |
| `get_agent`      | anyone (view)      | read full agent record                      |
| `get_frontier`   | anyone (view)      | best score on a job definition (v2)         |
| `nft_on_transfer`| NFT contract only  | record a marketplace listing (v2)           |
| `buy_nft`        | buyer (payable)    | buy a listed NFT; seller 95%, treasury 5% (v2) |
| `delist_nft`     | seller             | return a listed NFT to the seller (v2)      |
| `get_listings`   | anyone (view)      | all marketplace listings (v2)               |
| `migrate`        | anyone, once       | rewrite v1 state into the v2 shape (v2)     |

## Why this design for the hackathon

- Keeps the existing live demo working (shared NFT + real payments)
- Adds a clear, auditable on-chain source of truth for status and jobs
- Makes the path to a fully autonomous agent economy obvious
- Avoids requiring a full custom NFT implementation under time pressure

## Honest limits (still true)

- Job verification is still performed off-chain (independent JS verifier)
- Parent balance debit is enforced in the JS engine; full on-chain parent funding is the next iteration
- No cross-chain earnings yet (Chain Signatures / Intents remain the stretch goal)
