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
// Honest limits (v2):
// - The treasury key comes ONLY from Vercel env vars (TREASURY_PRIVATE_KEY,
//   TREASURY_ACCOUNT_ID). Without it the function answers "not configured"
//   and the site falls back to the copy-to-Everest flow. The key is never
//   logged, never returned, and never stored in the repo. Env vars set in
//   the Vercel project "genesis" (production + preview) on 2026-11-05 — a
//   production deploy from main is what makes them live for the function.
// - Dedup is per output hash: the same output can never be paid twice.
// - Per-account cap (implemented 2026-11-05): an account can be paid at
//   most 0.05 NEAR in total across all jobs (5 payments of 0.01). The
//   cap is read from the Core's get_paid_to view — no external store —
//   and if that read fails the payment is refused (fail closed).
// - Treasury floor (implemented 2026-11-05): the treasury keeps at least
//   0.1 NEAR. If paying the 0.01 reward would take it below the floor,
//   the payment is refused. If the balance read fails, fail closed.
// - Payment goes to the connected account that ran the job, not
//   necessarily the token owner. The token only has to exist.
// - What remains unbuilt: the arena script still scores by the older
//   rule (keywords + words) rather than the strict verifier + frontier;
//   the job board is a file, not onchain (the Core has post_job escrow
//   but the board is not wired to it yet).
const crypto = require('crypto');
const { connect, keyStores, KeyPair, utils } = require('near-api-js');

const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
const NFT_CONTRACT = 'nft.primitives.testnet';
const RPC_URL = 'https://rpc.testnet.near.org';
const REWARD_NEAR = '0.01';
const GAS = BigInt('100000000000000'); // 100 TGas

// Treasury protections (checked before any payment is sent; see capCheck).
const MAX_PAID_PER_ACCOUNT_NEAR = 0.05; // total per account, ever
const TREASURY_FLOOR_NEAR = 0.1;        // treasury keeps at least this
const YOCTO_PER_NEAR = BigInt('1000000000000000000000000');
const REWARD_YOCTO = BigInt('10000000000000000000000'); // 0.01 NEAR
const MAX_PAID_PER_ACCOUNT_YOCTO = BigInt('50000000000000000000000'); // 0.05 NEAR
const TREASURY_FLOOR_YOCTO = BigInt('100000000000000000000000'); // 0.1 NEAR

// yoctoNEAR (BigInt or numeric string) -> NEAR as a short decimal string.
function yoctoToNear(yocto) {
  const y = BigInt(yocto);
  const whole = y / YOCTO_PER_NEAR;
  const frac = y % YOCTO_PER_NEAR;
  if (frac === BigInt(0)) return whole.toString();
  return (whole.toString() + '.' + frac.toString().padStart(24, '0').replace(/0+$/, '')).replace(/\.$/, '');
}

// Pure treasury-protection decision. Inputs are yoctoNEAR (BigInt or
// numeric string); rewardYocto is the reward this payment would send.
// Returns { allowed, reason, paidToNear, treasuryNear }.
//   - allowed: false when the payment would push the account past its
//     total cap, or when the treasury would drop below the floor.
//   - reason: null when allowed, otherwise a human-readable refusal.
// Boundary: exactly reaching the cap or exactly reaching the floor is
// allowed (only *exceeding* the cap or *dropping below* the floor is
// refused).
function capCheck({ paidToYocto, treasuryYocto, rewardYocto }) {
  const paid = BigInt(paidToYocto);
  const treasury = BigInt(treasuryYocto);
  const reward = BigInt(rewardYocto);
  const paidToNear = yoctoToNear(paid);
  const treasuryNear = yoctoToNear(treasury);
  if (paid + reward > MAX_PAID_PER_ACCOUNT_YOCTO) {
    return {
      allowed: false,
      reason: `per-account payment cap reached: this account has already been paid ${paidToNear} NEAR in total, and the cap is ${MAX_PAID_PER_ACCOUNT_NEAR} NEAR — no further payment`,
      paidToNear,
      treasuryNear,
    };
  }
  if (treasury < TREASURY_FLOOR_YOCTO + reward) {
    return {
      allowed: false,
      reason: `treasury floor reached: the treasury holds ${treasuryNear} NEAR and must keep at least ${TREASURY_FLOOR_NEAR} NEAR after paying the ${yoctoToNear(reward)} NEAR reward — payment refused`,
      paidToNear,
      treasuryNear,
    };
  }
  return { allowed: true, reason: null, paidToNear, treasuryNear };
}

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

// Read an account's balance via view_account. Returns the amount in
// yoctoNEAR as a string. Throws when the RPC call fails or returns no
// amount — the caller fails closed on that.
async function rpcAccountBalance(accountId) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'pay-job-balance', method: 'query',
      params: { request_type: 'view_account', account_id: accountId, finality: 'final' },
    }),
  });
  const data = await res.json();
  const amount = data && data.result && data.result.amount;
  if (typeof amount !== 'string') throw new Error('no balance returned for ' + accountId);
  return amount;
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

  // Treasury protections — per-account cap + treasury floor — checked
  // AFTER the frontier and token checks and BEFORE any payment is sent.
  // Both reads are fail-closed: if either onchain read fails, refuse to
  // pay rather than paying without the check.
  let paidToYocto = null;
  let treasuryYocto = null;
  try {
    paidToYocto = await rpcView(CORE_CONTRACT, 'get_paid_to', { account_id });
    if (paidToYocto === null || paidToYocto === undefined) throw new Error('get_paid_to returned nothing');
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: 'could not check the per-account payment cap (get_paid_to failed) — payment refused',
      paid_to_near: null,
      treasury_balance_near: null,
      ...verdict,
    });
  }
  try {
    treasuryYocto = await rpcAccountBalance(treasuryId);
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: 'could not check the treasury balance — payment refused',
      paid_to_near: yoctoToNear(paidToYocto),
      treasury_balance_near: null,
      ...verdict,
    });
  }
  const cap = capCheck({ paidToYocto, treasuryYocto, rewardYocto: REWARD_YOCTO });
  if (!cap.allowed) {
    return res.status(200).json({
      ok: false,
      error: cap.reason,
      paid_to_near: cap.paidToNear,
      treasury_balance_near: cap.treasuryNear,
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
      paid_to_near: cap.paidToNear,
      treasury_balance_near: cap.treasuryNear,
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

module.exports.capCheck = capCheck;
module.exports.yoctoToNear = yoctoToNear;
module.exports.MAX_PAID_PER_ACCOUNT_NEAR = MAX_PAID_PER_ACCOUNT_NEAR;
module.exports.TREASURY_FLOOR_NEAR = TREASURY_FLOOR_NEAR;
module.exports.REWARD_YOCTO = REWARD_YOCTO;
