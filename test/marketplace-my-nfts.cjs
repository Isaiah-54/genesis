// Test the marketplace "your NFTs" picker (marketplace.js):
//  1. A connected wallet's owned NFTs are detected via
//     nft_tokens_for_owner and rendered as selectable gen cards.
//  2. Tapping a card fills the token id to list (no need to remember it);
//     tapping again unpicks it.
//  3. With no wallet connected, the section asks to connect and shows
//     nothing. With a wallet that owns nothing, it points at the mint form.
//  4. A wallet owning several NFTs renders one card per token.
// The RPC responses below use the real shapes returned live by
// nft.primitives.testnet (verified 2026-11-05 for otoyo4real.testnet,
// the treasury and gen2).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'marketplace.js'), 'utf8');

const VISITOR_1 = {
  token_id: 'genesis-visitor-1', owner_id: 'otoyo4real.testnet',
  metadata: { title: 'Genesis Visitor Agent', description: 'Gen 0', media: '', extra: '{"generation":0,"parent":"treasury","status":"alive"}' },
};
const GEN_2 = {
  token_id: 'genesis-gen-2', owner_id: 'gen2.genesisdemo354551.testnet',
  metadata: { title: 'Genesis Gen 2', description: 'Gen 2', media: '', extra: '{"generation":2,"parent":"genesis-gen-1","status":"alive"}' },
};
const GEN_3 = {
  token_id: 'genesis-gen-3', owner_id: 'gen2.genesisdemo354551.testnet',
  metadata: { title: 'Genesis Gen 3', description: 'Gen 3', media: '', extra: '{"generation":3,"parent":"genesis-gen-2","status":"alive"}' },
};

function rpcResult(value) {
  return JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } });
}

function loadPage({ restoreId, ownedTokens }) {
  const elements = {};
  function makeEl(id) {
    const el = {
      id, textContent: '', innerHTML: '', value: '', style: {},
      listeners: {},
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, force) { if (force) this._set.add(c); else this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      addEventListener(ev, fn) { this.listeners[ev] = fn; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      focus() {},
    };
    return el;
  }
  const documentStub = {
    getElementById(id) { return (elements[id] ||= makeEl(id)); },
    querySelectorAll() { return []; },
  };
  const windowListeners = {};
  const sandbox = {
    document: documentStub,
    console,
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      const method = body.params.method_name;
      const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString());
      if (method === 'get_listings') return { json: async () => JSON.parse(rpcResult([])) };
      if (method === 'nft_tokens_for_owner') {
        // Only the requested account's tokens, paged by from_index/limit.
        const from = parseInt(args.from_index || '0', 10);
        const limit = args.limit || 50;
        const mine = (ownedTokens || []).filter((t) => t.owner_id === args.account_id);
        return { json: async () => JSON.parse(rpcResult(mine.slice(from, from + limit))) };
      }
      if (method === 'nft_token') {
        const t = (ownedTokens || []).find((x) => x.token_id === args.token_id) || null;
        return { json: async () => JSON.parse(rpcResult(t)) };
      }
      throw new Error('unexpected RPC method ' + method);
    },
    nearWallet: {
      accountId() { return restoreId || null; },
      async restore({ network }) {
        return network === 'testnet' && restoreId ? { accountId: restoreId } : null;
      },
      async sendTransaction() { return { transaction: { hash: 'testhash' } }; },
    },
    TextDecoder,
    btoa: (s) => Buffer.from(s, 'utf8').toString('base64'),
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (ev, fn) => { windowListeners[ev] = fn; };
  sandbox.window.nearWallet = sandbox.nearWallet;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { elements, windowListeners, sandbox, documentStub };
}

async function tick(n) { for (let i = 0; i < (n || 5); i++) await new Promise((r) => setImmediate(r)); }

(async () => {
  // 1. Connected wallet owning one NFT: the card is detected and rendered.
  let page = loadPage({ restoreId: 'otoyo4real.testnet', ownedTokens: [VISITOR_1, GEN_2] });
  await page.windowListeners.load();
  await tick(10);
  assert.match(page.elements.myNftsStatus.textContent, /owns 1 agent NFT/);
  assert.match(page.elements.myNfts.innerHTML, /genesis-visitor-1/);
  assert.match(page.elements.myNfts.innerHTML, /nft\/gen-0\.svg/);
  assert.doesNotMatch(page.elements.myNfts.innerHTML, /genesis-gen-2/);
  console.log('1. one owned NFT detected and rendered as a gen card: ok');

  // 2. Tapping the card fills the token id; tapping again unpicks it.
  const grid = page.elements.myNfts;
  const tag = { textContent: 'Tap to list this one' };
  const card = {
    getAttribute(name) { return name === 'data-pick-token' ? 'genesis-visitor-1' : null; },
    classList: grid.classList,
    querySelector() { return tag; },
    closest() { return this; },
  };
  grid.querySelectorAll = () => [card];
  const click = grid.listeners.click;
  assert.ok(click, 'myNfts click handler wired');
  click({ target: card });
  assert.strictEqual(page.elements.listTokenId.value, 'genesis-visitor-1');
  assert.ok(card.classList.contains('selected'));
  assert.strictEqual(tag.textContent, 'SELECTED — tap again to unpick');
  click({ target: card });
  assert.strictEqual(page.elements.listTokenId.value, '');
  assert.ok(!card.classList.contains('selected'));
  console.log('2. tap to pick / tap again to unpick: ok');

  // 3. No wallet connected: nothing detected, asks to connect.
  page = loadPage({ restoreId: null, ownedTokens: [VISITOR_1] });
  await page.windowListeners.load();
  await tick(10);
  assert.strictEqual(page.elements.myNfts.innerHTML, '');
  assert.match(page.elements.myNftsStatus.textContent, /Connect a wallet/);
  console.log('3. no wallet: asks to connect, shows nothing: ok');

  // 4. Wallet owning nothing: points at the mint form.
  page = loadPage({ restoreId: 'otoyo4real.testnet', ownedTokens: [GEN_2] });
  await page.windowListeners.load();
  await tick(10);
  assert.strictEqual(page.elements.myNfts.innerHTML, '');
  assert.match(page.elements.myNftsStatus.innerHTML, /mint one first/);
  console.log('4. wallet owns nothing: points at the mint form: ok');

  // 5. Wallet owning several NFTs: one card per token.
  page = loadPage({ restoreId: 'gen2.genesisdemo354551.testnet', ownedTokens: [VISITOR_1, GEN_2, GEN_3] });
  await page.windowListeners.load();
  await tick(10);
  assert.match(page.elements.myNftsStatus.textContent, /owns 2 agent NFTs/);
  assert.match(page.elements.myNfts.innerHTML, /genesis-gen-2/);
  assert.match(page.elements.myNfts.innerHTML, /genesis-gen-3/);
  assert.match(page.elements.myNfts.innerHTML, /nft\/gen-2\.svg/);
  assert.match(page.elements.myNfts.innerHTML, /nft\/gen-3\.svg/);
  assert.doesNotMatch(page.elements.myNfts.innerHTML, /genesis-visitor-1/);
  console.log('5. several owned NFTs: one card per token, gen images right: ok');

  console.log('marketplace-my-nfts: all 5 scenarios pass');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
