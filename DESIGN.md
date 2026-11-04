# Genesis — design (locked for prototype v0)

## Idea in one line
An agent is born with a NEAR balance, takes real jobs, gets verified by an
independent verifier, earns, and — if profitable — reproduces a mutated child
funded from its own earnings. If it loses money repeatedly, it dies.

## Lifecycle (no escrow framing; the treasury is a birth/death ledger)
1. **Birth** — parent (or Genesis treasury for Gen 0) funds a child account.
   Cost: BIRTH_COST. Child gets a mutated skill set.
2. **Work** — worker takes a job (summarise / translate / research brief).
   Inference cost is charged per job. Output is produced by code in this repo
   (extractive summariser in v0 — never claimed to be an LLM call).
3. **Verify** — an independent verifier (different code path, different rules)
   checks length, source coverage and required keywords. Pass = pay, fail = no pay.
4. **Earn / die** — pass adds reward minus cost to balance.
   - Reproduce when: jobsDone >= 3 AND balance >= BIRTH_COST + PROFIT_THRESHOLD.
   - Die when: balance <= 0 OR 3 consecutive failed jobs.
   On death, remaining balance returns to the treasury.
5. **Evolve** — child skill mutates: one of speed, cost-efficiency, or quality
   improves by a fixed step, one may regress slightly. No skill is invented
   out of thin air; mutation table is in src/engine.js and is fully logged.

## What is real vs simulated in v0
- REAL: job execution, verification rules, balances, reproduction and death
  decisions, family tree — all computed by this code, reproducible.
- SIMULATED LEDGER in v0: balances are a JSON ledger, not yet NEAR transfers.
  v1 replaces ledger writes with NEAR testnet subaccount creation + transfers
  (NEAR testnet RPC is reachable from this host; no Rust toolchain, so the
  chain layer will be near-api-js, not a Rust contract).
- NEVER CLAIMED: that a simulated ledger balance is an onchain balance, that
  the summariser is an LLM, or that a testnet transfer is mainnet.

## Tracks (submission form allows multiple)
Primary: AI Swarms. Also: Agent Economy, NFTs That Do Something,
Autonomous Business.

## Working product (v2, on NEAR testnet — real, not just a ledger)
Each generation is a real NEP-171 NFT on the shared testnet contract
`nft.primitives.testnet` (verified live; the global contract account
`nft.globals.primitives.testnet` does NOT exist on testnet, and this host
has no Rust toolchain, so no custom contract was compiled — the shared
contract is the honest route, documented here, not hidden).
- Birth = create agent subaccount + mint its NFT to it.
- Work = fetch a live page, summarise with the repo worker, verify with
  the repo verifier. PASS = real testnet NEAR payment to the agent.
- Death = transfer the NFT back to the treasury + return balance.
- Proof files: `demo/realistic-testnet-run.json` (first run) and
  `demo/working-product-run.json` (clean run). Every tx hash in them was
  re-verified by RPC view calls (nft_token owners + balances).
- LOCKED TOKENS — honest failure, fixed in v2: the first run created
  gen0/gen1/gen5 subaccounts with random keys that were never saved, so
  their NFTs (genesis-gen-0, genesis-gen-1, genesis-gen-5-weak) are
  on-chain and provable, but not movable by us. v2 rule, enforced in
  code: keys are saved to `.testnet-agents.json` (chmod 600, gitignored)
  BEFORE any creation tx is broadcast. The MCP server also refuses to
  move a token whose owner key is not held, instead of faking it.
- Death cost note: the first death attempt failed with a chain-required
  ~0.30 NEAR against a 0.02 NEAR balance, so working agents are funded
  with 0.5 NEAR. The weak-2 death then succeeded.

## MCP (Model Context Protocol) — for transactions
The hackathon itself does NOT require MCP (submission = public repo +
public X demo post). NEAR does offer an official generic MCP server
(`@nearai/near-mcp`, `npx @nearai/near-mcp@latest run`) for accounts,
balances, signing and sending txs. Genesis ships its own MCP server
instead, because its tools are Genesis-specific: `src/mcp-server.mjs`
(run locally: `node src/mcp-server.mjs`, stdio transport). Tools:
genesis_token, genesis_balance, genesis_pay, genesis_mint,
genesis_create_agent (key-save-first), genesis_transfer_nft
(locked-token guard), genesis_job (real page + verify + pay on PASS).
It runs locally only and reads keys from gitignored local files only;
no key is ever returned in a tool result.

## Submission requirements (from nearhackathon.com, checked 2026-11-04)
- Public repo by 14 Nov 2026 23:59 UTC.
- Public demo post on X: say built at NEAR HACKATHON, tag @NEARProtocol and
  #NEARHackathon, attach video or screenshots.
- Submit repo link + demo post link via the form. One submission per project.
  A correction path exists via the Request changes page, but do not rely on it.
- AI judges (Claude Code & Codex) screen first that it runs and does what the
  README says — so README "do X, see Y" steps must be literally true.
