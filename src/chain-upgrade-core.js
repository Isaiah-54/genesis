// Upgrade Genesis Core v2.1 -> v2.2 IN PLACE on the same account.
// Pattern: sign locally with near-api-js, broadcast via curl (near-api-js
// RPC drops through this VM's proxy; curl succeeds).
//
// Usage: node src/chain-upgrade-core.js <wasm-path> [--dry-run] [--no-migrate]
//   wasm-path: the built v2.2 contract, e.g.
//   contracts/genesis-core/target/near/genesis_core.wasm
//   --dry-run: print the plan, sizes and costs; sign/broadcast nothing.
//   --no-migrate: deploy the WASM only, do NOT call migrate(). Use this
//     for a code-only fix on a contract whose state is ALREADY in the v2.2
//     shape (migrate() reads a v2.1 state and would panic on v2.2 bytes).
//     The state struct is unchanged by a return-value-only fix, so a plain
//     redeploy keeps every agent, job, listing and frontier intact.
//
// Steps: deploy the v2.2 WASM to core.genesisdemo354551.testnet -> call
// migrate() FIRST (it rewrites the v2.1 state into the v2.2 shape, adding
// Agent.wins and Agent.evolutions and keeping every agent, job, frontier,
// listing and parameter; it must run before any other method, because other
// methods would try to read v2.2 state from v2.1 bytes) ->
// verify the registry survived (agent_count 3, the three agents present
// with wins 0 and evolutions 0, the live frontier still 483, get_listings
// as before).
// Nothing is deployed without Isaiah's explicit yes on the preview.
const fs = require('fs');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');

const MASTER_SAVED = JSON.parse(fs.readFileSync('.testnet-account.json', 'utf8'));
const MASTER = MASTER_SAVED.accountId;
const CORE_ID = `core.${MASTER}`;
const CORE_KEY = JSON.parse(fs.readFileSync('.testnet-core-account.json', 'utf8'));

