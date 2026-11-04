// Realistic Genesis run on NEAR testnet — every step is a real on-chain tx.
// 1. Transfer Gen 0 NFT (already minted on nft.primitives.testnet) to its
//    agent subaccount gen0.genesisdemo354551.testnet.
// 2. Real job: fetch a live NEAR docs page, summarise it with the repo
//    worker, verify it with the repo verifier, pay 0.01 testnet NEAR on PASS.
// 3. Birth Gen 1: create gen1 subaccount, mint genesis-gen-1 NFT to it.
// 4. Death: create a weak agent, mint its NFT, transfer the NFT back to
//    the treasury (master) — the agent no longer owns its identity.
// Signs locally, broadcasts via curl. Every tx hash is saved to
// demo/realistic-testnet-run.json as it lands, and re-verified by RPC.
const fs = require('fs');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');
const { work, verify } = require('./engine');
const MASTER = 'genesisdemo354551.testnet';
const NFT_CONTRACT = 'nft.primitives.testnet';
function rpc(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params });
  const out = execSync(`curl -s -m 60 https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '${payload}'`, { maxBuffer: 4 * 1024 * 1024 });
  const j = JSON.parse(out.toString());
  if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error).slice(0, 800));
  return j.result;
}
function saveRun(run) {
  fs.writeFileSync(__dirname + '/../demo/realistic-testnet-run.json', JSON.stringify(run, null, 2));
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
  const b64 = Buffer.from(signedTx.encode()).toString('base64');
  const result = rpc('broadcast_tx_commit', [b64]);
  const status = result.status && (result.status.SuccessValue !== undefined ? 'Success' : JSON.stringify(result.status));
  const entry = { label, signerId, receiverId, hash: hashHex, status };
  run.txs.push(entry); saveRun(run);
  console.log(label, '->', hashHex, status);
  if (status !== 'Success') throw new Error(label + ' failed: ' + JSON.stringify(result).slice(0, 1000));
  return entry;
}
function nftMetadata({ title, description, gen, parent, skill, status, mediaLabel }) {
  return {
    title, description,
    media: `data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 288 288%27%3E%3Crect width=%27288%27 height=%27288%27 fill=%27%230b1020%27/%3E%3Ccircle cx=%27144%27 cy=%27144%27 r=%2790%27 fill=%27%233ddc84%27/%3E%3Ctext x=%27144%27 y=%27160%27 font-size=%2764%27 text-anchor=%27middle%27 fill=%27%230b1020%27 font-family=%27sans-serif%27 font-weight=%27bold%27%3E${mediaLabel}%3C/text%3E%3C/svg%3E`,
    attributes: [
      { trait_type: 'generation', value: String(gen) },
      { trait_type: 'parent', value: parent },
      { trait_type: 'speed', value: String(skill.speed) },
      { trait_type: 'quality', value: String(skill.quality) },
      { trait_type: 'costEff', value: String(skill.costEff) },
      { trait_type: 'status', value: status },
    ],
  };
}
async function main() {
  const run = { master: MASTER, nftContract: NFT_CONTRACT, txs: [], notes: [] };
  saveRun(run);
  const saved = JSON.parse(fs.readFileSync(__dirname + '/../.testnet-account.json', 'utf8'));
  const masterKp = KeyPair.fromString(saved.privateKey);
  const agentKeys = {};
  try { Object.assign(agentKeys, JSON.parse(fs.readFileSync(__dirname + '/../.testnet-agents.json', 'utf8'))); } catch (_) {}
  // 1. Gen 0 NFT -> its agent subaccount
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: NFT_CONTRACT,
    actions: [transactions.functionCall('nft_transfer', { receiver_id: 'gen0.' + MASTER, token_id: 'genesis-gen-0', memo: 'Genesis Gen 0 takes ownership of its NFT' }, 300000000000000n, 1n)], run, label: 'nft_transfer genesis-gen-0 to gen0 subaccount' });
  // 2. Real job from a live NEAR page
  let page = '';
  try { page = execSync(`curl -s -m 30 https://docs.near.org/primitives/nft/nft | sed -e 's/<[^>]*>/ /g' | tr -s ' \\n' ' '`, { maxBuffer: 4 * 1024 * 1024 }).toString(); } catch (_) {}
  if (page.length < 500) throw new Error('Real job page fetch too short: ' + page.length);
  const jobText = page.slice(0, 3000);
  const job = { brief: 'NEAR NFTs global contract mint', minWords: 20, keywords: ['near', 'nft', 'mint'], text: jobText };
  const agent0 = { skill: { speed: 1, quality: 1, costEff: 1, language: 'en' } };
  const output = work(job, agent0);
  const v = verify(job, output);
  run.job = { source: 'https://docs.near.org/primitives/nft/nft (live fetch)', textLength: jobText.length, outputWords: v.words, keywordsCovered: `${v.keywordsCovered}/${v.keywordsTotal}`, pass: v.pass, output: output.slice(0, 500) };
  saveRun(run);
  console.log('JOB verify:', JSON.stringify(run.job, null, 2).slice(0, 800));
  if (!v.pass) throw new Error('Real job FAILED verification — no payment sent (this is the honest outcome).');
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: 'gen0.' + MASTER,
    actions: [transactions.transfer(utils.format.parseNearAmount('0.01'))], run, label: 'job payment 0.01 NEAR to gen0 subaccount' });
  // 3. Birth Gen 1
  const gen1Kp = KeyPair.fromRandom('ed25519');
  agentKeys['gen1.' + MASTER] = gen1Kp.toString();
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: 'gen1.' + MASTER,
    actions: [transactions.createAccount(), transactions.transfer(utils.format.parseNearAmount('0.05')), transactions.addKey(gen1Kp.getPublicKey(), transactions.fullAccessKey())], run, label: 'create gen1 subaccount funded 0.05 NEAR' });
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: NFT_CONTRACT,
    actions: [transactions.functionCall('nft_mint', { token_id: 'genesis-gen-1', receiver_id: 'gen1.' + MASTER, token_metadata: nftMetadata({ title: 'Genesis Gen 1', description: 'Child of Genesis Gen 0. Mutated cost-efficiency 1.2. Born, works, earns, reproduces or dies.', gen: 1, parent: 'genesis-gen-0', skill: { speed: 1, quality: 0.95, costEff: 1.2 }, status: 'alive', mediaLabel: 'G1' }) }, 300000000000000n, utils.format.parseNearAmount('0.1'))], run, label: 'nft_mint genesis-gen-1 to gen1 subaccount' });
  // 4. Weak agent death: create, mint, return NFT to treasury
  const weakKp = KeyPair.fromRandom('ed25519');
  agentKeys['gen5.' + MASTER] = weakKp.toString();
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: 'gen5.' + MASTER,
    actions: [transactions.createAccount(), transactions.transfer(utils.format.parseNearAmount('0.02')), transactions.addKey(weakKp.getPublicKey(), transactions.fullAccessKey())], run, label: 'create weak gen5 subaccount funded 0.02 NEAR' });
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: NFT_CONTRACT,
    actions: [transactions.functionCall('nft_mint', { token_id: 'genesis-gen-5-weak', receiver_id: 'gen5.' + MASTER, token_metadata: nftMetadata({ title: 'Genesis Gen 5 (weak)', description: 'Weak branch: quality 0.2. Fails 3 jobs in a row and dies; its NFT returns to the treasury.', gen: 0, parent: 'treasury', skill: { speed: 0.5, quality: 0.2, costEff: 0.8 }, status: 'dead', mediaLabel: 'W5' }) }, 300000000000000n, utils.format.parseNearAmount('0.1'))], run, label: 'nft_mint genesis-gen-5-weak to gen5 subaccount' });
  await sendTx({ signerId: 'gen5.' + MASTER, keyPair: weakKp, receiverId: NFT_CONTRACT,
    actions: [transactions.functionCall('nft_transfer', { receiver_id: MASTER, token_id: 'genesis-gen-5-weak', memo: 'Death: NFT returns to Genesis treasury' }, 300000000000000n, 1n)], run, label: 'death transfer genesis-gen-5-weak to treasury' });
  fs.writeFileSync(__dirname + '/../.testnet-agents.json', JSON.stringify(agentKeys, null, 2));
  execSync('chmod 600 ' + __dirname + '/../.testnet-agents.json');
  // Verify by RPC view calls
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
    masterBalance: rpc('query', { request_type: 'view_account', account_id: MASTER, finality: 'final' }).amount,
  };
  saveRun(run);
  console.log('VERIFIED:', JSON.stringify(run.verification, null, 2).slice(0, 2000));
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
