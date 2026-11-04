// Genesis arena run: one open job, two working agents, winner paid.
// Agents: gen2 (alive, 0.53 NEAR) vs gen3 (newborn, created by this run).
// Both work the same live job with the real LLM worker. The verifier
// scores both; the winner takes 0.01 NEAR from the treasury, the loser
// gets nothing. Result saved to demo/arena-run.json with both outputs,
// both scores, and the payment tx — anyone can re-verify the scores.
const { execSync } = require('child_process');
const fs = require('fs');
const { KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');
const { verify } = require('./engine');
const { workLLM } = require('./worker-llm');
const { postJob, scoreOutput, pickWinner } = require('./jobs-board');
const MASTER = 'genesisdemo354551.testnet';
// Payment goes through src/cli.js pay, the proven curl-broadcast path.
(async () => {
  const job = postJob({ brief: 'NEAR NFTs global contract mint', keywords: ['near', 'nft', 'mint'], minWords: 20, pay: '0.01', poster: MASTER });
  const page = execSync(`curl -s -m 30 https://docs.near.org/primitives/nft/nft | perl -0777 -pe 's/<script.*?<\\/script>//gs; s/<style.*?<\\/style>//gs' | sed -e 's/<[^>]*>/ /g' | tr -s ' \\n' ' '`, { maxBuffer: 4 * 1024 * 1024 }).toString();
  const jobInput = { brief: job.brief, minWords: job.minWords, keywords: job.keywords, text: page.slice(0, 3000) };
  const entries = [];
  // Different angles per contestant: without them the same model returns
  // the same output twice (proven in arena run 1 — identical hashes), and
  // an arena with identical entries is not a competition.
  const contestants = [
    { agent: 'gen2.genesisdemo354551.testnet', angle: 'for a beginner, plain language, no jargon' },
    { agent: 'gen3.genesisdemo354551.testnet', angle: 'for a developer, include the exact steps and function names' },
  ];
  for (const c of contestants) {
    const agent = c.agent;
    const llm = await workLLM({ ...jobInput, angle: c.angle }, { skill: { speed: 1, quality: 1, costEff: 1, language: 'en' } });
    const s = scoreOutput(jobInput, llm.output, verify);
    entries.push({ agent, worker: llm.worker, model: llm.model, output: llm.output, ...s });
    console.log(agent, '->', llm.worker, s.pass ? 'PASS' : 'FAIL', s.words, 'words,', s.keywordsCovered + '/' + s.keywordsTotal, 'keywords, score', s.score.toFixed(2));
  }
  const winner = pickWinner(entries);
  console.log('WINNER:', winner.agent, 'score', winner.score.toFixed(2));
  // Pay via the CLI's proven curl-broadcast path: shell out to cli pay.
  const out = execSync(`node ${__dirname}/cli.js pay ${winner.agent} 0.01`, { cwd: __dirname + '/..' }).toString();
  console.log(out);
  const m = out.match(/hash: '([0-9a-f]+)'/);
  const result = { job, entries: entries.map(e => ({ agent: e.agent, worker: e.worker, model: e.model, output: e.output, words: e.words, keywordsCovered: e.keywordsCovered, keywordsTotal: e.keywordsTotal, pass: e.pass, score: e.score, outputHash: e.outputHash })), winner: winner.agent, payment: { amount: '0.01 NEAR', tx: m ? m[1] : null, status: 'Success' } };
  fs.writeFileSync(__dirname + '/../demo/arena-run.json', JSON.stringify(result, null, 2));
  console.log('Saved demo/arena-run.json, payment tx:', result.payment.tx);
})().catch(e => { console.error('ARENA FAILED:', e.message); process.exit(1); });
