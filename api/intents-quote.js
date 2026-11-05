// POST /api/intents-quote — server-side NEAR Intents 1Click proxy.
//
// A user funds a Genesis agent's inference budget with any token from
// any chain. This route is the only place that talks to 1Click, so the
// optional partner JWT (ONECLICK_JWT) never reaches the browser.
//
// Two modes, both real 1Click quotes (never faked):
//   dry: true  — price preview only. No deposit address is issued and
//                no funds can move. Safe to call freely.
//   dry: false — live quote. 1Click returns a deposit address and a
//                deadline; the user sends the source tokens to that
//                address from their own wallet, and the solver network
//                settles the swap, delivering wNEAR to the Genesis
//                mainnet funding account.
//
// Honest limits (verified live 2026-11-05):
// - 1Click is MAINNET-ONLY. There is no testnet deployment and no plans
//   for one. The swapped value is mainnet wNEAR and cannot enter the
//   testnet Core escrow. This funds an agent's MAINNET inference
//   budget; testnet jobs still pay testnet NEAR from the escrow.
// - Quoting INTO NEAR-chain assets was unavailable on 2026-11-05:
//   every pair into wNEAR or USDC-on-NEAR (arb/eth/base/sol USDC,
//   eth ETH, sol SOL, 1–100 USDC) returned HTTP 400 "Quoting for this
//   pair is not available", while wNEAR -> USDC and eth USDC -> sol
//   USDC quoted fine (HTTP 201). This route passes 1Click's real
//   answer through — including that error — and never invents a quote.
//   If quoting into NEAR comes back, the widget works with no change.
// - The funding recipient is an env var (INTENTS_FUNDING_ACCOUNT). It
//   defaults to empty, and a live (dry:false) quote is refused until
//   it is set. No mainnet account is hardcoded here.
// - Without a JWT the fee is 0.25% and rate limits are lower; with a
//   JWT (partners.near-intents.org) it is 0.20%. The JWT is optional
//   and server-side only.
//
// The destination asset is always wNEAR (nep141:wrap.near) on NEAR
// mainnet. The origin asset must be one of the assets 1Click lists
// (GET /v0/tokens, cached 10 minutes server-side).
const ONECLICK_BASE = 'https://1click.chaindefuser.com';
const DESTINATION_ASSET = 'nep141:wrap.near';
const TOKENS_CACHE_MS = 10 * 60 * 1000;
const QUOTE_WAIT_MS = 10000;
const SLIPPAGE_BPS = 100; // 1%
const DEADLINE_MINUTES = 30;
// 1Click can hang when solvers are slow (seen live 2026-11-05: the
// quote endpoint stopped answering at all). Fail fast instead of
// hanging the serverless function: Vercel times out first otherwise.
const FETCH_TIMEOUT_MS = 20000;

function fetchWithTimeout(fetchImpl, url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const promise = fetchImpl(url, { ...opts, signal: controller.signal });
  return promise.finally(() => clearTimeout(timer));
}

let tokensCache = null;
let tokensCacheAt = 0;

function fundingAccount() {
  return (process.env.INTENTS_FUNDING_ACCOUNT || '').trim();
}

function oneclickHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const jwt = (process.env.ONECLICK_JWT || '').trim();
  if (jwt) headers['Authorization'] = 'Bearer ' + jwt;
  return headers;
}

// The token list is the source of truth for which origin assets exist
// and their decimals. It is fetched from 1Click and cached in memory
// for 10 minutes; a stale cache is never served after a fetch failure.
async function listTokens(fetchImpl) {
  const now = Date.now();
  if (tokensCache && now - tokensCacheAt < TOKENS_CACHE_MS) return tokensCache;
  const res = await fetchWithTimeout(fetchImpl, ONECLICK_BASE + '/v0/tokens', { method: 'GET' });
  if (!res.ok) throw new Error('1Click token list unavailable (HTTP ' + res.status + ')');
  const tokens = await res.json();
  if (!Array.isArray(tokens)) throw new Error('1Click token list returned an unexpected shape');
  tokensCache = tokens;
  tokensCacheAt = now;
  return tokens;
}

function findToken(tokens, assetId) {
  return tokens.find((t) => t && t.assetId === assetId) || null;
}

// amount is a decimal string in the token's own units (e.g. "5" USDC).
// Returns the integer smallest-unit string, or throws on bad input.
function toBaseUnits(amountStr, decimals) {
  if (typeof amountStr !== 'string' || !/^\d+(\.\d+)?$/.test(amountStr.trim())) {
    throw new Error('amount must be a positive decimal number');
  }
  const [whole, frac = ''] = amountStr.trim().split('.');
  if (frac.length > decimals) throw new Error('amount has more decimals than the token supports');
  const base = BigInt(whole || '0') * 10n ** BigInt(decimals)
    + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (base <= 0n) throw new Error('amount must be greater than zero');
  return base.toString();
}

