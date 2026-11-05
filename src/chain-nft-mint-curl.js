// Test mint of Genesis Gen 0 as a real NFT on NEAR testnet, via the shared
// NEP-171 contract nft.primitives.testnet (verified live 2026-11-04).
// Signs locally with near-api-js, broadcasts via curl (proxy-safe pattern
// from src/chain-birth-curl.js). If the contract rejects the call (e.g.
// owner-only mint), the attached deposit is refunded except gas, and the
// failure is printed in full — never reported as a mint.
// Usage: node src/chain-nft-mint-curl.js <token_id> <receiver_id> [variant]
//   variant: receiver (default) or owner
const fs = require('fs');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');
function rpc(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params });
  const out = execSync(`curl -s -m 60 https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '${payload}'`, { maxBuffer: 1024 * 1024 });
  const j = JSON.parse(out.toString());
  if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error).slice(0, 800));
  return j.result;
}
async function main() {
  const tokenId = process.argv[2] || 'genesis-gen-0';
  const receiverId = process.argv[3] || 'genesisdemo354551.testnet';
  const variant = process.argv[4] || 'receiver';
  const { mediaForGen } = require('./nft-media.js');
  const genMatch = tokenId.match(/gen-(\d+)/);
  const gen = genMatch ? parseInt(genMatch[1], 10) : 0;
  const saved = JSON.parse(fs.readFileSync(__dirname + '/../.testnet-account.json', 'utf8'));
  const master = saved.accountId;
  const kp = KeyPair.fromString(saved.privateKey);
  const pub = kp.getPublicKey().toString();
  const accessKey = rpc('query', { request_type: 'view_access_key', account_id: master, public_key: pub, finality: 'final' });
  const block = rpc('block', { finality: 'final' });
  const metadata = {
    title: `Genesis Gen ${gen}`,
    description: `Genesis agent, generation ${gen}. Born with a balance, works real jobs, gets verified, earns, and reproduces or dies. NEAR Hackathon: Build Beyond Boundaries.`,
    media: mediaForGen(gen),
    attributes: [
      { trait_type: 'generation', value: String(gen) },
      { trait_type: 'parent', value: 'treasury' },
      { trait_type: 'speed', value: '1.0' },
      { trait_type: 'quality', value: '1.0' },
      { trait_type: 'costEff', value: '1.0' },
      { trait_type: 'status', value: 'alive' },
    ],
  };
  const args = variant === 'owner'
    ? { token_id: tokenId, token_owner_id: receiverId, token_metadata: metadata }
    : { token_id: tokenId, receiver_id: receiverId, token_metadata: metadata };
  const actions = [transactions.functionCall('nft_mint', args, 300000000000000n, utils.format.parseNearAmount('0.1'))];
  const tx = transactions.createTransaction(
    master, utils.PublicKey.fromString(pub), 'nft.primitives.testnet',
    accessKey.nonce + 1, actions,
    utils.serialize.base_decode(block.header.hash),
  );
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', master, kp);
  const signer = new InMemorySigner(ks);
  const [hash, signedTx] = await transactions.signTransaction(tx, signer, master, 'testnet');
  const b64 = Buffer.from(signedTx.encode()).toString('base64');
  console.log('signed tx hash (local):', Buffer.from(hash).toString('hex'));
  const result = rpc('broadcast_tx_commit', [b64]);
  console.log(JSON.stringify(result, null, 2).slice(0, 3000));
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