function rpc(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params });
  // Pass the body via a file, not the command line: a deploy tx is ~145 KB
  // base64 and exceeds the OS argument limit (spawnSync E2BIG).
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
function viewAccount(id) {
  return rpc('query', { request_type: 'view_account', account_id: id, finality: 'final' });
}
async function sendTx(signerId, kp, receiverId, actions, label, dryRun) {
  const pub = kp.getPublicKey().toString();
  const accessKey = rpc('query', { request_type: 'view_access_key', account_id: signerId, public_key: pub, finality: 'final' });
  const block = rpc('block', { finality: 'final' });
  const tx = transactions.createTransaction(
    signerId, utils.PublicKey.fromString(pub), receiverId,
    accessKey.nonce + 1, actions, utils.serialize.base_decode(block.header.hash));
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', signerId, kp);
  const signer = new InMemorySigner(ks);
  const [hash, signedTx] = await transactions.signTransaction(tx, signer, signerId, 'testnet');
  const hashHex = Buffer.from(hash).toString('hex');
  console.log(`[${label}] signed hash: ${hashHex}`);
  if (dryRun) return { hash: hashHex, status: 'DRY-RUN (not broadcast)' };
  const b64 = Buffer.from(signedTx.encode()).toString('base64');
  const result = rpc('broadcast_tx_commit', [b64]);
  const status = result.status && (result.status.SuccessValue !== undefined ? 'Success' : JSON.stringify(result.status).slice(0, 200));
  console.log(`[${label}] broadcast status: ${status}`);
  if (status !== 'Success') throw new Error(label + ' failed: ' + JSON.stringify(result).slice(0, 1000));
  return { hash: hashHex, status };
}
function callFunction(id, method, args) {
  const r = rpc('query', { request_type: 'call_function', account_id: id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final' });
  return JSON.parse(Buffer.from(r.result).toString());
}
async function main() {
  const wasmPath = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  const noMigrate = process.argv.includes('--no-migrate');
  if (!wasmPath) throw new Error('Usage: node src/chain-upgrade-core.js <wasm-path> [--dry-run] [--no-migrate]');
  const wasm = fs.readFileSync(wasmPath);
  const crypto = require('crypto');
  const wasmSha = crypto.createHash('sha256').update(wasm).digest('hex');
  const core = viewAccount(CORE_ID);
  const coreBal = Number(core.amount) / 1e24;
  const oldCodeHash = core.code_hash;
  const before = {
    agent_count: callFunction(CORE_ID, 'agent_count', {}),
    coreBalanceNear: coreBal,
    codeHash: oldCodeHash,
  };
  // NEAR storage: 1 byte costs 1e19 yocto (0.00001 NEAR), so ~1 NEAR per
  // 100 KB. The v2 WASM is ~39 KB bigger than v1, so ~0.39 NEAR extra
  // storage, paid from the Core's own balance.
  console.log(`WASM: ${wasmPath} (${wasm.length} bytes) sha256 ${wasmSha}`);
  console.log(`Core ${CORE_ID}: ${coreBal.toFixed(4)} NEAR, code_hash ${oldCodeHash}`);
  console.log(`Before upgrade: agent_count ${before.agent_count}.`);
  console.log(noMigrate
    ? 'Steps: deploy fixed WASM only (no migrate — state is already v2.2-shaped) -> verify.'
    : 'Steps: deploy v2.2 WASM -> migrate() (first call, v2.1 -> v2.2: adds Agent.wins/evolutions, preserves agents/jobs/frontiers/listings) -> verify.');
  if (dryRun) { console.log('DRY RUN — nothing signed, nothing broadcast.'); return; }
  const coreKp = KeyPair.fromString(CORE_KEY.privateKey);
  const proof = { core: CORE_ID, wasmBytes: wasm.length, wasmSha256: wasmSha, before, txs: {} };
  proof.txs.deploy = await sendTx(CORE_ID, coreKp, CORE_ID, [
    transactions.deployContract(wasm),
  ], 'deploy v2.2 contract', dryRun);
  if (noMigrate) {
    proof.txs.migrate = { status: 'SKIPPED (--no-migrate: state already v2.2-shaped)' };
  } else {
    proof.txs.migrate = await sendTx(CORE_ID, coreKp, CORE_ID, [
      transactions.functionCall('migrate', {}, 100000000000000n, 0n),
    ], 'migrate v2.1 -> v2.2', dryRun);
  }
  proof.verification = {
    agent_count: callFunction(CORE_ID, 'agent_count', {}),
    get_agent_genesis_gen_2: callFunction(CORE_ID, 'get_agent', { token_id: 'genesis-gen-2' }),
    get_agent_genesis_gen_3: callFunction(CORE_ID, 'get_agent', { token_id: 'genesis-gen-3' }),
    get_agent_genesis_visitor_1: callFunction(CORE_ID, 'get_agent', { token_id: 'genesis-visitor-1' }),
    get_listings: callFunction(CORE_ID, 'get_listings', {}),
    // The live frontier (sample job, set by the first frontier payment)
    // must survive the migrate — wiping it would reset the difficulty
    // bar to zero.
    get_frontier_sample_job: callFunction(CORE_ID, 'get_frontier', { job_def_id: 'f1d2c1eab156e2882c5c384e77aef3a69c5458c3ead77a528ac9cfa341f7cd52' }),
    get_jobs: callFunction(CORE_ID, 'get_jobs', {}),
    coreBalanceNear: Number(viewAccount(CORE_ID).amount) / 1e24,
    codeHash: viewAccount(CORE_ID).code_hash,
    note: noMigrate
      ? 'Code-only redeploy: state struct unchanged, so agent_count, agents, listings and frontiers must be exactly as before.'
      : 'agent_count must stay 3 and the three agents must be present, each with wins 0 and evolutions 0 — the migration preserves the registry. get_frontier (sample job) must still be 483 (gen2) and get_listings must be exactly as before the migrate.',
  };
  const proofFile = noMigrate ? 'demo/core-upgrade-v2-fix.json' : 'demo/core-upgrade-v2.2.json';
  fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2));
  console.log(`Wrote ${proofFile}`);
  console.log(JSON.stringify(proof, null, 2));
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
