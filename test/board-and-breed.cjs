// Test the Core v2.1 site layer (job board + breed picker):
//  Job board (app.js):
//  1. Core get_jobs returns jobs -> the board renders them, open first,
//     and the status says how many are on the Core and how many are open.
//  2. Core read fails -> the board falls back to the demo file and SAYS SO.
//  3. Post a job with no wallet -> refuses. With a connected .testnet
//     wallet -> calls post_job on the Core with the reward attached as
//     escrow and a sha256 job id, then refreshes the board.
//  Breed picker (marketplace.js):
//  4. A wallet owning two NFTs renders both as pickable breed cards.
//  5. Tap two cards -> Parent 1 + Parent 2, in pick order; a third tap
//     is refused; tapping a picked card unpicks it.
//  6. Breed with fewer than two parents -> refuses.
//  7. Breed with two living parents -> breed (0.5 NEAR) then nft_mint
//     (0.1 NEAR) with BOTH parents in `extra`; status shows the child
//     generation and skills.
//  8. Breed with a dead parent -> refuses before any transaction.
// The RPC shapes below use the real shapes returned live by the Core
// (verified 2026-11-05: get_jobs returns 3 paid jobs, get_agent returns
// status "Alive" and skill {speed, quality, cost_eff}).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const crypto = require('crypto');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const marketSrc = fs.readFileSync(path.join(__dirname, '..', 'marketplace.js'), 'utf8');

function rpcResult(value) {
  return JSON.stringify({ jsonrpc: '2.0', id: 'x', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } });
}

const CORE_JOBS = [
  { job_id: 'aaaa', brief: 'NEAR NFTs global contract mint', keywords: ['near', 'nft', 'mint'], reward: '10000000000000000000000', status: 'paid', winner: 'clearsite587.testnet', poster: 'genesisdemo354551.testnet', min_words: 0 },
  { job_id: 'bbbb', brief: 'Summarise the NEAR wallet docs', keywords: ['near', 'wallet'], reward: '20000000000000000000000', status: 'open', winner: null, poster: 'isaiah.testnet', min_words: 0 },
  { job_id: 'cccc', brief: 'NEAR NFTs global contract mint', keywords: ['near', 'nft', 'mint'], reward: '10000000000000000000000', status: 'paid', winner: 'gen2.genesisdemo354551.testnet', poster: 'genesisdemo354551.testnet', min_words: 0 },
];
const DEMO_BOARD = { jobs: [
  { id: 'job-1', brief: 'Demo board job', keywords: ['demo'], pay: 0.01, poster: 'anonymous', status: 'open' },
] };

const GEN_2 = {
  token_id: 'genesis-gen-2', owner_id: 'gen2.genesisdemo354551.testnet',
  metadata: { title: 'Genesis Gen 2', description: 'Gen 2', media: '', extra: '{"generation":2,"parent":"genesis-gen-1","status":"alive"}' },
};
const GEN_3 = {
  token_id: 'genesis-gen-3', owner_id: 'gen2.genesisdemo354551.testnet',
  metadata: { title: 'Genesis Gen 3', description: 'Gen 3', media: '', extra: '{"generation":3,"parent":"genesis-gen-2","status":"alive"}' },
};
const GEN_4 = {
  token_id: 'genesis-gen-4', owner_id: 'gen2.genesisdemo354551.testnet',
  metadata: { title: 'Genesis Gen 4', description: 'Gen 4', media: '', extra: '{"generation":4,"parent":"genesis-gen-3","status":"alive"}' },
};

async function tick(n) { for (let i = 0; i < (n || 8); i++) await new Promise((r) => setImmediate(r)); }

