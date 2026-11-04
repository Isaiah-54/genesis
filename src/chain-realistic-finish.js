// Finish the realistic run: the weak agent's death transfer failed first
// because nft_transfer on nft.primitives.testnet costs ~0.30 NEAR in
// storage/gas, and gen5 only held 0.02 NEAR. Fix: fund gen5 with 0.5 NEAR
// from the treasury, transfer its NFT back to the treasury, then return
// 0.45 NEAR to the treasury. Then re-verify every token and balance by RPC.
const fs = require('fs');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');
const MASTER = 'genesisdemo354551.testnet';
const NFT_CONTRACT = 'nft.primitives.testnet';
function rpc(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params });
  const out = execSync(`curl -s -m 60 https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '${payload}'`, { maxBuffer: 4 * 1024 * 1024 });
  const j = JSON.parse(out.toString());
  if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error).slice(0, 800));
  return j.result;
}
async function sendTx({ signerId, keyPair, receiverId, actions, run, label }) {
  const pub = keyPair.getPublicKey().toString();
  const accessKey = rpc('query', { request_type: 'view_access_key', account_id: signerId, public_key: pub, finality: 'final' });
  const block = rpc('block', { finality: 'final' });
  const tx = transactions.createTransaction(signerId, utils.PublicKey.fromString(pub), receiverId, accessKey.nonce + 1, actions, utils.serialize.base_decode(block.header.hash));
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', signerId, keyPair);
  const signer = new InMemorySigner(ks);
  const [hash, signedTx] = await transactions.signTransaction(tx, signer, signerId, 'testnet');
  const hashHex = Buffer.from(hash).toString('hex');
  const result = rpc('broadcast_tx_commit', [Buffer.from(signedTx.encode()).toString('base64')]);
  const status = result.status && (result.status.SuccessValue !== undefined ? 'Success' : JSON.stringify(result.status));
  run.txs.push({ label, signerId, receiverId, hash: hashHex, status });
  fs.writeFileSync(__dirname + '/../demo/realistic-testnet-run.json', JSON.stringify(run, null, 2));
  console.log(label, '->', hashHex, status);
  if (status !== 'Success') throw new Error(label + ' failed: ' + JSON.stringify(result).slice(0, 1000));
}
async function main() {
  const run = JSON.parse(fs.readFileSync(__dirname + '/../demo/realistic-testnet-run.json', 'utf8'));
  const saved = JSON.parse(fs.readFileSync(__dirname + '/../.testnet-account.json', 'utf8'));
  const agents = JSON.parse(fs.readFileSync(__dirname + '/../.testnet-agents.json', 'utf8'));
  const masterKp = KeyPair.fromString(saved.privateKey);
  const weakKp = KeyPair.fromString(agents['gen5.' + MASTER]);
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: 'gen5.' + MASTER,
    actions: [transactions.transfer(utils.format.parseNearAmount('0.5'))], run, label: 'fund weak gen5 with 0.5 NEAR for death transfer' });
  await sendTx({ signerId: 'gen5.' + MASTER, keyPair: weakKp, receiverId: NFT_CONTRACT,
    actions: [transactions.functionCall('nft_transfer', { receiver_id: MASTER, token_id: 'genesis-gen-5-weak', memo: 'Death: NFT returns to Genesis treasury' }, 300000000000000n, 1n)], run, label: 'death transfer genesis-gen-5-weak to treasury' });
  await sendTx({ signerId: 'gen5.' + MASTER, keyPair: weakKp, receiverId: MASTER,
    actions: [transactions.transfer(utils.format.parseNearAmount('0.45'))], run, label: 'weak agent balance return 0.45 NEAR to treasury' });
  function viewCall(accountId, method, args) {
    const r = rpc('query', { request_type: 'call_function', account_id: accountId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final' });
    return JSON.parse(Buffer.from(r.result).toString());
  }
  run.verification = {
    gen0: viewCall(NFT_CONTRACT, 'nft_token', { token_id: 'genesis-gen-0' }),
    gen1: viewCall(NFT_CONTRACT, 'nft_token', { token_id: 'genesis-gen-1' }),
    gen5weak: viewCall(NFT_CONTRACT, 'nft_token', { token_id: 'genesis-gen-5-weak' }),
    gen0Balance: rpc('query', { request_type: 'view_account', account_id: 'gen0.' + MASTER, finality: 'final' }).amount,
    gen1Balance: rpc('query', { request_type: 'view_account', account_id: 'gen1.' + MASTER, finality: 'final' }).amount,
    gen5Balance: rpc('query', { request_type: 'view_account', account_id: 'gen5.' + MASTER, finality: 'final' }).amount,
    masterBalance: rpc('query', { request_type: 'view_account', account_id: MASTER, finality: 'final' }).amount,
  };
  run.notes.push('Death transfer costs ~0.30 NEAR on this shared contract (storage/gas), not 1 yocto — weak agent needed 0.5 NEAR funding to die. That cost is now documented, not hidden.');
  fs.writeFileSync(__dirname + '/../demo/realistic-testnet-run.json', JSON.stringify(run, null, 2));
  console.log('VERIFIED:', JSON.stringify(run.verification, null, 2).slice(0, 2500));
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
