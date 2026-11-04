#!/usr/bin/env node
// Genesis product CLI — one command for every Genesis action.
// Usage:
//   node src/cli.js status
//   node src/cli.js agents
//   node src/cli.js token genesis-gen-2
//   node src/cli.js balance gen2.genesisdemo354551.testnet
//   node src/cli.js create-agent gen3 0.5
//   node src/cli.js mint genesis-gen-3 gen3.genesisdemo354551.testnet "Genesis Gen 3" 3 genesis-gen-2
//   node src/cli.js pay gen2.genesisdemo354551.testnet 0.01
//   node src/cli.js transfer-nft genesis-weak-2 genesisdemo354551.testnet
//   node src/cli.js job gen2.genesisdemo354551.testnet https://docs.near.org/primitives/nft/nft
// Add --dry-run to any write command to print the tx without broadcasting.
// Reads keys only from local gitignored files (.testnet-account.json,
// .testnet-agents.json). No key is ever printed.
const fs = require('fs');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');
const { work, verify } = require('./engine');
const MASTER = 'genesisdemo354551.testnet';
const NFT_CONTRACT = 'nft.primitives.testnet';
const TOKENS = ['genesis-gen-0', 'genesis-gen-1', 'genesis-gen-2', 'genesis-weak-2', 'genesis-gen-5-weak'];
function rpc(method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'x', method, params });
  const out = execSync(`curl -s -m 60 https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '${payload}'`, { maxBuffer: 4 * 1024 * 1024 });
  const j = JSON.parse(out.toString());
  if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error).slice(0, 800));
  return j.result;
}
function viewCall(accountId, method, args) {
  const r = rpc('query', { request_type: 'call_function', account_id: accountId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final' });
  return JSON.parse(Buffer.from(r.result).toString());
}
function balanceOf(a) { const x = rpc('query', { request_type: 'view_account', account_id: a, finality: 'final' }); return (Number(x.amount) / 1e24).toFixed(4); }
function masterKey() { return KeyPair.fromString(JSON.parse(fs.readFileSync(__dirname + '/../.testnet-account.json', 'utf8')).privateKey); }
function agentKeys() { try { return JSON.parse(fs.readFileSync(__dirname + '/../.testnet-agents.json', 'utf8')); } catch { return {}; } }
async function sendTx({ signerId, keyPair, receiverId, actions, dryRun, label }) {
  if (dryRun) { console.log('[dry-run]', label, '->', receiverId); return { dryRun: true, label }; }
  const pub = keyPair.getPublicKey().toString();
  const accessKey = rpc('query', { request_type: 'view_access_key', account_id: signerId, public_key: pub, finality: 'final' });
  const block = rpc('block', { finality: 'final' });
  const tx = transactions.createTransaction(signerId, utils.PublicKey.fromString(pub), receiverId, accessKey.nonce + 1, actions, utils.serialize.base_decode(block.header.hash));
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey('testnet', signerId, keyPair);
  const signer = new InMemorySigner(ks);
  const [hash, signedTx] = await transactions.signTransaction(tx, signer, signerId, 'testnet');
  const result = rpc('broadcast_tx_commit', [Buffer.from(signedTx.encode()).toString('base64')]);
  const status = result.status && (result.status.SuccessValue !== undefined ? 'Success' : JSON.stringify(result.status));
  if (status !== 'Success') throw new Error(label + ' failed: ' + JSON.stringify(result).slice(0, 1000));
  return { hash: Buffer.from(hash).toString('hex'), status };
}
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const a = args.filter(x => x !== '--dry-run');
  const cmd = a[0];
  if (!cmd || cmd === 'help') {
    console.log(`Genesis CLI (NEAR testnet)
  status                  Treasury balance + all Genesis NFTs, live
  agents                  All Genesis NFTs with owner + status, live
  token <id>              One NFT's owner + metadata
  balance <account>       One account's balance
  create-agent <id> <fund>  Create agent subaccount (key saved FIRST)
  mint <token> <receiver> <title> <gen> <parent>   Mint a Genesis NFT
  pay <receiver> <amount> Pay testnet NEAR from treasury
  transfer-nft <token> <receiver>  Transfer NFT (refuses locked tokens)
  job <agent> <page_url>  Real job: fetch, verify, pay 0.01 on PASS
  Add --dry-run to any write command to preview without broadcasting.`);
    return;
  }
  if (cmd === 'status') {
    console.log('Treasury:', MASTER, balanceOf(MASTER), 'NEAR');
    for (const t of TOKENS) { try { const tk = viewCall(NFT_CONTRACT, 'nft_token', { token_id: t }); console.log(t, '->', tk.owner_id, '|', tk.metadata.title); } catch (e) { console.log(t, '-> not found'); } }
    return;
  }
  if (cmd === 'agents') {
    // NEP-177 TokenMetadata has NO attributes field — the shared contract
    // drops it. Traits live in `extra` (JSON string) for new mints, and are
    // derived from title/description for the first tokens. Never claim an
    // onchain trait that is not in extra or description.
    for (const t of TOKENS) { try {
      const tk = viewCall(NFT_CONTRACT, 'nft_token', { token_id: t });
      let traits = {};
      try { traits = JSON.parse(tk.metadata.extra || '{}'); } catch {}
      const gen = traits.generation ?? (tk.metadata.title.match(/Gen (\d+)/) || [])[1] ?? (tk.metadata.title.includes('Weak') ? 0 : '?');
      const parent = traits.parent ?? ((tk.metadata.description.match(/Child of (Gen \d+|genesis-[a-z0-9-]+)/) || [])[1] ?? (tk.metadata.description.match(/parent ([A-Za-z0-9-]+)/i) || [])[1] ?? '?');
      let status = traits.status ?? (tk.metadata.title.includes('Weak') && tk.owner_id === MASTER ? 'dead' : 'alive');
      if (t === 'genesis-gen-5-weak') status = 'locked — death never completed (key lost)';
      console.log(`${t} | owner ${tk.owner_id} | gen ${gen} | parent ${parent} | status ${status}`);
    } catch { console.log(`${t} | not found`); } }
    return;
  }
  if (cmd === 'token') { console.log(JSON.stringify(viewCall(NFT_CONTRACT, 'nft_token', { token_id: a[1] }), null, 2)); return; }
  if (cmd === 'balance') { console.log(a[1], balanceOf(a[1]), 'NEAR'); return; }
  if (cmd === 'create-agent') {
    const accountId = a[1].endsWith('.' + MASTER) ? a[1] : a[1] + '.' + MASTER;
    const kp = KeyPair.fromRandom('ed25519');
    const keys = agentKeys(); keys[accountId] = kp.toString();
    fs.writeFileSync(__dirname + '/../.testnet-agents.json', JSON.stringify(keys, null, 2));
    execSync('chmod 600 ' + __dirname + '/../.testnet-agents.json');
    console.log('Key saved first for', accountId);
    console.log(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: accountId, actions: [transactions.createAccount(), transactions.transfer(utils.format.parseNearAmount(a[2])), transactions.addKey(kp.getPublicKey(), transactions.fullAccessKey())], dryRun, label: 'create-agent ' + accountId }));
    return;
  }
  if (cmd === 'mint') {
    const [, tokenId, receiver, title, gen, parent] = a;
    const metadata = { title, description: `Genesis agent, generation ${gen}, parent ${parent}.`, media: '', extra: JSON.stringify({ generation: gen, parent, status: 'alive' }) };
    console.log(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_mint', { token_id: tokenId, receiver_id: receiver, token_metadata: metadata }, 300000000000000n, utils.format.parseNearAmount('0.1'))], dryRun, label: 'mint ' + tokenId }));
    return;
  }
  if (cmd === 'pay') { console.log(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: a[1], actions: [transactions.transfer(utils.format.parseNearAmount(a[2]))], dryRun, label: 'pay ' + a[1] })); return; }
  if (cmd === 'transfer-nft') {
    const token = viewCall(NFT_CONTRACT, 'nft_token', { token_id: a[1] });
    const owner = token.owner_id;
    let kp = null;
    if (owner === MASTER) kp = masterKey();
    else { const keys = agentKeys(); if (keys[owner]) kp = KeyPair.fromString(keys[owner]); }
    if (!kp) throw new Error(`Key not held for owner ${owner} — token ${a[1]} is locked and cannot be moved by this CLI.`);
    console.log(await sendTx({ signerId: owner, keyPair: kp, receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_transfer', { receiver_id: a[2], token_id: a[1], memo: 'Genesis transfer via CLI' }, 300000000000000n, 1n)], dryRun, label: 'transfer-nft ' + a[1] }));
    return;
  }
  if (cmd === 'job') {
    const page = execSync(`curl -s -m 30 ${a[2]} | sed -e 's/<[^>]*>/ /g' | tr -s ' \\n' ' '`, { maxBuffer: 4 * 1024 * 1024 }).toString();
    if (page.length < 500) throw new Error('Fetched page too short for a real job');
    const job = { brief: 'NEAR NFTs global contract mint', minWords: 20, keywords: ['near', 'nft', 'mint'], text: page.slice(0, 3000) };
    const output = work(job, { skill: { speed: 1, quality: 1, costEff: 1, language: 'en' } });
    const v = verify(job, output);
    console.log('Verify:', v.pass ? 'PASS' : 'FAIL', v.words, 'words,', `${v.keywordsCovered}/${v.keywordsTotal}`, 'keywords');
    if (!v.pass) { console.log('No payment — job failed verification.'); return; }
    console.log(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: a[1], actions: [transactions.transfer(utils.format.parseNearAmount('0.01'))], dryRun, label: 'job payment to ' + a[1] }));
    return;
  }
  throw new Error('Unknown command: ' + cmd + ' — run: node src/cli.js help');
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
