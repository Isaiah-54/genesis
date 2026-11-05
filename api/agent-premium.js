// GET /api/agent-premium — premium agent CV, gated by x402.
//
// x402 (HTTP 402 Payment Required): a server returns 402 with payment
// details, the client pays with crypto, and the server serves the
// resource after verifying the payment. This endpoint is the Genesis
// agent-EARNINGS-via-x402 demo: a detailed premium CV for one agent,
// paid for in testnet USDC.
//
// Flow:
//   1. GET /api/agent-premium?token_id=genesis-gen-3 (no payment)
//      -> 402 with a PAYMENT-REQUIRED header (base64 x402 v2
//         PaymentRequired) and the same requirements in the JSON body.
//   2. The payer sends 0.01 testnet USDC to the treasury with a normal
//      ft_transfer on the testnet USDC contract (free testnet USDC
//      from the Circle faucet), then retries with
//      ?paymentTx=<tx hash>&paymentSender=<their account>.
//   3. This route verifies the payment onchain via the NEAR testnet
//      RPC (tx method): the transaction must have succeeded and must
//      contain an ft_transfer of >= 0.01 testnet USDC to the treasury.
//      The tx hash is recorded so one payment buys exactly one access.
//   4. Verified -> 200 with the premium CV + a PAYMENT-RESPONSE
//      header. Not verified -> 402 again. No payment, no content.
//
// Honest limits:
// - This is NEAR testnet x402, not EVM/Base x402. The asset is
//   testnet USDC (NEP-141, contract
//   3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af),
//   network near:testnet, scheme exact. The payer signs a normal
//   ft_transfer; the full NEP-366 SignedDelegate flow (via a
//   facilitator) is the production path and is documented in
//   docs/X402.md — it needs a facilitator API key, which is a manual
//   approval, so this route verifies the payment directly onchain
//   instead (self-facilitation). The payment itself is real testnet
//   USDC, verified onchain; nothing is faked.
// - Testnet USDC has no real value. The price (0.01 USDC) is a demo
//   price so anyone can try it with faucet funds.
// - The premium content is the agent's full onchain record (Core
//   get_agent) + league standing + recent matches. It is the same
//   data the free CV page shows, plus the full match history and
//   earnings breakdown — the payment buys the detail, not the agent.
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://rpc.testnet.near.org';
const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
const TREASURY_ACCOUNT = 'genesisdemo354551.testnet';
// RPC calls get a timeout so a slow node fails fast instead of hanging
// the serverless function.
const FETCH_TIMEOUT_MS = 20000;

function fetchWithTimeout(fetchImpl, url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const promise = fetchImpl(url, { ...opts, signal: controller.signal });
  return promise.finally(() => clearTimeout(timer));
}
// Circle testnet USDC (NEP-141) — faucet.circle.com, NEAR Testnet.
const USDC_CONTRACT = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const PRICE_USDC_SMALLEST = '10000'; // 0.01 USDC, 6 decimals
const PRICE_DISPLAY = '0.01 testnet USDC';
const NETWORK = 'near:testnet';
const PAYMENTS_LOG = process.env.X402_PAYMENTS_LOG || path.join(__dirname, '..', 'demo', 'x402-payments.json');

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function hexToBase58(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  let n = BigInt('0x' + bytes.toString('hex'));
  let s = '';
  while (n > 0n) {
    const r = n % 58n;
    n = n / 58n;
    s = B58_ALPHABET[Number(r)] + s;
  }
  let pad = 0;
  for (const b of bytes) { if (b === 0) pad++; else break; }
  return '1'.repeat(pad) + (s || '');
}

// NEAR explorers and near-api-js show transaction hashes in base58
// (44 chars, e.g. 9eAGcsjorP2MViC5bKXFfXRhFi6SJai3A7oE1fMRSku), while
// the RPC `tx` method takes the hash either way — but this route
// canonicalises on 64-hex internally. Accept both forms from the
// caller so a hash copied straight from Nearblocks just works.
function base58ToHex(b58) {
  let n = 0n;
  for (const c of b58) {
    const i = B58_ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let pad = 0;
  for (const c of b58) { if (c === '1') pad++; else break; }
  return '00'.repeat(pad) + hex.padStart(64 - pad * 2, '0');
}

function normaliseTxHash(input) {
  const h = String(input || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(h)) return h.toLowerCase();
  if (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h)) {
    const hex = base58ToHex(h);
    if (hex && /^[0-9a-f]{64}$/.test(hex)) return hex;
  }
  return null;
}

