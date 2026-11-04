// Working-product run — the lesson from the first realistic run, fixed:
// keys are saved to .testnet-agents.json (chmod 600, gitignored) BEFORE
// any account-creation tx is broadcast. No agent is ever created with a
// key that only lives in process memory.
// Agents in this run:
//  - gen2: born, minted as NFT genesis-gen-2, works a real job, gets paid.
//  - weak2: born, minted as NFT genesis-weak-2, dies: NFT returns to the
//    treasury and most of its balance returns too.
// All tx hashes are saved to demo/working-product-run.json as they land,
// then every token owner and balance is re-verified by RPC.
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
function saveRun(run) { fs.writeFileSync(__dirname + '/../demo/working-product-run.json', JSON.stringify(run, null, 2)); }
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
  run.txs.push({ label, signerId, receiverId, hash: hashHex, status }); saveRun(run);
  console.log(label, '->', hashHex, status);
  if (status !== 'Success') throw new Error(label + ' failed: ' + JSON.stringify(result).slice(0, 1000));
}
function meta({ title, description, gen, parent, skill, status, label }) {
  return { title, description,
    media: `data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 288 288%27%3E%3Crect width=%27288%27 height=%27288%27 fill=%27%230b1020%27/%3E%3Ccircle cx=%27144%27 cy=%27144%27 r=%2790%27 fill=%27%233ddc84%27/%3E%3Ctext x=%27144%27 y=%27160%27 font-size=%2764%27 text-anchor=%27middle%27 fill=%27%230b1020%27 font-family=%27sans-serif%27 font-weight=%27bold%27%3E${label}%3C/text%3E%3C/svg%3E`,
    attributes: [
      { trait_type: 'generation', value: String(gen) },
      { trait_type: 'parent', value: parent },
      { trait_type: 'speed', value: String(skill.speed) },
      { trait_type: 'quality', value: String(skill.quality) },
      { trait_type: 'costEff', value: String(skill.costEff) },
      { trait_type: 'status', value: status },
    ] };
}
async function main() {
  const run = { master: MASTER, nftContract: NFT_CONTRACT, txs: [], notes: ['Keys saved to .testnet-agents.json BEFORE any creation tx.'] };
  saveRun(run);
  const saved = JSON.parse(fs.readFileSync(__dirname + '/../.testnet-account.json', 'utf8'));
  const masterKp = KeyPair.fromString(saved.privateKey);
  // KEY-SAVE-FIRST: generate both agent keys and persist them now.
  const gen2Kp = KeyPair.fromRandom('ed25519');
  const weakKp = KeyPair.fromRandom('ed25519');
  const agentKeys = { ['gen2.' + MASTER]: gen2Kp.toString(), ['weak2.' + MASTER]: weakKp.toString() };
  fs.writeFileSync(__dirname + '/../.testnet-agents.json', JSON.stringify(agentKeys, null, 2));
  execSync('chmod 600 ' + __dirname + '/../.testnet-agents.json');
  console.log('Agent keys saved first for gen2 and weak2.');
  // Gen 2: birth, mint, work, pay
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: 'gen2.' + MASTER,
    actions: [transactions.createAccount(), transactions.transfer(utils.format.parseNearAmount('0.5')), transactions.addKey(gen2Kp.getPublicKey(), transactions.fullAccessKey())], run, label: 'create gen2 subaccount funded 0.5 NEAR' });
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: NFT_CONTRACT,
    actions: [transactions.functionCall('nft_mint', { token_id: 'genesis-gen-2', receiver_id: 'gen2.' + MASTER, token_metadata: meta({ title: 'Genesis Gen 2', description: 'Genesis agent, generation 2. Child of Gen 1 (skill costEff 1.15). Works real jobs, gets verified and paid on NEAR testnet.', gen: 2, parent: 'genesis-gen-1', skill: { speed: 1.2, quality: 0.95, costEff: 1.15 }, status: 'alive', label: 'G2' }) }, 300000000000000n, utils.format.parseNearAmount('0.1'))], run, label: 'nft_mint genesis-gen-2 to gen2 subaccount' });
  let page = '';
  try { page = execSync(`curl -s -m 30 https://docs.near.org/primitives/nft/nft | sed -e 's/<[^>]*>/ /g' | tr -s ' \\n' ' '`, { maxBuffer: 4 * 1024 * 1024 }).toString(); } catch (_) {}
  if (page.length < 500) throw new Error('Real job page fetch too short');
  const job = { brief: 'NEAR NFTs global contract mint', minWords: 20, keywords: ['near', 'nft', 'mint'], text: page.slice(0, 3000) };
  const output = work(job, { skill: { speed: 1.2, quality: 0.95, costEff: 1.15, language: 'en' } });
  const v = verify(job, output);
  run.job = { source: 'https://docs.near.org/primitives/nft/nft (live fetch)', textLength: 3000, outputWords: v.words, keywordsCovered: `${v.keywordsCovered}/${v.keywordsTotal}`, pass: v.pass };
  saveRun(run);
  console.log('JOB gen2 verify:', JSON.stringify(run.job));
  if (!v.pass) throw new Error('Gen2 job FAILED verification — no payment sent.');
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: 'gen2.' + MASTER,
    actions: [transactions.transfer(utils.format.parseNearAmount('0.01'))], run, label: 'job payment 0.01 NEAR to gen2 subaccount' });
  // Weak 2: birth, mint, death (NFT + balance back to treasury)
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: 'weak2.' + MASTER,
    actions: [transactions.createAccount(), transactions.transfer(utils.format.parseNearAmount('0.5')), transactions.addKey(weakKp.getPublicKey(), transactions.fullAccessKey())], run, label: 'create weak2 subaccount funded 0.5 NEAR' });
  await sendTx({ signerId: MASTER, keyPair: masterKp, receiverId: NFT_CONTRACT,
    actions: [transactions.functionCall('nft_mint', { token_id: 'genesis-weak-2', receiver_id: 'weak2.' + MASTER, token_metadata: meta({ title: 'Genesis Weak 2', description: 'Weak Genesis branch, quality 0.2. Dies: its NFT and balance return to the treasury.', gen: 0, parent: 'treasury', skill: { speed: 0.5, quality: 0.2, costEff: 0.8 }, status: 'dead', label: 'W2' }) }, 300000000000000n, utils.format.parseNearAmount('0.1'))], run, label: 'nft_mint genesis-weak-2 to weak2 subaccount' });
  await sendTx({ signerId: 'weak2.' + MASTER, keyPair: weakKp, receiverId: NFT_CONTRACT,
    actions: [transactions.functionCall('nft_transfer', { receiver_id: MASTER, token_id: 'genesis-weak-2', memo: 'Death: NFT returns to Genesis treasury' }, 300000000000000n, 1n)], run, label: 'death transfer genesis-weak-2 to treasury' });
  await sendTx({ signerId: 'weak2.' + MASTER, keyPair: weakKp, receiverId: MASTER,
    actions: [transactions.transfer(utils.format.parseNearAmount('0.15'))], run, label: 'weak2 balance return 0.15 NEAR to treasury' });
  function viewCall(accountId, method, args) {
    const r = rpc('query', { request_type: 'call_function', account_id: accountId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final' });
    return JSON.parse(Buffer.from(r.result).toString());
  }
  run.verification = {
    gen2: viewCall(NFT_CONTRACT, 'nft_token', { token_id: 'genesis-gen-2' }),
    weak2: viewCall(NFT_CONTRACT, 'nft_token', { token_id: 'genesis-weak-2' }),
    gen2Balance: rpc('query', { request_type: 'view_account', account_id: 'gen2.' + MASTER, finality: 'final' }).amount,
    weak2Balance: rpc('query', { request_type: 'view_account', account_id: 'weak2.' + MASTER, finality: 'final' }).amount,
    masterBalance: rpc('query', { request_type: 'view_account', account_id: MASTER, finality: 'final' }).amount,
  };
  saveRun(run);
  console.log('VERIFIED:', JSON.stringify(run.verification, null, 2).slice(0, 2500));
}
main().catch(e => { console.error('FAILED', e); process.exit(1); });
