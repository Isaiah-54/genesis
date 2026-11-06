// Tests for api/fastnear-rail.js — the fastnear facilitator x402
// rail (testnet). Everything is mocked: no facilitator, no RPC, no
// real funds, no chain. Run: node test/fastnear-rail.cjs
//
// Covers: the fastnear accepts entry shape (scheme exact, network
// near:testnet, testnet USDC asset, amount, payTo, facilitator URL
// — and NO assetTransferMethod anywhere), the accepts ordering
// (intents first, fastnear second, exact last), the /verify and
// /settle request construction (x402 v2, canonical requirements,
// signedDelegateAction, forwarded extensions), the response
// handling (valid / invalid / settled / failed / 401 / 409 / 429 /
// unavailable), the fail-closed behaviour without FASTNEAR_API_KEY
// (no fetch is ever made), and the offer-mismatch refusal.
const fastnear = require('../api/fastnear-rail');
const rail = require('../api/near-intents-rail');

const TREASURY = 'genesisdemo354551.testnet';
const USDC = fastnear.TESTNET_USDC;
const DELEGATE_B64 = Buffer.from('fake-signed-delegate-action-bytes').toString('base64');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

function fastnearAccepted(amount) {
  return {
    scheme: 'exact', network: 'near:testnet', amount: String(amount),
    asset: USDC, recipient: TREASURY, payTo: TREASURY, maxTimeoutSeconds: 1800,
  };
}

function fastnearPresented(amount) {
  return {
    x402Version: 2,
    accepted: fastnearAccepted(amount),
    payload: { signedDelegateAction: DELEGATE_B64 },
  };
}

const EXPECTED = { asset: USDC, amount: '50000', payTo: TREASURY };

