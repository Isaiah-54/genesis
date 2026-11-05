/**
 * Genesis marketplace — buy and sell agent NFTs on testnet.
 * Loads after app.js. Uses window.nearWallet directly for transactions
 * and plain RPC view calls to https://rpc.testnet.near.org for reads.
 *
 * Contract interface (Core v2, see docs/MARKETPLACE_AND_DIFFICULTY.md):
 *   Core  core.genesisdemo354551.testnet
 *     get_listings() -> Vec<Listing>   (view)
 *     buy_nft(token_id)                (payable; deposit must equal the
 *                                        listing price exactly)
 *     delist_nft(token_id)             (seller only; returns the NFT)
 *   NFT   nft.primitives.testnet
 *     nft_token(token_id)              (view; title / generation / media
 *                                        come from metadata + `extra`)
 *     nft_transfer_call(receiver_id: Core, token_id, msg: price in
 *       yoctoNEAR as a decimal string) (lists: the Core holds the NFT
 *       in escrow until it sells or the seller delists; 1 yocto deposit)
 *
 * If get_listings fails (the upgraded Core is not deployed yet), the page
 * says so and stays usable — no transaction is attempted.
 *
 * NOTE: in @fastnear/wallet, `nearWallet.accountId` is a FUNCTION, not a
 * string — never assign it as the account id. Use the string returned by
 * restore()/connect(), or call accountId({ network: 'testnet' }).
 * NOTE 2: the library defaults to MAINNET on every fresh page load, so
 * restore() MUST be passed { network: 'testnet' }.
 */
