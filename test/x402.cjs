// Test api/agent-premium.js (x402 gate) with mocked NEAR RPC — no real
// funds, no live RPC calls. The live behaviour (402 without payment,
// onchain verification of a real ft_transfer) is documented in
// docs/X402.md; these tests pin the route's logic.
//
// The payments log is pointed at a temp file so the tests never pollute
// the real demo/x402-payments.json (an earlier run recorded a fake hash
// there and then failed its own dedup check on re-run).
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP_LOG = path.join(os.tmpdir(), 'x402-test-payments-' + process.pid + '.json');
fs.writeFileSync(TMP_LOG, JSON.stringify({ payments: [] }));
process.env.X402_PAYMENTS_LOG = TMP_LOG;
const handler = require('../api/agent-premium');
const { USDC_CONTRACT, TREASURY_ACCOUNT } = require('../api/agent-premium')._test;

function fail(msg) { console.log('FAIL:', msg); process.exit(1); }

// A fake ft_transfer args payload: 0.01 USDC to the treasury.
function ftTransferArgs(receiver, amount) {
  return Buffer.from(JSON.stringify({ receiver_id: receiver, amount: String(amount) })).toString('base64');
}

// Mock fetch that answers the RPC `tx` method and the `query`
// (get_agent) method. txKind selects the transaction shape.
function mockFetch(txKind) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'tx') {
      let tx;
      if (txKind === 'good') {
        tx = {
          status: { SuccessValue: '' },
          transaction: {
            receiver_id: USDC_CONTRACT,
            signer_id: 'buyer.testnet',
            actions: [{ FunctionCall: { method_name: 'ft_transfer', args: ftTransferArgs(TREASURY_ACCOUNT, '10000'), gas: 100000000000000, deposit: '1' } }],
          },
        };
      } else if (txKind === 'wrong-amount') {
        tx = {
          status: { SuccessValue: '' },
          transaction: {
            receiver_id: USDC_CONTRACT,
            signer_id: 'buyer.testnet',
            actions: [{ FunctionCall: { method_name: 'ft_transfer', args: ftTransferArgs(TREASURY_ACCOUNT, '5000'), gas: 100000000000000, deposit: '1' } }],
          },
        };
      } else if (txKind === 'wrong-receiver') {
        tx = {
          status: { SuccessValue: '' },
          transaction: {
            receiver_id: USDC_CONTRACT,
            signer_id: 'buyer.testnet',
            actions: [{ FunctionCall: { method_name: 'ft_transfer', args: ftTransferArgs('someone-else.testnet', '10000'), gas: 100000000000000, deposit: '1' } }],
          },
        };
      } else if (txKind === 'failed') {
        tx = { status: { Failure: { error: 'boom' } }, transaction: { receiver_id: USDC_CONTRACT, signer_id: 'buyer.testnet', actions: [] } };
      } else if (txKind === 'not-usdc') {
        tx = {
          status: { SuccessValue: '' },
          transaction: {
            receiver_id: 'some-other-contract.testnet',
            signer_id: 'buyer.testnet',
            actions: [{ FunctionCall: { method_name: 'ft_transfer', args: ftTransferArgs(TREASURY_ACCOUNT, '10000'), gas: 100000000000000, deposit: '1' } }],
          },
        };
      } else {
        throw new Error('tx not found');
      }
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', result: tx }) };
    }
    if (body.method === 'query') {
      const agent = {
        token_id: 'genesis-gen-3', generation: 3, owner_id: 'gen3.genesisdemo354551.testnet',
        wins: 1, jobs_done: 1, earned: '10000000000000000000000', alive: true,
      };
      return {
        ok: true, status: 200,
        json: async () => ({ jsonrpc: '2.0', result: { result: Array.from(Buffer.from(JSON.stringify(agent))) } }),
      };
    }
    throw new Error('unexpected RPC method: ' + body.method);
  };
}

