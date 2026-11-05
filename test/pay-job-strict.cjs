// Test api/pay-job.js verification gates without a treasury key.
// The function verifies first, then checks the token, then the key — so
// with no TREASURY_PRIVATE_KEY set, a passing job answers "treasury key
// missing" with verdict PASS, and a failing job answers FAIL with no
// token lookup and no payment attempt.
const handler = require('../api/pay-job');

// Stub the semantic judge (Pollinations) so the tests never call a live
// model: the canned verdict is configurable per case. RPC calls pass
// through to the real testnet RPC, as before.
const realFetch = global.fetch;
let judgeVerdict = { accuracy: 92, relevance: 88, completeness: 85, evidence: 90, unsupported_claims: [], missing: [], reason: 'All claims supported by the source.' };
let judgeRaw = null; // when set, this exact text is returned instead
global.fetch = async (url, opts) => {
  if (String(url).includes('pollinations')) {
    const text = judgeRaw !== null ? judgeRaw : JSON.stringify(judgeVerdict);
    return { text: async () => text };
  }
  return realFetch(url, opts);
};

const SOURCE = 'NEAR has a shared NFT contract that anyone can mint on. The testnet contract is nft.primitives.testnet. To mint, call nft_mint with a token id, a receiver id, and token metadata including title, description and media. A deposit covers storage. NFTs on NEAR follow the NEP-177 standard with metadata under NEP-177.';
const GOOD = 'Anyone can mint a new NFT on the NEAR blockchain, and the resulting token is recorded in the caller\'s wallet for later use. Creating that token means sending an identifier, a destination account, and a small set of descriptive fields to the shared contract, while a storage deposit pays for the data the chain keeps. Because every token follows the public NEP-171 interface, wallets and marketplaces can recognise it without any custom integration code.';
const BASE = { token_id: 'genesis-visitor-1', account_id: 'isaiah.testnet', brief: 'NEAR NFTs global contract mint', keywords: ['near', 'nft', 'mint'], source: SOURCE };

function fail(msg) { console.log('FAIL:', msg); process.exit(1); }

async function call(body) {
  let status = 0;
  let payload = null;
  const req = { method: 'POST', body };
  const res = {
    status(code) { status = code; return this; },
    json(obj) { payload = obj; },
  };
  await handler(req, res);
  return { status, payload };
}

(async () => {
  delete process.env.TREASURY_PRIVATE_KEY;
  const STUFFED = 'near. nft. mint. near. nft. mint. near. nft. mint. near. nft. mint.';

  // 1. Three good original runs pass (median score 476) and stop at the key gate.
  let r = await call({ ...BASE, outputs: [GOOD, GOOD, GOOD] });
  console.log('1. three good runs:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'PASS') fail('three good runs did not PASS');
  if (r.payload.median_score !== 476) fail('median score is not 476, got ' + r.payload.median_score);
  if (r.payload.runs !== 3 || JSON.stringify(r.payload.scores) !== '[476,476,476]') fail('runs/scores wrong');
  if (r.payload.gates.coverage.covered !== 3) fail('good runs coverage is not 3/3');
  if (!String(r.payload.error).includes('treasury key missing')) fail('good runs did not stop at the key gate');

  // 2. Three copies of the source text fail the originality gate.
  r = await call({ ...BASE, outputs: [SOURCE, SOURCE, SOURCE] });
  console.log('2. three copied runs:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'FAIL') fail('copied runs passed');
  if (r.payload.gates.originality.copiedShare < 0.3) fail('copied runs originality gate did not catch them');

  // 3. Keyword stuffing fails the coverage gate.
  r = await call({ ...BASE, outputs: [STUFFED, STUFFED, STUFFED] });
  console.log('3. three stuffed runs:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'FAIL') fail('keyword stuffing passed');
  if (r.payload.gates.coverage.covered !== 0) fail('stuffed runs coverage is not 0/3');

  // 4. Two good runs and one bad run fail — ALL runs must pass.
  r = await call({ ...BASE, outputs: [GOOD, GOOD, SOURCE] });
  console.log('4. mixed runs:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'FAIL') fail('mixed runs passed with a failing run');

  // 5. A single output (copy fallback) is accepted as one run.
  r = await call({ ...BASE, output: GOOD });
  console.log('5. single output:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'PASS') fail('single good output did not PASS');
  if (r.payload.runs !== 1) fail('single output runs is not 1');

  // 6. A missing source is rejected before verification.
  r = await call({ ...BASE, outputs: [GOOD, GOOD, GOOD], source: undefined });
  console.log('6. no source:', r.status, JSON.stringify(r.payload));
  if (r.status !== 400) fail('missing source was not rejected with 400');

  // 7. A passing structural check still reaches the key gate only when
  // the semantic judge passes — the verdict carries the semantic scores.
  r = await call({ ...BASE, outputs: [GOOD, GOOD, GOOD] });
  if (!r.payload.semantic || r.payload.semantic.passed !== true) fail('passing job has no passing semantic verdict: ' + JSON.stringify(r.payload.semantic));
  if (r.payload.semantic.scores.accuracy !== 92) fail('semantic accuracy is not 92');

  // 8. A structurally perfect but factually wrong median output is
  // refused by the semantic judge before the token/key gates.
  judgeVerdict = { accuracy: 30, relevance: 85, completeness: 80, evidence: 40, unsupported_claims: ['minting costs exactly 100 NEAR'], missing: [], reason: 'The output invents a 100 NEAR fee.' };
  r = await call({ ...BASE, outputs: [GOOD, GOOD, GOOD] });
  console.log('8. judge fails accuracy:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'FAIL') fail('low-accuracy judge did not FAIL the job');
  if (!String(r.payload.error).includes('semantic verification')) fail('low-accuracy refusal does not name semantic verification');
  if (r.payload.semantic.scores.accuracy !== 30) fail('semantic accuracy is not 30');

  // 9. An unusable judge reply fails closed.
  judgeVerdict = { accuracy: 92, relevance: 88, completeness: 85, evidence: 90, unsupported_claims: [], missing: [], reason: 'ok' };
  judgeRaw = 'not json at all';
  r = await call({ ...BASE, outputs: [GOOD, GOOD, GOOD] });
  console.log('9. judge unusable:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'FAIL') fail('unusable judge reply did not FAIL the job');
  if (!String(r.payload.error).includes('semantic verification')) fail('unusable-judge refusal does not name semantic verification');

  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
