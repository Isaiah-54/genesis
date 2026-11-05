// test/treasury-sweep.cjs — pure-function checks for the sweep.
// No network, no funds. Run: node test/treasury-sweep.cjs
const { treasuryHealth, ACTION_COST_NEAR, REFILL_TARGET_NEAR } = require('../scripts/treasury-sweep');

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok ? '' : ' — ' + (extra || '')));
  if (!ok) failures++;
}

const Y = BigInt('1000000000000000000000000'); // 1 NEAR in yocto

check('action cost is 0.6 NEAR', ACTION_COST_NEAR === 0.6);
check('refill target is 1.2 NEAR', REFILL_TARGET_NEAR === 1.2);

let h = treasuryHealth((Y * BigInt(2015)) / BigInt(10000)); // 0.2015 NEAR
check('0.2015 NEAR covers 0 actions', h.actionsLeft === 0, 'got ' + h.actionsLeft);
check('0.2015 NEAR needs a refill', h.refillDue === true);
check('refill claims the faucet max (2 NEAR)', h.faucetAmount === 2, 'got ' + h.faucetAmount);

h = treasuryHealth((Y * BigInt(12)) / BigInt(10)); // 1.2 NEAR
check('1.2 NEAR covers 2 actions', h.actionsLeft === 2, 'got ' + h.actionsLeft);
check('1.2 NEAR needs no refill', h.refillDue === false);
check('no refill means no faucet claim', h.faucetAmount === 0, 'got ' + h.faucetAmount);

h = treasuryHealth((Y * BigInt(6)) / BigInt(10)); // 0.6 NEAR
check('0.6 NEAR covers exactly 1 action', h.actionsLeft === 1, 'got ' + h.actionsLeft);
check('0.6 NEAR still needs a refill (below target)', h.refillDue === true);

h = treasuryHealth(BigInt(0));
check('0 NEAR covers 0 actions and needs a refill', h.actionsLeft === 0 && h.refillDue === true);

console.log(failures === 0 ? 'treasury-sweep tests: all passed' : 'treasury-sweep tests: ' + failures + ' FAILED');
process.exitCode = failures === 0 ? 0 : 1;
