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
