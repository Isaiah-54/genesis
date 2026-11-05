// Live marketplace round-trip test (Core v2, testnet only).
// Uses the dead agent token genesis-weak-2 (owned by the treasury) so no
// live agent is touched. Price is 0.001 NEAR, and the token ends back with
// the treasury. Pattern: sign locally with near-api-js, broadcast via curl.
//
// Usage: node src/chain-marketplace-test.js [--dry-run]
// Steps: treasury lists genesis-weak-2 at 0.001 NEAR -> verify get_listings
// -> gen2 buys it -> verify owner is gen2 and the listing is gone ->
// gen2 lists it back at 0.001 NEAR -> treasury buys it back -> verify
// owner is the treasury again and get_listings is empty.
const fs = require('fs');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');

const MASTER = 'genesisdemo354551.testnet';
const GEN2 = 'gen2.genesisdemo354551.testnet';
const NFT_CONTRACT = 'nft.primitives.testnet';
const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
const TOKEN = 'genesis-weak-2';
const PRICE_YOCTO = '1000000000000000000000'; // 0.001 NEAR

function rpc(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params });
  const out = execSync(`curl -s -m 60 https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '${payload}'`, { maxBuffer: 4 * 1024 * 1024 });
  const j = JSON.parse(out.toString());
  if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error).slice(0, 500));
  return j.result;
}
function viewCall(accountId, method, args) {
  const r = rpc('query', { request_type: 'call_function', account_id: accountId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final' });
  return JSON.parse(Buffer.from(r.result).toString());
}
function balanceOf(a) { const x = rpc('query', { request_type: 'view_account', account_id: a, finality: 'final' }); return (Number(x.amount) / 1e24).toFixed(4); }
function masterKey() { return KeyPair.fromString(JSON.parse(fs.readFileSync(__dirname + '/../.testnet-account.json', 'utf8')).privateKey); }
function gen2Key() { return KeyPair.fromString(JSON.parse(fs.readFileSync(__dirname + '/../.testnet-agents.json', 'utf8'))[GEN2]); }
async function sendTx({ signerId, keyPair, receiverId, actions, label, dryRun }) {
  const pub = keyPair.getPublicKey().toString();
  const accessKey = rpc('query', { request_type: 'view_access_key', account_id: signerId, public_key: pub, finality: 'final' });
  const block = rpc('block', { finality: 'final' });
  const tx = transactions.createTransaction(signerId, utils.PublicKey.fromString(pub), receiverId, accessKey.nonce + 1, actions, utils.serialize.base_decode(block.header.hash));
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', signerId, keyPair);
  const signer = new InMemorySigner(ks);
  const [hash, signedTx] = await transactions.signTransaction(tx, signer, signerId, 'testnet');
  const hashHex = Buffer.from(hash).toString('hex');
  console.log(`[${label}] signed: ${hashHex}`);
  if (dryRun) return { hash: hashHex, status: 'DRY-RUN' };
  const result = rpc('broadcast_tx_commit', [Buffer.from(signedTx.encode()).toString('base64')]);
  const status = result.status && (result.status.SuccessValue !== undefined ? 'Success' : JSON.stringify(result.status).slice(0, 300));
  console.log(`[${label}] status: ${status}`);
  if (status !== 'Success') throw new Error(label + ' failed: ' + JSON.stringify(result).slice(0, 800));
  return { hash: hashHex, status };
}
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const proof = { token: TOKEN, priceNear: '0.001', txs: {}, checks: {} };
  proof.checks.ownerBefore = viewCall(NFT_CONTRACT, 'nft_token', { token_id: TOKEN }).owner_id;
  proof.checks.treasuryBefore = balanceOf(MASTER);
  proof.checks.gen2Before = balanceOf(GEN2);
  console.log(`Owner before: ${proof.checks.ownerBefore} | treasury ${proof.checks.treasuryBefore} NEAR | gen2 ${proof.checks.gen2Before} NEAR`);
  // Resume-safe: skip the list step ONLY if the Core actually owns the token
  // and it is listed. A listing whose token is still owned by the seller is
  // stale (the pre-fix receiver returned the token) — the list step must
  // run to overwrite it, and with the fixed receiver the token stays.
  const listed = !dryRun ? viewCall(CORE_CONTRACT, 'get_listings', {}) : [];
  const alreadyListed = proof.checks.ownerBefore === CORE_CONTRACT &&
    listed.some((l) => l.token_id === TOKEN && l.seller === MASTER);
  if (proof.checks.ownerBefore !== MASTER && !alreadyListed) throw new Error('genesis-weak-2 is not owned by the treasury and is not listed by it — aborting (it must end back there).');

  // 1. Treasury lists the token at 0.001 NEAR (skipped on resume).
  if (alreadyListed) {
    proof.txs.list1 = { status: 'SKIPPED — already listed by an earlier run' };
    console.log('Token already listed by the treasury — skipping list step 1.');
  } else {
    proof.txs.list1 = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_transfer_call', { receiver_id: CORE_CONTRACT, token_id: TOKEN, msg: PRICE_YOCTO }, 300000000000000n, 1n)], label: 'list (treasury -> Core)', dryRun });
  }
  if (!dryRun) {
    proof.checks.listingsAfterList1 = viewCall(CORE_CONTRACT, 'get_listings', {});
    console.log('Listings after list 1:', JSON.stringify(proof.checks.listingsAfterList1));
    if (proof.checks.listingsAfterList1.length !== 1 || proof.checks.listingsAfterList1[0].token_id !== TOKEN) throw new Error('listing not recorded');
  }

  // 2. gen2 buys it for exactly 0.001 NEAR.
  proof.txs.buy1 = await sendTx({ signerId: GEN2, keyPair: gen2Key(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('buy_nft', { token_id: TOKEN }, 200000000000000n, utils.format.parseNearAmount('0.001'))], label: 'buy (gen2)', dryRun });
  if (!dryRun) {
    proof.checks.ownerAfterBuy1 = viewCall(NFT_CONTRACT, 'nft_token', { token_id: TOKEN }).owner_id;
    proof.checks.listingsAfterBuy1 = viewCall(CORE_CONTRACT, 'get_listings', {});
    proof.checks.treasuryAfterBuy1 = balanceOf(MASTER);
    console.log(`Owner after buy 1: ${proof.checks.ownerAfterBuy1} | listings: ${JSON.stringify(proof.checks.listingsAfterBuy1)} | treasury ${proof.checks.treasuryAfterBuy1} NEAR`);
    if (proof.checks.ownerAfterBuy1 !== GEN2) throw new Error('buy did not move the NFT to gen2');
    if (proof.checks.listingsAfterBuy1.length !== 0) throw new Error('listing not removed after buy');
  }

  // 3. gen2 lists it back at 0.001 NEAR.
  proof.txs.list2 = await sendTx({ signerId: GEN2, keyPair: gen2Key(), receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_transfer_call', { receiver_id: CORE_CONTRACT, token_id: TOKEN, msg: PRICE_YOCTO }, 300000000000000n, 1n)], label: 'list back (gen2 -> Core)', dryRun });
  if (!dryRun) {
    proof.checks.listingsAfterList2 = viewCall(CORE_CONTRACT, 'get_listings', {});
    console.log('Listings after list 2:', JSON.stringify(proof.checks.listingsAfterList2));
  }

  // 4. Treasury buys it back for 0.001 NEAR.
  proof.txs.buy2 = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('buy_nft', { token_id: TOKEN }, 200000000000000n, utils.format.parseNearAmount('0.001'))], label: 'buy back (treasury)', dryRun });
  if (!dryRun) {
    proof.checks.ownerAfterBuy2 = viewCall(NFT_CONTRACT, 'nft_token', { token_id: TOKEN }).owner_id;
    proof.checks.listingsAfterBuy2 = viewCall(CORE_CONTRACT, 'get_listings', {});
    proof.checks.treasuryAfter = balanceOf(MASTER);
    proof.checks.gen2After = balanceOf(GEN2);
    console.log(`Owner after buy 2: ${proof.checks.ownerAfterBuy2} | listings: ${JSON.stringify(proof.checks.listingsAfterBuy2)} | treasury ${proof.checks.treasuryAfter} NEAR | gen2 ${proof.checks.gen2After} NEAR`);
    if (proof.checks.ownerAfterBuy2 !== MASTER) throw new Error('buy-back did not return the NFT to the treasury');
    if (proof.checks.listingsAfterBuy2.length !== 0) throw new Error('listing not removed after buy-back');
  }
  fs.writeFileSync('demo/marketplace-roundtrip.json', JSON.stringify(proof, null, 2));
  console.log('Wrote demo/marketplace-roundtrip.json');
  console.log(JSON.stringify(proof, null, 2));
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
