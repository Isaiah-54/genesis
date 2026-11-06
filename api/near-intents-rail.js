// Shared near-intents x402 rail for Genesis.
//
// This module is the ONLY place that knows the NEAR Intents 1Click API
// and the near-intents x402 wire shape (same split as Penstock's
// packages/intents-adapter). It is used by both /api/agent-action
// (mint / breed / evolve / buy) and /api/agent-premium (premium CV).
//
// The rail follows Penstock's pattern (ace-coderr/penstock), adapted to
// Genesis (Vercel serverless, no facilitator key, testnet actions):
//
//   1. The 402 offers TWO rails. near-intents is PRIMARY (first in
//      `accepts`): one `exact` entry per origin asset, with
//      extra.assetTransferMethod 'near-intents' and paymentFlow
//      'upfront'. The exact rail (testnet USDC, self-facilitated) is
//      SECONDARY (last entry), for payers who already hold USDC on
//      NEAR — so transactions can still complete while 1Click's NEAR
//      solvers are down.
//   2. near-intents is a 2-step dance (Penstock's method.ts):
//        a. quote: the client sends PAYMENT-SIGNATURE
//           {type:'quote', refundTo} -> the server asks 1Click for an
//           EXACT_OUTPUT quote (deliver the action price as USDC on
//           NEAR to the funding account), VERIFIES the quote's ed25519
//           signature (mirroring the official 1Click SDK check, with
//           node:crypto only), then answers with a second 402 whose
//           quoted entry has payTo = the single-use deposit address,
//           amount = amountIn, refundDeadline, and an HMAC operation
//           token bound to deposit + resource + destination + expiry.
//        b. deposit: the payer deposits on the origin chain, then
//           sends PAYMENT-SIGNATURE {type:'deposit', operationToken,
//           depositAddress, txHash} -> the server verifies the token
//           (constant-time), polls GET /v0/status until SUCCESS /
//           REFUNDED / FAILED, marks the operation executed exactly
//           once, and only then lets the caller run the paid action.
//   3. Signed receipts (ed25519, canonical JSON, Penstock-style):
//      every settled payment gets a receipt {body, sig, pub} that
//      anyone can verify with verifyReceipt() — no server needed.
//   4. Server terms always come from the server's own offers: a
//      presented `accepted` entry is only used to pick one of them; a
//      tampered price, payee or asset is refused.
//
// Modes (never mixed; simulated data is always labelled simulated):
//   live — real 1Click live quotes (deposit address issued) and live
//          status polling. Mainnet, real funds.
//   dry  — real 1Click DRY quotes (price preview, no deposit address,
//          no funds can move). The exact rail still verifies for real.
//   demo — everything simulated, no network: canned quotes, canned
//          status, simulated action results with `sim:` tx hashes.
//
// Honest limits (verified live 2026-11-05):
// - 1Click is MAINNET-ONLY and has no testnet. The near-intents rail
//   settles in MAINNET USDC to the funding account; the Genesis actions
//   themselves execute on NEAR TESTNET (the treasury covers the testnet
//   NEAR costs). The mainnet USDC is the payment for the action; the
//   testnet NEAR is the cost of executing it.
// - Quoting into AND out of NEAR is DOWN as of 2026-11-05 16:08 WAT:
//   every NEAR pair returns HTTP 400 'Quoting for this pair is not
//   available'. A live near-intents swap CANNOT complete until the
//   NEAR solvers return. This rail passes 1Click's real error through
//   and never invents a quote; dry mode still proves the flow.
// - 1Click route minimums: a payment below the origin route's minimum
//   is refused by 1Click ('Amount is too low for bridge'). The
//   near-intents prices are set above the highest offered route
//   minimum (Ethereum USDC ~0.30 USDC) so quotes usually clear.
// - Exactly-once is enforced per serverless instance (in-memory set)
//   plus a best-effort payments log. Vercel's filesystem is read-only,
//   so a replay across cold instances is NOT blocked by this code —
//   the durable proof is the 1Click deposit instrument (one deposit
//   address settles once) and the onchain action. A shared store is
//   the production path; this is documented, not hidden.
// - The operation-token secret (OPERATION_TOKEN_SECRET) must be set in
//   Vercel env for live near-intents settlement. Without it the rail
//   refuses to mint tokens (and therefore refuses live settlement)
//   with a clear error instead of silently using a weak secret. Demo
//   mode uses an in-memory secret and labels everything simulated.
// - Quote signatures depend on the one published 1Click manager key.
//   If 1Click rotates it, quotes fail closed (no payment proceeds)
//   until the key is updated here.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fastnearRail = require('./fastnear-rail');

