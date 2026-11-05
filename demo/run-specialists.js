// Demo: parent-funded specialist children + platform fee flow.
// Run: node demo/run-specialists.js
const { makeAgent, doJob, lifecycle, spawnSpecialist, BIRTH_COST, SPECIALIST_COST, PLATFORM_FEE_RATE } = require('../src/engine');

const treasury = { balance: 20 };

function logEvent(e) {
  console.log(JSON.stringify(e));
}

// Gen 0
const gen0 = makeAgent(null, treasury);
logEvent({ event: 'BIRTH', id: gen0.id, generation: 0, fundedBy: 'treasury', balance: gen0.balance });

// Longer text so the extractive worker + verifier pass
const job = {
  id: 'research-brief',
  brief: 'NEAR NFT standards and agent economies',
  keywords: ['near', 'nft', 'agent'],
  minWords: 12,
  reward: 1.2,
  text: [
    'NEAR Protocol supports NEP-171 NFTs for unique assets.',
    'Agents can hold balances and take real jobs on NEAR.',
    'An independent verifier checks the work before any payment.',
    'Parent-funded births create real selection pressure in the swarm.',
    'Arena competition ranks agents by score and pays the winner.',
    'Successful agents reproduce; unsuccessful agents die.',
    'This is the core loop of the Genesis agent economy on NEAR.',
  ].join(' '),
};

for (let i = 0; i < 3; i++) {
  const result = doJob(gen0, job, treasury);
  logEvent({
    event: 'JOB',
    agent: gen0.id,
    pass: result.verification.pass,
    words: result.verification.words,
    fee: result.fee,
    netReward: result.netReward,
    balance: gen0.balance,
  });
}

// Parent-funded normal birth
const birth = lifecycle(gen0, treasury);
if (birth && birth.event === 'birth') {
  logEvent({
    event: 'BIRTH',
    parent: birth.parent,
    child: birth.child,
    fundedBy: 'parent',
    skill: birth.childSkill,
  });
} else {
  logEvent({ event: 'NO_BIRTH', balance: gen0.balance, jobsDone: gen0.jobsDone, status: gen0.status });
}

// Parent spawns two specialists (only if still alive and funded)
if (gen0.status === 'alive') {
  try {
    const researcher = spawnSpecialist(gen0, treasury, 'researcher');
    logEvent({
      event: 'SPECIALIST',
      parent: researcher.parent,
      child: researcher.child,
      type: 'researcher',
      skill: researcher.childSkill,
      cost: SPECIALIST_COST,
    });
  } catch (e) {
    logEvent({ event: 'SPECIALIST_FAIL', reason: e.message });
  }

  try {
    const writer = spawnSpecialist(gen0, treasury, 'writer');
    logEvent({
      event: 'SPECIALIST',
      parent: writer.parent,
      child: writer.child,
      type: 'writer',
      skill: writer.childSkill,
      cost: SPECIALIST_COST,
    });
  } catch (e) {
    logEvent({ event: 'SPECIALIST_FAIL', reason: e.message });
  }
} else {
  logEvent({ event: 'SPECIALIST_SKIP', reason: 'parent not alive' });
}

console.log('\n--- Final state ---');
console.log('Treasury balance:', treasury.balance.toFixed(4), `(includes platform fees at ${PLATFORM_FEE_RATE * 100}%)`);
console.log('Gen0 balance:', gen0.balance.toFixed(4), 'earned:', gen0.earned, 'jobs:', gen0.jobsDone, 'status:', gen0.status);
console.log('Platform fee rate:', PLATFORM_FEE_RATE);
console.log('Specialist cost:', SPECIALIST_COST);
console.log('Birth cost:', BIRTH_COST);
