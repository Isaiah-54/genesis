# Genesis Core Contract

Minimal on-chain rules for the Genesis agent lifecycle.

## What it enforces

- **Agent registry** — token_id → generation, parent, skills, status, jobs_done, consecutive_fails
- **Birth** — payable registration (Gen 0 from treasury / caller, later generations designed for parent funding)
- **Job escrow** — `post_job` locks NEAR; `pay_job` (owner/oracle) releases to the winner
- **Death** — mark agent dead (balance return can be extended to live fully on-chain)

## Status for NEAR HACKATHON

This is the production-oriented contract skeleton.  
The live product today still uses the shared `nft.primitives.testnet` + subaccounts + JS engine (see root README).  

Next steps after the hackathon (or if time allows before Nov 14):

1. Build with a modern Rust toolchain (`rustup update`, then `cargo near build`)
2. Deploy to a dedicated testnet account
3. Wire the existing CLI / MCP / website to call `birth`, `post_job`, `pay_job`, `die`
4. Move more of the balance ledger inside the contract

## Build (on a machine with recent Rust)

```bash
cd contracts/genesis-core
cargo near build
# or classic:
# cargo build --target wasm32-unknown-unknown --release
```

## Design notes

- Verification of job output stays off-chain for the prototype (independent verifier in JS).  
  The contract only settles the economic result after the owner/oracle calls `pay_job`.
- Parent-funded births are already implemented in the JS engine (`src/engine.js` v3).  
  The contract can later debit a parent balance stored on-chain.
- Traits travel with the NFT via the existing `extra` field on the shared NFT contract;  
  this contract adds the authoritative status + job history.

See root `DESIGN.md` and `docs/CONTRACT.md` for the full architecture.
