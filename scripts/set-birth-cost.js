// Change the Core's birth_cost parameter (owner-only set_params).
// The other three params are passed through UNCHANGED — set_params sets
// all four at once, so omitting one would reset it.
//
// Usage: node scripts/set-birth-cost.js <new-birth-cost-near> [--execute]
//   Without --execute it prints the exact call and signs nothing.
//   With --execute it broadcasts and writes demo/set-birth-cost.json.
//
// Why this exists: birth_cost was 0.5 NEAR, so a mint cost the treasury
// 0.6 NEAR (0.5 birth + 0.1 NFT mint), ~$1.50. Isaiah lowered it to
// 0.05 NEAR for the Hackathon (2026-11-05), so a mint now costs 0.15 NEAR.
// The mint/breed callers MUST attach exactly birth_cost (v2.3 enforces
// it), so api/agent-action.js and src/cli.js were updated in the same
// change — never change this param without updating them.
const fs = require('fs');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');

const MASTER_SAVED = JSON.parse(fs.readFileSync('.testnet-account.json', 'utf8'));
const MASTER = MASTER_SAVED.accountId;
const CORE_ID = `core.${MASTER}`;
// Current values (set at deploy, never changed since — see
// src/chain-deploy-core.js and docs/CONTRACT.md). Passed through unchanged.
const PROFIT_THRESHOLD_YOCTO = '1500000000000000000000000'; // 1.5 NEAR
const MAX_CONSECUTIVE_FAILS = 3;
const MIN_JOBS_TO_REPRODUCE = 3;

function rpc(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params });
  const tmp = `.rpc-payload-${process.pid}.json`;
  fs.writeFileSync(tmp, payload);
  try {
    const out = execSync(`curl -s -m 60 https://rpc.testnet.near.org -H 'Content-Type: application/json' --data-binary @${tmp}`, { maxBuffer: 10 * 1024 * 1024 });
    const j = JSON.parse(out.toString());
    if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error).slice(0, 500));
    return j.result;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  const newBirthNear = process.argv[2];
  const execute = process.argv.includes('--execute');
  if (!newBirthNear || isNaN(Number(newBirthNear))) throw new Error('Usage: node scripts/set-birth-cost.js <new-birth-cost-near> [--execute]');
  const birthYocto = utils.format.parseNearAmount(newBirthNear);
  const args = {
    birth_cost: birthYocto,
    profit_threshold: PROFIT_THRESHOLD_YOCTO,
    max_consecutive_fails: MAX_CONSECUTIVE_FAILS,
    min_jobs_to_reproduce: MIN_JOBS_TO_REPRODUCE,
  };
  console.log('Preview: set_params on', CORE_ID);
  console.log('  signer (Core owner):', MASTER);
  console.log('  birth_cost:', newBirthNear, 'NEAR =', birthYocto, 'yocto');
  console.log('  profit_threshold: 1.5 NEAR (unchanged)');
  console.log('  max_consecutive_fails: 3 (unchanged)');
  console.log('  min_jobs_to_reproduce: 3 (unchanged)');
  console.log('  new mint cost: ', newBirthNear, '+ 0.1 NFT =', (Number(newBirthNear) + 0.1).toFixed(2), 'NEAR');
  if (!execute) { console.log('DRY RUN — nothing signed, nothing broadcast. Add --execute to run it.'); return; }
  const masterKp = KeyPair.fromString(MASTER_SAVED.privateKey);
  const pub = masterKp.getPublicKey().toString();
  const accessKey = rpc('query', { request_type: 'view_access_key', account_id: MASTER, public_key: pub, finality: 'final' });
  const block = rpc('block', { finality: 'final' });
  const tx = transactions.createTransaction(
    MASTER, utils.PublicKey.fromString(pub), CORE_ID,
    accessKey.nonce + 1, [transactions.functionCall('set_params', args, 100000000000000n, 0n)],
    utils.serialize.base_decode(block.header.hash));
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', MASTER, masterKp);
  const signer = new InMemorySigner(ks);
  const [hash, signedTx] = await transactions.signTransaction(tx, signer, MASTER, 'testnet');
  const hashHex = Buffer.from(hash).toString('hex');
  console.log('[set_params] signed hash:', hashHex);
  const b64 = Buffer.from(signedTx.encode()).toString('base64');
  const result = rpc('broadcast_tx_commit', [b64]);
  const status = result.status && (result.status.SuccessValue !== undefined ? 'Success' : JSON.stringify(result.status).slice(0, 300));
  console.log('[set_params] broadcast status:', status);
  if (status !== 'Success') throw new Error('set_params failed: ' + JSON.stringify(result).slice(0, 1000));
  const proof = { core: CORE_ID, signer: MASTER, args, txHash: hashHex, status, at: new Date().toISOString() };
  fs.writeFileSync('demo/set-birth-cost.json', JSON.stringify(proof, null, 2));
  console.log('Wrote demo/set-birth-cost.json');
  console.log('NOTE: birth_cost has no view method — verify by minting: a birth attaching exactly', newBirthNear, 'NEAR must succeed, and the old 0.5 NEAR deposit must now fail.');
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
