// Genesis open job board + arena scoring.
// Anyone can post a job. The board is a public, auditable file.
// True on-chain escrow is the contract's post_job/pay_job (see contracts/).
// Arena rule: every entered agent works the same job. Verifier scores.
// Winner takes the pay. Losers get nothing.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const BOARD = path.join(__dirname, '..', 'demo', 'jobs-board.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(BOARD, 'utf8'));
  } catch {
    return { jobs: [], version: 1 };
  }
}

function save(b) {
  fs.writeFileSync(BOARD, JSON.stringify(b, null, 2));
}

function postJob({ brief, keywords = [], pay = 0.01, poster = 'anonymous' }) {
  const b = load();
  const job = {
    id: 'job-' + Date.now(),
    brief,
    keywords,
    pay,
    poster,
    status: 'open',
    created: new Date().toISOString(),
    entries: [],
  };
  b.jobs = b.jobs || [];
  b.jobs.push(job);
  save(b);
  return job;
}

function listOpen() {
  return (load().jobs || []).filter(j => j.status === 'open');
}

function closeJob(jobId, winner = null) {
  const b = load();
  const job = (b.jobs || []).find(j => j.id === jobId);
  if (!job) throw new Error('Job not found: ' + jobId);
  job.status = winner ? 'awarded' : 'closed';
  job.winner = winner;
  job.closedAt = new Date().toISOString();
  save(b);
  return job;
}

function scoreOutput(job, output, verifyFn) {
  const v = verifyFn(job, output);
  // verifyStrict returns { pass, score, gates } with no flat words /
  // keywordsCovered fields; the legacy verify returns the flat fields and
  // no score. Normalise both so arena callers keep working, and never
  // recompute the score from the legacy formula when verifyStrict already
  // supplied the labinius score (the old formula reads undefined fields
  // and produces NaN).
  const words = v.gates?.originality?.totalWords ?? v.words ?? 0;
  const keywordsCovered = v.gates?.coverage?.covered ?? v.keywordsCovered ?? 0;
  const keywordsTotal = v.gates?.coverage?.total ?? v.keywordsTotal ?? (job.keywords || []).length;
  const score = typeof v.score === 'number'
    ? v.score
    : +(((job.keywords?.length ? (keywordsCovered / keywordsTotal) * 100 : 50)
      + Math.min(words, 200) / 200 * 10).toFixed(2));
  return {
    ...v,
    words,
    keywordsCovered,
    keywordsTotal,
    score,
    outputHash: crypto.createHash('sha256').update(output || '').digest('hex'),
  };
}

function pickWinner(scored) {
  const passing = scored.filter(s => s.pass);
  const pool = passing.length ? passing : scored;
  pool.sort((a, b) => b.score - a.score);
  return pool[0] || null;
}

function printBoard() {
  const jobs = load().jobs || [];
  console.log('\n═══ GENESIS JOB BOARD ═══');
  if (!jobs.length) {
    console.log('No jobs posted yet.');
    return;
  }
  jobs.slice(-10).reverse().forEach(j => {
    console.log(`[${j.status}] ${j.id}`);
    console.log(`  ${j.brief?.slice(0, 80)}...`);
    console.log(`  pay ${j.pay}  keywords: ${(j.keywords || []).join(', ')}  poster: ${j.poster}`);
  });
  console.log('');
}

module.exports = {
  load,
  save,
  postJob,
  listOpen,
  closeJob,
  scoreOutput,
  pickWinner,
  printBoard,
  BOARD,
};

if (require.main === module) {
  printBoard();
}