async function call(query, fetchImpl) {
  const origFetch = global.fetch;
  global.fetch = fetchImpl;
  let status = 0;
  let payload = null;
  const headers = {};
  const req = { method: 'GET', query };
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

// Distinct valid hex tx hashes per test (dedup is by hash).
const TX1 = 'a'.repeat(64);
const TX2 = 'b'.repeat(64);
const TX3 = 'c'.repeat(64);
const TX4 = 'd'.repeat(64);
const TX5 = 'e'.repeat(64);

(async () => {
  // 1. No payment -> 402 with a PAYMENT-REQUIRED header and x402 body.
  let r = await call({ token_id: 'genesis-gen-3' }, mockFetch('good'));
  console.log('1. no payment:', r.status, JSON.stringify(r.payload).slice(0, 400));
  if (r.status !== 402) fail('no-payment request was not 402');
  if (!r.headers['PAYMENT-REQUIRED']) fail('402 response has no PAYMENT-REQUIRED header');
  const required = JSON.parse(Buffer.from(r.headers['PAYMENT-REQUIRED'], 'base64').toString('utf8'));
  if (required.x402Version !== 2) fail('PAYMENT-REQUIRED is not x402 v2');
  if (required.accepts[0].scheme !== 'exact') fail('scheme is not exact');
  if (required.accepts[0].network !== 'near:testnet') fail('network is not near:testnet');
  if (required.accepts[0].asset !== USDC_CONTRACT) fail('asset is not testnet USDC');
  if (required.accepts[0].recipient !== TREASURY_ACCOUNT) fail('recipient is not the treasury');
  if (required.accepts[0].amount !== '10000') fail('amount is not 10000 (0.01 USDC)');
  if (!Array.isArray(r.payload.howToPay) || r.payload.howToPay.length < 3) fail('402 body has no payment instructions');

  // 2. Valid payment -> 200 with the premium CV + PAYMENT-RESPONSE.
  r = await call({ token_id: 'genesis-gen-3', paymentTx: TX1, paymentSender: 'buyer.testnet' }, mockFetch('good'));
  console.log('2. valid payment:', r.status, JSON.stringify(r.payload).slice(0, 400));
  if (r.status !== 200) fail('valid payment was not 200: ' + JSON.stringify(r.payload));
  if (r.payload.ok !== true || r.payload.premium !== true) fail('valid payment did not return the premium CV');
  if (!r.payload.agent || r.payload.agent.token_id !== 'genesis-gen-3') fail('premium CV agent record wrong');
  if (!r.headers['PAYMENT-RESPONSE']) fail('200 response has no PAYMENT-RESPONSE header');
  if (r.payload.paidWith.txHash !== TX1) fail('paidWith tx hash wrong');

  // 3. Same tx hash again -> 402 (one payment buys one access).
  r = await call({ token_id: 'genesis-gen-3', paymentTx: TX1, paymentSender: 'buyer.testnet' }, mockFetch('good'));
  console.log('3. reused tx hash:', r.status, JSON.stringify(r.payload).slice(0, 200));
  if (r.status !== 402) fail('reused tx hash was not 402');

  // 4. Too-small amount -> 402.
  r = await call({ token_id: 'genesis-gen-3', paymentTx: TX2, paymentSender: 'buyer.testnet' }, mockFetch('wrong-amount'));
  console.log('4. too-small amount:', r.status, JSON.stringify(r.payload).slice(0, 200));
  if (r.status !== 402) fail('too-small payment was not 402');

  // 5. Wrong receiver -> 402.
  r = await call({ token_id: 'genesis-gen-3', paymentTx: TX3, paymentSender: 'buyer.testnet' }, mockFetch('wrong-receiver'));
  console.log('5. wrong receiver:', r.status, JSON.stringify(r.payload).slice(0, 200));
  if (r.status !== 402) fail('payment to the wrong receiver was not 402');

  // 6. Failed transaction -> 402.
  r = await call({ token_id: 'genesis-gen-3', paymentTx: TX4, paymentSender: 'buyer.testnet' }, mockFetch('failed'));
  console.log('6. failed tx:', r.status, JSON.stringify(r.payload).slice(0, 200));
  if (r.status !== 402) fail('failed transaction was not 402');

  // 7. Call to a different contract -> 402.
  r = await call({ token_id: 'genesis-gen-3', paymentTx: TX5, paymentSender: 'buyer.testnet' }, mockFetch('not-usdc'));
  console.log('7. not the USDC contract:', r.status, JSON.stringify(r.payload).slice(0, 200));
  if (r.status !== 402) fail('non-USDC transaction was not 402');

  // 8. Bad tx hash format -> 402.
  r = await call({ token_id: 'genesis-gen-3', paymentTx: 'not-a-hash', paymentSender: 'buyer.testnet' }, mockFetch('good'));
  console.log('8. bad tx hash:', r.status, JSON.stringify(r.payload).slice(0, 200));
  if (r.status !== 402) fail('bad tx hash was not 402');

  // 9. Bad token id -> 400.
  r = await call({ token_id: 'not a token!' }, mockFetch('good'));
  console.log('9. bad token id:', r.status, JSON.stringify(r.payload).slice(0, 200));
  if (r.status !== 400) fail('bad token id was not 400');

  // 10. Base58 tx hash (as shown on Nearblocks) -> 200, canonicalised
  // to hex in paidWith. This is the real payment hash from the live
  // end-to-end test: base58 9eAGcsjorP2MViC5bKXFfXRhFi6SJai3A7oE1fMRSku
  // == hex 0236a9c81bce0ea5af79057b57863d67a41526cbaa8b144c785741619bceb7b6.
  const B58_TX = '9eAGcsjorP2MViC5bKXFfXRhFi6SJai3A7oE1fMRSku';
  const HEX_TX = '0236a9c81bce0ea5af79057b57863d67a41526cbaa8b144c785741619bceb7b6';
  r = await call({ token_id: 'genesis-gen-3', paymentTx: B58_TX, paymentSender: 'buyer.testnet' }, mockFetch('good'));
  console.log('10. base58 tx hash:', r.status, JSON.stringify(r.payload).slice(0, 200));
  if (r.status !== 200) fail('base58 tx hash was not 200: ' + JSON.stringify(r.payload));
  if (r.payload.paidWith.txHash !== HEX_TX) fail('base58 hash was not canonicalised to hex: ' + r.payload.paidWith.txHash);

  // 11. The same payment in hex form now dedups against the base58 one.
  r = await call({ token_id: 'genesis-gen-3', paymentTx: HEX_TX, paymentSender: 'buyer.testnet' }, mockFetch('good'));
  console.log('11. hex form of the same tx:', r.status, JSON.stringify(r.payload).slice(0, 200));
  if (r.status !== 402) fail('hex form of an already-used base58 tx was not 402');

  console.log('ALL CHECKS PASSED');
  try { fs.unlinkSync(TMP_LOG); } catch (_) {}
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
