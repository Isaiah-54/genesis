// Tests for api/near-intents-rail.js — the shared x402 near-intents
// rail. Everything here is mocked / local: no 1Click, no RPC, no
// real funds. Run: node test/near-intents-rail.cjs
//
// Covers: stableStringify ordering, quote-hash + ed25519 signature
// verification (with a test manager key), HMAC operation tokens
// (valid / expired / tampered / wrong resource), base58 round-trips,
// ed25519 receipt sign/verify (+ tamper), and the 402 offers builder
// (near-intents first, exact last).
const crypto = require('crypto');
const rail = require('../api/near-intents-rail');

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function makeTestKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = pubDer.slice(pubDer.length - 32);
  return { privateKey, publicKey, rawPub, b58Pub: rail.base58Encode(rawPub) };
}

async function main() {
  console.log('near-intents rail tests');

  // 1. stableStringify sorts keys recursively (canonical JSON).
  check('stableStringify sorts keys', rail.stableStringify({ b: 1, a: { d: 4, c: 3 } }) === '{"a":{"c":3,"d":4},"b":1}');
  check('stableStringify arrays keep order', rail.stableStringify({ a: [3, 2, 1] }) === '{"a":[3,2,1]}');

  // 2. base58 round-trip.
  const bytes = crypto.randomBytes(32);
  check('base58 round-trip', Buffer.from(rail.base58Decode(rail.base58Encode(bytes))).equals(Buffer.from(bytes)));
  check('base58 of zeros keeps leading 1s', rail.base58Encode(Buffer.from([0, 0, 1])) === '112');

  // 3. Quote signature verification with a test manager key. Build a
  //    fake 1Click quote response, sign its hash with the test key,
  //    and verify it the way the rail does.
  const mgr = makeTestKey();
  const fakeQuote = {
    quoteRequest: {
      dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: 100,
      originAsset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
      depositType: 'ORIGIN_CHAIN', destinationAsset: rail.DESTINATION_ASSET, amount: '500000',
      refundTo: '0x1111111111111111111111111111111111111111', refundType: 'ORIGIN_CHAIN',
      recipient: 'genesis-funding.near', recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-05T17:00:00.000Z', quoteWaitingTimeMs: 10000,
    },
    quote: {
      amountIn: '510000', amountInFormatted: '0.51', amountInUsd: '0.51', minAmountIn: '500000',
      amountOut: '500000', amountOutFormatted: '0.5', amountOutUsd: '0.5', minAmountOut: '495000',
      depositAddress: '0x2222222222222222222222222222222222222222', deadline: '2026-11-05T17:00:00.000Z',
      timeWhenInactive: '2026-11-05T17:00:00.000Z', timeEstimate: 300, refundFee: '0', withdrawFee: '0',
    },
    timestamp: '2026-11-05T16:30:00.000Z',
  };
  const hash = rail.quoteHash(fakeQuote);
  const sig = crypto.sign(null, Buffer.from(hash, 'utf8'), mgr.privateKey);
  const signed = { ...fakeQuote, signature: rail.base58Encode(sig) };
  check('quoteHash is deterministic', rail.quoteHash(fakeQuote) === hash);
  check('valid quote signature verifies (test key)', rail.verifyQuoteSignature(signed, 'ed25519:' + mgr.b58Pub) === true);
  check('quote signature fails with wrong key', rail.verifyQuoteSignature(signed, 'ed25519:' + makeTestKey().b58Pub) === false);
  const tampered = { ...fakeQuote, quote: { ...fakeQuote.quote, amountIn: '999999' }, signature: signed.signature };
  check('quote signature fails when the quote is tampered', rail.verifyQuoteSignature(tampered, 'ed25519:' + mgr.b58Pub) === false);
  check('quote without signature fails', rail.verifyQuoteSignature(fakeQuote, 'ed25519:' + mgr.b58Pub) === false);

  // 4. Operation tokens (HMAC, Penstock's token.ts shape).
  const ring = rail.demoRing();
  const dest = { network: 'near:mainnet', asset: rail.DESTINATION_ASSET, amount: '500000', recipient: 'genesis-funding.near' };
  const input = { network: 'eip155:42161', depositAddress: '0x2222222222222222222222222222222222222222', resource: 'https://genesis-roan-eta.vercel.app/api/agent-action?action=mint&token_id=genesis-visitor-4', destination: dest };
  const nowSec = Math.floor(Date.now() / 1000);
  const token = rail.mintOperationToken(ring, input, nowSec + 3600);
  check('operation token has the keyId.expiry.mac shape', token.split('.').length === 3);
  check('operation token verifies', rail.verifyOperationToken(ring, token, input, nowSec).ok === true);
  check('operation token fails on a different deposit address', rail.verifyOperationToken(ring, token, { ...input, depositAddress: '0x3333333333333333333333333333333333333333' }, nowSec).ok === false);
  check('operation token fails on a different resource', rail.verifyOperationToken(ring, token, { ...input, resource: 'https://genesis-roan-eta.vercel.app/api/agent-action?action=evolve&token_id=genesis-gen-3' }, nowSec).ok === false);
  check('operation token fails on a different amount', rail.verifyOperationToken(ring, token, { ...input, destination: { ...dest, amount: '1' } }, nowSec).ok === false);
  check('operation token fails when expired', rail.verifyOperationToken(ring, token, input, nowSec + 3601).reason === 'invalid_exact_near_intents_token_expired');
  check('operation token fails when the mac is flipped', rail.verifyOperationToken(ring, token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A'), input, nowSec).ok === false);
  check('operation token fails when malformed', rail.verifyOperationToken(ring, 'not-a-token', input, nowSec).ok === false);

  // 5. Signed receipts (ed25519, canonical JSON).
  const body = { v: 1, kind: 'action', paymentId: 'pay_test', action: 'mint', token_id: 'genesis-visitor-4', amountUsdc: '50000', simulated: false };
  const receipt = rail.signReceipt(body);
  check('receipt verifies', rail.verifyReceipt(receipt) === true);
  check('receipt fails when the body is tampered', rail.verifyReceipt({ ...receipt, body: { ...body, amountUsdc: '99999' } }) === false);
  check('receipt fails when the signature is flipped', rail.verifyReceipt({ ...receipt, sig: receipt.sig.slice(0, -2) + 'AA' }) === false);
  check('receipt carries a pub key', typeof receipt.pub === 'string' && receipt.pub.length > 40);

  // 6. Offers builder: near-intents first (primary), exact last (secondary).
  const accepts = rail.buildAccepts({
    nearIntentsPriceUsdc: 500000, exactPriceUsdc: 50000,
    testnetUsdcContract: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    treasury: 'genesisdemo354551.testnet', resource: { url: 'https://genesis-roan-eta.vercel.app/api/agent-action?action=mint' },
  });
  check('accepts has 7 entries (6 near-intents + 1 exact)', accepts.length === 7);
  check('first 6 entries are near-intents', accepts.slice(0, 6).every((a) => a.extra && a.extra.assetTransferMethod === 'near-intents'));
  check('last entry is the exact rail', accepts[6].network === 'near:testnet' && !accepts[6].extra);
  check('near-intents entries cover 6 origin assets', new Set(accepts.slice(0, 6).map((a) => a.network + ':' + a.asset)).size === 6);
  check('near-intents entries carry the destination', accepts[0].extra.destination && accepts[0].extra.destination.asset === rail.DESTINATION_ASSET && accepts[0].extra.destination.amount === '500000');
  check('exact entry has the testnet price', accepts[6].amount === '50000');

  // 7. PAYMENT-SIGNATURE parsing.
  const payload = { x402Version: 2, accepted: accepts[1], payload: { type: 'quote', refundTo: '0x1111111111111111111111111111111111111111' } };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const parsed = rail.parsePaymentSignature(b64);
  check('parsePaymentSignature decodes base64 payloads', parsed && parsed.payload.type === 'quote');
  check('parsePaymentSignature rejects garbage', rail.parsePaymentSignature('not json') === null);
  check('parsePaymentSignature rejects v1 payloads', rail.parsePaymentSignature(Buffer.from(JSON.stringify({ x402Version: 1, accepted: {}, payload: {} })).toString('base64')) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
