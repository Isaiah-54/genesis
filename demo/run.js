// Demo run: Gen 0 is born, works 3 jobs, reproduces, child works, tree grows.
// Run: node demo/run.js   Output: demo/family-tree.json + console log.
const { makeAgent, doJob, lifecycle } = require('../src/engine');
const fs = require('fs');
const treasury = { balance: 10.0 };
const agents = [];
const events = [];
const log = [];
const jobs = [
  { id: 'job-1', brief: 'NEAR Intents cross chain payments', minWords: 20,
    keywords: ['near', 'intents', 'chain'],
    text: 'NEAR Intents let a user state what outcome they want. Solvers compete to deliver that outcome across chains. Chain signatures let one NEAR account sign on other chains. This removes bridges for many payments. Fees stay low and settlement is fast on NEAR.',
    reward: 1.0 },
  { id: 'job-2', brief: 'agent economy earn spend', minWords: 20,
    keywords: ['agent', 'earn', 'spend'],
    text: 'An agent economy means agents earn money by doing work. Agents then spend that money on compute and on other agents services. A wallet with spending caps keeps an agent from overspending. Reputation helps strangers trust a new agent quickly.',
    reward: 1.0 },
  { id: 'job-3', brief: 'autonomous business treasury', minWords: 20,
    keywords: ['treasury', 'business', 'payments'],
    text: 'An autonomous business manages its own treasury and payments. Humans set constraints like budgets and approved services. The business hires agents for sales and procurement. Revenue is shared according to rules written in advance.',
    reward: 1.0 },
];
const gen0 = makeAgent(null, treasury);
let liveChild = null;
agents.push(gen0);
log.push(`BIRTH ${gen0.id} generation 0, balance ${gen0.balance}, treasury ${treasury.balance}`);
for (const job of jobs) {
  const r = doJob(gen0, job, treasury);
  log.push(`JOB ${r.job} -> ${r.verification.pass ? 'PASS' : 'FAIL'} (${r.verification.keywordsCovered}/${r.verification.keywordsTotal} keywords, ${r.verification.words} words), balance ${r.balance}`);
  const ev = lifecycle(gen0, treasury);
  if (ev) { if (ev.childObj) liveChild = ev.childObj; const { childObj, ...evLog } = ev; events.push(evLog); log.push(`${ev.event.toUpperCase()} ${ev.child || ev.agent} generation ${ev.generation}`); }
}
// Child works jobs if born, using the live child object from the birth event.
const child = liveChild;
if (child) {
  agents.push(child);
  log.push(`CHILD ${child.id} alive with skill ${JSON.stringify(child.skill)}, balance ${child.balance}`);
  for (const job of jobs.slice(0, 2)) {
    const r = doJob(child, { ...job, id: job.id + '-gen1' }, treasury);
    log.push(`JOB ${r.job} -> ${r.verification.pass ? 'PASS' : 'FAIL'} (${r.verification.keywordsCovered}/${r.verification.keywordsTotal} keywords, ${r.verification.words} words), balance ${r.balance}`);
  }
  log.push(`PARENT ${gen0.id} balance after funding child: ${gen0.balance.toFixed(4)}`);
}
log.push(`TREASURY ${treasury.balance.toFixed(4)} | AGENTS ${agents.length} | EVENTS ${events.length}`);
console.log(log.join('\n'));
fs.writeFileSync(__dirname + '/family-tree.json', JSON.stringify({ treasury, agents, events, log }, null, 2));
console.log('Wrote demo/family-tree.json');
