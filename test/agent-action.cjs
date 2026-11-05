// Tests for /api/agent-action (mint / breed / evolve / buy through
// the 402 payment rail) and the near-intents rail on /api/agent-premium.
// Everything is mocked: no 1Click, no RPC, no real funds, no chain.
// Run: node test/agent-action.cjs
//
// The mock fetch dispatches by URL: NEAR RPC view/tx calls, 1Click
// quote/status. The mock 1Click quote is signed with a TEST ed25519
// keypair and the rail's manager key is overridden to it, so the
// signature check runs for real on a fake quote. The mock executor
// records action executions without touching any chain.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.X402_ACTIONS_LOG = path.join(__dirname, '..', 'demo', 'x402-actions-test.json');
process.env.X402_PAYMENTS_LOG = path.join(__dirname, '..', 'demo', 'x402-payments-test.json');
process.env.OPERATION_TOKEN_SECRET = 'test-operation-secret-do-not-use-live';
// The mock 1Click quotes are addressed to this account; it does not
// need to exist for the mocked calls. Live, this is the real mainnet
// funding account (not created yet).
process.env.INTENTS_FUNDING_ACCOUNT = 'genesis-funding.near';

const rail = require('../api/near-intents-rail');
const actionHandler = require('../api/agent-action');
const premiumHandler = require('../api/agent-premium');

const TREASURY = 'genesisdemo354551.testnet';
const USDC_CONTRACT = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

// --- test ed25519 key (signs fake 1Click quotes) ---
const mgr = crypto.generateKeyPairSync('ed25519');
const mgrPubRaw = mgr.publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
const mgrPubB58 = rail.base58Encode(mgrPubRaw);
rail._test.setManagerKey('ed25519:' + mgrPubB58);

function hexToBase58(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  let n = BigInt('0x' + bytes.toString('hex'));
  let s = '';
  while (n > 0n) { const r = n % 58n; n /= 58n; s = B58[Number(r)] + s; }
  let pad = 0;
  for (const b of bytes) { if (b === 0) pad++; else break; }
  return '1'.repeat(pad) + (s || '');
}

function ftTransferArgs(receiver, amount) {
  return Buffer.from(JSON.stringify({ receiver_id: receiver, amount: String(amount), memo: null })).toString('base64');
}

// --- mock state ---
const TX_HEX = 'aa'.repeat(32);
const TX_HEX_2 = 'bb'.repeat(32);
const TX_HEX_3 = 'cc'.repeat(32);
const DEPOSIT_TX = 'ab'.repeat(32); // realistic 64-hex origin-chain deposit tx hash
const state = {
  // which tokens exist on the shared NFT contract
  tokens: { 'genesis-gen-2': true, 'genesis-gen-3': true, 'genesis-visitor-1': true, 'genesis-visitor-2': true },
  listings: [{ token_id: 'genesis-visitor-2', seller: 'clearsite587.testnet', price: '50000000000000000000000', listed_at: 1793875486830152400 }],
  // tx kind by hash hex: 'ok' | 'wrong-amount' | 'wrong-receiver' | 'failed' | 'not-usdc'
  txKind: { [TX_HEX]: 'ok', [TX_HEX_2]: 'wrong-amount', [TX_HEX_3]: 'wrong-receiver' },
  quoteMode: 'ok', // 'ok' | 'unavailable' (1Click NEAR outage) | 'bad-signature'
  statusMode: 'success', // 'success' | 'pending' | 'refunded'
  executorCalls: [],
};

