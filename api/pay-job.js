// POST /api/pay-job — automatic payment for a passed Genesis site job.
//
// Flow: the site sends the job result (token, connected account, 1-3 model
// outputs, source text, brief, keywords). This function
//   1. recomputes sha256 of the median output — that hash is the job id,
//   2. verifies every output with the STRICT rule (same three gates as
//      engine.js verifyStrict and app.js verifyStrictBrowser — keep the
//      thresholds identical): every keyword inside a sentence of >= 8
//      words, under 30% of output words copied from the source in 8-word
//      sequences, at least 3 sentences. There is NO word count.
//      Labinius-style, ALL runs must pass and the attempt is scored by the
//      MEDIAN score (one lucky output cannot win).
//   3. recomputes the job-definition id (sha256 of brief + keywords +
//      source) and reads the onchain frontier for it: the median score
//      must BEAT the best score on that job, or no payment is made.
//   4. checks the token exists on the shared NFT contract,
//   5. dedups through the Genesis Core escrow: get_job(median hash) — if
//      the job is already "paid" it refuses; if it is "open" (a previous
//      payment attempt posted the escrow but paying failed) it resumes at
//      pay_job; otherwise it posts the job with 0.01 NEAR locked as escrow
//      and then pays it to the connected account, passing the median score
//      and job-definition id so the contract records the new frontier.
//   6. returns the verdict either way: PASS + pay tx, or FAIL + no payment.
// The Core contract's Job.min_words field is posted as 0 — it is stored
// onchain but verification no longer uses it.
//
// Honest limits (v1):
// - The treasury key comes ONLY from Vercel env vars (TREASURY_PRIVATE_KEY,
//   TREASURY_ACCOUNT_ID). Without it the function answers "not configured"
//   and the site falls back to the copy-to-Everest flow. The key is never
//   logged, never returned, and never stored in the repo. Env vars set in
//   the Vercel project "genesis" (production + preview) on 2026-11-05 — a
//   production deploy from main is what makes them live for the function.
// - Dedup is per output hash: the same output can never be paid twice.
//   It does NOT stop someone generating many DIFFERENT passing outputs —
//   the treasury holds ~0.79 NEAR (about 78 auto-payments). A per-account
//   cap needs a store (Vercel KV) and is the follow-up if wanted.
// - Payment goes to the connected account that ran the job, not
//   necessarily the token owner. The token only has to exist.
const crypto = require('crypto');
const { connect, keyStores, KeyPair, utils } = require('near-api-js');

const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
const NFT_CONTRACT = 'nft.primitives.testnet';
const RPC_URL = 'https://rpc.testnet.near.org';
const REWARD_NEAR = '0.01';
const GAS = BigInt('100000000000000'); // 100 TGas