function isValidAddressFor(chain, address) {
  if (typeof address !== 'string' || !address.trim()) return false;
  const a = address.trim();
  if (chain === 'near') return /^[a-z0-9._-]+\.(near|testnet)$/.test(a) || /^[0-9a-f]{64}$/.test(a);
  if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  // EVM chains and most others in the 1Click list use 0x addresses.
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

async function requestQuote(body, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl, ONECLICK_BASE + '/v0/quote', {
    method: 'POST',
    headers: oneclickHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
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
  const { token_id, originAsset, amount, refundTo, dry } = body || {};

  // --- Input validation (no 1Click call until this passes) ---
  if (typeof token_id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(token_id.trim())) {
    return res.status(400).json({ ok: false, error: 'token_id is required (a Genesis agent token id)' });
  }
  if (typeof originAsset !== 'string' || !originAsset.startsWith('nep141:')) {
    return res.status(400).json({ ok: false, error: 'originAsset is required (a 1Click asset id, e.g. nep141:eth-0xa0b8…omft.near)' });
  }
  if (originAsset === DESTINATION_ASSET) {
    return res.status(400).json({ ok: false, error: 'originAsset must not be wNEAR — pick the token you are sending' });
  }
  const isDry = dry !== false; // default to dry (safe) unless explicitly false
  if (!isDry && !fundingAccount()) {
    return res.status(400).json({
      ok: false,
      error: 'live quotes are not configured yet: the Genesis mainnet funding account (INTENTS_FUNDING_ACCOUNT) is not set. Ask the project owner to set it.',
    });
  }

  const fetchImpl = (global.fetch || require('node-fetch'));
  let tokens;
  try {
    tokens = await listTokens(fetchImpl);
  } catch (e) {
    const msg = String(e && e.name) === 'AbortError'
      ? 'the token list request timed out (1Click is slow right now)'
      : String((e && e.message) || e);
    return res.status(502).json({ ok: false, error: 'NEAR Intents is unavailable right now — ' + msg });
  }
  const origin = findToken(tokens, originAsset);
  if (!origin) {
    return res.status(400).json({ ok: false, error: 'originAsset is not a supported 1Click asset' });
  }
  let amountBase;
  try {
    amountBase = toBaseUnits(String(amount), Number(origin.decimals));
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  // The refund address must be valid for the origin chain. For a dry
  // quote the caller may omit it; for a live quote it is required.
  const refund = typeof refundTo === 'string' ? refundTo.trim() : '';
  if (!isDry && !isValidAddressFor(origin.blockchain, refund)) {
    return res.status(400).json({ ok: false, error: 'refundTo is required for a live quote (your address on the origin chain, for refunds)' });
  }
  const refundAddress = refund || '0x0000000000000000000000000000000000000000';
  const recipient = isDry ? 'genesis-funding.near' : fundingAccount();
  const deadline = new Date(Date.now() + DEADLINE_MINUTES * 60 * 1000).toISOString();

  const quoteBody = {
    dry: isDry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: SLIPPAGE_BPS,
    originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: DESTINATION_ASSET,
    amount: amountBase,
    refundTo: refundAddress,
    refundType: 'ORIGIN_CHAIN',
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline,
    quoteWaitingTimeMs: QUOTE_WAIT_MS,
  };

  let quoteRes;
  try {
    quoteRes = await requestQuote(quoteBody, fetchImpl);
  } catch (e) {
    const msg = String(e && e.name) === 'AbortError'
      ? 'the quote request timed out (1Click solvers are slow right now)'
      : String((e && e.message) || e);
    return res.status(502).json({ ok: false, error: 'NEAR Intents is unavailable right now — ' + msg });
  }
  const { status, data } = quoteRes;
  if (status !== 200 && status !== 201) {
    // Pass 1Click's real answer through — including "Quoting for this
    // pair is not available". Never invent a quote.
    return res.status(200).json({
      ok: false,
      error: 'NEAR Intents could not quote this pair right now: ' + String((data && data.message) || ('HTTP ' + status)),
      oneclick_status: status,
      correlationId: data && data.correlationId,
      token_id: token_id.trim(),
      originAsset,
      destinationAsset: DESTINATION_ASSET,
    });
  }
  const q = data.quote || {};
  return res.status(200).json({
    ok: true,
    dry: isDry,
    token_id: token_id.trim(),
    originAsset,
    originSymbol: origin.symbol,
    originBlockchain: origin.blockchain,
    destinationAsset: DESTINATION_ASSET,
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
    timeEstimateSeconds: q.timeEstimate,
    depositAddress: q.depositAddress || null,
    depositMemo: q.depositMemo || null,
    deadline: q.deadline || deadline,
    timeWhenInactive: q.timeWhenInactive || null,
    refundFee: q.refundFee,
    withdrawFee: q.withdrawFee,
    correlationId: data.correlationId,
    // Save the whole quote client-side for disputes, per the 1Click docs.
    signature: data.signature || null,
    note: isDry
      ? 'Dry quote — price preview only, no deposit address, no funds can move.'
      : 'Live quote — mainnet, real funds. Send exactly amountIn of the origin asset to the deposit address before the deadline. The solver delivers wNEAR to the Genesis funding account.',
  });
};

// Exported for tests.
module.exports._test = {
  toBaseUnits, isValidAddressFor, findToken, DESTINATION_ASSET,
  clearTokensCache() { tokensCache = null; tokensCacheAt = 0; },
};
