// Fastnear facilitator x402 rail for Genesis.
//
// The NEAR-native x402 payment path: the payer signs a NEP-366
// SignedDelegate authorizing an NEP-141 ft_transfer of testnet USDC
// to the treasury, and the fastnear facilitator (testnet instance)
// verifies the delegate and settles it — the relayer sponsors gas
// and the 1 yoctoNEAR deposit. No 1Click, no NEAR Intents: this rail
// works while 1Click's NEAR solvers are down (every NEAR pair
// returns HTTP 400, re-checked 2026-11-06).
//
// Wire contract (fastnear/x402-facilitator docs/openapi.yaml,
// verified live 2026-11-06):
//   GET  /supported — public. x402 v2, scheme exact only.
//   POST /verify    — X-API-Key. Body { x402Version: 2,
//          paymentPayload, paymentRequirements }.
//          paymentPayload = { x402Version: 2,
//            accepted: { scheme, network, asset, amount, payTo,
//                       maxTimeoutSeconds },        // NO
//            // assetTransferMethod — the delegate route requires it
//            // to be omitted on BOTH accepted and requirements.
//            payload: { signedDelegateAction: "<base64 Borsh>" },
//            extensions?: {...} }                   // forwarded
//          paymentRequirements = the same requirements object.
//          200 -> { isValid, invalidReason?, invalidMessage? }.
//   POST /settle    — X-API-Key, same body. Claims the settlement
//          exactly once, reverifies, broadcasts at most once.
//          200 -> { success, transaction, network, payer?,
//                   errorReason?, errorMessage? }.
//          409 = the payment was already settled / the payment
//          identifier was reused with a different payload.
//   Auth: X-API-Key header (an identical Bearer token is also
//   accepted). Without a key /verify answers 401 invalid_api_key.
//
// The API key (env FASTNEAR_API_KEY) is per-instance and manually
// approved by fastnear — see docs/X402.md for the request process.
// Without it the rail FAILS CLOSED with a clear error: the 402
// offer is still served (so clients can see the rail), but
// verification and settlement refuse to run. The key is never
// hardcoded and never logged.
//
// Testnet first: network near:testnet, Circle testnet USDC
// 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af,
// facilitator https://test.x402.mikedotexe.com, relayer
// x402-relayer.mike.testnet. Mainnet (x402.mikedotexe.com, mainnet
// USDC 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1)
// is NOT wired: Genesis is testnet-only until Isaiah gives a
// separate mainnet go-ahead.
const FASTNEAR_TESTNET_URL = 'https://test.x402.mikedotexe.com';
const FASTNEAR_MAINNET_URL = 'https://x402.mikedotexe.com';
const TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const NETWORK = 'near:testnet';
const MAX_TIMEOUT_SECONDS = 1800; // 30 minutes, same as the exact rail
const FETCH_TIMEOUT_MS = 20000;

const API_KEY_ENV = 'FASTNEAR_API_KEY';
const ACCESS_REQUEST_URL = 'https://github.com/fastnear/x402-facilitator/issues/new?template=access_request.yml';

function facilitatorUrl() {
  return FASTNEAR_TESTNET_URL;
}

function facilitatorApiKey() {
  return (process.env[API_KEY_ENV] || '').trim();
}

function isConfigured() {
  return facilitatorApiKey().length > 0;
}

function notConfiguredMessage() {
  return 'fastnear settlement is not configured yet (FASTNEAR_API_KEY is not set) — request access from fastnear: ' + ACCESS_REQUEST_URL + ' (per-instance key, manually approved; see docs/X402.md)';
}

function fetchWithTimeout(fetchImpl, url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const promise = fetchImpl(url, { ...opts, signal: controller.signal });
  return promise.finally(() => clearTimeout(timer));
}

function facilitatorHeaders() {
  return { 'Content-Type': 'application/json', 'X-API-Key': facilitatorApiKey() };
}

// ---------------------------------------------------------------------------
// 402 offer. Sits between the near-intents entries and the exact
// entry in the accepts list (see near-intents-rail buildAccepts).
// The extra carries the facilitator URL so a paying client knows
// which facilitator to present to; it deliberately does NOT carry
// assetTransferMethod — the facilitator rejects ANY supplied value
// on accepted/requirements for the delegate route.
// ---------------------------------------------------------------------------
function fastnearOffer(priceUsdcSmallest, testnetUsdcContract, treasury, description) {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: String(priceUsdcSmallest),
    asset: testnetUsdcContract,
    recipient: treasury,
    payTo: treasury,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    description: description || `Pay ${Number(priceUsdcSmallest) / 1e6} testnet USDC via the fastnear facilitator (NEAR-native x402 — no 1Click, relayer-sponsored gas)`,
    extra: {
      paymentFlow: 'upfront',
      facilitator: FASTNEAR_TESTNET_URL,
    },
  };
}

