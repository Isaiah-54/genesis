// Genesis MCP server — Model Context Protocol tools for Genesis transactions
// on NEAR testnet. Run locally only: node src/mcp-server.mjs
// It reads keys ONLY from local files that are never committed:
//   .testnet-account.json  (treasury/master key, chmod 600, gitignored)
//   .testnet-agents.json   (agent subaccount keys, chmod 600, gitignored)
// Write tools sign with those keys and broadcast via curl (proxy-safe).
// Read tools query testnet RPC directly. No key is ever returned in a
// tool result, and a token whose owner key is not held is refused with
// "key not held" instead of being faked — that guard exists because the
// first realistic run lost gen0/gen1/gen5 subaccount keys.
import fs from 'fs';
import { execSync } from 'child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import nearApi from 'near-api-js';
import { mediaForGen } from './nft-media.js';
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = nearApi;
import engine from './engine.js';
const { verify } = engine;
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { workLLM } = require('./worker-llm.js');
const MASTER = 'genesisdemo354551.testnet';
const NFT_CONTRACT = 'nft.primitives.testnet';
const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
const BIRTH_COST_NEAR = '0.5';
const ROOT = new URL('..', import.meta.url).pathname;
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
function masterKey() { return KeyPair.fromString(JSON.parse(fs.readFileSync(ROOT + '.testnet-account.json', 'utf8')).privateKey); }
function agentKeys() { try { return JSON.parse(fs.readFileSync(ROOT + '.testnet-agents.json', 'utf8')); } catch { return {}; } }
async function sendTx({ signerId, keyPair, receiverId, actions }) {
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
  if (status !== 'Success') throw new Error('Transaction failed: ' + JSON.stringify(result).slice(0, 1000));
  return { hash: Buffer.from(hash).toString('hex'), status };
}
function text(obj) { return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }; }
const server = new McpServer({ name: 'genesis', version: '1.0.0' });
server.tool('genesis_token', 'Get a Genesis NFT token (owner + metadata) from nft.primitives.testnet on NEAR testnet.', { token_id: z.string() }, async ({ token_id }) => text(viewCall(NFT_CONTRACT, 'nft_token', { token_id })));
server.tool('genesis_balance', 'Get a NEAR testnet account balance in yocto and NEAR.', { account_id: z.string() }, async ({ account_id }) => {
  const a = rpc('query', { request_type: 'view_account', account_id, finality: 'final' });
  return text({ account_id, yocto: a.amount, near: (Number(a.amount) / 1e24).toFixed(4) });
});
server.tool('genesis_pay', 'Pay testnet NEAR from the Genesis treasury (master account) to any account. Testnet only, no real value.', { receiver_id: z.string(), amount_near: z.string() }, async ({ receiver_id, amount_near }) => text(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: receiver_id, actions: [transactions.transfer(utils.format.parseNearAmount(amount_near))] })));
server.tool('genesis_mint', 'Mint a Genesis NFT (NEP-171) on nft.primitives.testnet to a receiver account, with generation/parent/skill traits.', { token_id: z.string(), receiver_id: z.string(), title: z.string(), generation: z.number(), parent: z.string(), speed: z.number(), quality: z.number(), costEff: z.number() }, async (a) => {
  // NEP-177 has no attributes field — traits go in `extra` (JSON string),
  // which the contract actually stores. Do not pass attributes; they are dropped.
  const metadata = { title: a.title, description: `Genesis agent, generation ${a.generation}, parent ${a.parent}.`, media: mediaForGen(a.generation),
    extra: JSON.stringify({ generation: a.generation, parent: a.parent, speed: a.speed, quality: a.quality, costEff: a.costEff, status: 'alive' }) };
  return text(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_mint', { token_id: a.token_id, receiver_id: a.receiver_id, token_metadata: metadata }, 300000000000000n, utils.format.parseNearAmount('0.1'))] }));
});
server.tool('genesis_core_birth', 'Register an agent in the onchain Genesis Core registry (core.genesisdemo354551.testnet): birth() attaches the 0.5 NEAR birth cost from the treasury and stores generation, parent and skills onchain. The owner account must already exist. Skill defaults to 1.0/1.0/1.0 when omitted; parent may be "-" for none.', { token_id: z.string(), owner_id: z.string(), generation: z.number(), parent: z.string() }, async (a) => {
  return text(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('birth', { token_id: a.token_id, owner_id: a.owner_id, generation: a.generation, parent: (!a.parent || a.parent === '-') ? null : a.parent, skill: null }, 100000000000000n, utils.format.parseNearAmount(BIRTH_COST_NEAR))] }));
});
server.tool('genesis_core_agent', 'Get one agent\'s Genesis Core registry record (generation, parent, skills, status, jobs, earnings) from core.genesisdemo354551.testnet.', { token_id: z.string() }, async ({ token_id }) => text(viewCall(CORE_CONTRACT, 'get_agent', { token_id })));
server.tool('genesis_core_count', 'How many agents the Genesis Core onchain registry holds.', {}, async () => text({ core_contract: CORE_CONTRACT, agent_count: viewCall(CORE_CONTRACT, 'agent_count', {}) }));
server.tool('genesis_create_agent', 'Create a Genesis agent subaccount under the treasury, funded with testnet NEAR. The new key is saved to .testnet-agents.json BEFORE the creation tx is broadcast.', { agent_id: z.string(), fund_near: z.string() }, async ({ agent_id, fund_near }) => {
  const accountId = agent_id.endsWith('.' + MASTER) ? agent_id : agent_id + '.' + MASTER;
  const kp = KeyPair.fromRandom('ed25519');
  const keys = agentKeys(); keys[accountId] = kp.toString();
  fs.writeFileSync(ROOT + '.testnet-agents.json', JSON.stringify(keys, null, 2));
  execSync('chmod 600 ' + ROOT + '.testnet-agents.json');
  const r = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: accountId, actions: [transactions.createAccount(), transactions.transfer(utils.format.parseNearAmount(fund_near)), transactions.addKey(kp.getPublicKey(), transactions.fullAccessKey())] });
  return text({ account_id: accountId, public_key: kp.getPublicKey().toString(), ...r });
});
server.tool('genesis_transfer_nft', 'Transfer a Genesis NFT to a new owner. Works only if the current owner key is held locally (treasury or a saved agent key); otherwise it refuses instead of faking a transfer.', { token_id: z.string(), receiver_id: z.string() }, async ({ token_id, receiver_id }) => {
  const token = viewCall(NFT_CONTRACT, 'nft_token', { token_id });
  const owner = token.owner_id;
  let kp = null;
  if (owner === MASTER) kp = masterKey();
  else { const keys = agentKeys(); if (keys[owner]) kp = KeyPair.fromString(keys[owner]); }
  if (!kp) throw new Error(`Key not held for owner ${owner} — token ${token_id} cannot be moved by this server. This is the locked-token guard.`);
  return text(await sendTx({ signerId: owner, keyPair: kp, receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_transfer', { receiver_id, token_id, memo: 'Genesis transfer via MCP' }, 300000000000000n, 1n)] }));
});
server.tool('genesis_job', 'Run a real Genesis job: fetch a live page, summarise it with the repo worker, verify it, and pay the agent 0.01 testnet NEAR on PASS. No payment on FAIL.', { agent_id: z.string(), page_url: z.string(), brief: z.string(), keywords: z.array(z.string()) }, async ({ agent_id, page_url, brief, keywords }) => {
  const page = execSync(`curl -s -m 30 ${page_url} | perl -0777 -pe 's/<script.*?<\\/script>//gs; s/<style.*?<\\/style>//gs' | sed -e 's/<[^>]*>/ /g' | tr -s ' \\n' ' '`, { maxBuffer: 4 * 1024 * 1024 }).toString();
  if (page.length < 500) throw new Error('Fetched page too short for a real job');
  const job = { brief, minWords: 20, keywords, text: page.slice(0, 3000) };
  const llm = await workLLM(job, { skill: { speed: 1, quality: 1, costEff: 1, language: 'en' } });
  const output = llm.output;
  const v = verify(job, output);
  let payment = null;
  if (v.pass) payment = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: agent_id, actions: [transactions.transfer(utils.format.parseNearAmount('0.01'))] });
  return text({ worker: llm.worker, model: llm.model, pass: v.pass, words: v.words, keywordsCovered: `${v.keywordsCovered}/${v.keywordsTotal}`, payment });
});
await server.connect(new StdioServerTransport());
