// Genesis arena run: one open job, two working agents, winner paid.
// Agents: gen2 vs gen3 (the two live working agents).
// Both work the same live job with the real LLM worker. Each contestant
// does 3 fresh runs (labinius-style, like a paid job): ALL 3 must pass the
// strict verifier (coverage + originality + structure, no word count) and
// the contestant is scored by the MEDIAN score. One lucky output cannot
// win. The winner is the highest median score among contestants who
// passed; if nobody passes, there is no winner and no payment.
// Payment goes through the Genesis Core escrow (post_job + pay_job via the
// CLI's `core-pay-job`), so the onchain frontier is checked AND updated:
// the winner is only paid if their median score BEATS the frontier for
// this job definition. Result saved to demo/arena-run.json (both
// contestants' runs, medians, frontier, payment tx) and the match is
// appended to demo/league.json so the league stays in sync.
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { jobDefId } = require('./engine');
const { workLLM, callLLM } = require('./worker-llm');
const { verifyRunsWithSemantics } = require('./semantic-verify');

const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
const REWARD_NEAR = '0.01';

function rpcView(contractId, method, args) {
  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 'arena-view', method: 'query',
    params: {
      request_type: 'call_function', account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      finality: 'final',
    },
  });
  const out = execSync(`curl -s -m 30 https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '${payload.replace(/'/g, `'\\''`)}'`, { maxBuffer: 4 * 1024 * 1024 }).toString();
  const j = JSON.parse(out);
  const bytes = j && j.result && j.result.result;
  if (!bytes || !bytes.length) return null;
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

(async () => {
  const brief = 'NEAR NFTs global contract mint';
  const keywords = ['near', 'nft', 'mint'];
  const page = execSync(`curl -s -m 30 https://docs.near.org/primitives/nft/nft | perl -0777 -pe 's/<script.*?<\\/script>//gs; s/<style.*?<\\/style>//gs' | sed -e 's/<[^>]*>/ /g' | tr -s ' \\n' ' '`, { maxBuffer: 4 * 1024 * 1024 }).toString();
  const source = page.slice(0, 3000);
  const jobInput = { brief, keywords, text: source };
  const defId = jobDefId(brief, keywords, source);
  const frontier = rpcView(CORE_CONTRACT, 'get_frontier', { job_def_id: defId });
  console.log('Job:', brief, '| keywords:', keywords.join(', '));
  console.log('Frontier for this job:', frontier ? `${frontier.best_score} (by ${frontier.winner})` : 'none yet — first paying score sets it');

  // Different angles per contestant: without them the same model returns
  // the same output twice (proven in arena run 1 — identical hashes), and
  // an arena with identical entries is not a competition.
  const contestants = [
    { agent: 'gen2.genesisdemo354551.testnet', token: 'genesis-gen-2', angle: 'for a beginner, plain language, no jargon' },
    { agent: 'gen3.genesisdemo354551.testnet', token: 'genesis-gen-3', angle: 'for a developer, include the exact steps and function names' },
  ];
  const entries = [];
  for (const c of contestants) {
    // The agent's REAL onchain skill (from the Core), not a hardcoded
    // 1.0: a higher generation is genuinely smarter — its quality shapes
    // the worker's brief and token budget. Falls back to 1.0 if the
    // Core read fails.
    let skill = { speed: 1, quality: 1, cost_eff: 1 };
    try {
      const rec = rpcView(CORE_CONTRACT, 'get_agent', { token_id: c.token });
      if (rec && rec.skill) skill = rec.skill;
    } catch (_) {}
    const runs = [];
    for (let i = 1; i <= 3; i++) {
      const llm = await workLLM({ ...jobInput, angle: c.angle }, { skill: { speed: skill.speed, quality: skill.quality, costEff: skill.cost_eff, language: 'en' } });
      runs.push({ output: llm.output, worker: llm.worker, model: llm.model });
      console.log(`  ${c.agent} run ${i}: ${llm.worker} (${llm.model}), ${llm.output.length} chars (quality ${skill.quality})`);
    }
    // Labinius-style + semantic: all 3 runs must pass the structural
    // gates, the median scores, and the median output must also pass
    // the semantic judge (accuracy, relevance, completeness, evidence
    // against the source). A contestant whose median output is a
    // structured lie does not pass, however high it scores.
    const v = await verifyRunsWithSemantics(jobInput, runs.map(r => r.output), callLLM);
    const medianOutput = v.medianOutput;
    const outputHash = crypto.createHash('sha256').update(medianOutput).digest('hex');
    entries.push({
      agent: c.agent,
      runs: runs.map((r, i) => ({ run: i + 1, worker: r.worker, model: r.model, output: r.output })),
      scores: v.scores,
      medianScore: v.medianScore,
      pass: v.pass,
      semantic: v.semantic,
      medianOutput,
      outputHash,
      words: v.medianGates ? v.medianGates.originality.totalWords : 0,
      keywordsCovered: v.medianGates ? v.medianGates.coverage.covered : 0,
      keywordsTotal: keywords.length,
      // Backwards-compatible flat fields (the league reads score/words).
      score: v.medianScore,
      output: medianOutput,
    });
    console.log(`${c.agent} -> ${v.pass ? 'PASS' : 'FAIL'} (all 3 runs ${v.pass ? 'passed' : 'did not pass'}), scores [${v.scores.join(', ')}], median ${v.medianScore}, semantic: ${v.semantic ? (v.semantic.passed ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(v.semantic.scores) : 'skipped'}`);
  }

  const passing = entries.filter(e => e.pass);
  let winner = null;
  let payment = { amount: REWARD_NEAR + ' NEAR', tx: null, status: 'no payment' };
  let note = '';
  if (!passing.length) {
    note = 'No contestant passed the strict verifier (all 3 runs must pass), so there is no winner and no payment.';
    console.log(note);
  } else {
    passing.sort((a, b) => b.medianScore - a.medianScore);
    const best = passing[0];
    if (frontier && best.medianScore <= frontier.best_score) {
      note = `Winner ${best.agent} scored ${best.medianScore}, which does not beat the frontier ${frontier.best_score} — no payment. The frontier stands.`;
      console.log(note);
      winner = best.agent;
      payment.status = 'not paid — did not beat the frontier';
    } else {
      winner = best.agent;
      console.log(`WINNER: ${winner}, median score ${best.medianScore}`);
      // Pay through the Core escrow (the CLI's core-pay-job posts the job
      // with the reward locked, then pays it; the contract re-checks the
      // frontier onchain, so a race cannot pay a beaten score).
      const out = execSync(`node ${__dirname}/cli.js core-pay-job ${best.outputHash} ${winner} ${best.medianScore} ${defId} ${REWARD_NEAR}`, { cwd: __dirname + '/..' }).toString();
      console.log(out);
      // The CLI prints JSON {"post": "<hash|already posted>", "pay": "<hash|dry-run>"}.
      // Take the pay hash from it (fall back to the old "pay tx:" line, for
      // an older CLI). A missing hash means the payment did not happen.
      let payHash = null;
      try {
        const parsed = JSON.parse(out.trim().split('\n').find(l => l.trim().startsWith('{')) || '{}');
        if (parsed && typeof parsed.pay === 'string' && /^[0-9a-f]{64}$/.test(parsed.pay)) payHash = parsed.pay;
      } catch (_) {}
      if (!payHash) {
        const m = out.match(/pay tx: ([0-9a-f]+)/) || out.match(/hash: '([0-9a-f]+)'/);
        payHash = m ? m[1] : null;
      }
      payment = { amount: REWARD_NEAR + ' NEAR', tx: payHash, status: payHash ? 'Success' : 'FAILED — no pay tx in the CLI output' };
      note = `Winner paid ${REWARD_NEAR} NEAR through the Core escrow; the frontier for this job is now ${best.medianScore}.`;
    }
  }

  const result = {
    job: { brief, keywords, job_def_id: defId, source: 'https://docs.near.org/primitives/nft/nft' },
    frontier_before: frontier ? { best_score: frontier.best_score, winner: frontier.winner } : null,
    entries: entries.map(e => ({
      agent: e.agent, worker: e.runs[0].worker, model: e.runs[0].model,
      runs: e.runs.map(r => ({ run: r.run, output: r.output })),
      scores: e.scores, medianScore: e.medianScore, pass: e.pass, semantic: e.semantic,
      output: e.medianOutput, outputHash: e.outputHash,
      words: e.words, keywordsCovered: e.keywordsCovered, keywordsTotal: e.keywordsTotal,
      score: e.medianScore,
    })),
    winner,
    payment,
    note,
  };
  fs.writeFileSync(path.join(__dirname, '..', 'demo', 'arena-run.json'), JSON.stringify(result, null, 2));
  console.log('Saved demo/arena-run.json, payment tx:', payment.tx);

  // Append the match to the league so the standings stay in sync.
  const leaguePath = path.join(__dirname, '..', 'demo', 'league.json');
  const league = JSON.parse(fs.readFileSync(leaguePath, 'utf8'));
  league.matches = league.matches || [];
  league.matches.push({
    date: new Date().toISOString().slice(0, 10),
    job: brief,
    note: `Strict verifier + semantic judge + median of 3 + frontier. ${note}`,
    payment_tx: payment.tx || null,
    results: entries.map(e => ({ agent: e.agent, score: e.medianScore, words: e.words, pass: e.pass })),
    winner,
  });
  // Recompute the standings from ALL matches (not just this one), so the
  // table never goes stale: wins/losses are match wins (highest median
  // score), best score is the highest median, earnings count only paid
  // matches (payment_tx present, 0.01 NEAR each). Note: league wins are
  // match wins, not evolution wins — evolution counts only PAID jobs on
  // the Core, so a match won but not paid (tied frontier) is a league
  // win but not an evolution win.
  const byAgent = {};
  for (const m of league.matches) {
    const agents = (m.results || []).map(r => r.agent);
    for (const a of agents) {
      byAgent[a] = byAgent[a] || { agent: a, wins: 0, losses: 0, played: 0, best_score: 0, paid_wins: 0 };
      byAgent[a].played += 1;
      const res = (m.results || []).find(r => r.agent === a);
      if (res && typeof res.score === 'number') byAgent[a].best_score = Math.max(byAgent[a].best_score, res.score);
    }
    if (m.winner && byAgent[m.winner]) {
      byAgent[m.winner].wins += 1;
      if (m.payment_tx) byAgent[m.winner].paid_wins += 1;
      for (const a of agents) if (a !== m.winner && byAgent[a]) byAgent[a].losses += 1;
    }
  }
  const tokenFor = (a) => a.includes('gen2.') ? 'genesis-gen-2' : a.includes('gen3.') ? 'genesis-gen-3' : a;
  league.standings = Object.values(byAgent)
    .sort((x, y) => y.wins - x.wins || y.best_score - x.best_score)
    .map(s => ({
      agent: s.agent,
      token: tokenFor(s.agent),
      wins: s.wins,
      losses: s.losses,
      played: s.played,
      win_rate: s.played ? Math.round(100 * s.wins / s.played) + '%' : '0%',
      best_score: s.best_score,
      arena_earnings: (0.01 * s.paid_wins).toFixed(2) + ' NEAR',
    }));
  fs.writeFileSync(leaguePath, JSON.stringify(league, null, 2));
  console.log('Appended the match to demo/league.json (standings recomputed)');
})().catch(e => { console.error('ARENA FAILED:', e.message); process.exit(1); });
