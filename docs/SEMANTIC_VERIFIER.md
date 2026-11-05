# Semantic verifier — the quality judge

## The gap

The strict verifier (`src/engine.js` `verifyStrict`) checks **shape**: every
keyword inside a sentence of ≥ 8 words, under 30% copied from the source, at
least 3 sentences, and the score must beat the onchain frontier. A beautifully
structured but factually wrong answer passes all of that. Live proof
(`scripts/live-semantic-check.js`, 2026-11-05): a summary with an invented
100 NEAR fee and a 24-hour self-destruct scored **535** structurally — higher
than the true summary's 507. The old system would have paid the lie first.

## The five dimensions

The semantic judge (`src/semantic-verify.js`) scores the **median output**
— the one that would be paid on — against the source text as the **only**
ground truth:

| # | Dimension | How it is judged | Bar |
|---|---|---|---|
| 1 | Factual accuracy | Every claim must be supported by the source. One invented fact (a wrong number, name or step) caps accuracy at 40. | ≥ 80 |
| 2 | Relevance | The output answers the brief. | ≥ 70 |
| 3 | Completeness | The brief and every keyword covered in substance, not just mentioned. | ≥ 70 |
| 4 | Originality | Deterministic, from the structural gates (copied share under 30%). The judge does not re-decide this. | gate |
| 5 | Evidence | Claims anchored to specifics from the source (names, numbers, steps), not vague generalities. | ≥ 70 |

All five must pass. The verdict names the failing dimensions, the
unsupported claims, and what is missing, so a refusal is auditable.

## How it runs

- **The judge is a second model call** (`callLLM` from `src/worker-llm.js`,
  same route chain as the worker: NEAR AI Cloud first, then a configured
  endpoint, then Pollinations). The judge model can differ from the worker
  model via `SEMANTIC_JUDGE_MODEL`, so the worker does not grade its own
  homework when a second model is set. On the live check the judge ran on
  NEAR AI with a verifiable attestation.
- **The judge prompt carries the source** (first 12,000 chars, HTML
  entities decoded) and asks for JSON only: four 0–100 scores,
  `unsupported_claims`, `missing`, `reason`. The parser tolerates
  markdown fences and rejects out-of-range or missing scores. The worker
  reads only the first 3,000 chars of a page, but the judge gets the
  longer view: the facts an answer draws on can live further down the
  page. Proven live 2026-11-05 — the run-3 winning answer's
  deploy-command details sit at char 9,599 of the NEAR NFT docs, so a
  3,000-char judge view flagged a correct answer at accuracy 30.
  Callers hand the judge the full page; the 12,000-char cap does the
  slicing. The worker's 3,000-char slice is unchanged, so its outputs
  and scores do not move. The source is entity-decoded for the judge
  only (`&quot;decimals&quot;:0` reads as `"decimals":0`): the fetched
  source is tag-stripped but not decoded, and a live judge claimed the
  field was nowhere in the source. Decoding in the worker's pipeline
  would change the job_def_id and reset the frontier, so it stays out.
- **Token budget.** The judge reasons before answering: 800 max tokens was
  spent entirely on reasoning and returned empty content live. The judge
  gets 4000 tokens. 2000 was enough for a 3,000-char source, but the
  longer 12,000-char view needs more reasoning room: at 2000 the judge
  returned empty content live (2026-11-05), at 4000 it answered. If the
  model family changes, re-check this.
- **Fail closed.** An unavailable judge, an unparseable answer, or a score
  below bar all mean **no payment**.
- **Cost discipline.** The judge runs on the median output only (1 call per
  attempt, not 3), and only after the structural gates pass and the median
  beats the frontier — a failed or tied attempt costs no judge call. The
  arena is the exception: it judges each contestant's median output before
  picking a winner, so the winner is always a truthful answer.

## Where it gates payment

| Path | Order |
|---|---|
| CLI `job` | structural → frontier → semantic → pay |
| MCP `genesis_job` | structural → frontier → semantic → pay |
| Arena (`src/arena-run.js`) | structural + semantic per contestant → winner by median score → frontier → pay |
| Payment service (`api/pay-job.js`) | structural → frontier → semantic → token → key → caps → pay |

The payment service cannot import `src/semantic-verify.js`, so it carries a
duplicated copy of the prompt, thresholds and parser — keep the two
identical. Its judge runs on Pollinations (the only keyless route on
Vercel); the local judge uses NEAR AI first.

## Live proof

`node scripts/live-semantic-check.js` (no payment, no posting — it only
judges):

- **TRUE** (the worker's own summary of the NEAR NFT docs): structural 507,
  semantic PASS — accuracy 98, relevance 97, completeness 88,
  originality 93, evidence 93.
- **FALSE** (same summary + an invented 100 NEAR fee and 24-hour
  self-destruct): structural 535, semantic FAIL — accuracy 30, with both
  invented claims named exactly.

## Honest limits

- **The judge is a model, not a proof.** Scores vary run to run (the same
  false summary scored accuracy 30 and 40 on two runs — both far below the
  80 bar). The bar, not the exact number, is the guarantee.
- **Same-model judging.** By default the judge is the same model as the
  worker (z-ai/glm-5.3-flash). A different judge model (`SEMANTIC_JUDGE_MODEL`)
  removes the self-grading bias; it is not set yet.
- **Token budget.** The judge reasons before answering: 800 max tokens was
  spent entirely on reasoning and returned empty content live. The judge
  gets 4000 tokens (see "How it runs"). If the model family changes,
  re-check this.
- **The payment service is still the oracle.** The semantic gate runs in
  the service too, but the service decides who gets paid — the verifier is
  independent code, the decision is centralised.
- **The site judge is a GET.** The payment service calls Pollinations with
  the prompt in the URL, so a 12,000-char source makes a ~20,000-char URL
  and the request fails (a POST was tried live 2026-11-05 and timed out).
  A failure fails closed — no payment on an unjudged answer — but a long
  pasted source can block a site payment. The local judge (NEAR AI) has
  no such limit.