const ONECLICK_BASE = 'https://1click.chaindefuser.com';
const FETCH_TIMEOUT_MS = 20000;
const QUOTE_WAIT_MS = 10000;
const SLIPPAGE_BPS = 100; // 1%
const DEADLINE_MINUTES = 30;
const GRACE_SEC = 24 * 3600; // operation tokens stay valid a day past the quote deadline
const SETTLE_WINDOW_MS = 25000; // bounded status polling per settle call
const POLL_INTERVAL_MS = 2000;

// The 1Click manager key, from the official TypeScript SDK (0.1.26),
// via Penstock's packages/intents-adapter/src/quote-signature.ts.
const ONE_CLICK_MANAGER_PUB_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

// USDC on NEAR mainnet — the destination of every near-intents payment.
// Contract 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1.
const DESTINATION_ASSET = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const DESTINATION_NETWORK = 'near:mainnet';
const DESTINATION_DECIMALS = 6;

// Origin assets offered on the near-intents rail. oneClickAssetId values
// are from the live 1Click GET /v0/tokens list (verified 2026-11-05);
// x402Asset is the identifier used in x402 accepts[].asset (Penstock's
// convention: the token contract/mint for tokens, slip44:<coin> for
// native coins). routeMinimumUsdc is the smallest USDC 1Click would
// deliver from that chain, observed by Penstock 2026-11-01 — real
// values move with gas; live quotes read them from 1Click errors.
const ORIGINS = [
  {
    key: 'eth', caip2: 'eip155:1', label: 'Ethereum', symbol: 'USDC', decimals: 6,
    x402Asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    oneClickAssetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    addressPattern: /^0x[0-9a-fA-F]{40}$/, depositWindowSec: 900, routeMinimumUsdc: 0.30,
  },
  {
    key: 'arb', caip2: 'eip155:42161', label: 'Arbitrum', symbol: 'USDC', decimals: 6,
    x402Asset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    oneClickAssetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    addressPattern: /^0x[0-9a-fA-F]{40}$/, depositWindowSec: 300, routeMinimumUsdc: 0.0053,
  },
  {
    key: 'base', caip2: 'eip155:8453', label: 'Base', symbol: 'USDC', decimals: 6,
    x402Asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    oneClickAssetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    addressPattern: /^0x[0-9a-fA-F]{40}$/, depositWindowSec: 300, routeMinimumUsdc: 0.15,
  },
  {
    key: 'sol', caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', label: 'Solana', symbol: 'USDC', decimals: 6,
    x402Asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    oneClickAssetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, depositWindowSec: 300, routeMinimumUsdc: 0.094,
  },
  {
    key: 'eth', caip2: 'eip155:1', label: 'Ethereum', symbol: 'ETH', decimals: 18,
    x402Asset: 'slip44:60',
    oneClickAssetId: 'nep141:eth.omft.near',
    addressPattern: /^0x[0-9a-fA-F]{40}$/, depositWindowSec: 900, routeMinimumUsdc: 0.30,
  },
  {
    key: 'sol', caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', label: 'Solana', symbol: 'SOL', decimals: 9,
    x402Asset: 'slip44:501',
    oneClickAssetId: 'nep141:sol.omft.near',
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, depositWindowSec: 300, routeMinimumUsdc: 0.094,
  },
];

const TERMINAL_STATUSES = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);

function fetchWithTimeout(fetchImpl, url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const promise = fetchImpl(url, { ...opts, signal: controller.signal });
  return promise.finally(() => clearTimeout(timer));
}

function fundingAccount() {
  return (process.env.INTENTS_FUNDING_ACCOUNT || '').trim();
}

function oneclickHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const jwt = (process.env.ONECLICK_JWT || '').trim();
  if (jwt) headers['Authorization'] = 'Bearer ' + jwt;
  return headers;
}

function findOrigin(network, asset) {
  const a = String(asset || '').toLowerCase();
  return ORIGINS.find((o) => o.caip2 === network && (o.x402Asset.toLowerCase() === a || o.symbol.toLowerCase() === a)) || null;
}

function isValidAddressFor(origin, address) {
  return typeof address === 'string' && origin.addressPattern.test(address.trim());
}

