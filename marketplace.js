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
  function genFromToken(token) {
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

  function genCardUrl(gen) {
    const n = parseInt(gen, 10);
    return SITE + '/nft/gen-' + (Number.isInteger(n) && n >= 0 && n <= 9 ? n : 'x') + '.svg';
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
      return;
    }
    if (!tokens.length) {
      grid.innerHTML = '';
      if (status) {
        status.innerHTML = 'This wallet owns no agent NFTs yet — <a href="index.html#mint">mint one first</a>.';
      }
      return;
    }
    if (status) {
      status.textContent = tokens.length === 1
        ? 'This wallet owns 1 agent NFT — tap it to list it.'
        : 'This wallet owns ' + tokens.length + ' agent NFTs — tap the one you want to list.';
    }
    // Keep a previous selection if that token is still owned.
    if (selectedTokenId && !tokens.some(function (t) { return t.token_id === selectedTokenId; })) {
      selectedTokenId = null;
      const input = $('listTokenId');
      if (input) input.value = '';
    }
    grid.innerHTML = tokens.map(myNftCard).join('');
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
    // Each token's title / generation comes from the NFT contract.
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
