// Birth mirror via curl for ALL RPC calls (undici via this VM's proxy drops
// some near-api-js RPC calls with UND_ERR_SOCKET, while curl succeeds).
// Signs locally with near-api-js, broadcasts the signed tx via curl.
const fs = require('fs');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');
function rpc(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params });
  const out = execSync(`curl -s -m 60 https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '${payload}'`, { maxBuffer: 1024 * 1024 });
  const j = JSON.parse(out.toString());
  if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error).slice(0, 500));
  return j.result;
}
async function main() {
  const saved = JSON.parse(fs.readFileSync('.testnet-account.json', 'utf8'));
  const master = saved.accountId;
  const childId = `gen0.${master}`;
  const childKey = KeyPair.fromRandom('ed25519');
  const kp = KeyPair.fromString(saved.privateKey);
  const pub = kp.getPublicKey().toString();
  const accessKey = rpc('query', { request_type: 'view_access_key', account_id: master, public_key: pub, finality: 'final' });
  const block = rpc('block', { finality: 'final' });
  console.log('nonce', accessKey.nonce, 'block', block.header.height);
  const actions = [
    transactions.createAccount(),
    transactions.transfer(utils.format.parseNearAmount('0.1')),
    transactions.addKey(childKey.getPublicKey(), transactions.fullAccessKey()),
  ];
  const tx = transactions.createTransaction(
    master, utils.PublicKey.fromString(pub), childId,
    accessKey.nonce + 1, actions,
    utils.serialize.base_decode(block.header.hash),
  );
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', master, kp);
  const signer = new InMemorySigner(ks);
  const [hash, signedTx] = await transactions.signTransaction(tx, signer, master, 'testnet');
  const b64 = Buffer.from(signedTx.encode()).toString('base64');
  console.log('signed tx hash (local):', Buffer.from(hash).toString('hex'));
  console.log('child public key:', childKey.getPublicKey().toString());
  const result = rpc('broadcast_tx_commit', [b64]);
  console.log('broadcast status:', JSON.stringify(result).slice(0, 1500));
  fs.writeFileSync('demo/testnet-birth.json', JSON.stringify({ master, childId, childPublicKey: childKey.getPublicKey().toString(), signedTxHashHex: Buffer.from(hash).toString('hex'), broadcastStatus: result.status || result, note: 'Signed locally, broadcast via curl.' }, null, 2));
  console.log('Wrote demo/testnet-birth.json');
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
