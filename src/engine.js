// Genesis engine v0 — deterministic, no external API keys, no fake LLM claims.
// Worker = extractive summariser over the job text. Verifier = independent
// rules (length, coverage, keywords). Balances = JSON ledger in v0; the v1
// chain layer will mirror each birth/death transfer on NEAR testnet.
const BIRTH_COST = 1.0;          // NEAR units in the prototype ledger
const PROFIT_THRESHOLD = 0.5;
const INFERENCE_COST = 0.20;     // per job, scaled by skill cost-efficiency

let nextId = 0;
function skillFor(parent) {
  if (!parent) return { speed: 1.0, quality: 1.0, costEff: 1.0, language: 'en' };
  // One trait improves, one may regress slightly. Fully deterministic per child.
  const roll = nextId % 3;
  const s = { ...parent.skill };
  if (roll === 0) { s.speed += 0.2; s.costEff -= 0.05; }
  if (roll === 1) { s.quality += 0.2; s.speed -= 0.05; }
  if (roll === 2) { s.costEff += 0.2; s.quality -= 0.05; }
  return s;
}
function makeAgent(parent, treasury) {
  const id = `gen-${nextId++}`;
  const generation = parent ? parent.generation + 1 : 0;
  const agent = {
    id, generation, parent: parent ? parent.id : null,
    skill: skillFor(parent), balance: BIRTH_COST,
    status: 'alive', jobsDone: 0, earned: 0, consecutiveFails: 0,
  };
  if (parent) parent.balance -= BIRTH_COST;
  else treasury.balance -= BIRTH_COST;
  return agent;
}
// Extractive summary: top sentences by keyword overlap with the job brief.
function work(job, agent) {
  const sentences = job.text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const briefWords = new Set(job.brief.toLowerCase().match(/[a-z]+/g) || []);
  const scored = sentences.map(s => ({
    s, score: (s.toLowerCase().match(/[a-z]+/g) || [])
      .filter(w => briefWords.has(w)).length,
  })).sort((a, b) => b.score - a.score);
  const take = Math.max(1, Math.round(2 * agent.skill.quality));
  return scored.slice(0, take).map(x => x.s).join(' ');
}
function verify(job, output) {
  const words = output.toLowerCase().match(/[a-z]+/g) || [];
  const covered = job.keywords.filter(k => output.toLowerCase().includes(k)).length;
  return {
    pass: words.length >= job.minWords && covered >= Math.ceil(job.keywords.length * 0.5),
    words: words.length, keywordsCovered: covered, keywordsTotal: job.keywords.length,
  };
}
function doJob(agent, job, treasury) {
  const cost = INFERENCE_COST / agent.skill.costEff;
  agent.balance -= cost;
  const output = work(job, agent);
  const v = verify(job, output);
  agent.jobsDone += 1;
  if (v.pass) {
    agent.balance += job.reward; agent.earned += job.reward; agent.consecutiveFails = 0;
  } else { agent.consecutiveFails += 1; }
  return { agent: agent.id, job: job.id, output, verification: v, balance: +agent.balance.toFixed(4), cost: +cost.toFixed(4) };
}
function lifecycle(agent, treasury) {
  if (agent.status !== 'alive') return null;
  if (agent.balance <= 0 || agent.consecutiveFails >= 3) {
    agent.status = 'dead';
    treasury.balance += Math.max(0, agent.balance);
    agent.balance = 0;
    return { event: 'death', agent: agent.id, generation: agent.generation };
  }
  if (agent.jobsDone >= 3 && agent.balance >= BIRTH_COST + PROFIT_THRESHOLD) {
    const child = makeAgent(agent, treasury);
    return { event: 'birth', parent: agent.id, child: child.id, generation: child.generation, childSkill: child.skill, childObj: child };
  }
  return null;
}
module.exports = { BIRTH_COST, makeAgent, doJob, lifecycle, work, verify };
