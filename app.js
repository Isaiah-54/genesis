/**
 * Genesis frontend — real wallet connect + nft_mint on testnet
 * Uses @hot-labs/near-connect (Meteor, MyNearWallet, HOT, and others)
 */
(function () {
  const NFT_CONTRACT = 'nft.primitives.testnet';
  const NETWORK = 'testnet';
  const MINT_DEPOSIT = '100000000000000000000000'; // 0.1 NEAR in yocto
  const GAS = '300000000000000'; // 300 TGas

  let connector = null;
  let wallet = null;
  let accountId = null;

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, isError) {
    const el = $('walletStatus');
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? 'var(--red)' : 'var(--muted)';
    }
  }

  function updateWalletButtons() {
    document.querySelectorAll('#walletBtn').forEach((btn) => {
      if (accountId) {
        btn.textContent = accountId.length > 24 ? accountId.slice(0, 10) + '…' + accountId.slice(-6) : accountId;
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
    if (accountId) setStatus('Connected as ' + accountId + ' on testnet. Ready to mint.');
    else setStatus('Use Connect wallet in the top bar. Meteor and MyNearWallet are supported.');
  }

  async function ensureConnector() {
    if (connector) return connector;
    if (typeof NearConnector === 'undefined' && typeof window.NearConnector === 'undefined') {
      throw new Error('NEAR Connect library not loaded. Check the script tag.');
    }
    const NearConnectorCtor = window.NearConnector || NearConnector;
    connector = new NearConnectorCtor({
      network: NETWORK,
      features: {
        signAndSendTransaction: true,
        signInWithoutAddKey: true,
      },
    });
    connector.on('wallet:signIn', async (payload) => {
      try {
        wallet = payload.wallet || (await connector.wallet());
        accountId = (payload.accounts && payload.accounts[0] && payload.accounts[0].accountId) || null;
        if (!accountId && wallet && wallet.getAccounts) {
          const accounts = await wallet.getAccounts();
          accountId = accounts[0] && accounts[0].accountId;
        }
        updateWalletButtons();
      } catch (e) {
        console.error(e);
        setStatus('Sign-in event error: ' + (e.message || e), true);
      }
    });
    connector.on('wallet:signOut', () => {
      wallet = null;
      accountId = null;
      updateWalletButtons();
    });
    return connector;
  }

  async function connectWallet() {
    try {
      setStatus('Opening wallet selector…');
      const c = await ensureConnector();
      if (accountId) {
        try {
          const w = wallet || (await c.wallet());
          await c.disconnect(w);
        } catch (_) {
          wallet = null;
          accountId = null;
        }
        updateWalletButtons();
        return;
      }
      const connectedWallet = await c.connect();
      wallet = connectedWallet;
      const accounts = await connectedWallet.getAccounts();
      accountId = accounts[0] && accounts[0].accountId;
      updateWalletButtons();
    } catch (e) {
      console.error(e);
      if (String(e.message || e).toLowerCase().includes('user') || String(e).includes('reject')) {
        setStatus('Connection cancelled.', true);
      } else {
        setStatus('Connect failed: ' + (e.message || e), true);
      }
    }
  }

  async function mintAgent() {
    const status = $('mintStatus');
    const tokenId = ($('mintToken') && $('mintToken').value || '').trim();
    const title = ($('mintTitle') && $('mintTitle').value || 'Genesis Agent').trim();
    const gen = ($('mintGen') && $('mintGen').value) || '0';
    const parent = ($('mintParent') && $('mintParent').value) || 'treasury';

    if (!accountId || !wallet) {
      if (status) status.textContent = 'Connect a wallet first.';
      return;
    }
    if (!tokenId) {
      if (status) status.textContent = 'Enter a unique token id.';
      return;
    }

    if (status) status.textContent = 'Approve the mint in your wallet…';

    const description =
      'Genesis agent. Generation ' + gen + '. Parent: ' + parent +
      '. Works jobs, gets verified, earns, can reproduce or die.';

    // Each generation mints with its own card image (gen 0-9, gen-x above 9).
    const genNum = parseInt(gen, 10);
    const media = (Number.isInteger(genNum) && genNum >= 0 && genNum <= 9)
      ? 'https://genesis-roan-eta.vercel.app/nft/gen-' + genNum + '.svg'
      : 'https://genesis-roan-eta.vercel.app/nft/gen-x.svg';

    const tokenMetadata = {
      title: title,
      description: description,
      media: media,
      copies: 1,
      extra: JSON.stringify({
        generation: Number(gen) || 0,
        parent: parent,
        status: 'alive',
        product: 'genesis',
      }),
    };

    try {
      const w = wallet || (await connector.wallet());
      const result = await w.signAndSendTransaction({
        receiverId: NFT_CONTRACT,
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'nft_mint',
              args: {
                token_id: tokenId,
                receiver_id: accountId,
                token_metadata: tokenMetadata,
              },
              gas: GAS,
              deposit: MINT_DEPOSIT,
            },
          },
        ],
      });

      const hash =
        (result && result.transaction && result.transaction.hash) ||
        (result && result.transaction_outcome && result.transaction_outcome.id) ||
        (result && result.txHash) ||
        '';

      if (status) {
        status.innerHTML =
          'Mint submitted' +
          (hash
            ? '. Tx: <a href="https://testnet.nearblocks.io/txns/' + hash + '" target="_blank" rel="noopener">' +
              hash.slice(0, 12) + '…</a>'
            : '. Check your wallet activity.') +
          ' Token <span class="mono">' + tokenId + '</span> → ' + accountId;
        status.style.color = 'var(--green)';
      }
    } catch (e) {
      console.error(e);
      const msg = e.message || String(e);
      if (status) {
        status.textContent =
          msg.toLowerCase().includes('reject') || msg.toLowerCase().includes('cancel')
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
      const briefWords = new Set((brief.toLowerCase().match(/[a-z]+/g) || []));
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
      await ensureConnector();
      if (connector.wallet) {
        try {
          const w = await connector.wallet();
          if (w) {
            wallet = w;
            const accounts = await w.getAccounts();
            if (accounts && accounts[0]) {
              accountId = accounts[0].accountId;
              updateWalletButtons();
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn('NEAR Connect init:', e);
      setStatus('Wallet library loading… If this persists, hard-refresh the page.', true);
    }
  });
})();
