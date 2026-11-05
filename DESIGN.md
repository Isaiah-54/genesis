# Genesis — design (v3 for NEAR HACKATHON)

## Idea in one line

An agent is born with a NEAR balance, takes real jobs, gets verified by an independent verifier, earns, and — if profitable — reproduces a mutated child **funded from its own earnings**. If it loses money repeatedly, it dies and remaining balance returns to the treasury.

## Lifecycle (v3)

1. **Birth** — Gen 0 funded by treasury. Later generations are **parent-funded** (the parent pays the birth cost from its own balance). Child receives a mutated skill set.
2. **Work** — agent takes a job (summarise / research / brief). Inference cost is charged.
3. **Verify** — independent verifier (different code path) checks three gates, no word count: every keyword inside a sentence of ≥ 8 words, under 30% copied from the source, at least 3 sentences. Pass = pay, fail = no pay. Passing the gates is not enough to be paid: the score must also beat the onchain frontier for that job.
4. **Earn / die**
   - Reproduce when: `jobsDone >= 3` AND `balance >= BIRTH_COST + PROFIT_THRESHOLD`
   - Die when: `balance <= 0` OR `3 consecutive failed jobs`. Remaining balance returns to treasury.
5. **Evolve** — child mutates one skill (speed, quality or cost-efficiency). Mutation is deterministic and fully logged.

## What is real vs simulated

* **REAL on testnet:** NEP-171 NFTs, subaccount balances, job payments, death transfers, MCP tools, website mint + job flow.
* **Engine rules (JS):** parent-funded birth, consecutive-fail death, skill mutation — now the source of truth for the product demos and for the CLI.
* **Contract skeleton:** `contracts/genesis-core` defines the on-chain agent registry, job escrow and birth/death methods. Ready for deployment; the live product still uses the shared NFT contract while this is built out.

See `docs/CONTRACT.md` for the target architecture.

## Tracks

Primary: **AI Swarms**. Also: Agent Economy, NFTs That Do Something, Autonomous Business.

## Working product (v2, on NEAR testnet — real, not just a ledger)

Each generation is a real NEP-171 NFT on the shared testnet contract
`nft.primitives.testnet` (verified live; the global contract account
`nft.globals.primitives.testnet` does NOT exist on testnet, and this host
has no Rust toolchain, so no custom contract was compiled — the shared
contract is the honest route, documented here, not hidden).

* Birth = create agent subaccount + mint its NFT to it.
* Work = fetch a live page, summarise with the repo worker, verify with
the repo verifier. PASS = real testnet NEAR payment to the agent.
* Death = transfer the NFT back to the treasury + return balance.
* Proof files: demo/realistic-testnet-run.json (first run) and
demo/working-product-run.json (clean run). Every tx hash in them was
re-verified by RPC view calls (nft_token owners + balances).
* LOCKED TOKENS — honest failure, fixed in v2: the first run created
gen0/gen1/gen5 subaccounts with random keys that were never saved, so
their NFTs (genesis-gen-0, genesis-gen-1, genesis-gen-5-weak) are
on-chain and provable, but not movable by us. v2 rule, enforced in
code: keys are saved to .testnet-agents.json (chmod 600, gitignored)
BEFORE any creation tx is broadcast. The MCP server also refuses to
move a token whose owner key is not held, instead of faking it.
* Death cost note: the first death attempt failed with a chain-required
~0.30 NEAR against a 0.02 NEAR balance, so working agents are funded
with 0.5 NEAR. The weak-2 death then succeeded.

## MCP (Model Context Protocol) — for transactions

The hackathon itself does NOT require MCP (submission = public repo +
public X demo post). NEAR does offer an official generic MCP server
(`@nearai/near-mcp` , `npx @nearai/near-mcp@latest run`) for accounts,
balances, signing and sending txs. Genesis ships its own MCP server
instead, because its tools are Genesis-specific: `src/mcp-server.mjs`
(run locally: `node src/mcp-server.mjs`, stdio transport). Tools:
genesis_token, genesis_balance, genesis_pay, genesis_mint,
genesis_create_agent (key-save-first), genesis_transfer_nft
(locked-token guard), genesis_job (real page + verify + pay on PASS).
It runs locally only and reads keys from gitignored local files only;
no key is ever returned in a tool result.

## Submission requirements (from nearhackathon.com, checked 2026-11-04)

* Public repo by 14 Nov 2026 23:59 UTC.
* Public demo post on X: say built at NEAR HACKATHON, tag @NEARProtocol and
#NEARHackathon, attach video or screenshots.
* Submit repo link + demo post link via the form. One submission per project.
A correction path exists via the Request changes page, but do not rely on it.
* AI judges (Claude Code & Codex) screen first that it runs and does what the
README says — so README "do X, see Y" steps must be literally true.
