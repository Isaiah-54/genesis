// Test the Genesis app.js wallet layer with a mocked DOM + mocked @fastnear/wallet.
// Covers the bugs found on the live site:
//  1. Connect button showed the stringified accountId FUNCTION.
//  2. Mint failed: "No wallet connected on testnet. Call connect({ network: "testnet" }) first."
//  3. After connecting, navigating to another page asked to connect again:
//     the library defaults to MAINNET on every fresh page load, so restore()
//     with no options looks at the (empty) mainnet session instead of testnet.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const calls = { connect: [], restore: [], disconnect: [], sendTransaction: [], payJob: [] };
const POLLINATIONS_OUTPUT = 'NEAR is a blockchain where anyone can mint an NFT. The shared NFT contract on NEAR testnet lets an agent mint a token with metadata. To mint, call nft_mint with a token id and a receiver. NEAR NFTs follow the NEP-171 standard and the mint deposit covers storage.';

// One shared mocked wallet, like localStorage surviving a page navigation.
const sharedWallet = {
  _id: null,
  // accountId is a FUNCTION in the real library — the bug was assigning it
  // directly instead of calling it / using connect()'s return value.
  accountId(opts) { return this._id || null; },
  async connect({ network }) {
    calls.connect.push(network);
    this._id = 'isaiah.testnet';
    return { accountId: 'isaiah.testnet' };
  },
  async restore(opts) {
    // Real library: resolves options?.network ?? activeNetwork, and
    // activeNetwork defaults to "mainnet" on a fresh page load.
    const network = (opts && opts.network) || 'mainnet';
    calls.restore.push(network);
    if (network === 'testnet' && this._id) return { accountId: this._id };
    return null;
  },
  async disconnect(opts) {
    const network = (opts && opts.network) || 'mainnet';
    calls.disconnect.push(network);
    if (network === 'testnet') this._id = null;
  },
  async sendTransaction(tx) {
    calls.sendTransaction.push(tx);
    if (!this._id) throw new Error('No wallet connected on testnet. Call connect({ network: "testnet" }) first.');
    return { transaction: { hash: 'testhash123' } };
  },
};