(function () {
  const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
  const NFT_CONTRACT = 'nft.primitives.testnet';
  const RPC_URL = 'https://rpc.testnet.near.org';
  const NETWORK = 'testnet';
  const SITE = 'https://genesis-roan-eta.vercel.app';
  const GAS_BUY = '200000000000000'; // 200 TGas (cross-contract transfer + callback)
  const GAS_DELIST = '200000000000000'; // 200 TGas (returns the NFT)
  const GAS_TRANSFER_CALL = '300000000000000'; // 300 TGas (like nft_mint)
  const OWNER_PAGE = 50; // tokens per nft_tokens_for_owner page

  let accountId = null;
  let selectedTokenId = null; // the token picked by tapping one of your NFT cards
  let breedParents = []; // parent token ids for breeding, in pick order (max 2)
  let myTokens = []; // owned tokens, set by loadMyNfts (the breed grid reads it)
  // Core generations, keyed by token id. The Core is the source of truth
  // for an agent's CURRENT generation: an agent that evolved has a higher
  // Core generation than its NFT's birth generation (the NFT metadata is
  // immutable, so it still says the birth gen). genFromToken prefers this
  // cache when present, so an evolved agent shows its current gen card.
  let coreGenCache = {};

  function $(id) { return document.getElementById(id); }

  function fastnear() {
    if (typeof window.nearWallet === 'undefined') {
      throw new Error('FastNear wallet library not loaded. Check the script tag.');
    }
    return window.nearWallet;
  }

  // The connected account id is always a string. Returns null otherwise.
  function currentAccountId(nw) {
    try {
      const id = nw.accountId({ network: NETWORK });
      return typeof id === 'string' && id ? id : null;
    } catch (_) {
      return null;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(msg, isError, asHtml) {
    const el = $('marketStatus');
    if (!el) return;
    if (asHtml) el.innerHTML = msg;
    else el.textContent = msg;
    el.style.color = isError ? 'var(--red)' : 'var(--muted)';
  }

  // yoctoNEAR (string) -> "0.5" style NEAR display (up to 6 decimals).
  function yoctoToNear(yocto) {
    try {
      const y = BigInt(yocto);
      const whole = y / 1000000000000000000000000n;
      const frac = y % 1000000000000000000000000n;
      if (frac === 0n) return whole.toString();
      let fracStr = frac.toString().padStart(24, '0').replace(/0+$/, '');
      if (fracStr.length > 6) fracStr = fracStr.slice(0, 6);
      return whole.toString() + '.' + fracStr;
    } catch (_) {
      return String(yocto);
    }
  }

  // "0.5" NEAR -> yoctoNEAR string. Throws on bad input.
  function nearToYocto(near) {
    const s = String(near).trim();
    if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error('Enter a price in NEAR, e.g. 0.5');
    const parts = s.split('.');
    const whole = parts[0];
    const frac = parts[1] || '';
    const yocto = BigInt(whole) * 1000000000000000000000000n +
      BigInt((frac + '000000000000000000000000').slice(0, 24));
    if (yocto <= 0n) throw new Error('Price must be more than 0 NEAR.');
    return yocto.toString();
  }

  // Plain RPC view call, same shape as app.js's tokenExists().
  async function rpcView(contractId, methodName, args) {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'genesis-market', method: 'query',
        params: {
          request_type: 'call_function', account_id: contractId,
          method_name: methodName,
          args_base64: btoa(JSON.stringify(args || {})),
          finality: 'final',
        },
      }),
    });
    const data = await res.json();
    if (data && data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const bytes = data && data.result && data.result.result;
    if (!bytes || !bytes.length) throw new Error('Empty RPC response from ' + contractId + '.' + methodName);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
  }

  async function nftToken(tokenId) {
    return rpcView(NFT_CONTRACT, 'nft_token', { token_id: tokenId });
  }

  // Generation lives in the token's `extra` JSON; fall back to the
  // genesis-gen-N token id pattern, then 0. (Some tokens store the
  // generation as the string "3" rather than the number 3 — accept both.)
  // But the Core's generation wins when known: an evolved agent's Core
  // generation is higher than its NFT's birth generation, and the card
  // should show the current generation, not the birth one.
  function genFromToken(token) {
    const id = token && token.token_id;
    if (id && Object.prototype.hasOwnProperty.call(coreGenCache, id)) return coreGenCache[id];
    try {
      const extra = token && token.metadata && token.metadata.extra;
      if (extra) {
        const parsed = typeof extra === 'string' ? JSON.parse(extra) : extra;
        const n = parsed && Number(parsed.generation);
        if (Number.isInteger(n)) return n;
      }
    } catch (_) {}
    const m = token && token.token_id && String(token.token_id).match(/^genesis-gen-(\d+)$/);
    if (m) return parseInt(m[1], 10);
    return 0;
  }

  // Fill coreGenCache for a set of token ids from the Core registry.
  // Tokens that are not registered (or whose read fails) are left out,
  // so genFromToken falls back to the NFT metadata for them.
  async function loadCoreGens(tokenIds) {
    const ids = (tokenIds || []).filter(Boolean);
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(coreGenCache, id)) continue;
      try {
        const agent = await rpcView(CORE_CONTRACT, 'get_agent', { token_id: id });
        if (agent && Number.isInteger(agent.generation)) coreGenCache[id] = agent.generation;
      } catch (_) {}
    }
  }

  function genCardUrl(gen) {
    const n = parseInt(gen, 10);
    return SITE + '/api/nft-card?gen=' + (Number.isInteger(n) && n >= 0 && n <= 9 ? n : 'x');
  }

  // The CV page has anchors for the numbered generations (#gen2, #gen3).
  function cvHref(tokenId) {
    const m = String(tokenId).match(/^genesis-gen-(\d+)$/);
    return m ? 'cv.html#gen' + m[1] : 'cv.html';
  }

  // Every NFT the account owns on the shared contract, in pages of 50.
  // NEP-171 enumeration: nft_tokens_for_owner({account_id, from_index, limit}).
  // A token that is listed is owned by the Core, so it never shows up here —
  // this is exactly the list of tokens the wallet can still list.
  async function nftTokensForOwner(ownerId) {
    const all = [];
    let fromIndex = 0;
    for (let page = 0; page < 3; page++) {
      const batch = await rpcView(NFT_CONTRACT, 'nft_tokens_for_owner', {
        account_id: ownerId, from_index: String(fromIndex), limit: OWNER_PAGE,
      });
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push.apply(all, batch);
      if (batch.length < OWNER_PAGE) break;
      fromIndex += batch.length;
    }
    return all;
  }

  function myNftCard(token) {
    const gen = genFromToken(token);
    const title = (token && token.metadata && token.metadata.title) || token.token_id;
    const selected = selectedTokenId === token.token_id;
    return '<div class="card pick' + (selected ? ' selected' : '') + '" style="margin:0" data-pick-token="' + esc(token.token_id) + '" role="button" tabindex="0">' +
      '<img src="' + esc(genCardUrl(gen)) + '" alt="Genesis generation ' + gen + ' card" style="width:100%;border-radius:12px;margin-bottom:10px">' +
      '<h3>' + esc(token.token_id) + '</h3>' +
      '<p class="small">Generation ' + gen + ' · ' + esc(title) + '</p>' +
      '<p><span class="tag pick-tag">' + (selected ? 'SELECTED — tap again to unpick' : 'Tap to list this one') + '</span></p>' +
      '</div>';
  }

  // Tap a card: it becomes the token to list (no need to remember the id).
  // Tapping the selected card again unpicks it. The manual input below
  // stays editable as a fallback — typing there clears the card selection.
  function selectToken(tokenId) {
    selectedTokenId = (selectedTokenId === tokenId) ? null : tokenId;
    const input = $('listTokenId');
    if (input) input.value = selectedTokenId || '';
    const grid = $('myNfts');
    if (grid) {
      grid.querySelectorAll('[data-pick-token]').forEach(function (el) {
        const picked = el.getAttribute('data-pick-token') === selectedTokenId;
        el.classList.toggle('selected', picked);
        const tag = el.querySelector('.pick-tag');
        if (tag) tag.textContent = picked ? 'SELECTED — tap again to unpick' : 'Tap to list this one';
      });
    }
    if (selectedTokenId) {
      const price = $('listPrice');
      if (price) price.focus();
    }
  }

  async function loadMyNfts() {
    const grid = $('myNfts');
    const status = $('myNftsStatus');
    if (!grid) return;
    if (!accountId) {
      grid.innerHTML = '';
      if (status) status.textContent = 'Connect a wallet (top bar) to see the NFTs you own.';
      myTokens = [];
      loadBreedNfts();
      return;
    }
    if (status) status.textContent = 'Loading the NFTs this wallet owns…';
    let tokens;
    try {
      tokens = await nftTokensForOwner(accountId);
    } catch (e) {
      // Enumeration is a convenience: if the contract does not answer,
      // the manual token id below still works.
      grid.innerHTML = '';
      if (status) status.textContent = 'Could not detect this wallet\u2019s NFTs (' + (e.message || e) + ') — type the token id below instead.';
      myTokens = [];
      loadBreedNfts();
      return;
    }
    if (!tokens.length) {
      grid.innerHTML = '';
      if (status) {
        status.innerHTML = 'This wallet owns no agent NFTs yet — <a href="index.html#mint">mint one first</a>.';
      }
      myTokens = [];
      loadBreedNfts();
      return;
    }
    if (status) {
      status.textContent = tokens.length === 1
        ? 'This wallet owns 1 agent NFT — tap it to list it.'
        : 'This wallet owns ' + tokens.length + ' agent NFTs — tap the one you want to list.';
    }
    // The CURRENT generation comes from the Core (an evolved agent's
    // Core generation is higher than its NFT's birth generation), so
    // fetch it before rendering the cards.
    await loadCoreGens(tokens.map(t => t.token_id));
    // Keep a previous selection if that token is still owned.
    if (selectedTokenId && !tokens.some(function (t) { return t.token_id === selectedTokenId; })) {
      selectedTokenId = null;
      const input = $('listTokenId');
      if (input) input.value = '';
    }
    grid.innerHTML = tokens.map(myNftCard).join('');
    myTokens = tokens;
    loadBreedNfts();
  }

  // ─── Breed ─────────────────────────────────────────────────────────
  // Two parents, picked by tapping owned NFT cards (same picker pattern
  // as the list section, but up to two, in pick order). The breed flow
  // is two wallet transactions: breed on the Core (0.5 NEAR birth cost),
  // then nft_mint for the child (0.1 NEAR deposit). The child's
  // generation and skills come from the Core record read back after
  // breed, and BOTH parents are recorded in the NFT metadata `extra`.
  function breedNftCard(token) {
    const gen = genFromToken(token);
    const title = (token && token.metadata && token.metadata.title) || token.token_id;
    const slot = breedParents.indexOf(token.token_id);
    const label = slot === 0 ? 'PARENT 1 — tap to unpick'
      : slot === 1 ? 'PARENT 2 — tap to unpick'
      : 'Tap to pick as parent';
    return '<div class="card pick' + (slot >= 0 ? ' selected' : '') + '" style="margin:0" data-breed-token="' + esc(token.token_id) + '" role="button" tabindex="0">' +
      '<img src="' + esc(genCardUrl(gen)) + '" alt="Genesis generation ' + gen + ' card" style="width:100%;border-radius:12px;margin-bottom:10px">' +
      '<h3>' + esc(token.token_id) + '</h3>' +
      '<p class="small">Generation ' + gen + ' · ' + esc(title) + '</p>' +
      '<p><span class="tag pick-tag">' + label + '</span></p>' +
      '</div>';
  }

  function refreshBreedCards() {
    const grid = $('breedNfts');
    if (!grid) return;
    grid.querySelectorAll('[data-breed-token]').forEach(function (el) {
      const tokenId = el.getAttribute('data-breed-token');
      const slot = breedParents.indexOf(tokenId);
      el.classList.toggle('selected', slot >= 0);
      const tag = el.querySelector('.pick-tag');
      if (tag) tag.textContent = slot === 0 ? 'PARENT 1 — tap to unpick' : slot === 1 ? 'PARENT 2 — tap to unpick' : 'Tap to pick as parent';
    });
    const ps = $('breedParentsStatus');
    if (ps) {
      ps.textContent = breedParents.length === 0
        ? 'Tap two of your NFTs above to pick the parents.'
        : breedParents.length === 1
          ? 'Parent 1: ' + breedParents[0] + ' — tap one more NFT for Parent 2.'
          : 'Parents: ' + breedParents[0] + ' + ' + breedParents[1] + ' — tap one to unpick it.';
    }
  }

  // Tap a card: it becomes Parent 1, then Parent 2. Tapping a picked
  // card unpicks it. A third tap is refused until one is unpicked.
  function selectBreedParent(tokenId) {
    const at = breedParents.indexOf(tokenId);
    if (at >= 0) {
      breedParents.splice(at, 1);
    } else if (breedParents.length >= 2) {
      const s = $('breedStatus');
      if (s) s.textContent = 'Two parents are already picked — tap one of them to unpick it first.';
      return;
    } else {
      breedParents.push(tokenId);
    }
    refreshBreedCards();
  }

  function loadBreedNfts() {
    const grid = $('breedNfts');
    const status = $('breedNftsStatus');
    if (!grid) return;
    if (!accountId) {
      grid.innerHTML = '';
      if (status) status.textContent = 'Connect a wallet (top bar) to see the NFTs you own.';
      return;
    }
    if (!myTokens.length) {
      grid.innerHTML = '';
      if (status) status.textContent = 'This wallet owns no agent NFTs yet — mint one first, then breed.';
      return;
    }
    // Drop parents that are no longer owned (listed, sold, or delisted).
    breedParents = breedParents.filter(function (t) { return myTokens.some(function (x) { return x.token_id === t; }); });
    if (status) {
      status.textContent = myTokens.length === 1
        ? 'This wallet owns 1 agent NFT — breeding needs two parents, so mint or buy one more.'
        : 'This wallet owns ' + myTokens.length + ' agent NFTs — tap two to pick the parents.';
    }
    grid.innerHTML = myTokens.map(breedNftCard).join('');
    refreshBreedCards();
  }

  async function breedAgents() {
    const nw = walletOrNull();
    if (!nw) return;
    const status = $('breedStatus');
    const resultEl = $('breedResult');
    if (resultEl) resultEl.innerHTML = '';
    const childId = ($('breedChildId') && $('breedChildId').value || '').trim();
    if (!childId) { if (status) status.textContent = 'Enter a child token id (must be unique).'; return; }
    if (breedParents.length !== 2) { if (status) status.textContent = 'Pick exactly two parents above first.'; return; }
    const parent1 = breedParents[0];
    const parent2 = breedParents[1];
    if (status) status.textContent = 'Checking the parents and the child id…';
    // Both parents must be registered in the Core and alive — the Core
    // breed() panics otherwise, so check first and refuse clearly.
    let p1, p2;
    try {
      p1 = await rpcView(CORE_CONTRACT, 'get_agent', { token_id: parent1 });
      p2 = await rpcView(CORE_CONTRACT, 'get_agent', { token_id: parent2 });
    } catch (e) {
      if (status) status.textContent = 'Could not read the parents from the Core: ' + (e.message || e);
      return;
    }
    if (!p1) { if (status) status.textContent = parent1 + ' is not registered in the Core — only registered agents can breed.'; return; }
    if (p1.status !== 'Alive') { if (status) status.textContent = parent1 + ' is not alive (status ' + p1.status + ') — only living agents can breed.'; return; }
    if (!p2) { if (status) status.textContent = parent2 + ' is not registered in the Core — only registered agents can breed.'; return; }
    if (p2.status !== 'Alive') { if (status) status.textContent = parent2 + ' is not alive (status ' + p2.status + ') — only living agents can breed.'; return; }
    // The child id must be free — the shared contract rejects duplicates.
    try {
      const existing = await nftToken(childId);
      if (existing) { if (status) status.textContent = 'That child token id is already taken — pick a new unique token id.'; return; }
    } catch (_) { /* nftToken throws when the token does not exist: free */ }
    if (status) status.textContent = 'Approve the breed in your wallet… (0.5 NEAR birth cost)';
    let breedHash = '';
    try {
      const breedRes = await nw.sendTransaction({
        receiverId: CORE_CONTRACT,
        actions: [{
          type: 'FunctionCall', methodName: 'breed',
          args: { token_id: childId, owner_id: accountId, parent1: parent1, parent2: parent2 },
          gas: '100000000000000', deposit: '500000000000000000000000', // 0.5 NEAR birth cost
        }],
      });
      breedHash = txHash(breedRes);
    } catch (e) {
      const msg = e.message || String(e);
      if (status) status.textContent = txFailed(msg) || ('Breed failed: ' + msg);
      return;
    }
    // Read the child back: the Core sets generation and skills.
    if (status) status.textContent = 'Breed submitted — reading the child back from the Core…';
    let child = null;
    try { child = await rpcView(CORE_CONTRACT, 'get_agent', { token_id: childId }); } catch (_) {}
    if (!child) {
      if (status) status.textContent = 'Breed submitted but the child is not in the Core yet — wait a moment and refresh, then mint its NFT from the CLI.';
      return;
    }
    const gen = child.generation;
    const skills = child.skill || { speed: 1, quality: 1, cost_eff: 1 };
    if (status) status.textContent = 'Child is generation ' + gen + ' — approve the mint in your wallet… (0.1 NEAR deposit)';
    let mintHash = '';
    try {
      const metadata = {
        title: 'Genesis Gen ' + gen,
        description: 'Genesis agent, generation ' + gen + ', parents ' + parent1 + ' and ' + parent2 + '. Works jobs, gets verified, earns, can reproduce or die.',
        media: genCardUrl(gen),
        copies: 1,
        extra: JSON.stringify({ generation: gen, parent: parent1, second_parent: parent2, skills: skills, role: 'general', status: 'alive' }),
      };
      const mintRes = await nw.sendTransaction({
        receiverId: NFT_CONTRACT,
        actions: [{
          type: 'FunctionCall', methodName: 'nft_mint',
          args: { token_id: childId, receiver_id: accountId, token_metadata: metadata },
          gas: '300000000000000', deposit: '100000000000000000000000', // 0.1 NEAR
        }],
      });
      mintHash = txHash(mintRes);
    } catch (e) {
      const msg = e.message || String(e);
      if (status) {
        status.innerHTML = 'Breed succeeded' + txLink(breedHash) + ' but the mint failed: ' + esc(txFailed(msg) || msg) +
          ' The child is registered in the Core — mint its NFT from the CLI: node src/cli.js mint ' + esc(childId) + ' ' + esc(accountId) + ' "Genesis Gen ' + gen + '" ' + gen + ' ' + esc(parent1) + ' ' + esc(parent2);
        status.style.color = 'var(--red)';
      }
      return;
    }
    if (status) {
      status.innerHTML = 'Child born: <span class="mono">' + esc(childId) + '</span> — generation ' + gen +
        ' · skills speed ' + skills.speed + ' / quality ' + skills.quality + ' / costEff ' + skills.cost_eff +
        ' · parents ' + esc(parent1) + ' + ' + esc(parent2) +
        ' · Breed tx' + txLink(breedHash) + ' · Mint tx' + txLink(mintHash);
      status.style.color = 'var(--green)';
    }
    if (resultEl) {
      resultEl.innerHTML = '<div class="card" style="margin:10px 0 0 0">' +
        '<img src="' + esc(genCardUrl(gen)) + '" alt="Genesis generation ' + gen + ' card" style="width:100%;border-radius:12px;margin-bottom:10px">' +
        '<h3>' + esc(childId) + '</h3>' +
        '<p class="small">Generation ' + gen + ' · Parents ' + esc(parent1) + ' + ' + esc(parent2) + '</p>' +
        '<p>Skills: speed ' + skills.speed + ' · quality ' + skills.quality + ' · costEff ' + skills.cost_eff + '</p>' +
        '<p><a class="btn btn2 btn-sm" href="cv.html">View CV</a></p>' +
        '</div>';
    }
    breedParents = [];
    const input = $('breedChildId');
    if (input) input.value = '';
    await loadListings();
    await loadMyNfts(); // ownership changed: the child NFT is now yours
  }

  function txHash(result) {
    return (result && result.hash) ||
      (result && result.transaction && result.transaction.hash) ||
      (result && result.transaction_outcome && result.transaction_outcome.id) ||
      (result && result.txHash) || '';
  }

  function txLink(hash) {
    return hash
      ? ' Tx: <a href="https://testnet.nearblocks.io/txns/' + esc(hash) + '" target="_blank" rel="noopener">' +
        esc(hash.slice(0, 12)) + '…</a>'
      : '';
  }

  function listingCard(listing, token) {
    const gen = genFromToken(token);
    const priceNear = yoctoToNear(listing.price);
    const title = (token && token.metadata && token.metadata.title) || listing.token_id;
    const isMine = !!accountId && listing.seller === accountId;
    const action = isMine
      ? '<button class="ghost" data-action="delist" data-token="' + esc(listing.token_id) + '">Delist</button>'
      : '<button data-action="buy" data-token="' + esc(listing.token_id) + '" data-price="' + esc(listing.price) + '">Buy for ' + esc(priceNear) + ' NEAR</button>';
    return '<div class="card" style="margin:0">' +
      '<img src="' + esc(genCardUrl(gen)) + '" alt="Genesis generation ' + gen + ' card" style="width:100%;border-radius:12px;margin-bottom:10px">' +
      '<h3>' + esc(listing.token_id) + '</h3>' +
      '<p class="small">Generation ' + gen + ' · ' + esc(title) +
      (isMine ? ' · <span class="tag win">YOUR LISTING</span>' : '') + '</p>' +
      '<p>Price <b>' + esc(priceNear) + ' NEAR</b> · Seller <span class="mono">' + esc(listing.seller) + '</span></p>' +
      '<p>' + action + ' <a class="btn btn2 btn-sm" href="' + esc(cvHref(listing.token_id)) + '">View CV</a></p>' +
      '</div>';
  }

  async function loadListings() {
    const grid = $('marketListings');
    const mine = $('myListings');
    setStatus('Loading listings…');
    let listings;
    try {
      listings = await rpcView(CORE_CONTRACT, 'get_listings', {});
    } catch (e) {
      if (grid) {
        grid.innerHTML = '<div class="card" style="margin:0"><h3>Marketplace not open yet</h3>' +
          '<p>The marketplace opens when the upgraded contract deploys.</p></div>';
      }
      if (mine) mine.innerHTML = '<p class="small">The marketplace opens when the upgraded contract deploys.</p>';
      setStatus('The marketplace opens when the upgraded contract deploys.', true);
      return;
    }
    if (!Array.isArray(listings) || listings.length === 0) {
      if (grid) {
        grid.innerHTML = '<div class="card" style="margin:0"><h3>No listings yet</h3>' +
          '<p>Be the first to list an agent NFT.</p></div>';
      }
      if (mine) {
        mine.innerHTML = accountId
          ? '<p class="small">You have no listings yet.</p>'
          : '<p class="small">Connect a wallet (top bar) to see your listings.</p>';
      }
      setStatus('No listings yet. Testnet NEAR has no real value.');
      return;
    }
    setStatus(listings.length + ' listing' + (listings.length === 1 ? '' : 's') +
      ' · 5% of every sale goes to the treasury.');
    // Each token's title / generation comes from the NFT contract, but
    // the CURRENT generation comes from the Core (an evolved agent's
    // Core generation is higher than its NFT's birth generation).
    await loadCoreGens(listings.map(l => l.token_id));
    const cards = [];
    const myCards = [];
    for (const listing of listings) {
      let token = null;
      try { token = await nftToken(listing.token_id); } catch (_) {}
      const html = listingCard(listing, token);
      cards.push(html);
      if (accountId && listing.seller === accountId) myCards.push(html);
    }
    if (grid) grid.innerHTML = cards.join('');
    if (mine) {
      if (!accountId) mine.innerHTML = '<p class="small">Connect a wallet (top bar) to see your listings.</p>';
      else mine.innerHTML = myCards.length ? myCards.join('') : '<p class="small">You have no listings yet.</p>';
    }
  }

  function walletOrNull() {
    let nw;
    try { nw = fastnear(); } catch (e) { setStatus(e.message, true); return null; }
    if (!accountId) { setStatus('Connect a wallet first (top bar).', true); return null; }
    if (!String(accountId).endsWith('.testnet')) {
      setStatus('This is a MAINNET account (' + accountId + '). The marketplace runs on testnet — connect a .testnet account instead.', true);
      return null;
    }
    return nw;
  }

  function txFailed(msg) {
    const m = String(msg || '');
    if (m.toLowerCase().includes('reject') || m.toLowerCase().includes('cancel')) return 'Cancelled in wallet.';
    return null;
  }

  async function buyNft(tokenId, priceYocto) {
    const nw = walletOrNull();
    if (!nw) return;
    setStatus('Approve the purchase in your wallet…');
    try {
      const result = await nw.sendTransaction({
        receiverId: CORE_CONTRACT,
        actions: [{
          type: 'FunctionCall', methodName: 'buy_nft',
          args: { token_id: tokenId }, gas: GAS_BUY, deposit: String(priceYocto),
        }],
      });
      setStatus('Purchase submitted. The NFT and payment settle through the Core escrow.' + txLink(txHash(result)), false, true);
      await loadListings();
      await loadMyNfts(); // ownership changed: the bought NFT is now yours
    } catch (e) {
      const msg = e.message || String(e);
      setStatus(txFailed(msg) || ('Purchase failed: ' + msg), true);
    }
  }

  async function delistNft(tokenId) {
    const nw = walletOrNull();
    if (!nw) return;
    setStatus('Approve the delist in your wallet…');
    try {
      const result = await nw.sendTransaction({
        receiverId: CORE_CONTRACT,
        actions: [{
          type: 'FunctionCall', methodName: 'delist_nft',
          args: { token_id: tokenId }, gas: GAS_DELIST, deposit: '0',
        }],
      });
      setStatus('Delist submitted. The NFT returns to you.' + txLink(txHash(result)), false, true);
      await loadListings();
      await loadMyNfts(); // ownership changed: the NFT is yours again
    } catch (e) {
      const msg = e.message || String(e);
      setStatus(txFailed(msg) || ('Delist failed: ' + msg), true);
    }
  }

  async function listNft() {
    const nw = walletOrNull();
    if (!nw) return;
    const tokenId = ($('listTokenId') && $('listTokenId').value || '').trim();
    const priceInput = ($('listPrice') && $('listPrice').value || '').trim();
    if (!tokenId) { setStatus('Enter the token id to list.', true); return; }
    let priceYocto;
    try { priceYocto = nearToYocto(priceInput); } catch (e) { setStatus(e.message, true); return; }
    setStatus('Checking ownership…');
    let token = null;
    try { token = await nftToken(tokenId); } catch (e) { setStatus('Could not read that token: ' + (e.message || e), true); return; }
    if (!token) { setStatus('Token ' + tokenId + ' does not exist on nft.primitives.testnet.', true); return; }
    if (token.owner_id !== accountId) {
      setStatus('You do not own ' + tokenId + ' — its owner is ' + token.owner_id + '.', true);
      return;
    }
    setStatus('Approve the listing in your wallet… (the NFT moves to the Core escrow)');
    try {
      const result = await nw.sendTransaction({
        receiverId: NFT_CONTRACT,
        actions: [{
          type: 'FunctionCall', methodName: 'nft_transfer_call',
          args: { receiver_id: CORE_CONTRACT, token_id: tokenId, msg: priceYocto },
          gas: GAS_TRANSFER_CALL, deposit: '1', // NEP-171: exactly 1 yocto
        }],
      });
      setStatus('Listing submitted. ' + tokenId + ' is on the market for ' +
        yoctoToNear(priceYocto) + ' NEAR.' + txLink(txHash(result)), false, true);
      selectedTokenId = null;
      const input = $('listTokenId');
      if (input) input.value = '';
      await loadListings();
      await loadMyNfts(); // ownership changed: the listed NFT is now in escrow
    } catch (e) {
      const msg = e.message || String(e);
      setStatus(txFailed(msg) || ('Listing failed: ' + msg +
        ' (the marketplace needs the upgraded Core contract — see the note above).'), true);
    }
  }

  function wireButtons() {
    const btn = $('listNftBtn');
    if (btn) btn.addEventListener('click', listNft);
    const breedBtn = $('breedBtn');
    if (breedBtn) breedBtn.addEventListener('click', breedAgents);
    // Breed picker: tap a card to pick Parent 1, then Parent 2; tap a
    // picked card again to unpick it. Same delegated pattern as the list
    // picker, but with its own data attribute and selection (max 2).
    const breedGrid = $('breedNfts');
    if (breedGrid) {
      breedGrid.addEventListener('click', function (ev) {
        const target = ev.target && ev.target.closest ? ev.target.closest('[data-breed-token]') : null;
        if (!target) return;
        selectBreedParent(target.getAttribute('data-breed-token'));
      });
      breedGrid.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const target = ev.target && ev.target.closest ? ev.target.closest('[data-breed-token]') : null;
        if (!target) return;
        ev.preventDefault();
        selectBreedParent(target.getAttribute('data-breed-token'));
      });
    }
    // Typing a token id by hand clears the card selection, so the input
    // and the picked card never disagree.
    const tokenInput = $('listTokenId');
    if (tokenInput) {
      tokenInput.addEventListener('input', function () {
        if (selectedTokenId && tokenInput.value.trim() !== selectedTokenId) {
          selectedTokenId = null;
          const grid = $('myNfts');
          if (grid) {
            grid.querySelectorAll('[data-pick-token]').forEach(function (el) {
              el.classList.remove('selected');
              const tag = el.querySelector('.pick-tag');
              if (tag) tag.textContent = 'Tap to list this one';
            });
          }
        }
      });
    }
    const myGrid = $('myNfts');
    if (myGrid) {
      myGrid.addEventListener('click', function (ev) {
        const target = ev.target && ev.target.closest ? ev.target.closest('[data-pick-token]') : null;
        if (!target) return;
        selectToken(target.getAttribute('data-pick-token'));
      });
      myGrid.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const target = ev.target && ev.target.closest ? ev.target.closest('[data-pick-token]') : null;
        if (!target) return;
        ev.preventDefault();
        selectToken(target.getAttribute('data-pick-token'));
      });
    }
    [$('marketListings'), $('myListings')].forEach(function (container) {
      if (!container) return;
      container.addEventListener('click', function (ev) {
        const target = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
        if (!target) return;
        const action = target.getAttribute('data-action');
        const tokenId = target.getAttribute('data-token');
        if (action === 'buy') buyNft(tokenId, target.getAttribute('data-price'));
        if (action === 'delist') delistNft(tokenId);
      });
    });
  }

  async function init() {
    wireButtons();
    try {
      const nw = fastnear();
      const restored = await nw.restore({ network: NETWORK });
      const id = restored && typeof restored.accountId === 'string' ? restored.accountId : null;
      accountId = id || currentAccountId(nw);
    } catch (_) {}
    await loadListings();
    await loadMyNfts();
  }

  window.addEventListener('load', init);
})();
