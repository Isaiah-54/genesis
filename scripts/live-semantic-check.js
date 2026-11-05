// Live check for the semantic verifier (no payment, no posting).
// Fetches a real docs page, has the real worker write one summary, then
// judges two versions of it with the real model judge (NEAR AI first):
//   TRUE  — the worker's own output, as written.
//   FALSE — the same output plus one invented fact (a 100 NEAR fee and a
//           24-hour self-destruct the source never mentions).
// Expected: TRUE passes, FALSE fails on accuracy. Both must pass the
// structural gates — that is the gap the semantic judge closes.
// Usage: node scripts/live-semantic-check.js
const { execSync } = require('child_process');
const { workLLM, callLLM } = require('../src/worker-llm');
const { semanticVerify } = require('../src/semantic-verify');
const { verifyStrict } = require('../src/engine');

(async () => {
  const page = execSync(`curl -s -m 30 https://docs.near.org/primitives/nft/nft | perl -0777 -pe 's/<script.*?<\\/script>//gs; s/<style.*?<\\/style>//gs' | sed -e 's/<[^>]*>/ /g' | tr -s ' \\n' ' '`, { maxBuffer: 4 * 1024 * 1024 }).toString();
  if (page.length < 500) throw new Error('Fetched page too short for a real job');
  const job = { brief: 'NEAR NFTs global contract mint', keywords: ['near', 'nft', 'mint'], text: page.slice(0, 3000) };
  const llm = await workLLM(job, { skill: { speed: 1, quality: 1, costEff: 1, language: 'en' } });
  console.log('worker:', llm.worker, '| model:', llm.model, '| verifiable:', llm.verifiable);
  const TRUE = llm.output;
  const FALSE = TRUE + ' Minting also requires a one-time payment of exactly 100 NEAR to the contract owner, and the token is destroyed after 24 hours unless it is renewed.';
  const results = {};
  for (const [name, out] of [['TRUE', TRUE], ['FALSE', FALSE]]) {
    const structural = verifyStrict(job, out);
    console.log(`\n${name} — structural pass: ${structural.pass} | score: ${structural.score}`);
    // The judge gets the full page (it slices to SOURCE_BUDGET): the
    // facts an answer draws on can live past the worker's 3,000 chars.
    const sem = await semanticVerify({ brief: job.brief, keywords: job.keywords, sourceText: page, output: out, structural: structural.gates, callLLM });
    console.log(`${name} — semantic passed: ${sem.passed} | scores: ${JSON.stringify(sem.scores)} | judge model: ${sem.model} | verifiable: ${sem.verifiable}`);
    console.log(`${name} — reason: ${sem.reason}`);
    if (sem.unsupported_claims.length) console.log(`${name} — unsupported claims: ${JSON.stringify(sem.unsupported_claims)}`);
    results[name] = { structuralPass: structural.pass, semanticPassed: sem.passed, scores: sem.scores };
  }
  console.log('\n' + JSON.stringify(results, null, 2));
  if (!results.TRUE.structuralPass || !results.FALSE.structuralPass) throw new Error('expected both versions to pass the structural gates');
  if (!results.TRUE.semanticPassed) throw new Error('TRUE summary failed the semantic judge — judge too strict or worker hallucinated');
  if (results.FALSE.semanticPassed) throw new Error('FALSE summary passed the semantic judge — judge did not catch the invented fact');
  console.log('LIVE CHECK PASSED: true summary paid, invented-fact summary refused');
})().catch((e) => { console.error('LIVE CHECK FAILED:', e.message); process.exit(1); });
