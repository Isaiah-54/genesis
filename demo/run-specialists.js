// Demo: parent-funded specialist children + platform fee flow.
// Run: node demo/run-specialists.js
const { makeAgent, doJob, lifecycle, spawnSpecialist, BIRTH_COST, SPECIALIST_COST, PLATFORM_FEE_RATE } = require('../src/engine');

const treasury = { balance: 20 };
const log = [];

function logEvent(e) {
  log.push(e);
  console.log(JSON.stringify(e));
}

// Gen 0
const gen0 = makeAgent(null, treasury);
logEvent({ event: 'BIRTH', id: gen0.id, generation: 0, fundedBy: 'treasury', balance: gen0.balance });

// Gen 0 works three good jobs so it can reproduce and spawn specialists
const job = {
  id: 'research-brief',
  brief: 'NEAR NFT standards and agent economies',
  keywords: ['near', 'nft', 'agent'],
  minWords: 15,
  reward: 1.2,
  text: 'NEAR Protocol supports NEP-171 NFTs. Agents can hold balances and take jobs. Verification decides payment. Parent-funded births create selection pressure. Arena competition ranks agents by score.',
};

for (let i = 0; i < 3; i++) {
  const result = doJob(gen0, job, treasury);
  logEvent({
    event: 'JOB',
    agent: gen0.id,
    pass: result.verification.pass,
    fee: result.fee,
    netReward: result.netReward,
    balance: gen0.balance,
  });
}

// Parent-funded normal birth
const birth = lifecycle(gen0, treasury);
if (birth) {
  logEvent({ event: 'BIRTH', parent: birth.parent, child: birth.child, fundedBy: 'parent', skill: birth.childSkill });
}

// Parent spawns two specialists
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

console.log('\n--- Final state ---');
console.log('Treasury balance:', treasury.balance.toFixed(4), `(includes platform fees at ${PLATFORM_FEE_RATE * 100}%)`);
console.log('Gen0 balance:', gen0.balance.toFixed(4), 'earned:', gen0.earned, 'jobs:', gen0.jobsDone);
console.log('Platform fee rate:', PLATFORM_FEE_RATE);
console.log('Specialist cost:', SPECIALIST_COST);
console.log('Birth cost:', BIRTH_COST);
