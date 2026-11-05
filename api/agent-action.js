// POST/GET /api/agent-action — every Genesis onchain action goes
// through the 402 payment rail (Isaiah's rule, 2026-11-05: "our genesis
// should always use the 402 payment rail to mint trade breed evolve on
// chain that is the main purpose").
//
// Actions: mint | breed | evolve | buy (marketplace trade).
//   mint  token_id=<new gen-0 id> [receiver] [title]
//   breed token_id=<child id> parent1=<id> parent2=<id> [receiver]
//   evolve token_id=<agent id>
//   buy   token_id=<listed token id> [receiver]
//
// Flow (same on every action):
//   1. The action is VALIDATED onchain first (token free / parents
//      alive / evolve eligible / listing exists). An invalid action
//      returns 400 — no payment is ever taken for an impossible action.
//   2. No payment -> HTTP 402 with BOTH rails, near-intents FIRST
//      (primary rail) and exact LAST (secondary rail), the same object
//      in the Payment-Required header and in the JSON body.
//   3. Verified payment (either rail) -> the server executes the
//      onchain action via the treasury key and returns HTTP 200 with
//      the result (tx hashes, new token id / new generation / listing
//      bought) + an ed25519 SIGNED RECEIPT + a PAYMENT-RESPONSE header.
//      One payment buys exactly one action execution (dedup by tx hash
//      on the exact rail, by operation instrument on the near-intents
//      rail).
//
// Prices (documented in docs/X402.md and docs/ACTIONS-402.md):
//   exact rail (testnet USDC, free from the Circle faucet):
//     mint 0.05, breed 0.05, evolve 0.01, buy 0.05 (fixed demo price,
//     or the listing's NEAR price converted by a 1Click dry quote when
//     it works — it does not right now, the NEAR solvers are down).
//   near-intents rail (MAINNET USDC, real money, delivered to the
//     mainnet funding account): mint 0.50, breed 0.50, evolve 0.35,
//     buy 0.50. These sit above the highest offered route minimum
//     (Ethereum USDC ~0.30 USDC) so a quote usually clears.
// The 402 price is the service fee for executing the action AND the
// funding for the underlying NEAR cost — the caller funds the action,
// not the treasury owner (Isaiah's rule, 2026-11-05). Mint and breed
// each cost the treasury 0.15 NEAR (0.05 birth + 0.1 NFT mint), about
// $0.38 at NEAR ~$2.50, so their near-intents price is 0.50 USDC
// (birth_cost was 0.5 NEAR until 2026-11-05, when Isaiah lowered it
// to 0.05 for the Hackathon — see scripts/set-birth-cost.js).
// Evolve costs only gas (no attached deposit) and buy costs the
// listing price, so their prices are unchanged. The treasury swaps
// received USDC back into NEAR (scripts/treasury-sweep.js, docs/
// TREASURY.md); on testnet the refill comes from the free NEAR
// testnet faucet, because testnet USDC has no swap route.
const EXACT_PRICES = { mint: 50000, breed: 50000, evolve: 10000, buy: 50000 };
// Prices on the near-intents rail (mainnet USDC, 6 decimals). Mint and
// breed are cost-covering: 0.50 USDC ≈ 0.15 NEAR at NEAR ~$2.50.
// Re-price if NEAR moves materially. Evolve (gas only) and buy
// (listing price) are unchanged.
const INTENTS_PRICES = { mint: 500000, breed: 500000, evolve: 350000, buy: 500000 };
//
// Modes (mode= query/body, default live; never mixed):
//   live — real payments, real onchain execution.
//   dry  — near-intents quotes are dry (price preview, no deposit
//          address); exact payments still verify for real and actions
//          execute for real.
//   demo — everything simulated, no network: a `sim:...` payment is
//          accepted and the action returns a simulated result with
//          `sim:` tx hashes. Labelled simulated everywhere.
//
// Honest limits:
// - The near-intents rail is mainnet-only (1Click has no testnet) and
//   is currently BLOCKED: quoting into/out of NEAR is down
//   (2026-11-05 16:08 WAT, every NEAR pair returns HTTP 400). The
//   rail passes 1Click's real error through and never invents a quote.
//   The exact rail is the working path until the solvers return.
// - Exactly-once is per serverless instance (in-memory set) plus a
//   best-effort log at demo/x402-actions.json. Vercel's filesystem is
//   read-only, so cross-instance replay is not blocked by this code;
//   the durable proof is the 1Click deposit instrument and the
//   onchain action. See api/near-intents-rail.js for the full list.
// - If an action becomes invalid between payment and execution (the
//   window is seconds), the payment is NOT marked spent, so the same
//   tx hash / operation can be presented again for a corrected action
//   — but the USDC already reached the treasury and is not
//   auto-refunded. Validate before you pay; the 402 is only offered
//   for a currently valid action.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rail = require('./near-intents-rail');
const premium = require('./agent-premium')._test;