function readPaymentsLog() {
  try {
    const raw = fs.readFileSync(PAYMENTS_LOG, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.payments) ? parsed : { payments: [] };
  } catch (_) {
    return { payments: [] };
  }
}

function recordPayment(entry) {
  // Best-effort: on Vercel this write fails silently (read-only
  // filesystem) and the in-memory set below still dedups within one
  // instance. The durable record is the onchain transaction itself.
  try {
    const log = readPaymentsLog();
    if (log.payments.some((p) => p.txHash === entry.txHash)) return false;
    log.payments.push(entry);
    fs.writeFileSync(PAYMENTS_LOG, JSON.stringify(log, null, 2) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// In-memory dedup for this serverless instance (the log file is the
// durable record; the chain is the source of truth).
const usedTxHashes = new Set();

function paymentRequirements(tokenId) {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  return {
    x402Version: 2,
    error: 'Payment Required',
    accepts: [{
      scheme: 'exact',
      network: NETWORK,
      amount: PRICE_USDC_SMALLEST,
      asset: USDC_CONTRACT,
      recipient: TREASURY_ACCOUNT,
      nonce: tokenId + '-' + Date.now(),
      expiresAt,
      payTo: TREASURY_ACCOUNT,
      description: 'Premium CV for ' + tokenId + ' — full match history and earnings breakdown',
    }],
  };
}

function paymentRequiredResponse(res, tokenId) {
  const required = paymentRequirements(tokenId);
  const header = Buffer.from(JSON.stringify(required)).toString('base64');
  res.setHeader('PAYMENT-REQUIRED', header);
  return res.status(402).json({
    ok: false,
    error: 'Payment Required',
    x402: required,
    howToPay: [
      '1. Get free testnet USDC from the Circle faucet (faucet.circle.com, NEAR Testnet).',
      '2. Send ' + PRICE_DISPLAY + ' to ' + TREASURY_ACCOUNT + ' with ft_transfer on ' + USDC_CONTRACT + '.',
      '3. Retry this URL with ?paymentTx=<transaction hash>&paymentSender=<your account id>.',
      'The payment is verified onchain; one transaction hash buys one access.',
    ],
  });
}

async function rpcTx(txHashHex, sender, fetchImpl) {
  const hash58 = hexToBase58(txHashHex);
  const res = await fetchWithTimeout(fetchImpl, RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'x402-tx', method: 'tx',
      params: [hash58, sender],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error('transaction not found or RPC error: ' + String(data.error.message || data.error));
  return data.result;
}

// Verify a testnet USDC payment onchain. Returns { valid, reason }.
// The transaction must have succeeded and must contain an ft_transfer
// on the testnet USDC contract sending >= PRICE_USDC_SMALLEST to the
// treasury. The tx hash must not have been used before.
async function verifyPayment(txHash, sender, fetchImpl) {
  const txHashHex = normaliseTxHash(txHash);
  if (!txHashHex) {
    return { valid: false, reason: 'paymentTx must be a transaction hash (64-hex, or base58 as shown on Nearblocks)' };
  }
  if (typeof sender !== 'string' || !/^[a-z0-9._-]+\.testnet$/.test(sender)) {
    return { valid: false, reason: 'paymentSender must be a .testnet account id' };
  }
  const key = txHashHex.toLowerCase();
  if (usedTxHashes.has(key) || readPaymentsLog().payments.some((p) => p.txHash === key)) {
    return { valid: false, reason: 'this transaction hash has already been used to pay for access' };
  }
  let result;
  try {
    result = await rpcTx(txHashHex, sender, fetchImpl);
  } catch (e) {
    return { valid: false, reason: e.message };
  }
  const status = result && result.status;
  const succeeded = status && (status.SuccessValue !== undefined || status.SuccessReceiptId !== undefined);
  if (!succeeded) return { valid: false, reason: 'transaction did not succeed onchain' };
  const tx = result.transaction || {};
  if (tx.receiver_id !== USDC_CONTRACT) {
    return { valid: false, reason: 'transaction was not a call to the testnet USDC contract' };
  }
  const actions = Array.isArray(tx.actions) ? tx.actions : [];
  for (const action of actions) {
    const fc = action && action.FunctionCall;
    if (!fc || fc.method_name !== 'ft_transfer') continue;
    let args;
    try {
      args = JSON.parse(Buffer.from(String(fc.args || ''), 'base64').toString('utf8'));
    } catch (_) { continue; }
    if (args && args.receiver_id === TREASURY_ACCOUNT && BigInt(String(args.amount || '0')) >= BigInt(PRICE_USDC_SMALLEST)) {
      return { valid: true, reason: null, amount: String(args.amount), sender: tx.signer_id, txHash: key };
    }
  }
  return { valid: false, reason: 'transaction does not contain an ft_transfer of >= ' + PRICE_DISPLAY + ' to ' + TREASURY_ACCOUNT };
}

async function rpcView(contractId, method, args, fetchImpl) {
  const res = await fetchWithTimeout(fetchImpl, RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'x402-view', method: 'query',
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

function readLeague() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'demo', 'league.json'), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  const tokenId = String((req.query && req.query.token_id) || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(tokenId)) {
    return res.status(400).json({ ok: false, error: 'token_id is required (a Genesis agent token id)' });
  }
  const paymentTx = String((req.query && req.query.paymentTx) || '').trim();
  const paymentSender = String((req.query && req.query.paymentSender) || '').trim();
  if (!paymentTx || !paymentSender) {
    return paymentRequiredResponse(res, tokenId);
  }
  const fetchImpl = (global.fetch || require('node-fetch'));
  const check = await verifyPayment(paymentTx, paymentSender, fetchImpl);
  if (!check.valid) {
    return paymentRequiredResponse(res, tokenId);
  }
  // Payment verified — record it (dedup) and serve the premium CV.
  // Canonicalise on the 64-hex hash so a base58 hash and its hex form
  // dedup against each other instead of paying twice for one tx.
  const txHashHex = check.txHash || paymentTx.toLowerCase();
  usedTxHashes.add(txHashHex);
  recordPayment({
    token_id: tokenId, txHash: txHashHex,
    sender: check.sender || paymentSender, amount: check.amount,
    paidAt: new Date().toISOString(),
  });
  let agent = null;
  try { agent = await rpcView(CORE_CONTRACT, 'get_agent', { token_id: tokenId }, fetchImpl); } catch (_) {}
  if (!agent) {
    return res.status(404).json({ ok: false, error: 'token not found in the Core registry' });
  }
  const league = readLeague();
  const standing = league && Array.isArray(league.standings)
    ? league.standings.find((s) => s.token_id === tokenId || s.tokenId === tokenId) : null;
  const matches = league && Array.isArray(league.matches)
    ? league.matches.filter((m) => m.winner === tokenId || m.loser === tokenId || (m.contestants || []).includes(tokenId))
    : [];
  const response = {
    x402Version: 2,
    settlement: { txHash: txHashHex, sender: check.sender || paymentSender, amount: check.amount, asset: USDC_CONTRACT, network: NETWORK },
  };
  res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(response)).toString('base64'));
  return res.status(200).json({
    ok: true,
    premium: true,
    token_id: tokenId,
    agent,
    leagueStanding: standing || null,
    matches,
    paidWith: { txHash: txHashHex, amount: check.amount, asset: USDC_CONTRACT, network: NETWORK },
  });
};

module.exports._test = { hexToBase58, base58ToHex, normaliseTxHash, verifyPayment, paymentRequirements, USDC_CONTRACT, TREASURY_ACCOUNT, PRICE_USDC_SMALLEST };
