// Generations demo: Gen 0 -> Gen 1 -> Gen 2, plus one weak agent that dies.
// Run: node demo/run-generations.js  Output: demo/family-tree-generations.json
const { makeAgent, doJob, lifecycle } = require('../src/engine');
const fs = require('fs');
const treasury = { balance: 20.0 };
const agents = [];
const events = [];
const log = [];
const jobs = [
  { id: 'job-a', brief: 'NEAR Intents cross chain payments', minWords: 20,
    keywords: ['near', 'intents', 'chain'],
    text: 'NEAR Intents let a user state what outcome they want. Solvers compete to deliver that outcome across chains. Chain signatures let one NEAR account sign on other chains. This removes bridges for many payments. Fees stay low and settlement is fast on NEAR.',
    reward: 1.0 },
  { id: 'job-b', brief: 'agent economy earn spend', minWords: 20,
    keywords: ['agent', 'earn', 'spend'],
    text: 'An agent economy means agents earn money by doing work. Agents then spend that money on compute and on other agents services. A wallet with spending caps keeps an agent from overspending. Reputation helps strangers trust a new agent quickly.',
    reward: 1.0 },
  { id: 'job-c', brief: 'autonomous business treasury', minWords: 20,
    keywords: ['treasury', 'business', 'payments'],
    text: 'An autonomous business manages its own treasury and payments. Humans set constraints like budgets and approved services. The business hires agents for sales and procurement. Revenue is shared according to rules written in advance.',
    reward: 1.0 },
];
function runAgent(agent, jobSet, label) {
  for (const job of jobSet) {
    const r = doJob(agent, { ...job, id: `${job.id}-${agent.id}` }, treasury);
    log.push(`${label} JOB ${r.job} -> ${r.verification.pass ? 'PASS' : 'FAIL'} (${r.verification.keywordsCovered}/${r.verification.keywordsTotal} keywords, ${r.verification.words} words), balance ${r.balance}`);
    const ev = lifecycle(agent, treasury);
    if (ev) {
      const { childObj, ...evLog } = ev;
      events.push(evLog);
      log.push(`${ev.event.toUpperCase()} ${ev.child || ev.agent} generation ${ev.generation}`);
      return childObj || null;
    }
  }
  log.push(`${label} DORMANT ${agent.id} generation ${agent.generation}, balance ${agent.balance.toFixed(4)} (no birth, no death)`);
  return null;
}
const gen0 = makeAgent(null, treasury);
agents.push(gen0);
log.push(`BIRTH ${gen0.id} generation 0, balance ${gen0.balance}, treasury ${treasury.balance}`);
let child = runAgent(gen0, jobs, 'GEN0');
let generation = 1;
while (child && generation <= 3) {
  agents.push(child);
  log.push(`BIRTH ${child.id} generation ${child.generation}, skill ${JSON.stringify(child.skill)}, balance ${child.balance}`);
  child = runAgent(child, jobs, `GEN${generation}`);
  generation += 1;
}
if (child) {
  agents.push(child);
  log.push(`BIRTH ${child.id} generation ${child.generation}, skill ${JSON.stringify(child.skill)}, balance ${child.balance} (newborn, not yet worked in this demo)`);
}
// Weak agent: deliberately low quality, hard job — must die by 3 consecutive fails.
const weak = makeAgent(null, treasury);
weak.skill = { speed: 0.5, quality: 0.2, costEff: 0.8, language: 'en' };
agents.push(weak);
log.push(`BIRTH ${weak.id} WEAK generation 0, skill ${JSON.stringify(weak.skill)}, balance ${weak.balance}`);
const hardJobs = jobs.map(j => ({ ...j, minWords: 40 }));
runAgent(weak, hardJobs, 'WEAK');
log.push(`TREASURY ${treasury.balance.toFixed(4)} | AGENTS ${agents.length} | EVENTS ${events.length}`);
console.log(log.join('\n'));
fs.writeFileSync(__dirname + '/family-tree-generations.json',
  JSON.stringify({ treasury, agents, events, log }, null, 2));
console.log('Wrote demo/family-tree-generations.json');