function mockTx(kind) {
  if (kind === 'wrong-amount') {
    return {
      status: { SuccessValue: '' },
      transaction: { receiver_id: USDC_CONTRACT, signer_id: 'buyer.testnet', actions: [{ FunctionCall: { method_name: 'ft_transfer', args: ftTransferArgs(TREASURY, '5000'), gas: 100000000000000, deposit: '1' } }] },
    };
  }
  if (kind === 'wrong-receiver') {
    return {
      status: { SuccessValue: '' },
      transaction: { receiver_id: USDC_CONTRACT, signer_id: 'buyer.testnet', actions: [{ FunctionCall: { method_name: 'ft_transfer', args: ftTransferArgs('someone-else.testnet', '50000'), gas: 100000000000000, deposit: '1' } }] },
    };
  }
  if (kind === 'failed') {
    return { status: { Failure: { error: 'boom' } }, transaction: { receiver_id: USDC_CONTRACT, signer_id: 'buyer.testnet', actions: [] } };
  }
  if (kind === 'not-usdc') {
    return {
      status: { SuccessValue: '' },
      transaction: { receiver_id: 'some-other-contract.testnet', signer_id: 'buyer.testnet', actions: [{ FunctionCall: { method_name: 'ft_transfer', args: ftTransferArgs(TREASURY, '50000'), gas: 100000000000000, deposit: '1' } }] },
    };
  }
  // ok: 0.05 USDC to the treasury (covers the mint/breed/buy price)
  return {
    status: { SuccessValue: '' },
    transaction: { receiver_id: USDC_CONTRACT, signer_id: 'buyer.testnet', actions: [{ FunctionCall: { method_name: 'ft_transfer', args: ftTransferArgs(TREASURY, '50000'), gas: 100000000000000, deposit: '1' } }] },
  };
}

function mockView(contractId, method, args) {
  if (contractId === 'nft.primitives.testnet' && method === 'nft_token') {
    return state.tokens[args.token_id] ? { token_id: args.token_id, owner_id: 'owner.testnet' } : null;
  }
  if (contractId === 'core.genesisdemo354551.testnet' && method === 'get_agent') {
    const agents = {
      // Shape matches the real Core get_agent record: `status`,
      // not an `alive` boolean (the mock used to carry alive: true,
      // which hid a live bug where every breed was refused).
      'genesis-gen-2': { token_id: 'genesis-gen-2', generation: 2, owner_id: 'gen2.genesisdemo354551.testnet', status: 'Alive' },
      'genesis-gen-3': { token_id: 'genesis-gen-3', generation: 4, owner_id: 'gen3.genesisdemo354551.testnet', status: 'Alive' },
      // Split-brain: registered in the Core but the NFT was never
      // minted (this is the live genesis-visitor-4 state).
      'genesis-visitor-4': { token_id: 'genesis-visitor-4', generation: 0, owner_id: 'gen3.genesisdemo354551.testnet', status: 'Alive' },
      // Dead parent: breeding from it must be refused.
      'genesis-gen-8': { token_id: 'genesis-gen-8', generation: 8, owner_id: 'gen2.genesisdemo354551.testnet', status: 'Dead' },
    };
    return agents[args.token_id] || null;
  }
  if (contractId === 'core.genesisdemo354551.testnet' && method === 'get_evolve_status') {
    if (args.token_id === 'genesis-gen-3') return { token_id: 'genesis-gen-3', generation: 4, wins_since_evolution: 0, can_evolve: false };
    if (args.token_id === 'genesis-gen-2') return { token_id: 'genesis-gen-2', generation: 2, wins_since_evolution: 0, can_evolve: false };
    if (args.token_id === 'genesis-gen-9') return { token_id: 'genesis-gen-9', generation: 2, wins_since_evolution: 3, can_evolve: true };
    return null;
  }
  if (contractId === 'core.genesisdemo354551.testnet' && method === 'get_listings') {
    return state.listings;
  }
  return null;
}

