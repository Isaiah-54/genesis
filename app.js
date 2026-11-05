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
  const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
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

  // True if the token id already exists on the shared NFT contract,
  // false if it is free, null if the check itself failed.
  async function tokenExists(tokenId) {
    try {
      const check = await fetch('https://rpc.testnet.near.org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'genesis-mint-check', method: 'query',
          params: {
            request_type: 'call_function', account_id: NFT_CONTRACT,
            method_name: 'nft_token',
            args_base64: btoa(JSON.stringify({ token_id: tokenId })),
            finality: 'final',
          },
        }),
      });
      const data = await check.json();
      const bytes = data && data.result && data.result.result;
      if (!bytes || !bytes.length) return null;
      return !!JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
    } catch (_) {
      return null;
    }
  }

  // The mint form always offers a free token id: if the filled-in id follows
  // the genesis-visitor-N pattern and is already taken, walk up to the first
  // free number and fill it in. Any wallet can then mint another gen-0 card
  // — only the token id has to be unique, not the generation.
  async function suggestFreeTokenId() {
    const field = $('mintToken');
    if (!field) return;
    const m = (field.value || '').trim().match(/^genesis-visitor-(\d+)$/);
    if (!m) return;
    let n = parseInt(m[1], 10);
    for (let i = 0; i < 20; i++) {
      const exists = await tokenExists('genesis-visitor-' + n);
      if (exists === false) { field.value = 'genesis-visitor-' + n; return; }
      if (exists === null) return; // check failed — leave the field alone
      n += 1;
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

    if (status) status.textContent = 'Checking the token id…';

    // Pre-flight: the shared contract rejects a duplicate token id with a
    // panic ("token_id must be unique"). Check first so the user never opens
    // the wallet for a mint that cannot succeed. If the check itself fails
    // (network error), proceed anyway — the contract still rejects duplicates.
    // NOTE: uniqueness is per token id, NOT per generation — any number of
    // gen-0 agents can exist, each with its own token id (genesis-gen-0 and
    // genesis-visitor-1 are both gen 0, owned by different wallets).
    if (await tokenExists(tokenId)) {
      if (status) {
        status.textContent = 'That token id is already taken — pick a new unique token id.';
        status.style.color = 'var(--red)';
      }
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

  // Strict verifier for real paid work — same three gates as engine.js
  // verifyStrict and api/pay-job.js (keep the thresholds identical):
  //   1. Coverage: EVERY keyword, each inside a sentence of >= 8 words.
  //   2. Originality: under 30% of output words inside 8-word sequences
  //      copied from the source text. Copy-paste fails.
  //   3. Structure: at least 3 sentences. No word count anywhere.
  function verifyStrictBrowser(source, keywords, output) {
    const kw = keywords.map((k) => k.toLowerCase());
    const tokensOf = (t) => (t || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
    const sentencesOf = (t) => (t || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => tokensOf(s).length >= 3);
    const outTokens = tokensOf(output);
    const sentences = sentencesOf(output);
    const keywordOk = kw.map((k) =>
      sentences.some((s) => s.toLowerCase().includes(k) && tokensOf(s).length >= 8));
    const coverage = { passed: keywordOk.every(Boolean), covered: keywordOk.filter(Boolean).length, total: kw.length };
    const srcTokens = tokensOf(source);
    const srcShingles = new Set();
    for (let i = 0; i + 8 <= srcTokens.length; i++) srcShingles.add(srcTokens.slice(i, i + 8).join(' '));
    const coveredPos = new Array(outTokens.length).fill(false);
    for (let i = 0; i + 8 <= outTokens.length; i++) {
      if (srcShingles.has(outTokens.slice(i, i + 8).join(' '))) {
        for (let j = i; j < i + 8; j++) coveredPos[j] = true;
      }
    }
    const copiedWords = coveredPos.filter(Boolean).length;
    const copiedShare = outTokens.length ? copiedWords / outTokens.length : 0;
    const originality = { passed: copiedShare < 0.30, copiedShare: +copiedShare.toFixed(2), copiedWords, totalWords: outTokens.length };
    const structure = { passed: sentences.length >= 3, sentences: sentences.length };
    const pass = coverage.passed && originality.passed && structure.passed;
    // Deterministic quality score (labinius-style: one measured number).
    const score = coverage.covered * 100
      + Math.min(originality.totalWords, 200)
      + Math.round((1 - copiedShare) * 100);
    return { pass, score, gates: { coverage, originality, structure } };
  }

  function gatesText(g) {
    return 'Coverage ' + g.coverage.covered + '/' + g.coverage.total +
      ' · Originality ' + Math.round(g.originality.copiedShare * 100) + '% copied' +
      ' · Structure ' + g.structure.sentences + ' sentences';
  }

  // Generic read-only view call on testnet RPC.
  async function viewCall(accountId, methodName, args) {
    const r = await fetch('https://rpc.testnet.near.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'genesis-view', method: 'query',
        params: {
          request_type: 'call_function', account_id: accountId,
          method_name: methodName,
          args_base64: btoa(JSON.stringify(args)),
          finality: 'final',
        },
      }),
    });
    const data = await r.json();
    const bytes = data && data.result && data.result.result;
    if (!bytes || !bytes.length) return null;
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
  }

  // The labinius frontier for this job definition: the best score on it so
  // far, or null when no attempt has paid yet. jobDefId is the sha256 of
  // brief + '|' + keywords + '|' + source (same as engine.js / pay-job).
  async function getFrontier(brief, keywords, source) {
    try {
      const defId = await sha256Hex(brief + '|' + keywords + '|' + source);
      if (!defId || defId.startsWith('(')) return null;
      return await viewCall(CORE_CONTRACT, 'get_frontier', { job_def_id: defId });
    } catch (_) {
      return null;
    }
  }

  // Labinius-style: 3 fresh model runs of the same job. All 3 must pass
  // the gates; the attempt is scored by the MEDIAN score, so one lucky
  // output cannot win. onProgress(run) reports each run to the caller.
  async function runBrowserJob(text, brief, keywords, onProgress) {
    const kw = keywords.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const outputs = [];
    let worker = 'extractive-fallback';
    for (let run = 0; run < 3; run++) {
      if (onProgress) onProgress(run + 1);
      let output = '';
      try {
        const prompt =
          'Summarise the following for a brief about "' +
          brief +
          '". Cover every one of these keywords, each inside a full sentence of its own: ' +
          kw.join(', ') +
          '. Write in your own words — do not copy sentences from the text. Write at least three sentences. Text:\n\n' +
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
      outputs.push(output);
    }
    const results = outputs.map((o) => ({ output: o, v: verifyStrictBrowser(text, kw, o) }));
    const allPass = results.every((r) => r.v.pass);
    const scores = results.map((r) => r.v.score).sort((a, b) => a - b);
    const medianScore = scores[Math.floor(scores.length / 2)];
    const median = results.find((r) => r.v.score === medianScore) || results[0];
    return {
      outputs,
      medianOutput: median.output,
      medianScore,
      scores: results.map((r) => r.v.score),
      gates: median.v.gates,
      pass: allPass,
      worker,
    };
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
      out.textContent = 'Running… (3 real model calls, can take up to a few minutes — the median score counts)';
      // Show the labinius bar before running: the best score on this job.
      const frontier = await getFrontier(
        $('agentJobBrief').value,
        $('agentJobKeywords').value,
        $('agentJobText').value
      );
      if (frontier) {
        verdict.textContent = 'Current best on this job: ' + frontier.best_score + ' — beat it to earn 0.01 NEAR.';
        verdict.style.color = '';
      } else {
        verdict.textContent = 'No best yet on this job — a passing run sets the frontier.';
        verdict.style.color = '';
      }
      const res = await runBrowserJob(
        $('agentJobText').value,
        $('agentJobBrief').value,
        $('agentJobKeywords').value,
        (run) => { out.textContent = 'Running… model call ' + run + ' of 3 (median score counts)'; }
      );
      out.textContent = res.medianOutput;
      verdict.textContent =
        'Agent: ' + tokenId + ' (' + accountId + ') · Worker: ' + res.worker +
        ' · Runs: ' + res.scores.join(', ') + ' · Median score: ' + res.medianScore +
        (frontier ? ' · Frontier: ' + frontier.best_score : ' · Frontier: none yet') +
        ' · ' + gatesText(res.gates) + ' · Verdict: ' +
        (res.pass ? 'PASS' : 'FAIL');
      verdict.style.color = res.pass ? 'var(--green)' : 'var(--red)';
      const hash = await sha256Hex(res.medianOutput);
      if (hashEl) hashEl.textContent = 'Full output sha256: ' + hash;
      if (!res.pass) {
        if (payEl) payEl.textContent = 'No payment — a run failed verification.';
        return;
      }
      const payload =
        'Agent: ' + tokenId + ' (' + accountId + ') · Worker: ' + res.worker +
        ' · Runs: ' + res.scores.join(', ') + ' · Median score: ' + res.medianScore +
        ' · ' + gatesText(res.gates) + ' · Verdict: PASS' +
        ' · Output hash: ' + hash + ' · Output: ' + res.medianOutput;
      // Automatic payment: send the verified result to the server function,
      // which re-checks the output hash and the verdict and pays 0.01 NEAR
      // from the treasury through the Core escrow. The copy button stays as
      // a fallback if the automatic payment is unavailable or fails.
      if (payEl) payEl.textContent = 'Passed. Paying automatically…';
      let paid = false;
      try {
        const payRes = await fetch('/api/pay-job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token_id: tokenId,
            account_id: accountId,
            outputs: res.outputs,
            source: $('agentJobText').value,
            brief: $('agentJobBrief').value,
            keywords: $('agentJobKeywords').value,
          }),
        });
        const pay = await payRes.json();
        if (pay && pay.ok) {
          paid = true;
          if (payEl) {
            payEl.innerHTML =
              'Paid 0.01 NEAR automatically to ' + accountId + ' (median score ' + pay.median_score + '). Tx: <a href="https://testnet.nearblocks.io/txns/' + pay.pay_tx + '" target="_blank" rel="noopener">' +
              pay.pay_tx.slice(0, 12) + '…</a>';
            payEl.style.color = 'var(--green)';
          }
        } else if (payEl) {
          payEl.textContent = 'Automatic payment failed: ' + (pay && pay.error ? pay.error : 'unknown error') +
            ' — copy the result below and send it to Everest in chat instead.';
        }
      } catch (_) {
        if (payEl) payEl.textContent = 'Automatic payment is not reachable right now — copy the result below and send it to Everest in chat instead.';
      }
      if (paid) return;
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
      out.textContent = 'Running… (3 model calls — the median score counts)';
      const res = await runBrowserJob(
        $('jobText').value,
        $('jobBrief').value,
        $('jobKeywords').value,
        (run) => { out.textContent = 'Running… model call ' + run + ' of 3 (median score counts)'; }
      );
      out.textContent = res.medianOutput;
      verdict.textContent =
        (res.pass ? 'PASS' : 'FAIL') +
        ' · Runs: ' + res.scores.join(', ') + ' · Median score: ' + res.medianScore +
        ' · ' +
        gatesText(res.gates);
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
    try { await suggestFreeTokenId(); } catch (_) {}
  });
})();
