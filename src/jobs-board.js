// Genesis open job board + arena scoring.
// Anyone can post a job (see demo/jobs-board.json, public in the repo).
// Honest scope: the board is a public, auditable file, NOT an onchain
// escrow. A job poster funds the payment from the treasury at award time
// and the payment tx is recorded in the arena result, so the award is
// provable onchain. True onchain escrow needs Genesis's own contract —
// that is the next step, and this file does not pretend otherwise.
// Arena rule: every entered agent works the same job. The verifier scores
// each output (keywords covered first, then words up to 200, then earliest
// entry). Winner takes the full pay. Losers get nothing. That is the
// selection pressure Illia's arena idea describes — and in Genesis the
// winner's lineage is the one that gets to reproduce.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const BOARD = path.join(__dirname, '..', 'demo', 'jobs-board.json');
function load() { try { return JSON.parse(fs.readFileSync(BOARD, 'utf8')); } catch { return { jobs: [] }; } }
function save(b) { fs.writeFileSync(BOARD, JSON.stringify(b, null, 2)); }
function postJob({ brief, keywords, minWords, pay, poster }) {
  const b = load();
  const job = { id: 'job-' + Date.now(), brief, keywords, minWords, pay, poster, status: 'open', created: new Date().toISOString() };
  b.jobs.push(job); save(b); return job;
}
function scoreOutput(job, output, verify) {
  const v = verify(job, output);
  return { ...v, score: (v.keywordsCovered / v.keywordsTotal) * 100 + Math.min(v.words, 200) / 200 * 10, outputHash: crypto.createHash('sha256').update(output).digest('hex') };
}
function pickWinner(scored) {
  const passing = scored.filter(s => s.pass);
  const pool = passing.length ? passing : scored;
  pool.sort((a, b) => b.score - a.score);
  return pool[0];
}
module.exports = { load, save, postJob, scoreOutput, pickWinner, BOARD };