const { connect, keyStores, KeyPair, utils } = require('near-api-js');

const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
const NFT_CONTRACT = 'nft.primitives.testnet';
const RPC_URL = 'https://rpc.testnet.near.org';
const USDC_CONTRACT = premium.USDC_CONTRACT;
const TREASURY_ACCOUNT = premium.TREASURY_ACCOUNT;
const GAS = BigInt('100000000000000'); // 100 TGas
const NFT_MINT_GAS = BigInt('300000000000000'); // 300 TGas
const BUY_GAS = BigInt('200000000000000'); // 200 TGas
const YOCTO_PER_NEAR = BigInt('1000000000000000000000000');

// Prices on the near-intents rail (mainnet USDC, 6 decimals). Mint and
// breed are cost-covering: 0.50 USDC ≈ 0.15 NEAR at NEAR ~$2.50.
// Re-price if NEAR moves materially. Evolve (gas only) and buy
// (listing price) are unchanged.

const ACTIONS = ['mint', 'breed', 'evolve', 'buy'];
const PAYMENTS_LOG = process.env.X402_ACTIONS_LOG || path.join(__dirname, '..', 'demo', 'x402-actions.json');

// ---------------------------------------------------------------------------
// Exactly-once: in-memory set (per instance) + best-effort log file.
// A payment id is 'exact:<txHash>' or 'intents:<network>:<depositAddress>'.
// ---------------------------------------------------------------------------
const seenPayments = new Set();

