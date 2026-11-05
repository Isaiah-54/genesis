// Genesis engine v3 — stronger working product for NEAR HACKATHON
// Parent-funded births, clear death rules, deterministic mutation.
// Balances in the pure JS demos are ledger units.
// On testnet the CLI/MCP layer mirrors births, payments and deaths with real NEAR.

const BIRTH_COST = 1.0;          // ledger units (maps to ~0.5 NEAR on testnet)
const PROFIT_THRESHOLD = 0.5;
const INFERENCE_COST = 0.20;     // base cost per job, scaled by cost-efficiency skill
const MAX_CONSECUTIVE_FAILS = 3;
const MIN_JOBS_TO_REPRODUCE = 3;

let nextId = 0;

function skillFor(parent) {
  if (!parent) {
    return { speed: 1.0, quality: 1.0, costEff: 1.0, language: 'en' };
  }
  // Deterministic mutation: one trait improves, one may regress slightly.
  const roll = nextId % 3;
  const s = { ...parent.skill };
  if (roll === 0) { s.speed = +(s.speed + 0.2).toFixed(2); s.costEff = Math.max(0.5, +(s.costEff - 0.05).toFixed(2)); }
  if (roll === 1) { s.quality = +(s.quality + 0.2).toFixed(2); s.speed = Math.max(0.5, +(s.speed - 0.05).toFixed(2)); }
  if (roll === 2) { s.costEff = +(s.costEff + 0.2).toFixed(2); s.quality = Math.max(0.5, +(s.quality - 0.05).toFixed(2)); }
  return s;
}

/**
 * Create a new agent.
 * - Gen 0 is funded by the treasury.
 * - Later generations are funded by the parent (parent-funded birth).
 * This is the key economic rule that makes the swarm self-sustaining.
 */
function makeAgent(parent, treasury) {
  const id = `gen-${nextId++}`;
  const generation = parent ? parent.generation + 1 : 0;
  const agent = {
    id,
    generation,
    parent: parent ? parent.id : null,
    skill: skillFor(parent),
    balance: BIRTH_COST,
    status: 'alive',
    jobsDone: 0,
    earned: 0,
    consecutiveFails: 0,
    createdAt: Date.now(),
  };

  if (parent) {
    // Parent-funded birth — the core improvement
    if (parent.balance < BIRTH_COST) {
      throw new Error(`Parent ${parent.id} has insufficient balance (${parent.balance}) to fund birth`);
    }
    parent.balance = +(parent.balance - BIRTH_COST).toFixed(4);
  } else {
    // Gen 0 funded by treasury
    if (treasury.balance < BIRTH_COST) {
      throw new Error('Treasury has insufficient balance for Gen 0 birth');
    }
    treasury.balance = +(treasury.balance - BIRTH_COST).toFixed(4);
  }
  return agent;
}

// Extractive summary used by pure JS demos (never claimed as LLM).
function work(job, agent) {
  const sentences = (job.text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  const briefWords = new Set((job.brief || '').toLowerCase().match(/[a-z]+/g) || []);
  const scored = sentences.map(s => ({
    s,
    score: (s.toLowerCase().match(/[a-z]+/g) || []).filter(w => briefWords.has(w)).length,
  })).sort((a, b) => b.score - a.score);
  const take = Math.max(1, Math.round(2 * (agent.skill.quality || 1)));
  return scored.slice(0, take).map(x => x.s).join(' ') || 'No content extracted.';
}

function verify(job, output) {
  const words = (output || '').toLowerCase().match(/[a-z]+/g) || [];
  const keywords = job.keywords || [];
  const covered = keywords.filter(k => (output || '').toLowerCase().includes(k.toLowerCase())).length;
  const minWords = job.minWords || 20;
  return {
    pass: words.length >= minWords && covered >= Math.ceil(keywords.length * 0.5),
    words: words.length,
    keywordsCovered: covered,
    keywordsTotal: keywords.length,
  };
}

function doJob(agent, job, treasury) {
  if (agent.status !== 'alive') {
    return { error: 'agent is not alive', agent: agent.id };
  }
  const cost = +(INFERENCE_COST / (agent.skill.costEff || 1)).toFixed(4);
  agent.balance = +(agent.balance - cost).toFixed(4);
  const output = work(job, agent);
  const v = verify(job, output);
  agent.jobsDone += 1;

  if (v.pass) {
    agent.balance = +(agent.balance + (job.reward || 0)).toFixed(4);
    agent.earned = +(agent.earned + (job.reward || 0)).toFixed(4);
    agent.consecutiveFails = 0;
  } else {
    agent.consecutiveFails += 1;
  }

  return {
    agent: agent.id,
    job: job.id || 'job',
    output,
    verification: v,
    balance: agent.balance,
    cost,
    consecutiveFails: agent.consecutiveFails,
  };
}

/**
 * Lifecycle check after every job (or on demand).
 * - Death: balance <= 0 OR consecutiveFails >= MAX_CONSECUTIVE_FAILS
 *   Remaining balance returns to treasury.
 * - Reproduction: jobsDone >= MIN_JOBS_TO_REPRODUCE AND balance >= BIRTH_COST + PROFIT_THRESHOLD
 *   Child is funded by the parent (parent-funded birth).
 */
function lifecycle(agent, treasury) {
  if (agent.status !== 'alive') return null;

  // Death check
  if (agent.balance <= 0 || agent.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    agent.status = 'dead';
    const returned = Math.max(0, agent.balance);
    treasury.balance = +(treasury.balance + returned).toFixed(4);
    agent.balance = 0;
    return {
      event: 'death',
      agent: agent.id,
      generation: agent.generation,
      returned,
      reason: agent.consecutiveFails >= MAX_CONSECUTIVE_FAILS ? 'consecutive_fails' : 'balance_zero',
    };
  }

  // Reproduction check (parent-funded)
  if (agent.jobsDone >= MIN_JOBS_TO_REPRODUCE && agent.balance >= BIRTH_COST + PROFIT_THRESHOLD) {
    try {
      const child = makeAgent(agent, treasury);
      return {
        event: 'birth',
        parent: agent.id,
        child: child.id,
        generation: child.generation,
        childSkill: child.skill,
        childObj: child,
        fundedBy: 'parent',
      };
    } catch (e) {
      // Parent no longer has enough after costs — no birth
      return null;
    }
  }
  return null;
}

module.exports = {
  BIRTH_COST,
  PROFIT_THRESHOLD,
  INFERENCE_COST,
  MAX_CONSECUTIVE_FAILS,
  MIN_JOBS_TO_REPRODUCE,
  makeAgent,
  doJob,
  lifecycle,
  work,
  verify,
  skillFor,
};