function loadPage() {
  const elements = {};
  function makeEl(id) {
    return {
      id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
      classList: { add() {}, remove() {} },
      listeners: {},
      addEventListener(ev, fn) { this.listeners[ev] = fn; },
    };
  }
  const documentStub = {
    getElementById(id) { return (elements[id] ||= makeEl(id)); },
    querySelectorAll(sel) {
      if (sel === '#walletBtn') return [this.getElementById('walletBtn')];
      return [];
    },
  };
  const windowListeners = {};
  const sandbox = {
    document: documentStub,
    console,
    navigator: {},
    fetch: async (url, opts) => {
      if (typeof url === 'string' && url.startsWith('https://text.pollinations.ai/')) {
        return { ok: true, text: async () => POLLINATIONS_OUTPUT };
      }
      if (url === '/api/pay-job') {
        calls.payJob.push(JSON.parse(opts.body));
        return { json: async () => ({ ok: true, verdict: 'PASS', pay_tx: 'payhash123', output_hash: 'abc' }) };
      }
      // Simulated testnet RPC: only genesis-visitor-1 already exists.
      let tokenId = '';
      try {
        const body = JSON.parse(opts.body);
        tokenId = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString()).token_id;
      } catch (_) {}
      const payload = tokenId === 'genesis-visitor-1'
        ? { token_id: 'genesis-visitor-1', owner_id: 'otoyo4real.testnet' }
        : null;
      const bytes = Array.from(Buffer.from(JSON.stringify(payload)));
      return { json: async () => ({ result: { result: bytes } }) };
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    crypto: globalThis.crypto,
  };
  sandbox.window = {
    document: documentStub,
    crypto: globalThis.crypto,
    nearWallet: sharedWallet,
    addEventListener(ev, fn) { windowListeners[ev] = fn; },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { elements, windowListeners, $: (id) => documentStub.getElementById(id) };
}

function fail(msg) { console.log('FAIL:', msg); process.exit(1); }

(async () => {
  // Page 1: load, then connect.
  const page1 = loadPage();
  await page1.windowListeners.load();
  const btn1 = page1.$('walletBtn');
  console.log('1. page 1 after load, button:', JSON.stringify(btn1.textContent));
  await btn1.listeners.click();
  console.log('2. page 1 after connect, button:', JSON.stringify(btn1.textContent));
  console.log('   connect called with:', JSON.stringify(calls.connect));
  if (btn1.textContent !== 'isaiah.testnet') fail('button is not the account id string');
  if (btn1.textContent.includes('function accountId')) fail('button shows the function source');

  // Page 2: fresh load (new DOM, same wallet session) — the reported bug.
  const page2 = loadPage();
  await page2.windowListeners.load();
  const btn2 = page2.$('walletBtn');
  console.log('3. page 2 after load (no click), button:', JSON.stringify(btn2.textContent));
  console.log('   restore called with:', JSON.stringify(calls.restore));
  if (btn2.textContent !== 'isaiah.testnet') fail('connection lost on navigation — restore did not find the testnet session');

  // Mint from page 2 without re-connecting.
  page2.$('mintToken').value = 'genesis-test-1';
  page2.$('mintTitle').value = 'Genesis Test';
  page2.$('mintGen').value = '0';
  page2.$('mintParent').value = 'treasury';
  await page2.$('mintBtn').listeners.click();
  const tx = calls.sendTransaction[0];
  console.log('4. sendTransaction calls:', calls.sendTransaction.length,
    '| receiver:', tx && tx.receiverId, '| action:', tx && tx.actions[0].type, tx && tx.actions[0].methodName);
  if (!tx || tx.receiverId !== 'nft.primitives.testnet' || tx.actions[0].methodName !== 'nft_mint') {
    fail('mint tx shape wrong');
  }

  // 5. A duplicate token id is blocked before the wallet opens.
  const before = calls.sendTransaction.length;
  page2.$('mintToken').value = 'genesis-visitor-1';
  await page2.$('mintBtn').listeners.click();
  console.log('5. duplicate mint blocked:', calls.sendTransaction.length === before,
    '| status:', JSON.stringify(page2.$('mintStatus').textContent));
  if (calls.sendTransaction.length !== before) fail('duplicate token id reached the wallet');
  if (!page2.$('mintStatus').textContent.includes('already taken')) fail('no already-taken message');

  // 6. A fresh page load auto-suggests a free token id when the filled-in
  // one is taken (genesis-visitor-1 -> genesis-visitor-2).
  const page3 = loadPage();
  page3.$('mintToken').value = 'genesis-visitor-1';
  await page3.windowListeners.load();
  console.log('6. page 3 token field after load:', JSON.stringify(page3.$('mintToken').value));
  if (page3.$('mintToken').value !== 'genesis-visitor-2') fail('form did not suggest a free token id');

  // 7. A PASS auto-pays through /api/pay-job (no copy needed).
  const page4 = loadPage();
  await page4.windowListeners.load();
  page4.$('agentJobToken').value = 'genesis-visitor-2';
  page4.$('agentJobBrief').value = 'NEAR NFTs global contract mint';
  page4.$('agentJobKeywords').value = 'near, nft, mint';
  page4.$('agentJobMin').value = '20';
  await page4.$('runAgentJobBtn').listeners.click();
  console.log('7. pay-job calls:', calls.payJob.length,
    '| pay status:', JSON.stringify(page4.$('agentJobPay').innerHTML.slice(0, 60)));
  if (calls.payJob.length !== 1) fail('agent job did not call the payment service');
  const payBody = calls.payJob[0];
  if (payBody.token_id !== 'genesis-visitor-2' || payBody.account_id !== 'isaiah.testnet') fail('payment service got the wrong token/account');
  if (!page4.$('agentJobPay').innerHTML.includes('Paid 0.01 NEAR automatically')) fail('no paid confirmation shown');
  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