// Routing check for a presented PAYMENT-SIGNATURE: is this a
// fastnear delegate presentation? The exact rail never presents a
// signature (it takes paymentTx + paymentSender), and the
// near-intents rail presents {type:'quote'|'deposit'} payloads, so a
// payload carrying a signedDelegateAction on near:testnet can only
// be fastnear. Terms (asset / amount / payTo) are enforced by
// verify/settle, not here.
function isFastnearPresentation(presented) {
  if (!presented || typeof presented !== 'object') return false;
  const acc = presented.accepted;
  const payload = presented.payload;
  if (!acc || typeof acc !== 'object' || !payload || typeof payload !== 'object') return false;
  if (acc.scheme !== 'exact' || acc.network !== NETWORK) return false;
  const delegate = payload.signedDelegateAction;
  return typeof delegate === 'string' && delegate.length > 0;
}

// The canonical requirements for one action, built from OUR offer's
// terms — server terms always win over anything the client echoed.
// No `extra`, no `assetTransferMethod`: the facilitator's delegate
// route rejects any supplied value for it.
function canonicalRequirements(accepted) {
  const maxTimeout = Number(accepted.maxTimeoutSeconds);
  return {
    scheme: 'exact',
    network: NETWORK,
    asset: String(accepted.asset),
    amount: String(accepted.amount),
    payTo: String(accepted.payTo),
    maxTimeoutSeconds: Number.isFinite(maxTimeout) && maxTimeout >= 1 ? Math.floor(maxTimeout) : MAX_TIMEOUT_SECONDS,
  };
}

// The exact facilitator request body for /verify and /settle.
// extensions (e.g. payment-identifier) are forwarded when the
// client sent them, so the facilitator's binding checks see the
// same envelope the payer signed.
function buildFacilitatorRequest(accepted, signedDelegateAction, extensions) {
  const requirements = canonicalRequirements(accepted);
  const paymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { signedDelegateAction },
  };
  if (extensions && typeof extensions === 'object' && Object.keys(extensions).length > 0) {
    paymentPayload.extensions = extensions;
  }
  return { x402Version: 2, paymentPayload, paymentRequirements: requirements };
}

function isValidBase64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 16384) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) return false;
  try {
    const decoded = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return decoded.length > 0;
  } catch (_) {
    return false;
  }
}

// Check the presented offer against the server's terms for this
// action. Returns null when it matches, or a rejection otherwise.
function checkPresentedTerms(presented, expected) {
  const acc = presented.accepted;
  if (acc.scheme !== 'exact' || acc.network !== NETWORK) {
    return { kind: 'rejected', reason: 'offer_mismatch', message: 'the presented fastnear offer is not on near:testnet with scheme exact' };
  }
  if (String(acc.asset) !== String(expected.asset)) {
    return { kind: 'rejected', reason: 'offer_mismatch', message: 'the presented fastnear offer names a different asset than this action\'s offer' };
  }
  if (String(acc.amount) !== String(expected.amount)) {
    return { kind: 'rejected', reason: 'offer_mismatch', message: 'the presented fastnear offer has a different amount than this action\'s offer' };
  }
  if (String(acc.payTo) !== String(expected.payTo)) {
    return { kind: 'rejected', reason: 'offer_mismatch', message: 'the presented fastnear offer names a different payee than this action\'s offer' };
  }
  if (!isValidBase64(presented.payload.signedDelegateAction)) {
    return { kind: 'rejected', reason: 'invalid_payload', message: 'signedDelegateAction is not a valid base64 delegate' };
  }
  return null;
}

function facilitatorErrorMessage(status, data, path) {
  const inner = data && data.error;
  const msg = inner && typeof inner === 'object' ? (inner.message || inner.code) : (data && data.message);
  return 'fastnear ' + path + ' failed: HTTP ' + status + (msg ? ' — ' + String(msg).slice(0, 200) : '');
}

