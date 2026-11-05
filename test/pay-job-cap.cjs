// Test the treasury protections in api/pay-job.js (capCheck):
//   (a) per-account cap — 0.05 NEAR total per account, ever (5 payments);
//   (b) treasury floor — the treasury keeps at least 0.1 NEAR after the
//       0.01 reward is paid.
// capCheck is a pure function of yoctoNEAR amounts, so it is tested
// directly — no RPC, no treasury key, no payment is sent. The handler
// calls it after the frontier + token checks and before post_job/pay_job,
// and fails closed (refuses) when either onchain read fails.
// Yocto values: 1 NEAR = 10^24 yocto; reward 0.01 = 10^22; cap 0.05 =
// 5*10^22; floor 0.1 = 10^23.
const assert = require('assert');
const handler = require('../api/pay-job');
const { capCheck, yoctoToNear } = handler;

const NEAR = BigInt('1000000000000000000000000');
const REWARD = BigInt('10000000000000000000000'); // 0.01 NEAR

function near(n) { // n as a decimal string, e.g. '0.7524' -> yocto BigInt
  const [w, f = ''] = String(n).split('.');
  return BigInt(w) * NEAR + BigInt((f + '0'.repeat(24)).slice(0, 24));
}

function check(name, input, allowed, reasonMatch) {
  const r = capCheck(input);
  assert.strictEqual(r.allowed, allowed, `${name}: expected allowed=${allowed}, got ${r.allowed} (${r.reason})`);
  if (reasonMatch) assert.match(r.reason || '', reasonMatch, `${name}: reason did not match`);
  else assert.strictEqual(r.reason, null, `${name}: expected no reason`);
  return r;
}

// 1. Under cap + above floor = allowed (the normal case: fresh account,
//    treasury 0.7524 NEAR as verified 2026-11-05).
let r = check('1. fresh account, healthy treasury', { paidToYocto: BigInt(0), treasuryYocto: near('0.7524'), rewardYocto: REWARD }, true);
assert.strictEqual(r.paidToNear, '0');
assert.strictEqual(r.treasuryNear, '0.7524');
console.log('1. under cap + above floor = allowed: ok');

// 2. Account already at the cap (0.05 paid) = refused.
r = check('2. at cap', { paidToYocto: near('0.05'), treasuryYocto: near('0.7524'), rewardYocto: REWARD }, false, /per-account payment cap/);
assert.match(r.reason, /0\.05 NEAR/);
console.log('2. at cap = refused: ok');

// 3. Account over the cap (0.06 paid) = refused.
check('3. over cap', { paidToYocto: near('0.06'), treasuryYocto: near('0.7524'), rewardYocto: REWARD }, false, /per-account payment cap/);
console.log('3. over cap = refused: ok');

// 4. Treasury exactly at the floor (0.1) = refused (paying would take it
//    below the floor).
check('4. treasury at floor', { paidToYocto: BigInt(0), treasuryYocto: near('0.1'), rewardYocto: REWARD }, false, /treasury floor/);
console.log('4. treasury at floor = refused: ok');

// 5. Treasury just above the floor (0.12) = allowed.
check('5. treasury just above floor', { paidToYocto: BigInt(0), treasuryYocto: near('0.12'), rewardYocto: REWARD }, true);
console.log('5. treasury just above floor = allowed: ok');

// 6. Treasury exactly at floor + reward (0.11) = allowed (boundary:
//    paying leaves exactly the floor, which is not below it).
check('6. treasury exactly at floor+reward', { paidToYocto: BigInt(0), treasuryYocto: near('0.11'), rewardYocto: REWARD }, true);
console.log('6. treasury exactly at floor+reward = allowed: ok');

// 7. Account one payment below the cap (0.04 paid) = allowed (the
//    payment brings it exactly to the cap, which is not over it).
check('7. one payment below the cap', { paidToYocto: near('0.04'), treasuryYocto: near('0.7524'), rewardYocto: REWARD }, true);
console.log('7. one payment below the cap = allowed: ok');

// 8. The cap is checked before the floor in the reason: an account at
//    the cap with a low treasury reports the cap, not the floor.
r = check('8. cap beats floor in the reason', { paidToYocto: near('0.05'), treasuryYocto: near('0.1'), rewardYocto: REWARD }, false, /per-account payment cap/);
assert.doesNotMatch(r.reason, /treasury floor/);
console.log('8. cap reason takes precedence over the floor: ok');

// 9. yoctoToNear formats the values the handler returns in the JSON
//    response (paid_to_near, treasury_balance_near).
assert.strictEqual(yoctoToNear(BigInt('10000000000000000000000')), '0.01');
assert.strictEqual(yoctoToNear(BigInt('50000000000000000000000')), '0.05');
assert.strictEqual(yoctoToNear(BigInt('752400000000000000000000')), '0.7524');
assert.strictEqual(yoctoToNear(BigInt(0)), '0');
console.log('9. yoctoToNear formatting: ok');

// 10. The handler still exports as a function (the existing
//     pay-job-strict test calls it directly).
assert.strictEqual(typeof handler, 'function');
console.log('10. handler is still a callable function: ok');

console.log('pay-job-cap: all 10 scenarios pass');