function signedFakeQuote(qreq) {
  // amountOut follows the request: for EXACT_INPUT it is the input
  // amount converted at $1/NEAR (the buy-pricing dry quote); for
  // EXACT_OUTPUT it is the requested USDC amount.
  const amountOut = qreq.swapType === 'EXACT_INPUT'
    ? String(Math.max(1, Math.round(Number(qreq.amount) * 1e-24 * 1e6)))
    : qreq.amount;
  // EXACT_OUTPUT: the payer deposits ~2% over the requested USDC
  // (bridge fee); EXACT_INPUT: the deposit is the requested amount.
  const amountIn = qreq.swapType === 'EXACT_INPUT' ? qreq.amount : String(Math.ceil(Number(qreq.amount) * 1.02));
  const q = {
    amountIn, amountInFormatted: String(Number(amountIn) / 1e6), amountInUsd: String(Number(amountIn) / 1e6), minAmountIn: qreq.amount,
    amountOut, amountOutFormatted: String(Number(amountOut) / 1e6), amountOutUsd: String(Number(amountOut) / 1e6), minAmountOut: String(Math.round(Number(amountOut) * 0.99)),
    depositAddress: '0x2222222222222222222222222222222222222222',
    deadline: qreq.deadline, timeWhenInactive: qreq.deadline, timeEstimate: 300, refundFee: '0', withdrawFee: '0',
  };
  const resp = {
    quoteRequest: { ...qreq },
    quote: q,
    timestamp: new Date().toISOString(),
    correlationId: 'test-corr-1',
  };
  const hash = rail.quoteHash(resp);
  const sig = crypto.sign(null, Buffer.from(hash, 'utf8'), mgr.privateKey);
  resp.signature = state.quoteMode === 'bad-signature' ? rail.base58Encode(crypto.randomBytes(64)) : rail.base58Encode(sig);
  return resp;
}

const mockFetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  if (String(url).includes('rpc.testnet.near.org')) {
    if (body.method === 'tx') {
      const hash58 = body.params[0];
      // reverse the base58 back to hex via the premium helper
      const hex = premiumHandler._test.base58ToHex(hash58);
      const kind = state.txKind[hex] || 'unknown';
      if (kind === 'unknown') return { ok: false, status: 404, json: async () => ({ error: { message: 'tx not found' } }) };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', result: mockTx(kind) }) };
    }
    if (body.method === 'query') {
      const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8'));
      const value = mockView(body.params.account_id, body.params.method_name, args);
      const bytes = value === null ? [] : Array.from(Buffer.from(JSON.stringify(value)));
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', result: { result: bytes } }) };
    }
  }
  if (String(url).includes('1click.chaindefuser.com/v0/quote')) {
    if (state.quoteMode === 'unavailable') {
      return { ok: false, status: 400, json: async () => ({ message: 'Quoting for this pair is not available', correlationId: 'test-corr-2' }) };
    }
    return { ok: true, status: 200, json: async () => signedFakeQuote(body) };
  }
  if (String(url).includes('1click.chaindefuser.com/v0/status')) {
    if (state.statusMode === 'pending') {
      return { ok: true, status: 200, json: async () => ({ status: 'PENDING_DEPOSIT', swapDetails: {}, quoteResponse: { quoteRequest: { recipient: 'genesis-funding.near', destinationAsset: rail.DESTINATION_ASSET, amount: '500000' }, quote: { amountIn: '530000', amountInUsd: '0.53' } } }) };
    }
    if (state.statusMode === 'refunded') {
      return { ok: true, status: 200, json: async () => ({ status: 'REFUNDED', swapDetails: { originChainTxHashes: [{ hash: DEPOSIT_TX }], refundReason: 'INSUFFICIENT_DEPOSIT', refundedAmount: '100000' }, quoteResponse: { quoteRequest: { recipient: 'genesis-funding.near', destinationAsset: rail.DESTINATION_ASSET, amount: '500000' }, quote: { amountIn: '530000', amountInUsd: '0.53' } } }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        status: 'SUCCESS',
        swapDetails: {
          originChainTxHashes: [{ hash: DEPOSIT_TX }],
          destinationChainTxHashes: [{ hash: 'destTxHash123' }],
          amountIn: '530000', amountInUsd: '0.53', amountOutUsd: '1.5',
        },
        quoteResponse: {
          quoteRequest: { recipient: 'genesis-funding.near', destinationAsset: rail.DESTINATION_ASSET, amount: '500000', refundTo: '0x1111111111111111111111111111111111111111' },
          quote: { amountIn: '530000', amountInUsd: '0.53' },
        },
      }),
    };
  }
  throw new Error('unexpected fetch: ' + url);
};