async function facilitatorCall(path, body, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl, facilitatorUrl() + path, {
    method: 'POST',
    headers: facilitatorHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// POST /verify. Never broadcasts. Returns
//   {kind:'valid'} |
//   {kind:'rejected', reason, message} |
//   {kind:'not_configured', message}
// expected = { asset, amount, payTo } — the server's terms for
// this action. fetchImpl defaults to global fetch.
async function verifyFastnearPayment({ presented, expected, fetchImpl }) {
  if (!isConfigured()) {
    return { kind: 'not_configured', message: notConfiguredMessage() };
  }
  const mismatch = checkPresentedTerms(presented, expected);
  if (mismatch) return mismatch;
  const body = buildFacilitatorRequest(presented.accepted, presented.payload.signedDelegateAction, presented.extensions);
  let res;
  try {
    res = await facilitatorCall('/verify', body, fetchImpl || global.fetch);
  } catch (e) {
    return { kind: 'rejected', reason: 'facilitator_unavailable', message: 'fastnear facilitator did not answer /verify (' + String((e && e.message) || e).slice(0, 120) + ')' };
  }
  const { status, data } = res;
  if (status === 200 && data && data.isValid === true) return { kind: 'valid' };
  if (status === 200 && data && data.isValid === false) {
    return {
      kind: 'rejected', reason: data.invalidReason || 'invalid_payment',
      message: 'fastnear facilitator rejected the payment' + (data.invalidMessage ? ': ' + String(data.invalidMessage).slice(0, 200) : data.invalidReason ? ' (' + String(data.invalidReason).slice(0, 120) + ')' : ''),
    };
  }
  if (status === 401) {
    return { kind: 'rejected', reason: 'facilitator_unauthorized', message: 'fastnear facilitator rejected the API key (401 invalid_api_key) — the key may be revoked or wrong; request a rotation from fastnear' };
  }
  if (status === 429) {
    return { kind: 'rejected', reason: 'rate_or_budget_limit', message: 'fastnear facilitator rate/budget limit (429)' + (data && data.error && data.error.message ? ': ' + String(data.error.message).slice(0, 200) : ' — the client sponsorship budget may be exhausted') };
  }
  return { kind: 'rejected', reason: 'facilitator_error', message: facilitatorErrorMessage(status, data, '/verify') };
}

// POST /settle. Claims the settlement exactly once, reverifies,
// broadcasts at most once. Returns
//   {kind:'settled', settle, transaction, payer, network} |
//   {kind:'rejected', reason, message} |
//   {kind:'not_configured', message}
// The transaction is the NEAR tx hash of the settled ft_transfer —
// the durable proof, and the dedup key (paymentId
// 'fastnear:<tx hash>').
async function settleFastnearPayment({ presented, expected, fetchImpl }) {
  if (!isConfigured()) {
    return { kind: 'not_configured', message: notConfiguredMessage() };
  }
  const mismatch = checkPresentedTerms(presented, expected);
  if (mismatch) return mismatch;
  const body = buildFacilitatorRequest(presented.accepted, presented.payload.signedDelegateAction, presented.extensions);
  let res;
  try {
    res = await facilitatorCall('/settle', body, fetchImpl || global.fetch);
  } catch (e) {
    return { kind: 'rejected', reason: 'facilitator_unavailable', message: 'fastnear facilitator did not answer /settle (' + String((e && e.message) || e).slice(0, 120) + ')' };
  }
  const { status, data } = res;
  if (status === 200 && data && data.success === true) {
    // A success without a transaction hash cannot be deduped —
    // refuse it rather than minting a paymentId of 'fastnear:'.
    if (!data.transaction) {
      return { kind: 'rejected', reason: 'settlement_failed', message: 'fastnear facilitator reported success with no transaction hash — the settlement cannot be proven, so it was refused' };
    }
    return {
      kind: 'settled',
      settle: data,
      transaction: String(data.transaction || ''),
      payer: String(data.payer || ''),
      network: String(data.network || NETWORK),
    };
  }
  if (status === 200 && data && data.success === false) {
    return {
      kind: 'rejected', reason: data.errorReason || 'settlement_failed',
      message: 'fastnear facilitator did not settle the payment' + (data.errorMessage ? ': ' + String(data.errorMessage).slice(0, 200) : data.errorReason ? ' (' + String(data.errorReason).slice(0, 120) + ')' : ''),
    };
  }
  if (status === 409) {
    return { kind: 'rejected', reason: 'payment_conflict', message: 'fastnear facilitator reports a conflict (409) — this payment was already settled, or the payment identifier was reused with a different payload' };
  }
  if (status === 401) {
    return { kind: 'rejected', reason: 'facilitator_unauthorized', message: 'fastnear facilitator rejected the API key (401 invalid_api_key) — the key may be revoked or wrong; request a rotation from fastnear' };
  }
  if (status === 429) {
    return { kind: 'rejected', reason: 'rate_or_budget_limit', message: 'fastnear facilitator rate/budget limit (429)' + (data && data.error && data.error.message ? ': ' + String(data.error.message).slice(0, 200) : ' — the client sponsorship budget may be exhausted') };
  }
  return { kind: 'rejected', reason: 'facilitator_error', message: facilitatorErrorMessage(status, data, '/settle') };
}

module.exports = {
  FASTNEAR_TESTNET_URL,
  FASTNEAR_MAINNET_URL,
  TESTNET_USDC,
  MAINNET_USDC,
  NETWORK,
  MAX_TIMEOUT_SECONDS,
  API_KEY_ENV,
  ACCESS_REQUEST_URL,
  facilitatorUrl,
  facilitatorApiKey,
  isConfigured,
  fastnearOffer,
  isFastnearPresentation,
  canonicalRequirements,
  buildFacilitatorRequest,
  verifyFastnearPayment,
  settleFastnearPayment,
};
