// Test api/pay-job.js verification gates without a treasury key.
// The function verifies first, then checks the token, then the key — so
// with no TREASURY_PRIVATE_KEY set, a passing job answers "treasury key
// missing" with verdict PASS, and a failing job answers FAIL with no
// token lookup and no payment attempt.
const handler = require('../api/pay-job');

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

  // 1. A good original summary passes verification and stops at the key gate.
  let r = await call({ ...BASE, output: GOOD });
  console.log('1. good output:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'PASS') fail('good output did not PASS');
  if (r.payload.gates.coverage.covered !== 3) fail('good output coverage is not 3/3');
  if (!String(r.payload.error).includes('treasury key missing')) fail('good output did not stop at the key gate');

  // 2. A copy of the source text fails the originality gate.
  r = await call({ ...BASE, output: SOURCE });
  console.log('2. copied output:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'FAIL') fail('copied output passed');
  if (r.payload.gates.originality.copiedShare < 0.3) fail('copied output originality gate did not catch it');

  // 3. Keyword stuffing fails the coverage gate.
  r = await call({ ...BASE, output: 'near. nft. mint. near. nft. mint. near. nft. mint. near. nft. mint.' });
  console.log('3. stuffed output:', r.status, JSON.stringify(r.payload));
  if (r.payload.verdict !== 'FAIL') fail('keyword stuffing passed');
  if (r.payload.gates.coverage.covered !== 0) fail('stuffed output coverage is not 0/3');

  // 4. A missing source is rejected before verification.
  r = await call({ ...BASE, output: GOOD, source: undefined });
  console.log('4. no source:', r.status, JSON.stringify(r.payload));
  if (r.status !== 400) fail('missing source was not rejected with 400');

  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