function tokensOf(text) {
  return (text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function sentencesOf(text) {
  return (text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => tokensOf(s).length >= 3);
}

function verifyStrict(source, keywords, output) {
  const kw = keywords.map((k) => String(k).toLowerCase());
  const outTokens = tokensOf(output);
  const sentences = sentencesOf(output);
  const keywordOk = kw.map((k) =>
    sentences.some((s) => s.toLowerCase().includes(k) && tokensOf(s).length >= 8));
  const coverage = { passed: keywordOk.every(Boolean), covered: keywordOk.filter(Boolean).length, total: kw.length };
  const srcTokens = tokensOf(source);
  const srcShingles = new Set();
  for (let i = 0; i + 8 <= srcTokens.length; i++) srcShingles.add(srcTokens.slice(i, i + 8).join(' '));
  const coveredPos = new Array(outTokens.length).fill(false);
  for (let i = 0; i + 8 <= outTokens.length; i++) {
    if (srcShingles.has(outTokens.slice(i, i + 8).join(' '))) {
      for (let j = i; j < i + 8; j++) coveredPos[j] = true;
    }
  }
  const copiedWords = coveredPos.filter(Boolean).length;
  const copiedShare = outTokens.length ? copiedWords / outTokens.length : 0;
  const originality = { passed: copiedShare < 0.30, copiedShare: +copiedShare.toFixed(2), copiedWords, totalWords: outTokens.length };
  const structure = { passed: sentences.length >= 3, sentences: sentences.length };
  const pass = coverage.passed && originality.passed && structure.passed;
  // Deterministic quality score (labinius-style: one measured number).
  const score = coverage.covered * 100
    + Math.min(originality.totalWords, 200)
    + Math.round((1 - copiedShare) * 100);
  return { pass, score, gates: { coverage, originality, structure } };
}

// Labinius-style multi-run check: every submitted output must pass the
// gates; the attempt is scored by the MEDIAN score. One lucky output
// cannot win. Returns the median output (the one paid on) and its gates.
function verifyRuns(source, keywords, outputs) {
  const results = outputs.map((output) => ({ output, v: verifyStrict(source, keywords, output) }));
  const allPass = results.length > 0 && results.every((r) => r.v.pass);
  const scores = results.map((r) => r.v.score).sort((a, b) => a - b);
  const medianScore = scores.length ? scores[Math.floor(scores.length / 2)] : 0;
  const median = results.find((r) => r.v.score === medianScore) || results[0];
  return {
    pass: allPass,
    medianScore,
    medianOutput: median ? median.output : '',
    medianGates: median ? median.v.gates : null,
    scores: results.map((r) => r.v.score),
    runs: results.length,
  };
}

function jobDefId(brief, keywords, source) {
  return crypto
    .createHash('sha256')
    .update((brief || '') + '|' + keywords.join(',') + '|' + (source || ''))
    .digest('hex');
}

async function rpcView(contractId, method, args) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'pay-job-view', method: 'query',
      params: {
        request_type: 'call_function', account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        finality: 'final',
      },
    }),
  });
  const data = await res.json();
  const bytes = data && data.result && data.result.result;
  if (!bytes || !bytes.length) return null;
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ ok: false, error: 'bad JSON body' });
    }
  }
  const { token_id, account_id, output, outputs, source, brief, keywords } = body || {};
  if (typeof token_id !== 'string' || !token_id.trim()) {
    return res.status(400).json({ ok: false, error: 'token_id is required' });
  }
  if (typeof account_id !== 'string' || !account_id.trim()) {
    return res.status(400).json({ ok: false, error: 'account_id is required' });
  }
  // Labinius-style: the client submits 1-3 fresh runs of the same job
  // (a single `output` is accepted as one run, for the copy fallback).
  const runs = Array.isArray(outputs) && outputs.length ? outputs : (output ? [output] : []);
  if (runs.length < 1 || runs.length > 3) {
    return res.status(400).json({ ok: false, error: 'outputs must be 1-3 runs' });
  }
  for (const o of runs) {
    if (typeof o !== 'string' || o.length < 40 || o.length > 10000) {
      return res.status(400).json({ ok: false, error: 'each output must be 40-10000 characters' });
    }
  }
  if (typeof source !== 'string' || source.length < 40 || source.length > 10000) {
    return res.status(400).json({ ok: false, error: 'source must be 40-10000 characters' });
  }
  const kws = Array.isArray(keywords) ? keywords.map(String).filter(Boolean) : [];
  if (!kws.length || kws.length > 10) {
    return res.status(400).json({ ok: false, error: 'keywords must be 1-10 strings' });
  }

  const v = verifyRuns(source, kws, runs);
  const defId = jobDefId(brief, kws, source);
  const outputHash = crypto.createHash('sha256').update(v.medianOutput).digest('hex');
  const verdict = {
    output_hash: outputHash,
    job_def_id: defId,
    runs: v.runs,
    scores: v.scores,
    median_score: v.medianScore,
    gates: v.medianGates,
    verdict: v.pass ? 'PASS' : 'FAIL',
  };
  if (!v.pass) {
    return res.status(200).json({ ok: false, error: 'job did not pass verification', ...verdict });
  }

  // Labinius rule: the median score must BEAT the onchain frontier for
  // this job definition. The first paying score sets it.
  let frontier = null;
  try { frontier = await rpcView(CORE_CONTRACT, 'get_frontier', { job_def_id: defId }); } catch (_) {}
  if (frontier && v.medianScore <= frontier.best_score) {
    return res.status(200).json({
      ok: false,
      error: `median score ${v.medianScore} does not beat the frontier ${frontier.best_score}`,
      frontier: frontier.best_score,
      ...verdict,
    });
  }

  // The token must exist on the shared NFT contract.
  let token = null;
  try { token = await rpcView(NFT_CONTRACT, 'nft_token', { token_id }); } catch (_) {}
  if (!token) {
    return res.status(200).json({ ok: false, error: 'token not found on nft.primitives.testnet', ...verdict });
  }

  const privateKey = process.env.TREASURY_PRIVATE_KEY;
  const treasuryId = process.env.TREASURY_ACCOUNT_ID || 'genesisdemo354551.testnet';
  if (!privateKey) {
    return res.status(200).json({
      ok: false,
      error: 'automatic payments are not configured yet (treasury key missing)',
      ...verdict,
    });
  }

  try {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey('testnet', treasuryId, KeyPair.fromString(privateKey));
    const near = await connect({ networkId: 'testnet', nodeUrl: RPC_URL, keyStore });
    const treasury = await near.account(treasuryId);

    // Dedup / resume through the Core escrow.
    let job = null;
    try { job = await rpcView(CORE_CONTRACT, 'get_job', { job_id: outputHash }); } catch (_) {}
    if (job && job.status === 'paid') {
      return res.status(200).json({ ok: false, error: 'this output was already paid', ...verdict });
    }
    let postTx = null;
    if (!job) {
      const posted = await treasury.functionCall({
        contractId: CORE_CONTRACT,
        methodName: 'post_job',
        // min_words is a stored Core field; verification no longer uses it.
        args: { job_id: outputHash, brief: String(brief || ''), keywords: kws, min_words: 0 },
        gas: GAS,
        attachedDeposit: utils.format.parseNearAmount(REWARD_NEAR),
      });
      postTx = posted.transaction.hash;
    }
    const paid = await treasury.functionCall({
      contractId: CORE_CONTRACT,
      methodName: 'pay_job',
      // The contract enforces the frontier too, so a race cannot pay a
      // beaten score; it also records this score as the new frontier.
      args: { job_id: outputHash, winner: account_id, score: v.medianScore, job_def_id: defId },
      gas: GAS,
    });
    return res.status(200).json({
      ok: true,
      ...verdict,
      frontier: frontier ? frontier.best_score : null,
      post_tx: postTx,
      pay_tx: paid.transaction.hash,
      paid_to: account_id,
      amount_near: REWARD_NEAR,
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: 'payment failed: ' + String((e && e.message) || e).slice(0, 300),
      ...verdict,
    });
  }
};
