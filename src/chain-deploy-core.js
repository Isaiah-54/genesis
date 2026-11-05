// Deploy Genesis Core (contracts/genesis-core) to NEAR testnet.
// Pattern: sign locally with near-api-js, broadcast via curl (near-api-js
// RPC drops through this VM's proxy; curl succeeds). Key-save-first: the
// core account key is written to .testnet-core-account.json BEFORE any tx.
//
// Usage: node src/chain-deploy-core.js <wasm-path> [--dry-run]
//   wasm-path: the built contract, e.g. genesis_core.wasm downloaded from
//   the GitHub Actions artifact (see docs/DEPLOY_CORE.md).
//   --dry-run: print the plan, sizes and costs; sign/broadcast nothing.
//
// Steps: create core.<master> funded 4 NEAR -> deploy WASM -> init
// new(owner, treasury) -> owner set_params (birth_cost 0.5 NEAR,
// profit_threshold 1.5 NEAR, max 3 consecutive fails, min 3 jobs to
// reproduce) -> verify agent_count == 0 (registry starts empty; existing
// NFT agents are NOT auto-imported).
// Nothing is deployed without Isaiah's explicit yes on the preview.
const fs = require('fs');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');

const MASTER_SAVED = JSON.parse(fs.readFileSync('.testnet-account.json', 'utf8'));
const MASTER = MASTER_SAVED.accountId;
const CORE_ID = `core.${MASTER}`;
const FUND_NEAR = '4';
const BIRTH_COST_YOCTO = '500000000000000000000000';       // 0.5 NEAR
const PROFIT_THRESHOLD_YOCTO = '1500000000000000000000000'; // 1.5 NEAR

function rpc(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params });
  const out = execSync(`curl -s -m 60 https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '${payload}'`, { maxBuffer: 10 * 1024 * 1024 });
  const j = JSON.parse(out.toString());
  if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error).slice(0, 500));
  return j.result;
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
  return { hash: hashHex, status };
}
function callFunction(id, method, args) {
  const r = rpc('query', { request_type: 'call_function', account_id: id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final' });
  return JSON.parse(Buffer.from(r.result).toString());
}
async function main() {
  const wasmPath = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!wasmPath) throw new Error('Usage: node src/chain-deploy-core.js <wasm-path> [--dry-run]');
  const wasm = fs.readFileSync(wasmPath);
  const sizeKB = (wasm.length / 1024).toFixed(1);
  // NEAR storage: 1 byte costs 1e19 yocto (0.00001 NEAR), so ~1 NEAR per 100 KB.
  const storageNear = (wasm.length / 100000).toFixed(2);
  const masterBal = Number(viewAccount(MASTER).amount) / 1e24;
  console.log(`WASM: ${wasmPath} (${wasm.length} bytes, ${sizeKB} KB) — estimated deploy storage ~${storageNear} NEAR`);
  console.log(`Master ${MASTER}: ${masterBal.toFixed(4)} NEAR. Core account ${CORE_ID} will be funded ${FUND_NEAR} NEAR.`);
  console.log(`Init: new({owner_id: ${MASTER}, treasury: ${MASTER}}). set_params: birth_cost 0.5 NEAR, profit_threshold 1.5 NEAR, max_consecutive_fails 3, min_jobs_to_reproduce 3.`);
  if (dryRun) { console.log('DRY RUN — nothing signed, nothing broadcast, no key file written.'); return; }
  if (masterBal < 4.1) throw new Error(`Master balance ${masterBal} NEAR is below the 4.1 NEAR needed (4 funding + gas). Top up testnet NEAR first.`);
  // Key-save-first: write the core key BEFORE any creation tx.
  const coreKey = KeyPair.fromRandom('ed25519');
  fs.writeFileSync('.testnet-core-account.json', JSON.stringify({ accountId: CORE_ID, privateKey: coreKey.toString() }, null, 2));
  fs.chmodSync('.testnet-core-account.json', 0o600);
  console.log('Core key saved to .testnet-core-account.json (600) BEFORE any tx.');
  const masterKp = KeyPair.fromString(MASTER_SAVED.privateKey);
  const proof = { master: MASTER, core: CORE_ID, wasmBytes: wasm.length, wasmStorageNearEstimate: storageNear, txs: {} };
  proof.txs.createCore = await sendTx(MASTER, masterKp, CORE_ID, [
    transactions.createAccount(),
    transactions.transfer(utils.format.parseNearAmount(FUND_NEAR)),
    transactions.addKey(coreKey.getPublicKey(), transactions.fullAccessKey()),
  ], 'create core account', dryRun);
  proof.txs.deploy = await sendTx(CORE_ID, coreKey, CORE_ID, [
    transactions.deployContract(wasm),
  ], 'deploy contract', dryRun);
  proof.txs.init = await sendTx(CORE_ID, coreKey, CORE_ID, [
    transactions.functionCall('new', { owner_id: MASTER, treasury: MASTER }, 100000000000000n, 0n),
  ], 'init new()', dryRun);
  proof.txs.setParams = await sendTx(MASTER, masterKp, CORE_ID, [
    transactions.functionCall('set_params', { birth_cost: BIRTH_COST_YOCTO, profit_threshold: PROFIT_THRESHOLD_YOCTO, max_consecutive_fails: 3, min_jobs_to_reproduce: 3 }, 100000000000000n, 0n),
  ], 'set_params', dryRun);
  proof.verification = {
    agent_count: callFunction(CORE_ID, 'agent_count', {}),
    get_agent_genesis_gen_2: callFunction(CORE_ID, 'get_agent', { token_id: 'genesis-gen-2' }),
    masterBalanceNear: Number(viewAccount(MASTER).amount) / 1e24,
    coreBalanceNear: Number(viewAccount(CORE_ID).amount) / 1e24,
    note: 'agent_count 0 and get_agent null are EXPECTED: the registry starts empty; existing NFT agents are not auto-imported.',
  };
  fs.writeFileSync('demo/core-deploy.json', JSON.stringify(proof, null, 2));
  console.log('Wrote demo/core-deploy.json');
  console.log(JSON.stringify(proof, null, 2));
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