// Mock executor: records the call and returns a fake onchain result.
async function mockExecutor(action, params, ctx) {
  state.executorCalls.push({ action, params, ctx });
  const txs = {};
  if (action === 'mint') { txs.birth = 'birthTxMock'; txs.mint = 'mintTxMock'; return { action, token_id: params.token_id, generation: 0, owner: params.receiver || TREASURY, txs }; }
  if (action === 'breed') { txs.breed = 'breedTxMock'; txs.mint = 'mintTxMock'; return { action, token_id: params.token_id, generation: 5, owner: params.receiver || TREASURY, parents: [params.parent1, params.parent2], txs }; }
  if (action === 'evolve') { txs.evolve = 'evolveTxMock'; return { action, token_id: params.token_id, generation: 3, txs }; }
  if (action === 'buy') { txs.buy = 'buyTxMock'; return { action, token_id: params.token_id, owner: params.receiver || TREASURY, seller: ctx.listing.seller, price_near: '0.05', txs }; }
  throw new Error('unknown action in mock');
}

async function call(handler, query, body) {
  const origFetch = global.fetch;
  global.fetch = mockFetch;
  let status = 0;
  let payload = null;
  const headers = {};
  const req = { method: body ? 'POST' : 'GET', query: query || {}, body, headers: { host: 'genesis-roan-eta.vercel.app', 'x-forwarded-proto': 'https' } };
  const res = {
    status(code) { status = code; return this; },
    setHeader(k, v) { headers[k] = v; },
    json(obj) { payload = obj; },
  };
  try {
    await handler(req, res);
  } finally {
    global.fetch = origFetch;
  }
  return { status, payload, headers };
}

function acceptsOf(payload) {
  const x = payload && payload.x402;
  return x && Array.isArray(x.accepts) ? x.accepts : null;
}

function sigPayload(accepted, payloadObj) {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: payloadObj })).toString('base64');
}

