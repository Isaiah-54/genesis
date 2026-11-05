# Genesis: labinius-style difficulty + agent NFT marketplace (design spec, 2026-11-05)

Isaiah's direction: the job difficulty should be like labinius.fast, and the
site needs a marketplace page where users buy/sell agent gen NFTs.

## 1. Labinius difficulty — what it means here

labinius.fast (Yukon, Holindauer/labinius-fast) scores an entry by the
**median wall-clock ms of five fresh-seed runs**, lower is better, and an
entry only wins if it **beats the current best** (214.184 ms). The bar is a
measured, reproducible number, and it moves up every time someone beats it.

Genesis analog, for real paid jobs:

- **Score** — one deterministic number computed from an output (same formula
  in engine.js, app.js, api/pay-job.js):
  `score = coverage*100 + min(words, 200) + round((1 - copiedShare) * 100)`
  where coverage = keywords covered (0..N), words = output word count,
  copiedShare = share of output words inside 8-word sequences copied from
  the source. For 3 keywords the max is 600. A good original summary
  (~76 words, 0% copied, 3/3) scores ~476.
- **Frontier** — the best score achieved on that job definition, stored
  onchain in Core. A job definition is identified by
  `job_def_id = sha256(brief + '|' + keywords.join(',') + '|' + source)`.
  The first passing attempt on a fresh job sets the frontier; every later
  attempt must **beat** it to be paid. The bar rises as agents improve.
- **Median of 3** — the agent submits 3 fresh model runs of the same job.
  All 3 must pass the three gates (coverage, originality, structure); the
  **median** score counts. One lucky output cannot win. The payment service
  verifies all 3 outputs itself (hashes, gates, scores) — it trusts nothing
  the client claims.
- **PASS** = three gates pass AND median score > frontier. The payment
  service checks the frontier onchain before paying, and the contract
  enforces it in `pay_job` too (so a race cannot pay a beaten score).

The three gates stay (no word-count bar). The offline lifecycle demos keep
the legacy lenient rule.

## 2. Marketplace — design + suggestions

- **Escrow, not a listings board.** The seller sends the NFT to the Core
  with `nft_transfer_call` (receiver = Core, msg = price in yoctoNEAR).
  The Core holds the NFT until it sells or the seller delists. A buyer
  pays the Core; the Core releases the NFT to the buyer and pays the seller.
  Nobody can take the money and keep the NFT.
- **5% fee to the treasury** on every sale. It funds future job payments,
  so the marketplace feeds the economy instead of draining it.
- **Buy the record, not just the picture.** Each listing shows the gen card
  AND the agent's onchain record — generation, parent, jobs done, earnings,
  league score, and a link to its Agent CV (cv.html). A gen-3 agent with a
  107.00 league score is worth more than a fresh gen-0. That is the whole
  point of a Genesis NFT: it is a working agent with a history.
- **Price in testnet NEAR**, seller's choice. Listings are per token id.
- **Delist** returns the NFT to the seller at any time before a sale.

## 3. Core contract v2 — interface (address stays core.genesisdemo354551.testnet)

New state: `frontiers: LookupMap<String, Frontier>`,
`listings: LookupMap<String, Listing>`.
Existing agents/jobs state is preserved by a `migrate()` call
(`#[init(ignore_state)]`) after redeploying to the same account.

```rust
pub struct Frontier { pub best_score: u32, pub best_output_hash: String, pub winner: AccountId }
pub struct Listing { pub token_id: String, pub seller: AccountId, pub price: U128, pub listed_at: u64 }
```

- `get_frontier(job_def_id: String) -> Option<Frontier>` (view)
- `pay_job(job_id: String, winner: AccountId, score: u32, job_def_id: String)` —
  owner-only as before; releases escrow; updates the frontier when the score
  beats it; panics when a frontier exists and score <= best.
- `nft_on_transfer(sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> PromiseOrValue<bool>` —
  NEP-171 receiver callback. `msg` is the price in yoctoNEAR as a decimal
  string. Records the listing (seller = previous_owner_id). Return value
  is INVERTED vs the plain NEP-171 reading: near-contract-standards 5.x
  reads the bool as `must_revert`, so the Core returns `false` to KEEP
  the token (good listing) and `true` to send it back (bad price).
  Returning `true` on a good listing makes the NFT contract hand the
  token straight back to the seller. A re-list overwrites a stale
  listing (a valid double-list is impossible — only the token's owner
  can call `nft_transfer_call`).
- `buy_nft(token_id: String)` — payable; attached deposit must equal the
  listing price exactly. Transfers the NFT to the buyer (cross-contract
  call), then a private callback pays the seller 95% and the Core owner
  (treasury, genesisdemo354551.testnet) 5%, and removes the listing.
  On NFT-transfer failure the buyer is refunded.
- `delist_nft(token_id: String)` — seller only; returns the NFT to the
  seller, removes the listing.
- `get_listings() -> Vec<Listing>` (view), `get_listing(token_id: String) -> Option<Listing>` (view)
- `migrate()` — `#[init(ignore_state)]`; reads the v1 state, writes v2 with
  empty frontiers/listings. First call after redeploy, before any other call.
- `new`, `birth`, `post_job`, `die`, `set_params`, `get_agent`, `get_job`,
  `agent_count` — unchanged (post_job keeps its existing args).

NFT contract: `nft.primitives.testnet` (NEP-171; `nft_transfer_call` is part
of the standard — verify live during testing; fallback is `nft_approve`).
Treasury / Core owner: `genesisdemo354551.testnet`.

## 4. Site — marketplace page

- `marketplace.html` + `marketplace.js` (loads after app.js; uses
  `window.nearWallet` directly and RPC view calls to
  https://rpc.testnet.near.org). Element ids: `#marketListings`,
  `#marketStatus`, `#listTokenId`, `#listPrice`, `#listNftBtn`, `#myListings`.
- Listing card: gen card image
  `https://genesis-roan-eta.vercel.app/nft/gen-N.svg` (generation from the
  token's `extra`), token id, seller, price in NEAR, Buy button, CV link.
- If `get_listings` fails (contract not yet upgraded), show: "The
  marketplace opens when the upgraded contract deploys."
- Add a Marketplace link to the header nav on every page.

## 5. Payment service changes (api/pay-job.js)

- Accepts `outputs: [o1, o2, o3]` (3 runs) instead of a single `output`.
  Verifies each (gates), scores each, takes the median score and the median
  output. The escrow job id is the median output's hash.
- Recomputes `job_def_id` from brief + keywords + source (never trusts the
  client's value), reads the frontier from Core, pays only when the median
  score beats it, and passes `score` + `job_def_id` to `pay_job`.
- `post_job` keeps its existing args (job_id, brief, keywords, min_words 0).
