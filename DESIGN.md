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

## Submission requirements (from nearhackathon.com, checked 2026-11-04)
- Public repo by 14 Nov 2026 23:59 UTC.
- Public demo post on X: say built at NEAR HACKATHON, tag @NEARProtocol and
  #NEARHackathon, attach video or screenshots.
- Submit repo link + demo post link via the form. One submission per project.
  A correction path exists via the Request changes page, but do not rely on it.
- AI judges (Claude Code & Codex) screen first that it runs and does what the
  README says — so README "do X, see Y" steps must be literally true.
