// Re-judge the arena run-3 winning answer (gen3's median output) with
// the semantic judge's longer view of the source. The original demo
// verdict (accuracy 30, FAIL) came from a judge that only saw the first
// 3,000 chars of the docs page — the answer's deploy-command details
// sit at char 9,599. The judge now gets the full page (it slices to
// SOURCE_BUDGET, 12,000 chars). This script writes the new verdict into
// demo/guided-tour.json (gen3.semantic) so the demo shows the current
// result honestly, pass or fail. No payment, no posting.
// Usage: node scripts/rejudge-run3.js
const { execSync } = require('child_process');
const fs = require('fs');
const { callLLM } = require('../src/worker-llm');
const { semanticVerify, SOURCE_BUDGET } = require('../src/semantic-verify');

(async () => {
  // Fetch with plain curl to a file and strip tags in Node: the perl
  // pipeline inside a shell string mangles backslashes too easily.
  execSync('curl -s -m 30 https://docs.near.org/primitives/nft/nft -o /tmp/nft-page.html', { stdio: 'ignore' });
  const raw = fs.readFileSync('/tmp/nft-page.html', 'utf8');
  const page = raw.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (page.length < 500) throw new Error('Fetched page too short for a real job');
  const tour = JSON.parse(fs.readFileSync('demo/guided-tour.json', 'utf8'));
  const gen3 = tour.gen3;
  const sem = await semanticVerify({
    brief: tour.job.brief,
    keywords: tour.job.keywords,
    sourceText: page, // the full page — the judge slices to SOURCE_BUDGET
    output: gen3.output,
    structural: gen3.gates,
    callLLM,
  });
  console.log('Run-3 gen3 answer, judge with the longer view (budget', SOURCE_BUDGET, 'chars):');
  console.log('passed:', sem.passed, '| scores:', JSON.stringify(sem.scores));
  console.log('reason:', sem.reason);
  if (sem.unsupported_claims.length) console.log('unsupported claims:', JSON.stringify(sem.unsupported_claims, null, 2));
  if (sem.missing.length) console.log('missing:', JSON.stringify(sem.missing, null, 2));
  console.log('judge model:', sem.model, '| provider:', sem.provider, '| verifiable:', sem.verifiable);
  // Never overwrite the demo's verdict with a fail-closed "judge
  // unavailable": that would replace a real verdict with a non-result.
  if (!sem.scores) throw new Error('judge returned no scores — guided-tour.json left untouched');
  gen3.semantic = { ...sem, sourceBudgetChars: SOURCE_BUDGET, judgedAt: new Date().toISOString() };
  fs.writeFileSync('demo/guided-tour.json', JSON.stringify(tour, null, 1) + '\n');
  console.log('Wrote the new verdict into demo/guided-tour.json (gen3.semantic).');
})().catch((e) => { console.error('REJUDGE FAILED:', e.message); process.exit(1); });
