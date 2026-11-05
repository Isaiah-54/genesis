// scripts/faucet-relay-refill.js — refill the treasury when the
// top-up faucet (near-faucet.io) is down.
//
// Fallback route, verified 2026-11-05: the testnet helper faucet
// (helper.testnet.near.org) funds a NEW account with 10 testnet NEAR
// — the same endpoint that created the treasury account itself
// (src/chain-testnet.js). This script creates one such relay account
// (once; its key is saved to .testnet-faucet-relay.json, chmod 600,
// gitignored) and transfers testnet NEAR from it to the treasury.
//
// Nothing here touches Isaiah's accounts: the relay account is fresh,
// funded only by the free helper faucet. Testnet NEAR has no value.
//
// Usage:
//   node scripts/faucet-relay-refill.js            transfer 2 NEAR
//   node scripts/faucet-relay-refill.js --amount 1 transfer 1 NEAR
//   node scripts/faucet-relay-refill.js --force   top up even when
//     the treasury is already above the 1.2 NEAR target (explicit
//     top-ups only; the default refuses when no refill is due).
//   node scripts/faucet-relay-refill.js --dry      show what would
//     happen (relay balance, treasury balance) without moving funds.
// Exit code 0 when the treasury ends at or above the 1.2 NEAR target.
const fs = require('fs');
const path = require('path');
const { connect, keyStores, KeyPair, utils } = require('near-api-js');

const TREASURY_ACCOUNT = process.env.TREASURY_ACCOUNT_ID || 'genesisdemo354551.testnet';
const RELAY_FILE = path.join(__dirname, '..', '.testnet-faucet-relay.json');
const HELPER_URL = 'https://helper.testnet.near.org/account';
const RPC_URL = 'https://rpc.testnet.near.org';
const REFILL_TARGET_NEAR = 1.2;

async function createRelayAccount() {
  const keyPair = KeyPair.fromRandom('ed25519');
  const suffix = Math.floor(Math.random() * 900000 + 100000);
  const accountId = `genesisrelay${suffix}.testnet`;
  const res = await fetch(HELPER_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('helper faucet request failed (HTTP ' + res.status + '): ' + text.slice(0, 300));
  fs.writeFileSync(RELAY_FILE, JSON.stringify({ accountId, privateKey: keyPair.toString() }, null, 2), { mode: 0o600 });
  console.log('Relay account created via the helper faucet:', accountId, '(10 testnet NEAR, key saved chmod 600, gitignored)');
  return { accountId, keyPair };
}

async function loadRelay() {
  try {
    const saved = JSON.parse(fs.readFileSync(RELAY_FILE, 'utf8'));
    return { accountId: saved.accountId, keyPair: KeyPair.fromString(saved.privateKey) };
  } catch (_) {
    return createRelayAccount();
  }
}

async function balanceOf(near, accountId) {
  const account = await near.account(accountId);
  const state = await account.state();
  return { yocto: BigInt(state.amount), near: Number(utils.format.formatNearAmount(state.amount)) };
}

async function main() {
  const dry = process.argv.includes('--dry');
  const force = process.argv.includes('--force'); // top up even when above target
  const amountIdx = process.argv.findIndex((a) => a === '--amount' || a.startsWith('--amount='));
  let amountNear = 2;
  if (amountIdx !== -1) {
    const arg = process.argv[amountIdx];
    const raw = arg.includes('=') ? arg.split('=')[1] : process.argv[amountIdx + 1];
    amountNear = Number(raw);
  }
  if (!Number.isFinite(amountNear) || amountNear <= 0) throw new Error('--amount must be a positive number of NEAR');

  const relay = await loadRelay();
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey('testnet', relay.accountId, relay.keyPair);
  const near = await connect({ networkId: 'testnet', nodeUrl: RPC_URL, keyStore });

  const relayBefore = await balanceOf(near, relay.accountId);
  const treasuryBefore = await balanceOf(near, TREASURY_ACCOUNT);
  console.log('Relay ' + relay.accountId + ': ' + relayBefore.near.toFixed(4) + ' NEAR');
  console.log('Treasury ' + TREASURY_ACCOUNT + ': ' + treasuryBefore.near.toFixed(4) + ' NEAR');
  if (!force && treasuryBefore.near >= REFILL_TARGET_NEAR) {
    console.log('Treasury is already at or above the ' + REFILL_TARGET_NEAR + ' NEAR target — no refill needed. Re-run with --force to top up anyway.');
    process.exitCode = 0;
    return;
  }
  if (relayBefore.near < amountNear + 0.01) {
    throw new Error('relay account holds only ' + relayBefore.near.toFixed(4) + ' NEAR, cannot send ' + amountNear);
  }
  if (dry) {
    console.log('[dry run] would transfer ' + amountNear + ' NEAR from ' + relay.accountId + ' to ' + TREASURY_ACCOUNT + '. No funds moved.');
    process.exitCode = 1; // refill still due
    return;
  }
  const relayAccount = await near.account(relay.accountId);
  const result = await relayAccount.sendMoney(TREASURY_ACCOUNT, utils.format.parseNearAmount(String(amountNear)));
  console.log('Transferred ' + amountNear + ' NEAR to the treasury. tx: ' + result.transaction.hash);
  const treasuryAfter = await balanceOf(near, TREASURY_ACCOUNT);
  const relayAfter = await balanceOf(near, relay.accountId);
  console.log('Treasury now: ' + treasuryAfter.near.toFixed(4) + ' NEAR (covers ' + Math.floor(treasuryAfter.near / 0.6) + ' action(s) at 0.6 NEAR each)');
  console.log('Relay now: ' + relayAfter.near.toFixed(4) + ' NEAR (kept for future refills)');
  process.exitCode = treasuryAfter.near >= REFILL_TARGET_NEAR ? 0 : 1;
}

main().catch((e) => { console.error('FAILED: ' + String((e && e.message) || e)); process.exitCode = 2; });
