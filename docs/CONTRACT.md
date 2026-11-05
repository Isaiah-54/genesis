# Genesis Contract Design (NEAR HACKATHON 2026)

## Goal

Make the agent lifecycle (birth → work → verify → earn → reproduce or die) enforceable and auditable on NEAR, not only in a JS ledger.

## Genesis Core — DEPLOYED on testnet (2026-11-05)

The contract is live at **`core.genesisdemo354551.testnet`** (wasm 104,091 bytes, sha256 `11b6a95d…`, deployed 2026-11-05; deploy tx `21530332…`, init `3673385f…`, set_params `14fc4e43…`, all Success; proof in `demo/core-deploy.json`). Params: birth cost 0.5 NEAR, profit threshold 1.5 NEAR, max 3 consecutive fails, min 3 jobs to reproduce. **The registry starts empty** — existing NFT agents are not auto-imported; register them with `core-birth` (below). Verification is still off-chain and `pay_job` is owner-as-oracle in this version.

- CLI: `node src/cli.js core-birth <token> <owner> <gen> <parent|->` (0.5 NEAR from the treasury; owner account must already exist), `core-agent <token>`, `core-count`. `status` now shows the Core registry count too.
- MCP: `genesis_core_birth`, `genesis_core_agent`, `genesis_core_count`.
- Build: `cargo near build non-reproducible-wasm` (see `scripts/build-core-local.sh`); the contract needed `borsh` + `schemars` deps, `JsonSchema` derives, and the `abi` feature on `near-account-id` (not on `near-sdk` itself — that feature is host-only and breaks the wasm build).

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

| Method       | Who calls          | Effect                                      |
|--------------|--------------------|---------------------------------------------|
| `new`        | deployer           | init owner + treasury                       |
| `birth`      | treasury / parent  | register agent + attach deposit             |
| `post_job`   | anyone             | lock reward as escrow                       |
| `pay_job`    | owner (oracle)     | release escrow to winner                    |
| `die`        | system / owner     | mark agent dead                             |
| `get_agent`  | anyone (view)      | read full agent record                      |

## Why this design for the hackathon

- Keeps the existing live demo working (shared NFT + real payments)
- Adds a clear, auditable on-chain source of truth for status and jobs
- Makes the path to a fully autonomous agent economy obvious
- Avoids requiring a full custom NFT implementation under time pressure

## Honest limits (still true)

- Job verification is still performed off-chain (independent JS verifier)
- Parent balance debit is enforced in the JS engine; full on-chain parent funding is the next iteration
- No cross-chain earnings yet (Chain Signatures / Intents remain the stretch goal)
