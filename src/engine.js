// Genesis engine v4 — autonomous agent economy
// Parent-funded births, specialist spawn, fee tracking, clear death rules.
// Balances in pure JS demos are ledger units.
// On testnet the CLI/MCP layer mirrors births, payments and deaths with real NEAR.

const BIRTH_COST = 1.0;
const PROFIT_THRESHOLD = 0.5;
const INFERENCE_COST = 0.20;
const MAX_CONSECUTIVE_FAILS = 3;
const MIN_JOBS_TO_REPRODUCE = 3;
const SPECIALIST_COST = 0.8;   // slightly cheaper than full birth
const PLATFORM_FEE_RATE = 0.05; // 5% of job rewards go back to treasury

let nextId = 0;

const SPECIALIST_TYPES = {
  researcher: { quality: 0.3, speed: -0.05, costEff: 0 },
  writer:     { quality: 0.2, speed: 0.1,  costEff: -0.05 },
  coder:      { quality: 0.15, speed: 0.05, costEff: 0.15 },
  factchecker:{ quality: 0.25, speed: -0.1, costEff: 0.1 },
};

function skillFor(parent, specialistType) {
  if (!parent) {
    return { speed: 1.0, quality: 1.0, costEff: 1.0, language: 'en', role: 'general' };
  }
  const s = { ...parent.skill };
  if (specialistType && SPECIALIST_TYPES[specialistType]) {
    const delta = SPECIALIST_TYPES[specialistType];
    s.speed   = Math.max(0.5, +(s.speed + (delta.speed || 0)).toFixed(2));
    s.quality = Math.max(0.5, +(s.quality + (delta.quality || 0)).toFixed(2));
    s.costEff = Math.max(0.5, +(s.costEff + (delta.costEff || 0)).toFixed(2));
    s.role = specialistType;
    return s;
  }
  // Default mutation
  const roll = nextId % 3;
  if (roll === 0) { s.speed = +(s.speed + 0.2).toFixed(2); s.costEff = Math.max(0.5, +(s.costEff - 0.05).toFixed(2)); }
  if (roll === 1) { s.quality = +(s.quality + 0.2).toFixed(2); s.speed = Math.max(0.5, +(s.speed - 0.05).toFixed(2)); }
  if (roll === 2) { s.costEff = +(s.costEff + 0.2).toFixed(2); s.quality = Math.max(0.5, +(s.quality - 0.05).toFixed(2)); }
  s.role = s.role || 'general';
  return s;
}

function makeAgent(parent, treasury, options = {}) {
  const id = options.id || `gen-${nextId++}`;
  const generation = parent ? parent.generation + 1 : 0;
  const cost = options.specialist ? SPECIALIST_COST : BIRTH_COST;
  const agent = {
    id,
    generation,
    parent: parent ? parent.id : null,
    skill: skillFor(parent, options.specialist),
    balance: cost,
    status: 'alive',
    jobsDone: 0,
    earned: 0,
    consecutiveFails: 0,
    role: options.specialist || 'general',
    createdAt: Date.now(),
  };

  if (parent) {
    if (parent.balance < cost) {
      throw new Error(`Parent ${parent.id} has insufficient balance (${parent.balance}) to fund ${options.specialist || 'birth'}`);
    }
    parent.balance = +(parent.balance - cost).toFixed(4);
  } else {
    if (treasury.balance < cost) {
      throw new Error('Treasury has insufficient balance for Gen 0 birth');
    }
    treasury.balance = +(treasury.balance - cost).toFixed(4);
  }
  return agent;
}

