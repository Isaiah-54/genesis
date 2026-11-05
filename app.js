/**
 * Genesis frontend — real wallet connect + nft_mint on testnet
 * Uses @fastnear/wallet (Meteor, MyNearWallet, HOT, etc.) via CDN UMD build.
 */
(function () {
  const NFT_CONTRACT = 'nft.primitives.testnet';
  const NETWORK = 'testnet';
  const MINT_DEPOSIT = '100000000000000000000000'; // 0.1 NEAR
  const GAS = '300000000000000'; // 300 TGas

  let accountId = null;

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, isError) {
    const el = $('walletStatus');
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? 'var(--red)' : 'var(--muted)';
    }
  }

  function getNearWallet() {
    return window.nearWallet || null;
  }

  function updateWalletButtons() {
    document.querySelectorAll('#walletBtn').forEach((btn) => {
      if (accountId) {
        btn.textContent =
          accountId.length > 24
            ? accountId.slice(0, 10) + '…' + accountId.slice(-6)
            : accountId;
        btn.classList.add('btn2');
        btn.dataset.connected = '1';
      } else {
        btn.textContent = 'Connect wallet';
        btn.classList.remove('btn2');
        btn.dataset.connected = '0';
      }
    });
    const mintForm = $('mintForm');
    if (mintForm) mintForm.style.display = accountId ? 'block' : 'none';
    if (accountId) {
      setStatus('Connected as ' + accountId + ' on testnet. Ready to mint.');
    } else {
      setStatus('Use Connect wallet in the top bar. Meteor and MyNearWallet are supported.');
    }
  }

  function waitForWallet(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function tick() {
        const w = getNearWallet();
        if (w && typeof w.connect === 'function') return resolve(w);
        if (Date.now() - start > (timeoutMs || 8000)) {
          return reject(new Error('Wallet library not loaded. Hard-refresh the page or open in the system browser.'));
        }
        setTimeout(tick, 150);
      })();
    });
  }

  async function connectWallet() {
    try {
      setStatus('Opening wallet selector…');
      const nw = await waitForWallet(10000);

      if (accountId) {
        try {
          if (typeof nw.disconnect === 'function') await nw.disconnect();
        } catch (_) {}
        accountId = null;
        updateWalletButtons();
        return;
      }

      const result = await nw.connect({ network: NETWORK });
      accountId =
        (result && result.accountId) ||
        nw.accountId ||
        nw.currentAccountId ||
        null;

      if (!accountId && typeof nw.getAccounts === 'function') {
        const accounts = await nw.getAccounts();
        accountId = accounts && accounts[0] && (accounts[0].accountId || accounts[0]);
      }

      if (!accountId) {
        setStatus('Connected but no account id returned. Try again.', true);
        return;
      }
      updateWalletButtons();
    } catch (e) {
      console.error(e);
      const msg = e && e.message ? e.message : String(e);
      if (/user|reject|cancel/i.test(msg)) {
        setStatus('Connection cancelled.', true);
      } else {
        setStatus('Connect failed: ' + msg, true);
      }
    }
  }

  async function mintAgent() {
    const status = $('mintStatus');
    const tokenId = (($('mintToken') && $('mintToken').value) || '').trim();
    const title = (($('mintTitle') && $('mintTitle').value) || 'Genesis Agent').trim();
    const gen = ($('mintGen') && $('mintGen').value) || '0';
    const parent = ($('mintParent') && $('mintParent').value) || 'treasury';

    if (!accountId) {
      if (status) status.textContent = 'Connect a wallet first.';
      return;
    }
    if (!tokenId) {
      if (status) status.textContent = 'Enter a unique token id.';
      return;
    }

    if (status) {
      status.textContent = 'Approve the mint in your wallet…';
      status.style.color = 'var(--muted)';
    }

    const description =
      'Genesis agent. Generation ' +
      gen +
      '. Parent: ' +
      parent +
      '. Works jobs, gets verified, earns, can reproduce or die.';

    const tokenMetadata = {
      title: title,
      description: description,
      media: 'https://raw.githubusercontent.com/Isaiah-54/genesis/main/favicon.svg',
      copies: 1,
      extra: JSON.stringify({
        generation: Number(gen) || 0,
        parent: parent,
        status: 'alive',
        product: 'genesis',
      }),
    };

    try {
      const nw = await waitForWallet(5000);
      const result = await nw.sendTransaction({
        receiverId: NFT_CONTRACT,
        actions: [
          {
            type: 'FunctionCall',
            methodName: 'nft_mint',
            args: {
              token_id: tokenId,
              receiver_id: accountId,
              token_metadata: tokenMetadata,
            },
            gas: GAS,
            deposit: MINT_DEPOSIT,
          },
        ],
      });

      const hash =
        (result && result.transaction && result.transaction.hash) ||
        (result && result.transaction_outcome && result.transaction_outcome.id) ||
        (result && result.txHash) ||
        (result && result.hash) ||
        '';

      if (status) {
        status.innerHTML =
          'Mint submitted' +
          (hash
            ? '. Tx: <a href="https://testnet.nearblocks.io/txns/' +
              hash +
              '" target="_blank" rel="noopener">' +
              hash.slice(0, 12) +
              '…</a>'
            : '. Check your wallet activity.') +
          ' Token <span class="mono">' +
          tokenId +
          '</span> → ' +
          accountId;
        status.style.color = 'var(--green)';
      }
    } catch (e) {
      console.error(e);
      const msg = e && e.message ? e.message : String(e);
      if (status) {
        status.textContent = /reject|cancel/i.test(msg)
          ? 'Mint cancelled in wallet.'
          : 'Mint failed: ' + msg;
        status.style.color = 'var(--red)';
      }
    }
  }

  async function runBrowserJob(text, brief, keywords, minWords) {
    const kw = keywords.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    let output = '';
    try {
      const prompt =
        'Summarise the following for a brief about "' +
        brief +
        '". Use the keywords: ' +
        kw.join(', ') +
        '. Text:\n\n' +
        text.slice(0, 2500);
      const r = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt));
      if (r.ok) output = await r.text();
    } catch (_) {}
    if (!output || output.length < 40) {
      const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
      const briefWords = new Set(brief.toLowerCase().match(/[a-z]+/g) || []);
      const scored = sentences
        .map((s) => ({
          s,
          score: (s.toLowerCase().match(/[a-z]+/g) || []).filter((w) => briefWords.has(w)).length,
        }))
        .sort((a, b) => b.score - a.score);
      output =
        '[extractive-fallback] ' +
        (scored.slice(0, 3).map((x) => x.s).join(' ') || text.slice(0, 200));
    }
    const words = (output.toLowerCase().match(/[a-z]+/g) || []).length;
    const covered = kw.filter((k) => output.toLowerCase().includes(k)).length;
    const pass = words >= (minWords || 20) && covered >= Math.ceil(Math.max(kw.length, 1) * 0.5);
    return { output, words, covered, total: kw.length, pass };
  }

  function wireJobButton() {
    const runJobBtn = $('runJobBtn');
    if (!runJobBtn) return;
    runJobBtn.addEventListener('click', async () => {
      const out = $('jobOut');
      const verdict = $('jobVerdict');
      out.textContent = 'Running…';
      const res = await runBrowserJob(
        $('jobText').value,
        $('jobBrief').value,
        $('jobKeywords').value,
        parseInt($('jobMin').value, 10)
      );
      out.textContent = res.output;
      verdict.textContent =
        (res.pass ? 'PASS' : 'FAIL') +
        ' · ' +
        res.words +
        ' words · ' +
        res.covered +
        '/' +
        res.total +
        ' keywords';
      verdict.style.color = res.pass ? 'var(--green)' : 'var(--red)';
    });
  }

  function wireWalletButtons() {
    document.querySelectorAll('#walletBtn').forEach((btn) => {
      btn.addEventListener('click', connectWallet);
    });
    const mintBtn = $('mintBtn');
    if (mintBtn) mintBtn.addEventListener('click', mintAgent);
  }

  wireWalletButtons();
  wireJobButton();
  updateWalletButtons();

  window.addEventListener('load', async () => {
    try {
      const nw = await waitForWallet(10000);
      if (typeof nw.restore === 'function') {
        try {
          const restored = await nw.restore({ network: NETWORK });
          if (restored && restored.accountId) accountId = restored.accountId;
        } catch (_) {}
      }
      if (!accountId) {
        accountId = nw.accountId || nw.currentAccountId || null;
      }
      if (accountId) updateWalletButtons();
      else setStatus('Wallet ready. Tap Connect wallet (Meteor / MyNearWallet supported).');
    } catch (e) {
      console.warn(e);
      setStatus(
        'Wallet library slow to load in this browser. Hard-refresh, or open the site in Chrome/Safari and connect from there.',
        true
      );
    }
  });
})();
