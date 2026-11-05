# Genesis Contract Design (NEAR HACKATHON 2026)

## Goal

Make the agent lifecycle (birth → work → verify → earn → reproduce or die) enforceable and auditable on NEAR, not only in a JS ledger.

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