function readPaymentsLog() {
  try {
    const data = fs.readFileSync(PAYMENTS_LOG, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function logPayment(entry) {
  try {
    const rows = readPaymentsLog();
    rows.push(entry);
    fs.mkdirSync(path.dirname(PAYMENTS_LOG), { recursive: true });
    fs.writeFileSync(PAYMENTS_LOG, JSON.stringify(rows, null, 2));
  } catch (_) {
    // Vercel's filesystem is read-only — the in-memory set still holds.
  }
}

function isPaymentUsed(paymentId) {
  if (seenPayments.has(paymentId)) return true;
  return readPaymentsLog().some((r) => r.paymentId === paymentId);
}

function markPaymentUsed(entry) {
  seenPayments.add(entry.paymentId);
  logPayment(entry);
}

// ---------------------------------------------------------------------------
// RPC view calls (testnet). Uses global fetch so tests can mock it.
// ---------------------------------------------------------------------------
async function rpcView(contractId, method, args) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'agent-action-view', method: 'query',
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

// ---------------------------------------------------------------------------
// Action pre-validation (read-only). Runs BEFORE the 402 is offered and
// again AFTER payment, before execution. Returns {ok} or {ok:false,
// error}.
// ---------------------------------------------------------------------------
async function validateAction(action, params, view) {
  const viewFn = view || rpcView;
  if (action === 'mint') {
    if (!params.token_id || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(params.token_id)) {
      return { ok: false, error: 'token_id is required (lowercase, letters/digits/dashes, 2-64 chars)' };
    }
    // Check BOTH the NFT contract and the Core registry. The two can
    // disagree (a birth that registered the agent but whose NFT mint
    // never landed) — that split-brain token is completable, not a
    // duplicate: the action just mints the NFT. Only a token that
    // already HAS an NFT is a duplicate.
    let existing = null;
    try { existing = await viewFn(NFT_CONTRACT, 'nft_token', { token_id: params.token_id }); } catch (_) {}
    if (existing) return { ok: false, error: `token ${params.token_id} already exists (owner ${existing.owner_id})` };
    let agent = null;
    try { agent = await viewFn(CORE_CONTRACT, 'get_agent', { token_id: params.token_id }); } catch (_) {}
    if (agent) {
      const receiver = (params.receiver || TREASURY_ACCOUNT).trim();
      if (agent.owner_id !== receiver) {
        return { ok: false, error: `token ${params.token_id} is already registered in the Core (owner ${agent.owner_id}) — the NFT can only be minted to that owner` };
      }
      return { ok: true, completeOnly: true, agent };
    }
    return { ok: true };
  }
  if (action === 'breed') {
    for (const p of ['parent1', 'parent2']) {
      if (!params[p]) return { ok: false, error: p + ' is required' };
    }
    if (params.parent1 === params.parent2) return { ok: false, error: 'the two parents must be different agents' };
    if (!params.token_id) return { ok: false, error: 'token_id (the child id) is required' };
    let existing = null;
    try { existing = await viewFn(NFT_CONTRACT, 'nft_token', { token_id: params.token_id }); } catch (_) {}
    if (existing) return { ok: false, error: `token ${params.token_id} already exists (owner ${existing.owner_id})` };
    let childAgent = null;
    try { childAgent = await viewFn(CORE_CONTRACT, 'get_agent', { token_id: params.token_id }); } catch (_) {}
    if (childAgent) {
      const receiver = (params.receiver || TREASURY_ACCOUNT).trim();
      if (childAgent.owner_id !== receiver) {
        return { ok: false, error: `child ${params.token_id} is already registered in the Core (owner ${childAgent.owner_id}) — the NFT can only be minted to that owner` };
      }
      // The breed already landed but the NFT mint did not: completable.
      return { ok: true, completeOnly: true, childAgent };
    }
    for (const p of ['parent1', 'parent2']) {
      let agent = null;
      try { agent = await viewFn(CORE_CONTRACT, 'get_agent', { token_id: params[p] }); } catch (_) {}
      if (!agent) return { ok: false, error: `parent ${params[p]} is not a registered agent` };
      // The Core record carries `status: 'Alive'`, not an `alive`
      // boolean — checking agent.alive refused every breed live
      // (found 2026-11-05 while checking the rail; the test mock
      // used to carry the wrong shape too).
      if (agent.status !== 'Alive') return { ok: false, error: `parent ${params[p]} is not alive (status ${agent.status})` };
    }
    return { ok: true };
  }
  if (action === 'evolve') {
    if (!params.token_id) return { ok: false, error: 'token_id is required' };
    let status = null;
    try { status = await viewFn(CORE_CONTRACT, 'get_evolve_status', { token_id: params.token_id }); } catch (_) {}
    if (!status) return { ok: false, error: `agent ${params.token_id} is not registered` };
    if (!status.can_evolve) {
      return { ok: false, error: `agent ${params.token_id} cannot evolve yet (${status.wins_since_evolution || 0} win(s) since its last evolution; 3 are needed, max generation 9)` };
    }
    return { ok: true, evolve: status };
  }
  if (action === 'buy') {
    if (!params.token_id) return { ok: false, error: 'token_id is required' };
    let listings = [];
    try { listings = await viewFn(CORE_CONTRACT, 'get_listings', {}) || []; } catch (_) {}
    const listing = listings.find((l) => l.token_id === params.token_id);
    if (!listing) return { ok: false, error: `token ${params.token_id} is not listed for sale` };
    return { ok: true, listing };
  }
  return { ok: false, error: 'unknown action' };
}

// ---------------------------------------------------------------------------
// buy price in USDC. Tries a 1Click dry quote (wNEAR -> USDC on NEAR,
// EXACT_INPUT, the listing's NEAR price) and falls back to the fixed
// demo price when quoting fails (it does right now — NEAR solvers down).
// ---------------------------------------------------------------------------
async function priceBuyInUsdc(listingPriceYocto, fetchImpl) {
  const near = Number(BigInt(listingPriceYocto)) / 1e24;
  const nearUnits = String(Math.round(near * 1e24));
  try {
    const res = await fetch('https://1click.chaindefuser.com/v0/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100,
        originAsset: 'nep141:wrap.near', depositType: 'ORIGIN_CHAIN',
        destinationAsset: rail.DESTINATION_ASSET, amount: nearUnits,
        refundTo: 'genesisdemo354551.testnet', refundType: 'ORIGIN_CHAIN',
        recipient: 'genesis-funding.near', recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 1800000).toISOString(), quoteWaitingTimeMs: 10000,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 200 && data && data.quote && data.quote.amountOut) {
      const usdc = Math.ceil(Number(data.quote.amountOut) / 1e6 * 1e6); // round up to a whole micro-unit
      return { exactUsdc: Math.max(10000, usdc), intentsUsdc: Math.max(350000, usdc), source: 'dry-quote', note: 'converted from the listing price via a 1Click dry quote' };
    }
    return { exactUsdc: EXACT_PRICES.buy, intentsUsdc: INTENTS_PRICES.buy, source: 'fixed-demo', note: '1Click could not convert the listing price right now (' + String((data && data.message) || ('HTTP ' + res.status)) + '); fixed demo price used' };
  } catch (e) {
    return { exactUsdc: EXACT_PRICES.buy, intentsUsdc: INTENTS_PRICES.buy, source: 'fixed-demo', note: '1Click quote failed (' + String((e && e.message) || e) + '); fixed demo price used' };
  }
}

// ---------------------------------------------------------------------------
// Onchain execution (testnet) via the treasury key. This is the ONLY
// part that signs. It runs only after a verified payment. The default
// executor is replaceable in tests via _test.setExecutor.
// ---------------------------------------------------------------------------
async function defaultExecutor(action, params, ctx) {
  const privateKey = process.env.TREASURY_PRIVATE_KEY;
  const treasuryId = process.env.TREASURY_ACCOUNT_ID || TREASURY_ACCOUNT;
  if (!privateKey) throw new Error('actions are not configured yet (treasury key missing)');
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', treasuryId, KeyPair.fromString(privateKey));
  const near = await connect({ networkId: 'testnet', nodeUrl: RPC_URL, keyStore });
  const treasury = await near.account(treasuryId);
  const receiver = (params.receiver || treasuryId).trim();
  const txs = {};

  if (action === 'mint') {
    // Idempotent: if the agent is already registered in the Core
    // (a birth whose NFT mint never landed), skip birth and just
    // mint the NFT to the Core record's owner. A fresh mint does
    // birth + nft_mint.
    let agent = null;
    try { agent = await rpcView(CORE_CONTRACT, 'get_agent', { token_id: params.token_id }); } catch (_) {}
    if (!agent) {
      const birth = await treasury.functionCall({
        contractId: CORE_CONTRACT, methodName: 'birth',
        args: { token_id: params.token_id, owner_id: receiver, generation: 0, parent: null, skill: { speed: 1.0, quality: 1.0, cost_eff: 1.0 } },
        gas: GAS, attachedDeposit: utils.format.parseNearAmount('0.05'),
      });
      txs.birth = birth.transaction.hash;
    } else {
      txs.birth = 'already-registered';
    }
    const mintReceiver = agent ? agent.owner_id : receiver;
    const minted = await treasury.functionCall({
      contractId: NFT_CONTRACT, methodName: 'nft_mint',
      args: {
        token_id: params.token_id, receiver_id: mintReceiver,
        token_metadata: {
          title: params.title || 'Genesis Gen 0', description: 'Genesis agent — born, earns, reproduces, evolves',
          media: 'https://genesis-roan-eta.vercel.app/api/nft-card?gen=0',
          extra: JSON.stringify({ generation: 0, parent: null, second_parent: null, skill: { speed: 1.0, quality: 1.0, cost_eff: 1.0 } }),
        },
      },
      gas: NFT_MINT_GAS, attachedDeposit: utils.format.parseNearAmount('0.1'),
    });
    txs.mint = minted.transaction.hash;
    return { action, token_id: params.token_id, generation: 0, owner: mintReceiver, txs };
  }

  if (action === 'breed') {
    // Idempotent like mint: if the child is already registered in
    // the Core, skip breed and just mint the NFT.
    let existingChild = null;
    try { existingChild = await rpcView(CORE_CONTRACT, 'get_agent', { token_id: params.token_id }); } catch (_) {}
    if (!existingChild) {
      const bred = await treasury.functionCall({
        contractId: CORE_CONTRACT, methodName: 'breed',
        args: { token_id: params.token_id, owner_id: receiver, parent1: params.parent1, parent2: params.parent2 },
        gas: GAS, attachedDeposit: utils.format.parseNearAmount('0.05'),
      });
      txs.breed = bred.transaction.hash;
    } else {
      txs.breed = 'already-registered';
    }
    // Read the child back for its generation and skills (for the receipt).
    let child = null;
    try { child = await rpcView(CORE_CONTRACT, 'get_agent', { token_id: params.token_id }); } catch (_) {}
    const breedReceiver = child ? child.owner_id : receiver;
    const minted = await treasury.functionCall({
      contractId: NFT_CONTRACT, methodName: 'nft_mint',
      args: {
        token_id: params.token_id, receiver_id: breedReceiver,
        token_metadata: {
          title: `Genesis Gen ${child ? child.generation : '?'}`, description: 'Genesis agent — born of two parents, earns, reproduces, evolves',
          media: `https://genesis-roan-eta.vercel.app/api/nft-card?gen=${child ? child.generation : 0}`,
          extra: JSON.stringify({ generation: child ? child.generation : null, parent: params.parent1, second_parent: params.parent2, skill: child ? child.skill : null }),
        },
      },
      gas: NFT_MINT_GAS, attachedDeposit: utils.format.parseNearAmount('0.1'),
    });
    txs.mint = minted.transaction.hash;
    return { action, token_id: params.token_id, generation: child ? child.generation : null, owner: breedReceiver, parents: [params.parent1, params.parent2], txs };
  }

  if (action === 'evolve') {
    const evolved = await treasury.functionCall({
      contractId: CORE_CONTRACT, methodName: 'evolve',
      args: { token_id: params.token_id }, gas: GAS,
    });
    txs.evolve = evolved.transaction.hash;
    let agent = null;
    try { agent = await rpcView(CORE_CONTRACT, 'get_agent', { token_id: params.token_id }); } catch (_) {}
    return { action, token_id: params.token_id, generation: agent ? agent.generation : null, txs };
  }

  if (action === 'buy') {
    const listing = ctx.listing;
    const bought = await treasury.functionCall({
      contractId: CORE_CONTRACT, methodName: 'buy_nft',
      args: { token_id: params.token_id }, gas: BUY_GAS,
      attachedDeposit: listing.price,
    });
    txs.buy = bought.transaction.hash;
    let transferTx = null;
    if (receiver !== treasuryId) {
      const transferred = await treasury.functionCall({
        contractId: NFT_CONTRACT, methodName: 'nft_transfer',
        args: { receiver_id: receiver, token_id: params.token_id }, gas: GAS, attachedDeposit: '1',
      });
      transferTx = transferred.transaction.hash;
      txs.transfer = transferTx;
    }
    return {
      action, token_id: params.token_id, owner: receiver, seller: listing.seller,
      price_near: (Number(BigInt(listing.price)) / 1e24).toString(), txs,
    };
  }
  throw new Error('unknown action');
}

let executor = defaultExecutor;

function resourceFor(req, action, params) {
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'genesis-roan-eta.vercel.app';
  const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';
  const qs = new URLSearchParams({ action });
  for (const k of ['token_id', 'parent1', 'parent2', 'receiver']) {
    if (params[k]) qs.set(k, params[k]);
  }
  return { url: `${proto}://${host}/api/agent-action?${qs.toString()}` };
}

function payRequired(res, resourceUrl, accepts, error, status) {
  const obj = rail.paymentRequiredObject({ resource: { url: resourceUrl }, accepts, ...(error ? { error } : {}) });
  // The header carries the same object, base64-encoded (the x402
  // standard, as in agent-premium): raw JSON is not a legal header
  // value — a non-ASCII character in a description throws
  // ERR_INVALID_CHAR on Vercel. The JSON body carries the raw object.
  res.setHeader('Payment-Required', Buffer.from(JSON.stringify(obj)).toString('base64'));
  res.status(status || 402).json({ ok: false, error: error || 'payment required', x402: obj, resource: resourceUrl });
}

module.exports = async (req, res) => {
  const mode = String((req.query && req.query.mode) || ((req.body && req.body.mode) || 'live')).toLowerCase();
  const modeOk = ['live', 'dry', 'demo'].includes(mode) ? mode : 'live';
  let params = {};
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'bad JSON body' }); }
    }
    params = { ...(body || {}) };
  }
  const q = req.query || {};
  for (const k of ['action', 'token_id', 'parent1', 'parent2', 'receiver', 'title']) {
    if (typeof q[k] === 'string' && q[k] !== '') params[k] = q[k];
  }
  const action = String(params.action || '').toLowerCase();
  if (!ACTIONS.includes(action)) {
    return res.status(400).json({
      ok: false, error: 'action is required: mint | breed | evolve | buy',
      usage: '/api/agent-action?action=mint&token_id=genesis-visitor-4',
    });
  }

  // 1. Pre-validation: the 402 is only offered for a currently valid
  //    action. No payment is ever taken for an impossible action.
  let validation;
  try {
    validation = await validateAction(action, params);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'could not validate the action onchain: ' + String((e && e.message) || e).slice(0, 200) });
  }
  if (!validation.ok) return res.status(400).json({ ok: false, error: validation.error, action });

  // 2. Prices. buy is priced from the listing (dry quote, else fixed).
  let exactPrice = EXACT_PRICES[action];
  let intentsPrice = INTENTS_PRICES[action];
  let priceNote = null;
  if (action === 'buy') {
    const priced = await priceBuyInUsdc(validation.listing.price, global.fetch);
    exactPrice = priced.exactUsdc;
    intentsPrice = priced.intentsUsdc;
    priceNote = priced.source + ': ' + priced.note;
  }

  const resource = resourceFor(req, action, params);
  const accepts = rail.buildAccepts({
    nearIntentsPriceUsdc: intentsPrice, exactPriceUsdc: exactPrice,
    testnetUsdcContract: USDC_CONTRACT, treasury: TREASURY_ACCOUNT, resource,
    exactDescription: `Pay ${exactPrice / 1e6} testnet USDC to the treasury (secondary rail — works while 1Click NEAR solvers are down)`,
  });
  const now = Date.now();

  // 3. Payment presentation.
  const paymentTx = params.paymentTx || q.paymentTx;
  const paymentSender = params.paymentSender || q.paymentSender;
  const sigRaw = (req.headers && (req.headers['payment-signature'] || req.headers['PAYMENT-SIGNATURE'])) || params.paymentSignature || q.paymentSignature;

  // --- demo mode: a simulated payment, clearly labelled ---
  if (modeOk === 'demo' && (paymentTx || sigRaw)) {
    if (paymentTx && !String(paymentTx).startsWith('sim:')) {
      return res.status(402).json({ ok: false, error: 'demo mode only accepts simulated payments (paymentTx starting with sim:)', simulated: true });
    }
    const paymentId = paymentTx ? `exact:${paymentTx}` : 'intents:sim';
    if (isPaymentUsed(paymentId)) {
      return payRequired(res, resource.url, accepts, 'this payment was already used for an action', 402);
    }
    const simResult = { action, token_id: params.token_id || null, simulated: true, txs: { simulated: 'sim:action-' + String(paymentTx || 'demo').slice(4, 20) } };
    if (action === 'mint') { simResult.generation = 0; simResult.owner = params.receiver || TREASURY_ACCOUNT; }
    if (action === 'breed') { simResult.parents = [params.parent1, params.parent2]; }
    if (action === 'evolve') { simResult.generation = '(simulated)'; }
    if (action === 'buy') { simResult.seller = validation.listing.seller; simResult.price_near = (Number(BigInt(validation.listing.price)) / 1e24).toString(); }
    markPaymentUsed({ paymentId, action, token_id: params.token_id || null, simulated: true, at: new Date().toISOString() });
    const receipt = rail.signReceipt({
      v: 1, kind: 'action', paymentId, action, token_id: params.token_id || null,
      amountUsdc: String(exactPrice), rail: paymentTx ? 'exact' : 'near-intents',
      transaction: simResult.txs.simulated, payer: paymentSender || 'sim-payer',
      timestamp: new Date(now).toISOString(), simulated: true,
    });
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, transaction: simResult.txs.simulated, payer: paymentSender || 'sim-payer', amount: String(exactPrice), network: 'near:testnet', simulated: true })).toString('base64'));
    return res.status(200).json({ ok: true, simulated: true, mode: 'demo', ...simResult, receipt, priceNote });
  }

  // --- exact rail: paymentTx + paymentSender, verified onchain ---
  if (paymentTx && paymentSender) {
    let check;
    try {
      check = await premium.verifyPayment(paymentTx, paymentSender, global.fetch, exactPrice);
    } catch (e) {
      return payRequired(res, resource.url, accepts, 'payment verification failed: ' + String((e && e.message) || e).slice(0, 200), 402);
    }
    if (!check.valid) return payRequired(res, resource.url, accepts, 'payment did not verify: ' + check.reason, 402);
    const paymentId = 'exact:' + premium.normaliseTxHash(paymentTx);
    if (isPaymentUsed(paymentId)) {
      return payRequired(res, resource.url, accepts, 'this payment was already used for an action', 402);
    }
    // Re-validate (state may have moved since the 402 was offered).
    const re = await validateAction(action, params);
    if (!re.ok) {
      return res.status(402).json({ ok: false, error: 'the action is no longer valid: ' + re.error + ' — the payment was NOT spent, present the same tx hash again for a corrected action (the testnet USDC is not auto-refunded)', action });
    }
    if (action === 'buy') validation.listing = re.listing;
    let result;
    try {
      result = await executor(action, params, { listing: validation.listing });
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'payment verified but the action failed onchain: ' + String((e && e.message) || e).slice(0, 300), action, paymentId });
    }
    markPaymentUsed({ paymentId, action, token_id: params.token_id || null, rail: 'exact', paymentTx: check.txHash, payer: paymentSender, at: new Date().toISOString() });
    const actionTx = result.txs && (result.txs.mint || result.txs.buy || result.txs.evolve || result.txs.breed) || '';
    const receipt = rail.signReceipt({
      v: 1, kind: 'action', paymentId, action, token_id: params.token_id || null,
      amountUsdc: String(exactPrice), rail: 'exact', network: 'near:testnet',
      transaction: actionTx, originTx: check.txHash, payer: paymentSender,
      timestamp: new Date(now).toISOString(), simulated: false,
    });
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, transaction: actionTx, payer: paymentSender, amount: String(exactPrice), network: 'near:testnet' })).toString('base64'));
    return res.status(200).json({ ok: true, mode: modeOk, ...result, priceNote, receipt });
  }

  // --- near-intents rail: PAYMENT-SIGNATURE (quote / deposit) ---
  if (sigRaw) {
    const presented = rail.parsePaymentSignature(sigRaw);
    if (!presented) {
      return payRequired(res, resource.url, accepts, 'PAYMENT-SIGNATURE is not a valid x402 v2 payload', 402);
    }
    const acc = presented.accepted;
    const isIntents = acc.extra && acc.extra.assetTransferMethod === 'near-intents';
    if (!isIntents) {
      return payRequired(res, resource.url, accepts, 'the exact rail takes paymentTx + paymentSender, not a PAYMENT-SIGNATURE — pay testnet USDC to the treasury, then retry with the tx hash', 402);
    }
    const origin = rail.findOrigin(acc.network, acc.asset);
    if (!origin) {
      return payRequired(res, resource.url, accepts, 'unknown origin network/asset in the presented offer', 402);
    }
    // Server terms always win: the presented entry must match one of
    // OUR offers for this action (same network, asset, and the amount
    // the server priced — a tampered price is refused).
    const ours = accepts.find((a) => a.network === acc.network && a.asset.toLowerCase() === String(acc.asset).toLowerCase()
      && a.extra && a.extra.assetTransferMethod === 'near-intents');
    if (!ours) {
      return payRequired(res, resource.url, accepts, 'the presented near-intents offer is not one of this action\'s offers', 402);
    }
    const payload = presented.payload || {};
    if (payload.type === 'quote') {
      const quoted = await rail.quoteForAction({
        origin, priceUsdcSmallest: intentsPrice, resource: resource.url,
        refundTo: payload.refundTo, slippageTolerance: payload.slippageTolerance,
        mode: modeOk, fetchImpl: global.fetch, now,
      });
      if (quoted.kind !== 'quoted') {
        return payRequired(res, resource.url, accepts, quoted.message, 402);
      }
      const quotedAccepts = accepts.map((a) => (a.network === origin.caip2 && a.asset.toLowerCase() === origin.x402Asset.toLowerCase() && a.extra && a.extra.assetTransferMethod === 'near-intents' ? quoted.quoted : a));
      const obj = rail.paymentRequiredObject({ resource: { url: resource.url }, accepts: quotedAccepts });
      res.setHeader('Payment-Required', JSON.stringify(obj));
      return res.status(402).json({
        ok: false, error: 'near-intents quote issued — deposit ' + (quoted.amountIn || '?') + ' ' + origin.symbol + ' to ' + quoted.depositAddress + ' on ' + origin.label + ', then present the deposit',
        step: 'deposit', quoted: quoted.quoted, x402: obj, resource: resource.url,
      });
    }
    if (payload.type === 'deposit') {
      const settled = await rail.settleDeposit({
        origin, operationToken: payload.operationToken, depositAddress: payload.depositAddress,
        depositMemo: payload.depositMemo, txHash: payload.txHash, resource: resource.url,
        priceUsdcSmallest: intentsPrice, mode: modeOk, fetchImpl: global.fetch, now,
      });
      if (settled.kind === 'pending') {
        res.setHeader('Retry-After', '5');
        return payRequired(res, resource.url, accepts, 'near-intents settlement is pending — retry with the same deposit in a few seconds', 402);
      }
      if (settled.kind !== 'settled') {
        return payRequired(res, resource.url, accepts, settled.message || 'near-intents payment did not settle', 402);
      }
      const instrument = settled.fields.operationId;
      const paymentId = 'intents:' + instrument;
      if (isPaymentUsed(paymentId)) {
        return payRequired(res, resource.url, accepts, 'this near-intents operation was already used for an action', 402);
      }
      const re = await validateAction(action, params);
      if (!re.ok) {
        return res.status(402).json({ ok: false, error: 'the action is no longer valid: ' + re.error + ' — the payment was NOT spent, present the deposit again for a corrected action', action });
      }
      if (action === 'buy') validation.listing = re.listing;
      let result;
      try {
        result = await executor(action, params, { listing: validation.listing });
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'payment settled but the action failed onchain: ' + String((e && e.message) || e).slice(0, 300), action, paymentId });
      }
      markPaymentUsed({ paymentId, action, token_id: params.token_id || null, rail: 'near-intents', originTx: settled.fields.originTx, destTx: settled.settle.transaction, payer: settled.fields.payer, at: new Date().toISOString() });
      const actionTx = result.txs && (result.txs.mint || result.txs.buy || result.txs.evolve || result.txs.breed) || '';
      const receipt = rail.signReceipt({
        v: 1, kind: 'action', paymentId, action, token_id: params.token_id || null,
        amountUsdc: String(intentsPrice), rail: 'near-intents', network: 'near:mainnet',
        transaction: actionTx, originTx: settled.fields.originTx, destTx: settled.settle.transaction,
        payer: settled.fields.payer, timestamp: new Date(now).toISOString(), simulated: settled.fields.simulated || false,
      });
      res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, transaction: actionTx, payer: settled.fields.payer, amount: String(intentsPrice), network: 'near:mainnet', extra: { originNetwork: origin.caip2, originTxHash: settled.fields.originTx } })).toString('base64'));
      return res.status(200).json({ ok: true, mode: modeOk, ...result, priceNote, receipt });
    }
    return payRequired(res, resource.url, accepts, 'unknown near-intents payload type (expected quote or deposit)', 402);
  }

  // --- no payment: the 402 (near-intents first, exact last) ---
  return payRequired(res, resource.url, accepts, null, 402);
};

module.exports._test = {
  setExecutor(fn) { executor = fn; },
  resetExecutor() { executor = defaultExecutor; },
  validateAction,
  priceBuyInUsdc,
  isPaymentUsed,
  EXACT_PRICES,
  INTENTS_PRICES,
};
