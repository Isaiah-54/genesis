// Shared frontend helpers for Genesis multi-page site
(function () {
  const walletBtn = document.getElementById('walletBtn');
  const walletStatus = document.getElementById('walletStatus');
  const mintForm = document.getElementById('mintForm');

  if (walletBtn) {
    walletBtn.addEventListener('click', () => {
      const connected = walletBtn.dataset.connected === '1';
      if (!connected) {
        walletBtn.dataset.connected = '1';
        walletBtn.textContent = 'Wallet connected';
        walletBtn.classList.add('btn2');
        if (walletStatus) walletStatus.textContent = 'Wallet connected (demo state). Use a real NEAR testnet wallet for minting on chain.';
        if (mintForm) mintForm.style.display = 'block';
      } else {
        walletBtn.dataset.connected = '0';
        walletBtn.textContent = 'Connect wallet';
        walletBtn.classList.remove('btn2');
        if (walletStatus) walletStatus.textContent = 'Use Connect wallet in the top bar first.';
        if (mintForm) mintForm.style.display = 'none';
      }
    });
  }

  async function runBrowserJob(text, brief, keywords, minWords) {
    const kw = keywords.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    let output = '';
    try {
      const prompt = 'Summarise the following for a brief about "' + brief + '". Use the keywords: ' + kw.join(', ') + '. Text:\n\n' + text.slice(0, 2500);
      const r = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt));
      if (r.ok) output = await r.text();
    } catch (e) {}
    if (!output || output.length < 40) {
      const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
      const briefWords = new Set(brief.toLowerCase().match(/[a-z]+/g) || []);
      const scored = sentences.map(s => ({
        s,
        score: (s.toLowerCase().match(/[a-z]+/g) || []).filter(w => briefWords.has(w)).length
      })).sort((a, b) => b.score - a.score);
      output = '[extractive-fallback] ' + (scored.slice(0, 3).map(x => x.s).join(' ') || text.slice(0, 200));
    }
    const words = (output.toLowerCase().match(/[a-z]+/g) || []).length;
    const covered = kw.filter(k => output.toLowerCase().includes(k)).length;
    const pass = words >= (minWords || 20) && covered >= Math.ceil(Math.max(kw.length, 1) * 0.5);
    return { output, words, covered, total: kw.length, pass };
  }

  const runJobBtn = document.getElementById('runJobBtn');
  if (runJobBtn) {
    runJobBtn.addEventListener('click', async () => {
      const out = document.getElementById('jobOut');
      const verdict = document.getElementById('jobVerdict');
      out.textContent = 'Running…';
      const res = await runBrowserJob(
        document.getElementById('jobText').value,
        document.getElementById('jobBrief').value,
        document.getElementById('jobKeywords').value,
        parseInt(document.getElementById('jobMin').value, 10)
      );
      out.textContent = res.output;
      verdict.textContent = (res.pass ? 'PASS' : 'FAIL') + ' · ' + res.words + ' words · ' + res.covered + '/' + res.total + ' keywords';
      verdict.style.color = res.pass ? 'var(--green)' : 'var(--red)';
    });
  }

  const mintBtn = document.getElementById('mintBtn');
  if (mintBtn) {
    mintBtn.addEventListener('click', () => {
      const status = document.getElementById('mintStatus');
      const token = document.getElementById('mintToken').value.trim();
      if (!token) {
        status.textContent = 'Enter a unique token id.';
        return;
      }
      status.textContent = 'Mint is signed in your wallet on testnet. For a full wallet integration use Meteor or MyNearWallet against nft.primitives.testnet. Demo UI only here.';
    });
  }
})();
