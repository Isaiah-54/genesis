// POST /api/pay-job — automatic payment for a passed Genesis site job.
//
// Flow: the site sends the job result (token, connected account, model
// output, brief, keywords). This function
//   1. recomputes sha256(output) — the output hash is the job id,
//   2. verifies the output with the STRICT rule (same three gates as
//      engine.js verifyStrict and app.js verifyStrictBrowser — keep the
//      thresholds identical): every keyword inside a sentence of >= 8
//      words, under 30% of output words copied from the source in 8-word
//      sequences, at least 3 sentences. There is NO word count.
//   3. checks the token exists on the shared NFT contract,
//   4. dedups through the Genesis Core escrow: get_job(hash) — if the job
//      is already "paid" it refuses; if it is "open" (a previous payment
//      attempt posted the escrow but paying failed) it resumes at pay_job;
//      otherwise it posts the job with 0.01 NEAR locked as escrow and then
//      pays it to the connected account.
//   5. returns the verdict either way: PASS + pay tx, or FAIL + no payment.
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
  return { pass: coverage.passed && originality.passed && structure.passed, gates: { coverage, originality, structure } };
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
  const { token_id, account_id, output, source, brief, keywords } = body || {};
  if (typeof token_id !== 'string' || !token_id.trim()) {
    return res.status(400).json({ ok: false, error: 'token_id is required' });
  }
  if (typeof account_id !== 'string' || !account_id.trim()) {
    return res.status(400).json({ ok: false, error: 'account_id is required' });
  }
  if (typeof output !== 'string' || output.length < 40 || output.length > 10000) {
    return res.status(400).json({ ok: false, error: 'output must be 40-10000 characters' });
  }
  if (typeof source !== 'string' || source.length < 40 || source.length > 10000) {
    return res.status(400).json({ ok: false, error: 'source must be 40-10000 characters' });
  }
  const kws = Array.isArray(keywords) ? keywords.map(String).filter(Boolean) : [];
  if (!kws.length || kws.length > 10) {
    return res.status(400).json({ ok: false, error: 'keywords must be 1-10 strings' });
  }

  const outputHash = crypto.createHash('sha256').update(output).digest('hex');
  const v = verifyStrict(source, kws, output);
  const verdict = { output_hash: outputHash, gates: v.gates, verdict: v.pass ? 'PASS' : 'FAIL' };
  if (!v.pass) {
    return res.status(200).json({ ok: false, error: 'job did not pass verification', ...verdict });
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
      args: { job_id: outputHash, winner: account_id },
      gas: GAS,
    });
    return res.status(200).json({
      ok: true,
      ...verdict,
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