async function main() {
  console.log('agent-action tests');
  // Fresh logs for this run (the in-memory sets are fresh per process).
  for (const f of [process.env.X402_ACTIONS_LOG, process.env.X402_PAYMENTS_LOG]) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  actionHandler._test.setExecutor(mockExecutor);

  // 1. mint, no payment -> 402 with BOTH rails, near-intents first.
  let r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9' });
  let accepts = acceptsOf(r.payload);
  check('mint without payment returns 402', r.status === 402, 'got ' + r.status);
  check('402 has 7 accepts (6 near-intents + 1 exact)', accepts && accepts.length === 7, 'got ' + (accepts && accepts.length));
  check('near-intents entries come first (primary)', accepts && accepts.slice(0, 6).every((a) => a.extra && a.extra.assetTransferMethod === 'near-intents'));
  check('exact entry is last (secondary)', accepts && accepts[6].network === 'near:testnet' && accepts[6].amount === '50000');
  check('mint near-intents price is cost-covering (0.50 USDC = 0.15 NEAR)', accepts && accepts.slice(0, 6).every((a) => a.extra && a.extra.destination && a.extra.destination.amount === '500000'), 'got ' + (accepts && accepts[0] && accepts[0].extra && accepts[0].extra.destination && accepts[0].extra.destination.amount));
  check('header and body carry the same 402 object (base64)', r.headers['Payment-Required'] && JSON.parse(Buffer.from(r.headers['Payment-Required'], 'base64').toString('utf8')).accepts.length === 7);
  r = await call(actionHandler, { action: 'breed', token_id: 'genesis-gen-5', parent1: 'genesis-gen-2', parent2: 'genesis-gen-3' });
  accepts = acceptsOf(r.payload);
  check('breed without payment returns 402', r.status === 402, 'got ' + r.status);
  check('breed near-intents price is cost-covering (0.50 USDC = 0.15 NEAR)', accepts && accepts.slice(0, 6).every((a) => a.extra && a.extra.destination && a.extra.destination.amount === '500000'), 'got ' + (accepts && accepts[0] && accepts[0].extra && accepts[0].extra.destination && accepts[0].extra.destination.amount));
  // Regression: the liveness check reads the Core `status` field,
  // not an `alive` boolean. A dead parent is refused (400); living
  // parents pass (the 402 above).
  r = await call(actionHandler, { action: 'breed', token_id: 'genesis-gen-6', parent1: 'genesis-gen-8', parent2: 'genesis-gen-3' });
  check('breed with a dead parent returns 400', r.status === 400, 'got ' + r.status);

  // 2. Invalid actions are refused BEFORE any payment (400, not 402).
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-2' });
  check('mint of an existing token returns 400', r.status === 400, 'got ' + r.status);
  r = await call(actionHandler, { action: 'evolve', token_id: 'genesis-gen-3' });
  check('evolve of an ineligible agent returns 400', r.status === 400, 'got ' + r.status);
  r = await call(actionHandler, { action: 'buy', token_id: 'genesis-gen-2' });
  check('buy of an unlisted token returns 400', r.status === 400, 'got ' + r.status);
  r = await call(actionHandler, { action: 'breed', token_id: 'genesis-gen-5', parent1: 'genesis-gen-2', parent2: 'genesis-gen-2' });
  check('breed with the same parent twice returns 400', r.status === 400, 'got ' + r.status);
  r = await call(actionHandler, { action: 'dance' });
  check('unknown action returns 400', r.status === 400, 'got ' + r.status);

  // 2b. Split-brain completion: genesis-visitor-4 is registered in
  // the Core (owner gen3) but has no NFT. The 402 IS offered when
  // the receiver matches the Core owner (the action completes the
  // mint); a mismatched receiver is refused before any payment.
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-4', receiver: 'gen3.genesisdemo354551.testnet' });
  check('split-brain mint is offered to the Core owner (402)', r.status === 402, 'got ' + r.status);
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-4', receiver: 'gen2.genesisdemo354551.testnet' });
  check('split-brain mint to a different receiver returns 400', r.status === 400, 'got ' + r.status);
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-4' });
  check('split-brain mint with no receiver (defaults to treasury) returns 400', r.status === 400, 'got ' + r.status);
  const vSplit = await actionHandler._test.validateAction('mint', { token_id: 'genesis-visitor-4', receiver: 'gen3.genesisdemo354551.testnet' }, async (c, m, a) => mockView(c, m, a));
  check('split-brain validation flags completeOnly', vSplit.ok === true && vSplit.completeOnly === true, JSON.stringify(vSplit));

  // 3. Valid exact payment -> 200, action executed, signed receipt.
  state.executorCalls = [];
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentTx: TX_HEX, paymentSender: 'buyer.testnet' });
  check('valid exact payment executes mint (200)', r.status === 200 && r.payload && r.payload.token_id === 'genesis-visitor-9', 'got ' + r.status + ' ' + JSON.stringify(r.payload).slice(0, 200));
  check('mock executor was called for mint', state.executorCalls.length === 1 && state.executorCalls[0].action === 'mint');
  check('receipt verifies', r.payload && rail.verifyReceipt(r.payload.receipt) === true);
  check('receipt is not simulated', r.payload && r.payload.receipt.body.simulated === false);
  check('receipt names the exact rail', r.payload && r.payload.receipt.body.rail === 'exact');
  check('PAYMENT-RESPONSE header is set', !!r.headers['PAYMENT-RESPONSE']);

  // 4. Reused payment -> 402 (dedup).
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentTx: TX_HEX, paymentSender: 'buyer.testnet' });
  check('reused payment returns 402', r.status === 402, 'got ' + r.status);

  // 5. Same payment via base58 hash -> also dedup (hex/base58 canonicalisation).
  const b58 = hexToBase58(TX_HEX);
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentTx: b58, paymentSender: 'buyer.testnet' });
  check('same payment in base58 form returns 402', r.status === 402, 'got ' + r.status);

  // 6. Wrong amount / wrong receiver -> 402.
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentTx: TX_HEX_2, paymentSender: 'buyer.testnet' });
  check('wrong amount returns 402', r.status === 402, 'got ' + r.status);
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentTx: TX_HEX_3, paymentSender: 'buyer.testnet' });
  check('wrong receiver returns 402', r.status === 402, 'got ' + r.status);

  // 7. near-intents quote flow (mock 1Click, test-signed quote).
  const first402 = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9' });
  const firstAccepts = acceptsOf(first402.payload);
  const arbOffer = firstAccepts.find((a) => a.network === 'eip155:42161' && a.asset === '0xaf88d065e77c8cc2239327c5edb3a432268e5831');
  check('Arbitrum USDC near-intents offer exists', !!arbOffer);
  const quoteSig = sigPayload(arbOffer, { type: 'quote', refundTo: '0x1111111111111111111111111111111111111111' });
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentSignature: quoteSig });
  check('near-intents quote returns a quoted 402', r.status === 402 && r.payload && r.payload.step === 'deposit', 'got ' + r.status + ' ' + JSON.stringify(r.payload).slice(0, 200));
  const quoted = r.payload && r.payload.quoted;
  check('quoted entry has a deposit address', quoted && quoted.payTo === '0x2222222222222222222222222222222222222222');
  check('quoted entry has an operation token', quoted && quoted.extra && typeof quoted.extra.operationToken === 'string');
  check('quoted entry keeps the near-intents method', quoted && quoted.extra && quoted.extra.assetTransferMethod === 'near-intents');
  check('quote step is not simulated', r.payload && r.payload.quoted && r.payload.quoted.extra.simulated !== true);

  // 8. near-intents deposit flow -> 200, action executed, receipt.
  state.executorCalls = [];
  const depositSig = sigPayload(quoted, {
    type: 'deposit', operationToken: quoted.extra.operationToken,
    depositAddress: quoted.payTo, txHash: DEPOSIT_TX,
  });
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentSignature: depositSig });
  check('near-intents deposit settles and executes mint (200)', r.status === 200 && r.payload && r.payload.token_id === 'genesis-visitor-9', 'got ' + r.status + ' ' + JSON.stringify(r.payload).slice(0, 200));
  check('mock executor was called for the near-intents mint', state.executorCalls.length === 1);
  check('near-intents receipt verifies', r.payload && rail.verifyReceipt(r.payload.receipt) === true);
  check('near-intents receipt names the rail', r.payload && r.payload.receipt.body.rail === 'near-intents');

  // 9. Same near-intents operation again -> 402 (exactly-once).
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentSignature: depositSig });
  check('replayed near-intents deposit returns 402', r.status === 402, 'got ' + r.status);

  // 10. Tampered operation token -> 402.
  const badDepositSig = sigPayload(quoted, {
    type: 'deposit', operationToken: quoted.extra.operationToken.slice(0, -1) + 'X',
    depositAddress: quoted.payTo, txHash: DEPOSIT_TX,
  });
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentSignature: badDepositSig });
  check('tampered operation token returns 402', r.status === 402, 'got ' + r.status);

  // 11. 1Click outage surfaces honestly (quote step fails with the real error).
  state.quoteMode = 'unavailable';
  const quoteSig2 = sigPayload(arbOffer, { type: 'quote', refundTo: '0x1111111111111111111111111111111111111111' });
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentSignature: quoteSig2 });
  check('1Click outage returns a 402 with the real error', r.status === 402 && r.payload && String(r.payload.error || '').includes('Quoting for this pair is not available'), 'got ' + r.status + ' ' + JSON.stringify(r.payload).slice(0, 200));
  state.quoteMode = 'ok';

  // 12. Bad quote signature is refused.
  state.quoteMode = 'bad-signature';
  const quoteSig3 = sigPayload(arbOffer, { type: 'quote', refundTo: '0x1111111111111111111111111111111111111111' });
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentSignature: quoteSig3 });
  check('bad quote signature returns 402', r.status === 402 && r.payload && String(r.payload.error || '').includes('signature'), 'got ' + r.status + ' ' + JSON.stringify(r.payload).slice(0, 200));
  state.quoteMode = 'ok';

  // 13. Pending settlement -> 402 with Retry-After.
  state.statusMode = 'pending';
  const quoteSig4 = sigPayload(arbOffer, { type: 'quote', refundTo: '0x1111111111111111111111111111111111111111' });
  const q4 = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentSignature: quoteSig4 });
  const dep4 = sigPayload(q4.payload.quoted, { type: 'deposit', operationToken: q4.payload.quoted.extra.operationToken, depositAddress: q4.payload.quoted.payTo, txHash: DEPOSIT_TX });
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', paymentSignature: dep4 });
  check('pending settlement returns 402 with Retry-After', r.status === 402 && r.headers['Retry-After'] === '5', 'got ' + r.status);
  state.statusMode = 'success';

  // 14. Demo mode: simulated payment -> 200, labelled simulated.
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', mode: 'demo', paymentTx: 'sim:demo-tx-1', paymentSender: 'sim-payer.testnet' });
  check('demo mode simulated payment returns 200', r.status === 200 && r.payload && r.payload.simulated === true, 'got ' + r.status + ' ' + JSON.stringify(r.payload).slice(0, 200));
  check('demo receipt is labelled simulated', r.payload && r.payload.receipt.body.simulated === true);
  r = await call(actionHandler, { action: 'mint', token_id: 'genesis-visitor-9', mode: 'demo', paymentTx: 'sim:demo-tx-1', paymentSender: 'sim-payer.testnet' });
  check('demo simulated payment replays to 402', r.status === 402, 'got ' + r.status);

  // 15. buy action via the exact rail (mocked listing + executor).
  state.executorCalls = [];
  const TX_HEX_4 = 'dd'.repeat(32);
  state.txKind[TX_HEX_4] = 'ok';
  r = await call(actionHandler, { action: 'buy', token_id: 'genesis-visitor-2', paymentTx: TX_HEX_4, paymentSender: 'buyer.testnet' });
  check('buy of a listed token executes (200)', r.status === 200 && r.payload && r.payload.seller === 'clearsite587.testnet', 'got ' + r.status + ' ' + JSON.stringify(r.payload).slice(0, 200));

  // 16. Premium endpoint: 402 now offers both rails, near-intents first.
  r = await call(premiumHandler, { token_id: 'genesis-gen-3' });
  const pAccepts = acceptsOf(r.payload);
  check('premium 402 has 7 accepts', r.status === 402 && pAccepts && pAccepts.length === 7, 'got ' + r.status);
  check('premium near-intents entries come first', pAccepts && pAccepts.slice(0, 6).every((a) => a.extra && a.extra.assetTransferMethod === 'near-intents'));
  check('premium exact entry is last (0.01 testnet USDC)', pAccepts && pAccepts[6].network === 'near:testnet' && pAccepts[6].amount === '10000');
  check('premium exact price is unchanged', premiumHandler._test.PRICE_USDC_SMALLEST === '10000');

  // 17. Premium endpoint: valid exact payment still serves the CV (200).
  const TX_HEX_5 = 'ee'.repeat(32);
  state.txKind[TX_HEX_5] = 'ok';
  r = await call(premiumHandler, { token_id: 'genesis-gen-3', paymentTx: TX_HEX_5, paymentSender: 'buyer.testnet' });
  check('premium exact payment still serves the CV (200)', r.status === 200 && r.payload && r.payload.premium === true, 'got ' + r.status + ' ' + JSON.stringify(r.payload).slice(0, 200));
  check('premium 200 carries a signed receipt', r.payload && rail.verifyReceipt(r.payload.receipt) === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
