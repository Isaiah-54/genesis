// NEAR testnet chain layer (v1, in progress).
// DO NOT COMMIT .testnet-account.json — it holds a testnet private key.
// Step 1: create a testnet master account via the testnet helper faucet.
// Step 2: create a Gen 0 subaccount funded from the master (mirrors a birth).
// Step 3: write tx hashes + balances to demo/testnet-proof.json (public-safe:
// account ids and tx hashes only, never the private key).
const fs = require('fs');
const path = require('path');
const { connect, keyStores, KeyPair, utils } = require('near-api-js');
const ACC_FILE = path.join(__dirname, '..', '.testnet-account.json');
const PROOF_FILE = path.join(__dirname, '..', 'demo', 'testnet-proof.json');
async function main() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')); } catch {}
  let accountId, keyPair;
  if (saved) {
    accountId = saved.accountId; keyPair = KeyPair.fromString(saved.privateKey);
    console.log('Using existing testnet account:', accountId);
  } else {
    keyPair = KeyPair.fromRandom('ed25519');
    const suffix = Math.floor(Math.random() * 900000 + 100000);
    accountId = `genesisdemo${suffix}.testnet`;
    console.log('Requesting faucet account:', accountId);
    const res = await fetch('https://helper.testnet.near.org/account', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
    });
    const text = await res.text();
    console.log('Faucet HTTP', res.status, text.slice(0, 300));
    if (!res.ok) throw new Error('Faucet request failed: ' + text.slice(0, 300));
    fs.writeFileSync(ACC_FILE, JSON.stringify({ accountId, privateKey: keyPair.toString() }, null, 2), { mode: 0o600 });
    console.log('Saved', ACC_FILE, '(chmod 600, gitignored)');
  }
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', accountId, keyPair);
  const near = await connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org', keyStore });
  const account = await near.account(accountId);
  const state = await account.state();
  console.log('Master balance (yocto):', state.amount, '=', utils.format.formatNearAmount(state.amount), 'NEAR');
  // Birth mirror: create gen0 subaccount funded with 0.1 NEAR (testnet scale).
  const childId = `gen0.${accountId}`;
  let childTx = null;
  try {
    const childKey = KeyPair.fromRandom('ed25519');
    const result = await account.createAccount(childId, childKey.getPublicKey(), utils.format.parseNearAmount('0.1'));
    childTx = result.transaction.hash;
    console.log('Created subaccount:', childId, 'tx:', childTx);
  } catch (e) {
    console.log('Subaccount creation skipped/failed:', String(e).slice(0, 400));
  }
  const proof = { network: 'testnet', master: accountId, masterBalanceNear: utils.format.formatNearAmount(state.amount), child: childId, childTx, note: 'Birth funding mirror only. Engine ledger in src/engine.js remains the lifecycle source of truth in v0/v1.' };
  fs.writeFileSync(PROOF_FILE, JSON.stringify(proof, null, 2));
  console.log('Wrote', PROOF_FILE);
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
