// Test api/intents-quote.js with a mocked 1Click API — no real funds,
// no live 1Click calls. The live behaviour (dry quotes, the
// "quoting into NEAR unavailable" error) was verified manually against
// the real API on 2026-11-05; these tests pin the route's logic.
const handler = require('../api/intents-quote');

const TOKENS = [
  { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, blockchain: 'near' },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', symbol: 'USDC', decimals: 6, blockchain: 'eth' },
  { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', symbol: 'USDC', decimals: 6, blockchain: 'arb' },
];

function fail(msg) { console.log('FAIL:', msg); process.exit(1); }

// Mock fetch: tokens list + a quote response chosen by the test.
function mockFetch(quoteResponse, quoteStatus) {
  return async (url, opts) => {
    if (String(url).endsWith('/v0/tokens')) {
      return { ok: true, status: 200, json: async () => TOKENS };
    }
    if (String(url).endsWith('/v0/quote')) {
      return { ok: quoteStatus >= 200 && quoteStatus < 300, status: quoteStatus, json: async () => quoteResponse };
    }
    throw new Error('unexpected fetch: ' + url);
  };
}

async function call(body, fetchImpl) {
  const origFetch = global.fetch;
  global.fetch = fetchImpl;
  let status = 0;
  let payload = null;
  const req = { method: 'POST', body };
  const res = {
    status(code) { status = code; return this; },
    json(obj) { payload = obj; },
  };
  try {
    await handler(req, res);
  } finally {
    global.fetch = origFetch;
  }
  return { status, payload };
}

const BASE = {
  token_id: 'genesis-gen-3',
  originAsset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  amount: '5',
  refundTo: '0x9F3b8528bc2EbD30C49A6E809DE3E90f2C236df2',
};

(async () => {
  delete process.env.INTENTS_FUNDING_ACCOUNT;
  delete process.env.ONECLICK_JWT;

  const GOOD_QUOTE = {
    quote: {
      amountIn: '5000000', amountInFormatted: '5.0', amountInUsd: '4.99',
      amountOut: '1234567890123456789012345', amountOutFormatted: '1.2345',
      amountOutUsd: '4.85', minAmountOut: '1220000000000000000000000',
      timeEstimate: 42, depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8',
      deadline: '2026-11-05T14:30:00Z', timeWhenInactive: '2026-11-05T14:30:00Z',
      refundFee: '300000', withdrawFee: '254171',
    },
    correlationId: 'test-correlation', signature: 'ed25519:test',
  };

  // 1. Dry quote returns the price preview, no deposit address.
  let r = await call({ ...BASE, dry: true }, mockFetch({
    quote: { ...GOOD_QUOTE.quote, depositAddress: undefined, deadline: undefined, timeWhenInactive: undefined },
    correlationId: 'test-correlation', signature: 'ed25519:test',
  }, 201));
  console.log('1. dry quote:', r.status, JSON.stringify(r.payload));
  if (r.status !== 200 || r.payload.ok !== true) fail('dry quote did not succeed');
  if (r.payload.dry !== true) fail('dry quote dry flag is not true');
  if (r.payload.depositAddress) fail('dry quote returned a deposit address');
  if (r.payload.amountOutFormatted !== '1.2345') fail('dry quote amountOut wrong');
  if (r.payload.originSymbol !== 'USDC') fail('dry quote origin symbol wrong');

  // 2. Live quote without a funding account is refused (no 1Click call).
  let fetchCalled = false;
  const countingFetch = async (url) => {
    fetchCalled = true;
    return mockFetch(GOOD_QUOTE, 201)(url);
  };
  r = await call({ ...BASE, dry: false }, countingFetch);
  console.log('2. live quote, no funding account:', r.status, JSON.stringify(r.payload));
  if (r.status !== 400) fail('live quote without funding account was not refused with 400');
  if (!String(r.payload.error).includes('INTENTS_FUNDING_ACCOUNT')) fail('live quote refusal did not name the missing env var');

  // 3. Live quote with a funding account returns the deposit address.
  process.env.INTENTS_FUNDING_ACCOUNT = 'genesis-funding.near';
  r = await call({ ...BASE, dry: false }, mockFetch(GOOD_QUOTE, 201));
  console.log('3. live quote, funding account set:', r.status, JSON.stringify(r.payload));
  if (r.status !== 200 || r.payload.ok !== true) fail('live quote did not succeed');
  if (r.payload.dry !== false) fail('live quote dry flag is not false');
  if (r.payload.depositAddress !== '0x76b4c56085ED136a8744D52bE956396624a730E8') fail('live quote deposit address wrong');
  delete process.env.INTENTS_FUNDING_ACCOUNT;

  // 4. 1Click's "quoting not available" error is passed through, never faked.
  r = await call({ ...BASE, dry: true }, mockFetch(
    { message: 'Quoting for this pair is not available', correlationId: 'abc-123' }, 400));
  console.log('4. quoting unavailable:', r.status, JSON.stringify(r.payload));
  if (r.status !== 200 || r.payload.ok !== false) fail('quoting-unavailable was not reported as ok:false');
  if (!String(r.payload.error).includes('Quoting for this pair is not available')) fail('1Click error was not passed through');
  if (r.payload.correlationId !== 'abc-123') fail('correlation id was not passed through');
  if (r.payload.amountOut) fail('unavailable quote invented an amountOut');

  // 5. Invalid origin asset is rejected before any quote.
  r = await call({ ...BASE, originAsset: 'nep141:not-a-real-asset', dry: true }, mockFetch(GOOD_QUOTE, 201));
  console.log('5. bad origin asset:', r.status, JSON.stringify(r.payload));
  if (r.status !== 400) fail('unknown origin asset was not rejected with 400');

  // 6. wNEAR as origin is rejected (it is the destination).
  r = await call({ ...BASE, originAsset: 'nep141:wrap.near', dry: true }, mockFetch(GOOD_QUOTE, 201));
  console.log('6. wNEAR origin:', r.status, JSON.stringify(r.payload));
  if (r.status !== 400) fail('wNEAR origin was not rejected');

  // 7. Bad amount is rejected.
  r = await call({ ...BASE, amount: 'not-a-number', dry: true }, mockFetch(GOOD_QUOTE, 201));
  console.log('7. bad amount:', r.status, JSON.stringify(r.payload));
  if (r.status !== 400) fail('bad amount was not rejected');
  r = await call({ ...BASE, amount: '0', dry: true }, mockFetch(GOOD_QUOTE, 201));
  if (r.status !== 400) fail('zero amount was not rejected');

  // 8. Bad token id is rejected.
  r = await call({ ...BASE, token_id: 'not a token!', dry: true }, mockFetch(GOOD_QUOTE, 201));
  console.log('8. bad token id:', r.status, JSON.stringify(r.payload));
  if (r.status !== 400) fail('bad token id was not rejected');

  // 9. Token list failure returns 502 (Intents unavailable).
  require('../api/intents-quote')._test.clearTokensCache();
  const failingFetch = async (url) => {
    if (String(url).endsWith('/v0/tokens')) return { ok: false, status: 503, json: async () => ({}) };
    throw new Error('unexpected fetch: ' + url);
  };
  r = await call({ ...BASE, dry: true }, failingFetch);
  console.log('9. token list down:', r.status, JSON.stringify(r.payload));
  if (r.status !== 502) fail('token list failure was not a 502');
  if (!String(r.payload.error).includes('token list')) fail('token list failure did not name the token list');

  // 10. Live quote without a refund address is rejected.
  process.env.INTENTS_FUNDING_ACCOUNT = 'genesis-funding.near';
  r = await call({ ...BASE, dry: false, refundTo: '' }, mockFetch(GOOD_QUOTE, 201));
  console.log('10. live quote, no refund address:', r.status, JSON.stringify(r.payload));
  if (r.status !== 400) fail('live quote without refund address was not rejected');
  delete process.env.INTENTS_FUNDING_ACCOUNT;

  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