// ─── app.js harness (job board) ──────────────────────────────────────
function loadAppPage({ walletId, failCore }) {
  const elements = {};
  function makeEl(id) {
    return {
      id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
      classList: { add() {}, remove() {} },
      listeners: {},
      addEventListener(ev, fn) { this.listeners[ev] = fn; },
      focus() {},
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
  const sendTxCalls = [];
  const wallet = {
    _id: walletId || null,
    accountId() { return this._id || null; },
    async restore({ network }) {
      return network === 'testnet' && this._id ? { accountId: this._id } : null;
    },
    async disconnect() { this._id = null; },
    async sendTransaction(tx) {
      sendTxCalls.push(tx);
      if (!this._id) throw new Error('No wallet connected on testnet.');
      return { transaction: { hash: 'testhash123' } };
    },
  };
  const sandbox = {
    document: documentStub,
    console,
    navigator: {},
    fetch: async (url, opts) => {
      if (url === '/demo/jobs-board.json') {
        return { json: async () => DEMO_BOARD };
      }
      const body = JSON.parse(opts.body);
      const method = body.params.method_name;
      const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString());
      if (method === 'get_jobs') {
        if (failCore) throw new Error('Core unreachable in this test');
        return { json: async () => JSON.parse(rpcResult(CORE_JOBS)) };
      }
      if (method === 'nft_token') {
        const tokenId = args.token_id;
        const payload = tokenId === 'genesis-visitor-1'
          ? { token_id: 'genesis-visitor-1', owner_id: 'otoyo4real.testnet' } : null;
        return { json: async () => JSON.parse(rpcResult(payload)) };
      }
      return { json: async () => JSON.parse(rpcResult(null)) };
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    crypto: globalThis.crypto,
  };
  sandbox.window = {
    document: documentStub,
    crypto: globalThis.crypto,
    nearWallet: wallet,
    addEventListener(ev, fn) { windowListeners[ev] = fn; },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(appSrc, sandbox);
  return { elements, windowListeners, sendTxCalls, wallet, $: (id) => documentStub.getElementById(id) };
}

// ─── marketplace.js harness (breed picker) ───────────────────────────
function loadMarketPage({ restoreId, ownedTokens, agentStatus }) {
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
  const sendTxCalls = [];
  const sandbox = {
    document: documentStub,
    console,
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      const method = body.params.method_name;
      const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString());
      if (method === 'get_listings') return { json: async () => JSON.parse(rpcResult([])) };
      if (method === 'nft_tokens_for_owner') {
        const from = parseInt(args.from_index || '0', 10);
        const limit = args.limit || 50;
        const mine = (ownedTokens || []).filter((t) => t.owner_id === args.account_id);
        return { json: async () => JSON.parse(rpcResult(mine.slice(from, from + limit))) };
      }
      if (method === 'nft_token') {
        const t = (ownedTokens || []).find((x) => x.token_id === args.token_id) || null;
        return { json: async () => JSON.parse(rpcResult(t)) };
      }
      if (method === 'get_agent') {
        const tokenId = args.token_id;
        if (tokenId === 'genesis-gen-4') {
          return { json: async () => JSON.parse(rpcResult({ token_id: 'genesis-gen-4', owner_id: restoreId, generation: 4, parent: 'genesis-gen-2', second_parent: 'genesis-gen-3', skill: { speed: 1.08, quality: 1.08, cost_eff: 1.08 }, status: 'Alive' })) };
        }
        const token = (ownedTokens || []).find((x) => x.token_id === tokenId);
        if (!token) return { json: async () => JSON.parse(rpcResult(null)) };
        const gen = JSON.parse(token.metadata.extra).generation;
        const status = (agentStatus && agentStatus[tokenId]) || 'Alive';
        return { json: async () => JSON.parse(rpcResult({ token_id: tokenId, owner_id: token.owner_id, generation: gen, parent: 'genesis-gen-1', second_parent: null, skill: { speed: 1, quality: 1, cost_eff: 1 }, status })) };
      }
      throw new Error('unexpected RPC method ' + method);
    },
    nearWallet: {
      accountId() { return restoreId || null; },
      async restore({ network }) {
        return network === 'testnet' && restoreId ? { accountId: restoreId } : null;
      },
      async sendTransaction(tx) {
        sendTxCalls.push(tx);
        if (!restoreId) throw new Error('No wallet connected on testnet.');
        return { transaction: { hash: 'testhash' } };
      },
    },
    TextDecoder,
    btoa: (s) => Buffer.from(s, 'utf8').toString('base64'),
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (ev, fn) => { windowListeners[ev] = fn; };
  sandbox.window.nearWallet = sandbox.nearWallet;
  vm.createContext(sandbox);
  vm.runInContext(marketSrc, sandbox);
  return { elements, windowListeners, sendTxCalls, sandbox, $: (id) => documentStub.getElementById(id) };
}

function breedCardEl(page, tokenId) {
  const grid = page.elements.breedNfts;
  const tag = { textContent: 'Tap to pick as parent' };
  return {
    getAttribute(name) { return name === 'data-breed-token' ? tokenId : null; },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) { if (force) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    querySelector() { return tag; },
    closest() { return this; },
    _tag: tag,
  };
}

(async () => {
  // 1. Job board from the Core: open job first, paid jobs after.
  let app = loadAppPage({ walletId: null, failCore: false });
  await app.windowListeners.load();
  await tick(10);
  assert.match(app.elements.jobBoardList.innerHTML, /Summarise the NEAR wallet docs/);
  assert.match(app.elements.jobBoardList.innerHTML, /0\.02 NEAR/);
  assert.match(app.elements.jobBoardList.innerHTML, /0\.01 NEAR/);
  assert.match(app.elements.jobBoardStatus.textContent, /3 jobs on the Core · 1 open/);
  const openPos = app.elements.jobBoardList.innerHTML.indexOf('Summarise the NEAR wallet docs');
  const paidPos = app.elements.jobBoardList.innerHTML.indexOf('NEAR NFTs global contract mint');
  assert.ok(openPos >= 0 && paidPos > openPos, 'open job renders before paid jobs');
  console.log('1. job board reads the Core, open first: ok');

  // 2. Core read fails: falls back to the demo file and says so.
  app = loadAppPage({ walletId: null, failCore: true });
  await app.windowListeners.load();
  await tick(10);
  assert.match(app.elements.jobBoardList.innerHTML, /Demo board job/);
  assert.match(app.elements.jobBoardStatus.textContent, /showing the demo board file instead/);
  console.log('2. Core read fails: falls back to the demo board and says so: ok');

  // 3. Post a job with no wallet: refuses.
  app = loadAppPage({ walletId: null, failCore: false });
  await app.windowListeners.load();
  await tick(10);
  app.$('postJobBrief').value = 'Summarise the NEAR wallet docs';
  app.$('postJobKeywords').value = 'near, wallet';
  app.$('postJobReward').value = '0.02';
  await app.$('postJobBtn').listeners.click();
  await tick(5);
  assert.match(app.elements.postJobStatus.textContent, /Connect a wallet first/);
  assert.strictEqual(app.sendTxCalls.length, 0);
  console.log('3. post a job with no wallet: refuses, no tx: ok');

  // 4. Post a job with a connected testnet wallet: post_job + escrow.
  app = loadAppPage({ walletId: 'isaiah.testnet', failCore: false });
  await app.windowListeners.load();
  await tick(10);
  app.$('postJobBrief').value = 'Summarise the NEAR wallet docs';
  app.$('postJobKeywords').value = 'near, wallet';
  app.$('postJobReward').value = '0.02';
  await app.$('postJobBtn').listeners.click();
  await tick(10);
  assert.strictEqual(app.sendTxCalls.length, 1);
  const postTx = app.sendTxCalls[0];
  assert.strictEqual(postTx.receiverId, 'core.genesisdemo354551.testnet');
  assert.strictEqual(postTx.actions[0].methodName, 'post_job');
  assert.strictEqual(postTx.actions[0].args.brief, 'Summarise the NEAR wallet docs');
  assert.deepEqual(postTx.actions[0].args.keywords, ['near', 'wallet']); // loose: the array was built inside the vm realm
  assert.strictEqual(postTx.actions[0].args.min_words, 0);
  assert.strictEqual(postTx.actions[0].deposit, '20000000000000000000000'); // 0.02 NEAR escrow
  assert.match(postTx.actions[0].args.job_id, /^[0-9a-f]{64}$/); // sha256(brief|keywords|timestamp); the timestamp is not reproducible here, so only the shape is checkable
  assert.match(app.elements.postJobStatus.innerHTML, /Job posted/);
  console.log('4. post a job: post_job with the reward as escrow and a sha256 job id: ok');

  // 5. Breed picker: two owned NFTs render as pickable cards.
  let market = loadMarketPage({ restoreId: 'gen2.genesisdemo354551.testnet', ownedTokens: [GEN_2, GEN_3, GEN_4] });
  await market.windowListeners.load();
  await tick(10);
  assert.match(market.elements.breedNftsStatus.textContent, /owns 3 agent NFTs/);
  assert.match(market.elements.breedNfts.innerHTML, /genesis-gen-2/);
  assert.match(market.elements.breedNfts.innerHTML, /genesis-gen-3/);
  assert.match(market.elements.breedNfts.innerHTML, /genesis-gen-4/);
  console.log('5. breed picker renders the owned NFTs as cards: ok');

  // 6. Tap two cards -> Parent 1 + Parent 2; a third tap is refused;
  //    tapping a picked card unpicks it.
  const grid = market.elements.breedNfts;
  const click = grid.listeners.click;
  assert.ok(click, 'breedNfts click handler wired');
  const card2 = breedCardEl(market, 'genesis-gen-2');
  const card3 = breedCardEl(market, 'genesis-gen-3');
  const card4 = breedCardEl(market, 'genesis-gen-4');
  grid.querySelectorAll = () => [card2, card3, card4];
  click({ target: card2 });
  assert.match(market.elements.breedParentsStatus.textContent, /Parent 1: genesis-gen-2/);
  assert.strictEqual(card2._tag.textContent, 'PARENT 1 — tap to unpick');
  click({ target: card3 });
  assert.match(market.elements.breedParentsStatus.textContent, /Parents: genesis-gen-2 \+ genesis-gen-3/);
  assert.strictEqual(card3._tag.textContent, 'PARENT 2 — tap to unpick');
  click({ target: card4 });
  assert.match(market.elements.breedStatus.textContent, /Two parents are already picked/);
  click({ target: card3 }); // unpick Parent 2
  assert.match(market.elements.breedParentsStatus.textContent, /Parent 1: genesis-gen-2/);
  click({ target: card4 }); // now Parent 2
  assert.match(market.elements.breedParentsStatus.textContent, /Parents: genesis-gen-2 \+ genesis-gen-4/);
  console.log('6. tap to pick two parents, third refused, tap to unpick: ok');

  // 7. Breed with fewer than two parents: refuses.
  market = loadMarketPage({ restoreId: 'gen2.genesisdemo354551.testnet', ownedTokens: [GEN_2, GEN_3] });
  await market.windowListeners.load();
  await tick(10);
  const grid2 = market.elements.breedNfts;
  const card2b = breedCardEl(market, 'genesis-gen-2');
  grid2.querySelectorAll = () => [card2b];
  grid2.listeners.click({ target: card2b });
  market.$('breedChildId').value = 'genesis-gen-4';
  await market.elements.breedBtn.listeners.click();
  await tick(5);
  assert.match(market.elements.breedStatus.textContent, /Pick exactly two parents/);
  assert.strictEqual(market.sendTxCalls.length, 0);
  console.log('7. breed with one parent: refuses, no tx: ok');

  // 8. Breed with two living parents: breed then mint, both parents in extra.
  market = loadMarketPage({ restoreId: 'gen2.genesisdemo354551.testnet', ownedTokens: [GEN_2, GEN_3] });
  await market.windowListeners.load();
  await tick(10);
  const grid3 = market.elements.breedNfts;
  const card2c = breedCardEl(market, 'genesis-gen-2');
  const card3c = breedCardEl(market, 'genesis-gen-3');
  grid3.querySelectorAll = () => [card2c, card3c];
  grid3.listeners.click({ target: card2c });
  grid3.listeners.click({ target: card3c });
  market.$('breedChildId').value = 'genesis-gen-4';
  await market.elements.breedBtn.listeners.click();
  await tick(10);
  assert.strictEqual(market.sendTxCalls.length, 2, 'breed + mint');
  const breedTx = market.sendTxCalls[0];
  assert.strictEqual(breedTx.receiverId, 'core.genesisdemo354551.testnet');
  assert.strictEqual(breedTx.actions[0].methodName, 'breed');
  assert.deepEqual(breedTx.actions[0].args, { token_id: 'genesis-gen-4', owner_id: 'gen2.genesisdemo354551.testnet', parent1: 'genesis-gen-2', parent2: 'genesis-gen-3' }); // loose: the object was built inside the vm realm
  assert.strictEqual(breedTx.actions[0].deposit, '500000000000000000000000'); // 0.5 NEAR birth cost
  const mintTx = market.sendTxCalls[1];
  assert.strictEqual(mintTx.receiverId, 'nft.primitives.testnet');
  assert.strictEqual(mintTx.actions[0].methodName, 'nft_mint');
  assert.strictEqual(mintTx.actions[0].args.token_id, 'genesis-gen-4');
  assert.strictEqual(mintTx.actions[0].args.receiver_id, 'gen2.genesisdemo354551.testnet');
  assert.strictEqual(mintTx.actions[0].deposit, '100000000000000000000000'); // 0.1 NEAR
  const extra = JSON.parse(mintTx.actions[0].args.token_metadata.extra);
  assert.strictEqual(extra.generation, 4);
  assert.strictEqual(extra.parent, 'genesis-gen-2');
  assert.strictEqual(extra.second_parent, 'genesis-gen-3');
  assert.deepStrictEqual(extra.skills, { speed: 1.08, quality: 1.08, cost_eff: 1.08 });
  assert.strictEqual(extra.role, 'general');
  assert.match(mintTx.actions[0].args.token_metadata.media, /nft\/gen-4\.svg/);
  assert.match(market.elements.breedStatus.innerHTML, /Child born:.*genesis-gen-4.*generation 4/);
  assert.match(market.elements.breedStatus.innerHTML, /speed 1\.08 \/ quality 1\.08 \/ costEff 1\.08/);
  console.log('8. breed: breed (0.5 NEAR) then mint (0.1 NEAR), both parents in extra: ok');

  // 9. Breed with a dead parent: refuses before any transaction.
  market = loadMarketPage({ restoreId: 'gen2.genesisdemo354551.testnet', ownedTokens: [GEN_2, GEN_3], agentStatus: { 'genesis-gen-3': 'Dead' } });
  await market.windowListeners.load();
  await tick(10);
  const grid4 = market.elements.breedNfts;
  const card2d = breedCardEl(market, 'genesis-gen-2');
  const card3d = breedCardEl(market, 'genesis-gen-3');
  grid4.querySelectorAll = () => [card2d, card3d];
  grid4.listeners.click({ target: card2d });
  grid4.listeners.click({ target: card3d });
  market.$('breedChildId').value = 'genesis-gen-4';
  await market.elements.breedBtn.listeners.click();
  await tick(5);
  assert.match(market.elements.breedStatus.textContent, /genesis-gen-3 is not alive/);
  assert.strictEqual(market.sendTxCalls.length, 0);
  console.log('9. breed with a dead parent: refuses, no tx: ok');

  console.log('board-and-breed: all 9 scenarios pass');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
