/**
 * Genesis frontend — real wallet connect + nft_mint on testnet
 * Uses @fastnear/wallet 2.5.0 (Meteor, MyNearWallet, HOT, and others).
 * NOTE: in @fastnear/wallet, `nearWallet.accountId` is a FUNCTION, not a
 * string — never assign it as the account id (doing so prints the function
 * source into the button). The connected account id is the STRING returned
 * by connect()/restore(), or by calling accountId({ network }).
 * NOTE 2: the library defaults to MAINNET on every fresh page load, so
 * restore()/disconnect() MUST be passed { network: 'testnet' } or they look
 * at the mainnet session (empty) and the connection is lost on navigation.
 */
(function () {
  const NFT_CONTRACT = 'nft.primitives.testnet';
  const NETWORK = 'testnet';
  const MINT_DEPOSIT = '100000000000000000000000'; // 0.1 NEAR in yocto
  const GAS = '300000000000000'; // 300 TGas

  let accountId = null;

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

  async function connectWallet() {
    try {
      const nw = fastnear();
      if (accountId) {
        try { await nw.disconnect({ network: NETWORK }); } catch (_) {}
        accountId = null;
        updateWalletButtons();
        return;
      }
      setStatus('Opening wallet selector…');
      const result = await nw.connect({ network: NETWORK });
      const id =
        (result && typeof result.accountId === 'string' && result.accountId) ||
        currentAccountId(nw);
      if (typeof id !== 'string' || !id) {
        throw new Error('Wallet connected but returned no account id.');
      }
      accountId = id;
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

    if (!accountId) {
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
      const nw = fastnear();
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
        (result && result.hash) ||
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
    let worker = 'extractive-fallback';
    try {
      const prompt =
        'Summarise the following for a brief about "' +
        brief +
        '". Use the keywords: ' +
        kw.join(', ') +
        '. Text:\n\n' +
        text.slice(0, 2500);
      const r = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt));
      if (r.ok) { output = await r.text(); worker = 'llm (pollinations, in your browser)'; }
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
    return { output, words, covered, total: kw.length, pass, worker };
  }

  async function sha256Hex(text) {
    if (!window.crypto || !window.crypto.subtle) return '(hash unavailable in this browser)';
    const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function wireAgentJobButton() {
    const btn = $('runAgentJobBtn');
    if (!btn) return;
    const copyBtn = $('copyAgentJobBtn');
    btn.addEventListener('click', async () => {
      const out = $('agentJobOut');
      const verdict = $('agentJobVerdict');
      const hashEl = $('agentJobHash');
      const payEl = $('agentJobPay');
      if (copyBtn) copyBtn.style.display = 'none';
      if (hashEl) hashEl.textContent = '';
      if (payEl) payEl.textContent = '';
      const tokenId = ($('agentJobToken') && $('agentJobToken').value || '').trim() || 'genesis-visitor-1';
      if (!accountId) { out.textContent = 'Connect a wallet first (Mint section above).'; return; }
      if (!accountId.endsWith('.testnet')) {
        out.textContent = 'This is a MAINNET account (' + accountId + '). Agent jobs pay in testnet NEAR — connect a .testnet account instead.';
        return;
      }
      out.textContent = 'Running… (real model call, can take up to a minute)';
      const res = await runBrowserJob(
        $('agentJobText').value,
        $('agentJobBrief').value,
        $('agentJobKeywords').value,
        parseInt($('agentJobMin').value, 10)
      );
      out.textContent = res.output;
      verdict.textContent =
        'Agent: ' + tokenId + ' (' + accountId + ') · Worker: ' + res.worker +
        ' · ' + res.words + ' words · ' + res.covered + '/' + res.total + ' keywords · Verdict: ' +
        (res.pass ? 'PASS' : 'FAIL');
      verdict.style.color = res.pass ? 'var(--green)' : 'var(--red)';
      const hash = await sha256Hex(res.output);
      if (hashEl) hashEl.textContent = 'Full output sha256: ' + hash;
      if (!res.pass) {
        if (payEl) payEl.textContent = 'No payment — job failed verification.';
        return;
      }
      const payload =
        'Agent: ' + tokenId + ' (' + accountId + ') · Worker: ' + res.worker +
        ' · ' + res.words + ' words · ' + res.covered + '/' + res.total + ' keywords · Verdict: PASS' +
        ' · Output hash: ' + hash + ' · Output: ' + res.output;
      if (payEl) payEl.textContent = 'Passed. Payment is not automatic here — copy the result below and send it to Everest in chat; he verifies the hash and pays 0.01 NEAR from the treasury to ' + accountId + '.';
      if (copyBtn) {
        copyBtn.style.display = '';
        copyBtn.onclick = async () => {
          try { await navigator.clipboard.writeText(payload); copyBtn.textContent = 'Copied — send it to Everest'; }
          catch (_) { copyBtn.textContent = 'Copy failed — select the text above'; }
        };
      }
    });
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
  wireAgentJobButton();
  updateWalletButtons();

  window.addEventListener('load', async () => {
    try {
      const nw = fastnear();
      const restored = await nw.restore({ network: NETWORK });
      const id = restored && typeof restored.accountId === 'string' ? restored.accountId : null;
      if (id) {
        accountId = id;
        updateWalletButtons();
      }
    } catch (e) {
      console.warn('FastNear restore:', e);
      setStatus('Wallet library loading… If this persists, hard-refresh the page.', true);
    }
  });
})();
