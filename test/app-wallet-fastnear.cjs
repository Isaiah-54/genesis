// Test the Genesis app.js wallet layer with a mocked DOM + mocked @fastnear/wallet.
// Reproduces the two bugs from Isaiah's screenshot:
//  1. Connect button showed the stringified accountId FUNCTION.
//  2. Mint failed: "No wallet connected on testnet. Call connect({ network: "testnet" }) first."
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');

const calls = { connect: [], restore: [], disconnect: 0, sendTransaction: [] };
const elements = {};
function makeEl(id) {
  const el = {
    id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {} },
    listeners: {},
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
  };
  return el;
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
  window: null,
  document: documentStub,
  console,
  navigator: {},
  fetch: async () => { throw new Error('no network in test'); },
  crypto: globalThis.crypto,
};
sandbox.window = {
  document: documentStub,
  crypto: globalThis.crypto,
  nearWallet: {
    // NOTE: accountId is a FUNCTION in the real library — the bug was
    // assigning it directly instead of calling it / using connect()'s return.
    accountId(opts) { return this._id || null; },
    _id: null,
    async connect({ network }) {
      calls.connect.push(network);
      this._id = 'isaiah.testnet';
      return { accountId: 'isaiah.testnet' };
    },
    async restore() { calls.restore.push(1); return null; },
    async disconnect() { calls.disconnect += 1; this._id = null; },
    async sendTransaction(tx) {
      calls.sendTransaction.push(tx);
      if (!this._id) throw new Error('No wallet connected on testnet. Call connect({ network: "testnet" }) first.');
      return { transaction: { hash: 'testhash123' } };
    },
  },
  addEventListener(ev, fn) { windowListeners[ev] = fn; },
};
sandbox.window.window = sandbox.window;
const vm = require('vm');
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

(async () => {
  const $ = (id) => documentStub.getElementById(id);
  // Page load: restore finds nothing.
  await windowListeners.load();
  const btn = $('walletBtn');
  console.log('1. after load, button text:', JSON.stringify(btn.textContent));
  // Click Connect.
  await btn.listeners.click();
  console.log('2. after connect, button text:', JSON.stringify(btn.textContent));
  console.log('   connect called with:', JSON.stringify(calls.connect));
  if (typeof btn.textContent !== 'string' || btn.textContent.includes('function accountId')) {
    console.log('FAIL: button still shows the function source');
    process.exit(1);
  }
  if (btn.textContent !== 'isaiah.testnet') { console.log('FAIL: button is not the account id'); process.exit(1); }
  // Fill mint form + click Mint.
  $('mintToken').value = 'genesis-test-1';
  $('mintTitle').value = 'Genesis Test';
  $('mintGen').value = '0';
  $('mintParent').value = 'treasury';
  await $('mintBtn').listeners.click();
  console.log('3. sendTransaction calls:', calls.sendTransaction.length);
  const tx = calls.sendTransaction[0];
  console.log('   receiver:', tx.receiverId, '| action:', tx.actions[0].type, tx.actions[0].methodName, '| deposit:', tx.actions[0].deposit, '| gas:', tx.actions[0].gas);
  console.log('   mint status:', JSON.stringify($('mintStatus').innerHTML.slice(0, 80)));
  if (!tx || tx.receiverId !== 'nft.primitives.testnet' || tx.actions[0].methodName !== 'nft_mint') {
    console.log('FAIL: mint tx shape wrong'); process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