/** Spawn a specialist child funded by the parent. */
function spawnSpecialist(parent, treasury, specialistType) {
  if (!SPECIALIST_TYPES[specialistType]) {
    throw new Error(`Unknown specialist type: ${specialistType}. Use: ${Object.keys(SPECIALIST_TYPES).join(', ')}`);
  }
  if (parent.status !== 'alive') throw new Error('Parent is not alive');
  if (parent.balance < SPECIALIST_COST) {
    throw new Error(`Parent needs at least ${SPECIALIST_COST} to spawn a specialist`);
  }
  const child = makeAgent(parent, treasury, { specialist: specialistType });
  return {
    event: 'specialist_birth',
    parent: parent.id,
    child: child.id,
    specialist: specialistType,
    childSkill: child.skill,
    childObj: child,
    fundedBy: 'parent',
  };
}

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
  // Legacy rule, kept ONLY for the offline lifecycle simulator (doJob and
  // the demo scripts): words >= minWords and at least half the keywords.
  // It is deliberately lenient so the demos can show the full
  // born → earn → reproduce → die lifecycle offline. Real paid work does
  // NOT use this — it uses verifyStrict below.
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

// Strict verifier for real paid work (CLI job, MCP genesis_job, site,
// api/pay-job). No word count — three gates, all must pass:
//   1. Coverage: EVERY keyword appears, each inside a sentence of >= 8
//      words (no bare keyword lists, no one-word sentences).
//   2. Originality: under 30% of output words sit inside 8-word sequences
//      copied from the source text (job.text). Copy-paste fails.
//   3. Structure: at least 3 sentences (each >= 3 words).
// The same logic is duplicated in app.js and api/pay-job.js (the browser
// and the serverless function cannot import this module) — keep the
// thresholds identical in all three places.
function tokensOf(text) {
  return (text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function sentencesOf(text) {
  return (text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => tokensOf(s).length >= 3);
}

function verifyStrict(job, output) {
  const keywords = (job.keywords || []).map(k => String(k).toLowerCase());
  const out = output || '';
  const outTokens = tokensOf(out);
  const sentences = sentencesOf(out);
  const keywordOk = keywords.map(k =>
    sentences.some(s => s.toLowerCase().includes(k) && tokensOf(s).length >= 8));
  const coverage = {
    passed: keywordOk.every(Boolean),
    covered: keywordOk.filter(Boolean).length,
    total: keywords.length,
  };
  const srcTokens = tokensOf(job.text || '');
  const srcShingles = new Set();
  for (let i = 0; i + 8 <= srcTokens.length; i++) srcShingles.add(srcTokens.slice(i, i + 8).join(' '));
  const coveredPos = new Array(outTokens.length).fill(false);
  for (let i = 0; i + 8 <= outTokens.length; i++) {
    if (srcShingles.has(outTokens.slice(i, i + 8).join(' '))) {
      for (let j = i; j < i + 8; j++) coveredPos[j] = true;
    }
  }
  const copiedWords = coveredPos.filter(Boolean).length;
  const copiedShare = outTokens.length ? copiedWords / outTokens.length : 0;
  const originality = {
    passed: copiedShare < 0.30,
    copiedShare: +copiedShare.toFixed(2),
    copiedWords,
    totalWords: outTokens.length,
  };
  const structure = { passed: sentences.length >= 3, sentences: sentences.length };
  return {
    pass: coverage.passed && originality.passed && structure.passed,
    gates: { coverage, originality, structure },
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

  let fee = 0;
  let netReward = 0;
  if (v.pass) {
    const reward = job.reward || 0;
    fee = +(reward * PLATFORM_FEE_RATE).toFixed(4);
    netReward = +(reward - fee).toFixed(4);
    agent.balance = +(agent.balance + netReward).toFixed(4);
    agent.earned = +(agent.earned + netReward).toFixed(4);
    agent.consecutiveFails = 0;
    // Fee flows back to treasury — makes the system more self-sustaining
    treasury.balance = +(treasury.balance + fee).toFixed(4);
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
    fee,
    netReward,
    consecutiveFails: agent.consecutiveFails,
  };
}

function lifecycle(agent, treasury) {
  if (agent.status !== 'alive') return null;

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
  SPECIALIST_COST,
  PLATFORM_FEE_RATE,
  SPECIALIST_TYPES,
  makeAgent,
  spawnSpecialist,
  doJob,
  lifecycle,
  work,
  verify,
  verifyStrict,
  skillFor,
};
