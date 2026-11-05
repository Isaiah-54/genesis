# Deploy Genesis Core — build-and-deploy run (v3)

## What is prepared

- **Contract:** `contracts/genesis-core/` (near-sdk 5.5). One fix applied
  while preparing this run: `birth()` now enforces `birth_cost`
  (`deposit >= birth_cost`) — before, the cost was stored by `set_params`
  but never checked, so a birth could attach 1 yocto and still register.
- **Build:** GitHub Actions workflow in `docs/build-core-workflow.yml`.
  It cannot be pushed by the agent (the Muse GitHub App has no workflows
  permission), so Isaiah adds it in the GitHub web UI — see step 1.
- **Deploy script:** `src/chain-deploy-core.js` — signs locally with
  near-api-js, broadcasts via curl (the pattern all Genesis chain scripts
  use). Key-save-first: the core account key is written to
  `.testnet-core-account.json` (chmod 600, gitignored) BEFORE any tx.
- **Deploy target (testnet only):** new subaccount
  `core.genesisdemo354551.testnet`, owner + treasury =
  `genesisdemo354551.testnet` (the Genesis treasury, 6.2965 NEAR).

## Step 1 — Isaiah: add the workflow (GitHub web UI, ~2 minutes)

1. On github.com/Isaiah-54/genesis, open **Add file → Create new file**.
2. Path: `.github/workflows/build-genesis-core.yml`.
3. Paste the full contents of `docs/build-core-workflow.yml` from the repo.
4. Commit directly to `main`.
5. Open the **Actions** tab → **Build Genesis Core** → **Run workflow**.
6. When it finishes, download the **`genesis-core-wasm`** artifact and
   send the `genesis_core.wasm` file to Everest in chat (as a file
   attachment). If the artifact lists a different wasm filename, say so —
   the deploy script takes the path as its argument.

## Step 2 — Everest: dry-run preview, then deploy (only on Isaiah's yes)

```
node src/chain-deploy-core.js genesis_core.wasm --dry-run   # preview only
node src/chain-deploy-core.js genesis_core.wasm              # real deploy
```

Preview (shown before anything is signed):

| Step | What | Cost |
|---|---|---|
| Create `core.genesisdemo354551.testnet` | CreateAccount + 4 NEAR funding + full-access key | 4 NEAR from treasury |
| Deploy WASM | DeployContract, code = the built wasm | storage ~1 NEAR per 100 KB of wasm (e.g. ~2.5 NEAR for 250 KB), paid from the core account's 4 NEAR; leftover stays in the core account, not lost |
| Init | `new({owner_id, treasury})` | gas only |
| Params | `set_params`: birth_cost **0.05 NEAR** (lowered from 0.5 on 2026-11-05 for the Hackathon), profit_threshold **1.5 NEAR**, max 3 consecutive fails, min 3 jobs to reproduce | gas only |
| Verify | `agent_count` (expect 0), `get_agent(genesis-gen-2)` (expect null) | read-only |

Treasury after: ~6.2965 − 4 − gas ≈ **2.29 NEAR**. Testnet NEAR is
free (faucet), so the treasury can be topped up if births/jobs need more.
Nothing is deployed until Isaiah confirms this exact preview.

## Honest limits (still true after deploy)

- **Registry starts empty.** `agent_count` is 0 after deploy. The
  existing NFT agents (gen2, gen3, genesis-visitor-1) are NOT
  auto-imported — they must be registered with `birth()` calls (their
  token ids, owners, generations, parents), or the CLI/MCP birth flow
  must be wired to call core `birth()` as well as minting the NFT.
- **Verification is still off-chain.** `pay_job` is owner-only: the
  escrow is onchain, but the decision to pay still comes from the
  off-chain verifier/oracle. That is the next iteration, not this one.
- **`die()` marks dead only.** Returning an agent's remaining balance is
  still the caller's job (CLI/MCP), as the skeleton's docs say.
- **No Rust toolchain on the build host.** The contract cannot be
  compiled on this VM, so the GitHub Actions build is the route — the
  wasm is only trusted after the artifact is downloaded and its size
  and `agent_count` verification pass.