// Mock facilitator fetch that records every call and answers from
// `mode`: 'valid' | 'invalid' | 'settle-failed' | 'unauthorized' |
// 'conflict' | 'rate-limited' | 'error' | 'throws'.
function capturingFetch(mode) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: opts && opts.headers, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (mode === 'throws') throw new Error('network down');
    if (String(url).endsWith('/verify')) {
      if (mode === 'invalid') return { status: 200, json: async () => ({ isValid: false, invalidReason: 'invalid_signature', invalidMessage: 'the delegate signature did not verify' }) };
      if (mode === 'unauthorized') return { status: 401, json: async () => ({ error: { code: 'invalid_api_key', message: 'missing or invalid API key' } }) };
      if (mode === 'rate-limited') return { status: 429, json: async () => ({ error: { code: 'rate_limited', message: 'too many requests' } }) };
      if (mode === 'error') return { status: 503, json: async () => ({ error: { code: 'unavailable', message: 'facilitator busy' } }) };
      return { status: 200, json: async () => ({ isValid: true }) };
    }
    if (String(url).endsWith('/settle')) {
      if (mode === 'settle-failed') return { status: 200, json: async () => ({ success: false, errorReason: 'settlement_failed', errorMessage: 'relayer could not broadcast', transaction: '', network: 'near:testnet' }) };
      if (mode === 'conflict') return { status: 409, json: async () => ({ error: { code: 'conflict', message: 'already settled' } }) };
      if (mode === 'unauthorized') return { status: 401, json: async () => ({ error: { code: 'invalid_api_key', message: 'missing or invalid API key' } }) };
      if (mode === 'rate-limited') return { status: 429, json: async () => ({ error: { code: 'sponsorship_budget_exhausted', message: 'daily budget exhausted' } }) };
      if (mode === 'error') return { status: 503, json: async () => ({ error: { code: 'unavailable', message: 'facilitator busy' } }) };
      return { status: 200, json: async () => ({ success: true, transaction: 'fastnearTxHash123', network: 'near:testnet', payer: 'payer.testnet' }) };
    }
    throw new Error('unexpected facilitator URL: ' + url);
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  console.log('fastnear rail tests');
  process.env.FASTNEAR_API_KEY = 'test-fastnear-key-do-not-use-live';

  // 1. The accepts entry shape.
  const offer = fastnear.fastnearOffer(50000, USDC, TREASURY);
  check('offer scheme is exact', offer.scheme === 'exact');
  check('offer network is near:testnet', offer.network === 'near:testnet');
  check('offer asset is the testnet USDC contract', offer.asset === USDC);
  check('offer amount is the price in smallest units', offer.amount === '50000');
  check('offer payTo and recipient are the treasury', offer.payTo === TREASURY && offer.recipient === TREASURY);
  check('offer maxTimeoutSeconds is 1800', offer.maxTimeoutSeconds === 1800);
  check('offer names the testnet facilitator URL', offer.extra && offer.extra.facilitator === fastnear.FASTNEAR_TESTNET_URL);
  check('offer carries NO assetTransferMethod anywhere', !JSON.stringify(offer).includes('assetTransferMethod'), JSON.stringify(offer.extra));
  check('offer description names the price', typeof offer.description === 'string' && offer.description.includes('0.05'));

  // 2. Accepts ordering: intents first, fastnear second, exact last.
  const accepts = rail.buildAccepts({
    nearIntentsPriceUsdc: 300000, fastnearPriceUsdc: 50000, exactPriceUsdc: 50000,
    testnetUsdcContract: USDC, treasury: TREASURY, resource: { url: 'https://genesis-roan-eta.vercel.app/api/agent-action?action=mint' },
  });
  check('accepts has 8 entries (6 near-intents + 1 fastnear + 1 exact)', accepts.length === 8, 'got ' + accepts.length);
  check('first 6 entries are near-intents', accepts.slice(0, 6).every((a) => a.extra && a.extra.assetTransferMethod === 'near-intents'));
  check('7th entry is the fastnear rail', accepts[6].network === 'near:testnet' && accepts[6].amount === '50000' && accepts[6].extra && accepts[6].extra.facilitator === fastnear.FASTNEAR_TESTNET_URL, JSON.stringify(accepts[6]));
  check('fastnear entry is priced like the exact rail', accepts[6].amount === accepts[7].amount);
  check('last entry is still the exact rail', accepts[7].network === 'near:testnet' && accepts[7].amount === '50000' && !accepts[7].extra);
  const noFastnear = rail.buildAccepts({
    nearIntentsPriceUsdc: 300000, exactPriceUsdc: 50000,
    testnetUsdcContract: USDC, treasury: TREASURY, resource: { url: 'https://example.com/' },
  });
  check('buildAccepts without a fastnear price still returns 7 (backward compatible)', noFastnear.length === 7, 'got ' + noFastnear.length);

  // 3. Facilitator request construction.
  const reqBody = fastnear.buildFacilitatorRequest(fastnearAccepted(50000), DELEGATE_B64);
  check('request is x402 v2', reqBody.x402Version === 2 && reqBody.paymentPayload.x402Version === 2);
  check('request requirements carry scheme/network/asset/amount/payTo/maxTimeoutSeconds',
    reqBody.paymentRequirements.scheme === 'exact' && reqBody.paymentRequirements.network === 'near:testnet'
    && reqBody.paymentRequirements.asset === USDC && reqBody.paymentRequirements.amount === '50000'
    && reqBody.paymentRequirements.payTo === TREASURY && reqBody.paymentRequirements.maxTimeoutSeconds === 1800);
  check('request requirements carry NO assetTransferMethod and NO extra',
    !('assetTransferMethod' in reqBody.paymentRequirements) && !('extra' in reqBody.paymentRequirements)
    && !('assetTransferMethod' in reqBody.paymentPayload.accepted) && !('extra' in reqBody.paymentPayload.accepted));
  check('request accepted matches requirements exactly',
    JSON.stringify(reqBody.paymentPayload.accepted) === JSON.stringify(reqBody.paymentRequirements));
  check('request payload carries the signed delegate', reqBody.paymentPayload.payload.signedDelegateAction === DELEGATE_B64);
  check('request omits extensions when the client sent none', !('extensions' in reqBody.paymentPayload));
  const withExt = fastnear.buildFacilitatorRequest(fastnearAccepted(50000), DELEGATE_B64, { 'payment-identifier': { info: { required: true, id: 'pay_1234567890123456' }, schema: {} } });
  check('request forwards client extensions when present', withExt.paymentPayload.extensions && withExt.paymentPayload.extensions['payment-identifier'].info.id === 'pay_1234567890123456');

  // 4. Routing: isFastnearPresentation.
  check('valid fastnear payload routes to fastnear', fastnear.isFastnearPresentation(fastnearPresented(50000)) === true);
  const intentsPayload = { x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:42161', asset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', extra: { assetTransferMethod: 'near-intents' } }, payload: { type: 'quote', refundTo: '0x1111111111111111111111111111111111111111' } };
  check('near-intents quote payload does not route to fastnear', fastnear.isFastnearPresentation(intentsPayload) === false);
  check('payload without a delegate does not route to fastnear', fastnear.isFastnearPresentation({ x402Version: 2, accepted: fastnearAccepted(50000), payload: {} }) === false);
  check('delegate on the wrong network does not route to fastnear', fastnear.isFastnearPresentation({ x402Version: 2, accepted: { ...fastnearAccepted(50000), network: 'near:mainnet' }, payload: { signedDelegateAction: DELEGATE_B64 } }) === false);
  check('empty delegate does not route to fastnear', fastnear.isFastnearPresentation({ x402Version: 2, accepted: fastnearAccepted(50000), payload: { signedDelegateAction: '' } }) === false);
  check('garbage is not a fastnear presentation', fastnear.isFastnearPresentation(null) === false && fastnear.isFastnearPresentation({}) === false);

  // 5. /verify request construction + valid response.
  let fetchImpl = capturingFetch('valid');
  let verified = await fastnear.verifyFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('valid delegate verifies', verified.kind === 'valid', JSON.stringify(verified));
  check('verify called the testnet facilitator /verify', fetchImpl.calls.length === 1 && fetchImpl.calls[0].url === fastnear.FASTNEAR_TESTNET_URL + '/verify', JSON.stringify(fetchImpl.calls.map((c) => c.url)));
  check('verify sent the X-API-Key header', fetchImpl.calls[0].headers['X-API-Key'] === 'test-fastnear-key-do-not-use-live');
  check('verify body is the x402 v2 facilitator request', fetchImpl.calls[0].body.x402Version === 2 && fetchImpl.calls[0].body.paymentPayload.payload.signedDelegateAction === DELEGATE_B64 && fetchImpl.calls[0].body.paymentRequirements.amount === '50000');

  // 6. /verify invalid response.
  fetchImpl = capturingFetch('invalid');
  verified = await fastnear.verifyFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('invalid delegate is rejected with the facilitator reason', verified.kind === 'rejected' && verified.reason === 'invalid_signature' && String(verified.message).includes('did not verify'), JSON.stringify(verified));

  // 7. /settle request construction + settled response.
  fetchImpl = capturingFetch('valid');
  const settled = await fastnear.settleFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('settled delegate returns the tx hash and payer', settled.kind === 'settled' && settled.transaction === 'fastnearTxHash123' && settled.payer === 'payer.testnet' && settled.network === 'near:testnet', JSON.stringify(settled));
  check('settle called the testnet facilitator /settle with the same body shape', fetchImpl.calls.length === 1 && fetchImpl.calls[0].url === fastnear.FASTNEAR_TESTNET_URL + '/settle' && fetchImpl.calls[0].body.paymentPayload.payload.signedDelegateAction === DELEGATE_B64);
  check('settle sent the X-API-Key header', fetchImpl.calls[0].headers['X-API-Key'] === 'test-fastnear-key-do-not-use-live');

  // 8. /settle failure modes.
  fetchImpl = capturingFetch('settle-failed');
  let s2 = await fastnear.settleFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('failed settlement is rejected with the facilitator reason', s2.kind === 'rejected' && s2.reason === 'settlement_failed' && String(s2.message).includes('could not broadcast'), JSON.stringify(s2));
  fetchImpl = capturingFetch('conflict');
  s2 = await fastnear.settleFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('409 conflict is rejected as payment_conflict', s2.kind === 'rejected' && s2.reason === 'payment_conflict', JSON.stringify(s2));
  fetchImpl = capturingFetch('rate-limited');
  s2 = await fastnear.settleFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('429 is rejected as rate_or_budget_limit', s2.kind === 'rejected' && s2.reason === 'rate_or_budget_limit', JSON.stringify(s2));
  fetchImpl = capturingFetch('unauthorized');
  const v2 = await fastnear.verifyFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('401 is rejected as facilitator_unauthorized', v2.kind === 'rejected' && v2.reason === 'facilitator_unauthorized', JSON.stringify(v2));
  fetchImpl = capturingFetch('error');
  const v3 = await fastnear.verifyFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('503 is rejected as facilitator_error', v3.kind === 'rejected' && v3.reason === 'facilitator_error', JSON.stringify(v3));
  fetchImpl = capturingFetch('throws');
  const v4 = await fastnear.verifyFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('facilitator timeout/network failure is rejected as facilitator_unavailable', v4.kind === 'rejected' && v4.reason === 'facilitator_unavailable', JSON.stringify(v4));

  // 9. Offer mismatch: server terms win, no fetch is made.
  fetchImpl = capturingFetch('valid');
  const wrongAmount = await fastnear.verifyFastnearPayment({ presented: fastnearPresented(99999), expected: EXPECTED, fetchImpl });
  check('wrong amount is refused before any facilitator call', wrongAmount.kind === 'rejected' && wrongAmount.reason === 'offer_mismatch' && fetchImpl.calls.length === 0, JSON.stringify(wrongAmount));
  const wrongAsset = await fastnear.verifyFastnearPayment({ presented: { x402Version: 2, accepted: { ...fastnearAccepted(50000), asset: 'other.testnet' }, payload: { signedDelegateAction: DELEGATE_B64 } }, expected: EXPECTED, fetchImpl });
  check('wrong asset is refused before any facilitator call', wrongAsset.kind === 'rejected' && wrongAsset.reason === 'offer_mismatch' && fetchImpl.calls.length === 0, JSON.stringify(wrongAsset));
  const wrongPayee = await fastnear.verifyFastnearPayment({ presented: { x402Version: 2, accepted: { ...fastnearAccepted(50000), payTo: 'someone-else.testnet' }, payload: { signedDelegateAction: DELEGATE_B64 } }, expected: EXPECTED, fetchImpl });
  check('wrong payee is refused before any facilitator call', wrongPayee.kind === 'rejected' && wrongPayee.reason === 'offer_mismatch' && fetchImpl.calls.length === 0, JSON.stringify(wrongPayee));

  // 10. Fail closed without FASTNEAR_API_KEY: no fetch is ever made.
  delete process.env.FASTNEAR_API_KEY;
  fetchImpl = capturingFetch('valid');
  const noKeyVerify = await fastnear.verifyFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('verify without a key fails closed as not_configured', noKeyVerify.kind === 'not_configured' && String(noKeyVerify.message).includes('FASTNEAR_API_KEY'), JSON.stringify(noKeyVerify));
  check('verify without a key makes no facilitator call', fetchImpl.calls.length === 0);
  const noKeySettle = await fastnear.settleFastnearPayment({ presented: fastnearPresented(50000), expected: EXPECTED, fetchImpl });
  check('settle without a key fails closed as not_configured', noKeySettle.kind === 'not_configured' && String(noKeySettle.message).includes('FASTNEAR_API_KEY'), JSON.stringify(noKeySettle));
  check('settle without a key makes no facilitator call', fetchImpl.calls.length === 0);
  check('isConfigured is false without the key', fastnear.isConfigured() === false);
  process.env.FASTNEAR_API_KEY = 'test-fastnear-key-do-not-use-live';
  check('isConfigured is true with the key', fastnear.isConfigured() === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