// ---------------------------------------------------------------------------
// base58 (for quote signatures and tx hashes)
// ---------------------------------------------------------------------------
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------------------
// 1Click quote signature verification (port of Penstock's
// quote-signature.ts, which mirrors verifyQuoteSignature() in
// @defuse-protocol/one-click-sdk-typescript 0.1.26, with node:crypto).
//   message = base58(sha256(stableStringify({...signedRequestFields,
//             ...signedQuoteFields, timestamp})))
//   valid   = ed25519.verify(utf8(message), base58(signature),
//             ONE_CLICK_MANAGER_PUB_KEY)
// ---------------------------------------------------------------------------
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',') + ']';
  const o = v;
  const parts = Object.keys(o).sort().filter((k) => o[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + stableStringify(o[k]));
  return '{' + parts.join(',') + '}';
}

const orUndef = (x) => (x ? x : undefined);

function quoteHash(r) {
  const q = r.quoteRequest || {};
  const request = {
    dry: q.dry, swapType: q.swapType, slippageTolerance: q.slippageTolerance, originAsset: q.originAsset,
    depositType: q.depositType, destinationAsset: q.destinationAsset, amount: q.amount, refundTo: q.refundTo,
    refundType: q.refundType, recipient: q.recipient, recipientType: q.recipientType, deadline: q.deadline,
    quoteWaitingTimeMs: orUndef(q.quoteWaitingTimeMs), referral: orUndef(q.referral),
    virtualChainRecipient: orUndef(q.virtualChainRecipient), virtualChainRefundRecipient: orUndef(q.virtualChainRefundRecipient),
    customRecipientMsg: orUndef(q.customRecipientMsg),
  };
  const a = r.quote || {};
  const amounts = {
    amountIn: a.amountIn, amountInFormatted: a.amountInFormatted, amountInUsd: a.amountInUsd, minAmountIn: a.minAmountIn,
    amountOut: a.amountOut, amountOutFormatted: a.amountOutFormatted, amountOutUsd: a.amountOutUsd, minAmountOut: a.minAmountOut,
  };
  const quote = q.dry ? amounts : {
    ...amounts,
    depositAddress: orUndef(a.depositAddress), depositMemo: orUndef(a.depositMemo), deadline: orUndef(a.deadline),
    timeWhenInactive: orUndef(a.timeWhenInactive), timeEstimate: orUndef(a.timeEstimate), refundFee: orUndef(a.refundFee),
    withdrawFee: orUndef(a.withdrawFee),
  };
  const digest = crypto.createHash('sha256').update(stableStringify({ ...request, ...quote, timestamp: r.timestamp }), 'utf8').digest();
  return base58Encode(digest);
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeKey(v) {
  return base58Decode(v.startsWith('ed25519:') ? v.slice('ed25519:'.length) : v);
}

// True when the quote carries a valid 1Click signature. Never throws.
// The manager key is overridable in tests only (a test keypair can
// sign a fake quote); in production it is always the published 1Click
// manager key above.
let managerKeyOverride = null;
function verifyQuoteSignature(r, managerPublicKey) {
  try {
    if (!r || typeof r.signature !== 'string' || !r.signature) return false;
    const raw = decodeKey(managerPublicKey || managerKeyOverride || ONE_CLICK_MANAGER_PUB_KEY);
    const sig = decodeKey(r.signature);
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(quoteHash(r), 'utf8'), key, Buffer.from(sig));
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HMAC operation tokens (port of Penstock's token.ts, following the
// near-intents draft section 'Operation Token'):
//   token = <keyId>.<expiry>.<mac>
//   mac = unpadded base64url HMAC-SHA256(key,
//         network:depositAddress[:depositMemo]:resource:destinationHash:expiry)
//   destinationHash = lowercase hex SHA-256 of network:asset:amount:recipient
// Stateless: the server recomputes the MAC at settlement; no lookup.
// ---------------------------------------------------------------------------
function destinationHash(d) {
  return crypto.createHash('sha256').update(`${d.network}:${d.asset}:${d.amount}:${d.recipient}`).digest('hex');
}

function macInput(t, expiry) {
  const memo = t.depositMemo ? `:${t.depositMemo}` : '';
  return `${t.network}:${t.depositAddress}${memo}:${t.resource}:${destinationHash(t.destination)}:${expiry}`;
}

function operationKeyRing() {
  const secret = (process.env.OPERATION_TOKEN_SECRET || '').trim();
  if (!secret) return null;
  return { currentKeyId: 'v1', keys: new Map([['v1', Buffer.from(secret, 'utf8')]]) };
}

// In demo mode (and only there) an in-memory secret is used so the
// simulated flow can be exercised end to end. It is labelled simulated
// everywhere and never used for a live settlement.
let demoKeyRing = null;
function demoRing() {
  if (!demoKeyRing) {
    demoKeyRing = { currentKeyId: 'demo', keys: new Map([['demo', crypto.randomBytes(32)]]) };
  }
  return demoKeyRing;
}

function mintOperationToken(ring, input, expiry) {
  const key = ring.keys.get(ring.currentKeyId);
  if (!key) throw new Error('current operation-token key is missing');
  if (ring.currentKeyId.includes('.')) throw new Error('keyId must not contain .');
  const mac = crypto.createHmac('sha256', key).update(macInput(input, expiry)).digest('base64url');
  return `${ring.currentKeyId}.${expiry}.${mac}`;
}

function verifyOperationToken(ring, token, input, nowSec) {
  if (typeof token !== 'string' || token.length > 256) return { ok: false, reason: 'invalid_exact_near_intents_token_invalid' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'invalid_exact_near_intents_token_invalid' };
  const [keyId, expiryRaw, mac] = parts;
  if (!/^\d{1,12}$/.test(expiryRaw)) return { ok: false, reason: 'invalid_exact_near_intents_token_invalid' };
  const expiry = Number(expiryRaw);
  if (expiry < nowSec) return { ok: false, reason: 'invalid_exact_near_intents_token_expired' };
  const key = ring.keys.get(keyId);
  if (!key) return { ok: false, reason: 'invalid_exact_near_intents_token_invalid' };
  const expected = Buffer.from(crypto.createHmac('sha256', key).update(macInput(input, expiry)).digest('base64url'));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'invalid_exact_near_intents_token_invalid' };
  }
  return { ok: true, expiry };
}

// ---------------------------------------------------------------------------
// ed25519 signed receipts (Penstock-style). The receipt body is canonical
// JSON (stableStringify); sig is base64, pub is the base64 SPKI DER of
// the signing key. verifyReceipt() needs no server: anyone can check a
// receipt against its own pub field.
// The signing key comes from env RECEIPT_SIGNING_KEY (base64 of the
// 32-byte ed25519 seed). Without it a random per-process key is used
// and the receipt still verifies against its own pub — but a verifier
// cannot know the key is the project's, so the receipt is only as
// trustworthy as the server that issued it. Set the env var for
// production use.
// ---------------------------------------------------------------------------
let receiptKeyPair = null;
function receiptKey() {
  if (receiptKeyPair) return receiptKeyPair;
  const seedB64 = (process.env.RECEIPT_SIGNING_KEY || '').trim();
  if (seedB64) {
    const seed = Buffer.from(seedB64, 'base64');
    if (seed.length === 32) {
      const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
      receiptKeyPair = { privateKey: priv, publicKey: crypto.createPublicKey(priv), fromEnv: true };
      return receiptKeyPair;
    }
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  receiptKeyPair = { privateKey, publicKey, fromEnv: false };
  return receiptKeyPair;
}

function signReceipt(body) {
  const { privateKey, publicKey, fromEnv } = receiptKey();
  const canonical = stableStringify(body);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey);
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { body, sig: sig.toString('base64'), pub, keyFromEnv: fromEnv };
}

function verifyReceipt(receipt) {
  try {
    if (!receipt || !receipt.body || !receipt.sig || !receipt.pub) return false;
    const pub = crypto.createPublicKey({ key: Buffer.from(receipt.pub, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(stableStringify(receipt.body), 'utf8'), pub, Buffer.from(receipt.sig, 'base64'));
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 402 offers. near-intents entries come FIRST (primary rail); the
// fastnear entry is SECOND (NEAR-native x402, works while 1Click's
// NEAR solvers are down); the exact entry is LAST (secondary rail).
// Every entry carries the same object in the header and in the JSON
// body, so header truncation cannot hide it.
// ---------------------------------------------------------------------------
function nearIntentsOffers(priceUsdcSmallest, resource) {
  return ORIGINS.map((o) => ({
    scheme: 'exact',
    network: o.caip2,
    amount: '',
    asset: o.x402Asset,
    payTo: '',
    maxTimeoutSeconds: o.depositWindowSec,
    description: `Pay ${priceUsdcSmallest / 1e6} USDC from ${o.label} ${o.symbol} via NEAR Intents (primary rail)`,
    extra: {
      assetTransferMethod: 'near-intents',
      paymentFlow: 'upfront',
      originSymbol: o.symbol,
      originChain: o.key,
      routeMinimumUsdc: o.routeMinimumUsdc,
      destination: { network: DESTINATION_NETWORK, asset: DESTINATION_ASSET, amount: String(priceUsdcSmallest), recipient: fundingAccount() || 'genesis-funding.near' },
    },
  }));
}

function exactOffer(priceUsdcSmallest, testnetUsdcContract, treasury, description) {
  return {
    scheme: 'exact',
    network: 'near:testnet',
    amount: String(priceUsdcSmallest),
    asset: testnetUsdcContract,
    recipient: treasury,
    payTo: treasury,
    maxTimeoutSeconds: 1800,
    description: description || `Pay ${priceUsdcSmallest / 1e6} testnet USDC to the treasury (secondary rail — works while 1Click NEAR solvers are down)`,
  };
}

// Full accepts list for an action: near-intents first, fastnear
// second, exact last. fastnearPriceUsdc is optional — when omitted
// no fastnear entry is offered (the rail is then unavailable for
// that action); both handlers pass it.
function buildAccepts({ nearIntentsPriceUsdc, fastnearPriceUsdc, exactPriceUsdc, testnetUsdcContract, treasury, resource, exactDescription, fastnearDescription }) {
  const fastnear = fastnearPriceUsdc != null
    ? [fastnearRail.fastnearOffer(fastnearPriceUsdc, testnetUsdcContract, treasury, fastnearDescription)]
    : [];
  return [
    ...nearIntentsOffers(nearIntentsPriceUsdc, resource),
    ...fastnear,
    exactOffer(exactPriceUsdc, testnetUsdcContract, treasury, exactDescription),
  ];
}

function paymentRequiredObject({ resource, accepts, error }) {
  return { x402Version: 2, ...(error ? { error } : {}), resource, accepts };
}

// ---------------------------------------------------------------------------
// 1Click client (live + dry). Every call has the 20s timeout; a hung
// 1Click fails fast with a clear error instead of hanging the function.
// ---------------------------------------------------------------------------
async function oneclickQuote(body, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl, ONECLICK_BASE + '/v0/quote', {
    method: 'POST',
    headers: oneclickHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function oneclickStatus(depositAddress, depositMemo, fetchImpl) {
  let url = ONECLICK_BASE + '/v0/status?depositAddress=' + encodeURIComponent(depositAddress);
  if (depositMemo) url += '&depositMemo=' + encodeURIComponent(depositMemo);
  const res = await fetchWithTimeout(fetchImpl, url, { method: 'GET', headers: oneclickHeaders() });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function parseRouteMinimum(message) {
  if (typeof message !== 'string') return null;
  const m = message.match(/at least\s+([0-9.]+)/i) || message.match(/minimum[^0-9]*([0-9.]+)/i);
  return m ? Number(m[1]) : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// near-intents quote step: {type:'quote', refundTo} (+ optional
// slippageTolerance). Returns {kind:'quoted', quoted, ...} on success or
// {kind:'rejected', reason, message} — the caller turns those into the
// second 402 or an error 402. The quoted entry REPLACES the unquoted
// entry for that origin in the accepts list (Penstock's pattern).
// ---------------------------------------------------------------------------
async function quoteForAction({ origin, priceUsdcSmallest, resource, refundTo, slippageTolerance, mode, fetchImpl, now }) {
  const chain = origin;
  if (!isValidAddressFor(chain, refundTo)) {
    return { kind: 'rejected', reason: 'invalid_payload', message: `refundTo must be a valid ${chain.label} address` };
  }
  const recipient = mode === 'live' ? fundingAccount() : (fundingAccount() || 'genesis-funding.near');
  if (mode === 'live' && !recipient) {
    return { kind: 'rejected', reason: 'not_configured', message: 'live near-intents quotes need INTENTS_FUNDING_ACCOUNT set (the Genesis mainnet funding account does not exist yet)' };
  }
  const deadlineMs = now + chain.depositWindowSec * 1000;
  const slippage = Math.min(500, Math.max(10, Number.isFinite(slippageTolerance) ? Math.round(slippageTolerance) : SLIPPAGE_BPS));
  const qreq = {
    dry: mode !== 'live',
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: slippage,
    originAsset: chain.oneClickAssetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: DESTINATION_ASSET,
    amount: String(priceUsdcSmallest),
    refundTo: refundTo.trim(),
    refundType: 'ORIGIN_CHAIN',
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(deadlineMs).toISOString(),
    quoteWaitingTimeMs: QUOTE_WAIT_MS,
  };
  let quoteRes;
  try {
    quoteRes = await oneclickQuote(qreq, fetchImpl);
  } catch (e) {
    const msg = String(e && e.name) === 'AbortError' ? 'the quote request timed out (1Click solvers are slow right now)' : String((e && e.message) || e);
    return { kind: 'rejected', reason: 'oneclick_unavailable', message: msg };
  }
  const { status, data } = quoteRes;
  if (status !== 200 && status !== 201) {
    // Pass 1Click's real answer through — including 'Quoting for this
    // pair is not available'. Never invent a quote.
    const msg = String((data && data.message) || ('HTTP ' + status));
    const min = parseRouteMinimum(msg);
    if (min !== null) {
      return { kind: 'rejected', reason: 'below_route_minimum', message: `below the ${chain.label} route minimum of ${min} USDC — pay from another chain, fund a larger amount, or use the exact rail (testnet USDC)` };
    }
    return { kind: 'rejected', reason: 'quote_unavailable', message: 'NEAR Intents could not quote this pair right now: ' + msg, oneclickStatus: status, correlationId: data && data.correlationId };
  }
  // The echoed request must carry our destination terms; anything else
  // is not our quote.
  const echo = data.quoteRequest || {};
  if (echo.recipient !== recipient || echo.destinationAsset !== DESTINATION_ASSET || echo.amount !== String(priceUsdcSmallest) || echo.swapType !== 'EXACT_OUTPUT') {
    return { kind: 'rejected', reason: 'quote_mismatch', message: '1Click quote does not match the destination terms' };
  }
  // Verify the quote's ed25519 signature BEFORE using its deposit
  // address. A quote that fails this check is refused outright.
  if (!verifyQuoteSignature(data)) {
    return { kind: 'rejected', reason: 'quote_signature_invalid', message: '1Click quote signature did not verify — the quote was refused' };
  }
  const q = data.quote || {};
  const depositAddress = q.depositAddress;
  if (mode === 'live' && !depositAddress) {
    return { kind: 'rejected', reason: 'quote_unavailable', message: '1Click returned a live quote with no deposit address' };
  }
  const ring = mode === 'demo' ? demoRing() : operationKeyRing();
  if (mode === 'live' && !ring) {
    return { kind: 'rejected', reason: 'not_configured', message: 'near-intents settlement is not configured yet (OPERATION_TOKEN_SECRET is not set) — the quote was not issued' };
  }
  const destination = { network: DESTINATION_NETWORK, asset: DESTINATION_ASSET, amount: String(priceUsdcSmallest), recipient };
  const expiry = Math.floor(deadlineMs / 1000) + GRACE_SEC;
  const operationToken = ring ? mintOperationToken(ring, { network: chain.caip2, depositAddress: depositAddress || 'dry-no-deposit', depositMemo: q.depositMemo, resource, destination }, expiry) : null;
  const quoted = {
    scheme: 'exact',
    network: chain.caip2,
    amount: q.amountIn || '',
    asset: chain.x402Asset,
    payTo: depositAddress || '',
    maxTimeoutSeconds: chain.depositWindowSec,
    description: `Pay ${q.amountInFormatted || q.amountIn || '?'} ${chain.symbol} via NEAR Intents to receive ${priceUsdcSmallest / 1e6} USDC on NEAR`,
    extra: {
      assetTransferMethod: 'near-intents',
      paymentFlow: 'upfront',
      originSymbol: chain.symbol,
      originChain: chain.key,
      destination,
      refundDeadline: new Date(deadlineMs).toISOString(),
      operationToken,
      ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
      amountInUsd: q.amountInUsd,
      amountOutUsd: q.amountOutUsd,
      timeEstimateSeconds: q.timeEstimate,
      simulated: mode === 'demo',
    },
  };
  return {
    kind: 'quoted', quoted, buyerChain: chain.key, depositAddress: depositAddress || null,
    amountIn: q.amountIn || null, amountInUsd: q.amountInUsd || null, simulated: mode === 'demo',
    quote: { correlationId: data.correlationId, signatureVerified: true },
  };
}

// ---------------------------------------------------------------------------
// near-intents settle step: {type:'deposit', operationToken,
// depositAddress, depositMemo?, txHash}. Verifies the token, then polls
// 1Click status (bounded) until a terminal state. Returns
//   {kind:'settled', settle, fields} | {kind:'pending', settle} |
//   {kind:'rejected', reason, message, refund?}
// The caller marks the operation executed exactly once on 'settled'.
// ---------------------------------------------------------------------------
async function settleDeposit({ origin, operationToken, depositAddress, depositMemo, txHash, resource, priceUsdcSmallest, mode, fetchImpl, now }) {
  const chain = origin;
  const txOk = /^[0-9a-zA-Z]{16,128}$/.test(String(txHash || '').replace(/^0x/, ''));
  if (!depositAddress || depositAddress.length > 128 || !txOk) {
    return { kind: 'rejected', reason: 'invalid_payload', message: 'deposit payload needs operationToken, depositAddress and a well-formed txHash' };
  }
  const recipient = mode === 'live' ? fundingAccount() : (fundingAccount() || 'genesis-funding.near');
  const destination = { network: DESTINATION_NETWORK, asset: DESTINATION_ASSET, amount: String(priceUsdcSmallest), recipient };
  const ring = mode === 'demo' ? demoRing() : operationKeyRing();
  if (!ring) {
    return { kind: 'rejected', reason: 'not_configured', message: 'near-intents settlement is not configured yet (OPERATION_TOKEN_SECRET is not set)' };
  }
  const check = verifyOperationToken(ring, operationToken, { network: chain.caip2, depositAddress, depositMemo, resource, destination }, Math.floor(now / 1000));
  if (!check.ok) {
    return { kind: 'rejected', reason: check.reason, message: check.reason === 'invalid_exact_near_intents_token_expired' ? 'operation token expired' : 'operation token does not verify for this resource and deposit' };
  }
  // Demo mode: no network. A deposit with txHash 'sim:...' settles at
  // once; anything else is pending (the demo never sees a real deposit).
  if (mode === 'demo') {
    if (String(txHash).startsWith('sim:')) {
      return {
        kind: 'settled',
        settle: { success: true, network: DESTINATION_NETWORK, transaction: 'sim:delivery-' + String(txHash).slice(4, 20), payer: 'sim-payer', amount: String(priceUsdcSmallest), extra: { originNetwork: chain.caip2, originTxHash: txHash } },
        fields: { method: 'near-intents', originChain: chain.key, originAsset: chain.x402Asset, originSymbol: chain.symbol, amountOut: String(priceUsdcSmallest), payer: 'sim-payer', refundTo: 'sim-payer', depositAddress, originTx: txHash, destTx: 'sim:delivery', operationId: chain.caip2 + ':' + depositAddress, simulated: true },
      };
    }
    return { kind: 'pending', settle: { success: false, errorReason: 'settlement_pending', network: chain.caip2, transaction: txHash, extra: { status: 'PENDING_DEPOSIT' } } };
  }
  let status;
  try {
    status = await oneclickStatus(depositAddress, depositMemo, fetchImpl);
  } catch (e) {
    return { kind: 'pending', settle: { success: false, errorReason: 'settlement_pending', network: chain.caip2, transaction: txHash, extra: { status: 'UNKNOWN' } } };
  }
  if (status.status === 404) {
    return { kind: 'rejected', reason: 'deposit_not_found', message: 'deposit address unknown to 1Click' };
  }
  let st = status.data || {};
  // The quote terms must match the seller's destination.
  const qr = st.quoteResponse && st.quoteResponse.quoteRequest;
  if (qr && (qr.recipient !== recipient || qr.destinationAsset !== DESTINATION_ASSET || qr.amount !== String(priceUsdcSmallest))) {
    return { kind: 'rejected', reason: 'quote_mismatch', message: '1Click quote terms do not match the seller destination' };
  }
  const until = now + SETTLE_WINDOW_MS;
  while (!TERMINAL_STATUSES.has(st.status) && Date.now() < until) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const again = await oneclickStatus(depositAddress, depositMemo, fetchImpl);
      st = again.data || st;
    } catch (_) { break; }
  }
  const d = st.swapDetails || {};
  const known = Array.isArray(d.originChainTxHashes) && d.originChainTxHashes.some((t) => String(t.hash || '').toLowerCase() === String(txHash).toLowerCase());
  if (st.status === 'SUCCESS' && !known) {
    return { kind: 'rejected', reason: 'deposit_not_found', message: 'txHash is not a deposit of this operation' };
  }
  if (!TERMINAL_STATUSES.has(st.status)) {
    return { kind: 'pending', settle: { success: false, errorReason: 'settlement_pending', network: chain.caip2, transaction: txHash, extra: { status: st.status || 'UNKNOWN' } } };
  }
  const base = {
    method: 'near-intents', originChain: chain.key, originAsset: chain.x402Asset, originSymbol: chain.symbol,
    amountIn: d.amountIn || d.depositedAmount || (st.quoteResponse && st.quoteResponse.quote.amountIn) || null,
    amountInUsd: Number(d.amountInUsd || (st.quoteResponse && st.quoteResponse.quote.amountInUsd) || 0),
    amountOut: String(priceUsdcSmallest),
    payer: (qr && qr.refundTo) || '', refundTo: (qr && qr.refundTo) || '', depositAddress,
    originTx: txHash, operationId: chain.caip2 + ':' + depositAddress, simulated: false,
  };
  if (st.status === 'SUCCESS') {
    const destTx = (d.destinationChainTxHashes && d.destinationChainTxHashes[0] && d.destinationChainTxHashes[0].hash) || (d.nearTxHashes && d.nearTxHashes[0]) || '';
    return {
      kind: 'settled',
      settle: { success: true, network: DESTINATION_NETWORK, transaction: destTx, payer: base.payer, amount: String(priceUsdcSmallest), extra: { originNetwork: chain.caip2, originTxHash: txHash } },
      fields: { ...base, destTx },
    };
  }
  return {
    kind: 'rejected',
    reason: st.status === 'REFUNDED' ? 'payment_refunded' : 'payment_failed',
    message: `${st.status}: funds are returned by 1Click to ${base.refundTo}`,
    settle: { success: false, errorReason: st.status, network: chain.caip2, transaction: '', extra: { status: st.status, refundTo: base.refundTo } },
    refund: { ...base, destTx: null, refundedAmount: d.refundedAmount || d.depositedAmount || null, refundReason: d.refundReason || st.status },
  };
}

// Parse a presented PAYMENT-SIGNATURE (base64/base64url JSON, or the
// raw JSON). Returns the x402 v2 PaymentPayload or null.
function parsePaymentSignature(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text.length > 16384) return null;
  try {
    if (!text.startsWith('{')) {
      const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
      text = Buffer.from(b64, 'base64').toString('utf8');
    }
    const p = JSON.parse(text);
    if (!p || typeof p !== 'object') return null;
    if (p.x402Version !== 2 || !p.accepted || typeof p.accepted !== 'object' || !p.payload || typeof p.payload !== 'object') return null;
    if (typeof p.accepted.scheme !== 'string' || typeof p.accepted.network !== 'string') return null;
    return p;
  } catch (_) {
    return null;
  }
}

module.exports = {
  ORIGINS, DESTINATION_ASSET, DESTINATION_NETWORK, DESTINATION_DECIMALS,
  ONE_CLICK_MANAGER_PUB_KEY, TERMINAL_STATUSES,
  findOrigin, isValidAddressFor, fundingAccount,
  base58Encode, base58Decode, stableStringify, quoteHash, verifyQuoteSignature,
  destinationHash, mintOperationToken, verifyOperationToken, operationKeyRing, demoRing,
  signReceipt, verifyReceipt,
  nearIntentsOffers, exactOffer, buildAccepts, paymentRequiredObject,
  quoteForAction, settleDeposit, parsePaymentSignature, parseRouteMinimum,
  _test: {
    setReceiptKey(seedB64) {
      const seed = Buffer.from(seedB64, 'base64');
      const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
      receiptKeyPair = { privateKey: priv, publicKey: crypto.createPublicKey(priv), fromEnv: true };
    },
    clearReceiptKey() { receiptKeyPair = null; },
    setManagerKey(pub) { managerKeyOverride = pub; },
    clearManagerKey() { managerKeyOverride = null; },
  },
};
