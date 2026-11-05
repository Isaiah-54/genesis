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
import crypto from 'crypto';
import { execSync } from 'child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import nearApi from 'near-api-js';
import { mediaForGen } from './nft-media.js';
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = nearApi;
import engine from './engine.js';
const { verify, verifyStrict, jobDefId, verifyRuns } = engine;
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { workLLM, callLLM } = require('./worker-llm.js');
const { semanticVerify } = require('./semantic-verify.js');
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

// Post a job to the Core escrow (only if it is not already posted) and pay
// it to a winner. The Core enforces the frontier: pay_job panics when the
// score does not beat the best score on that job definition, and records
// the new frontier when it does. Returns { post, pay } (post tx hash or
// 'already posted', pay tx hash). This is what the arena uses to pay a
// winner through the Core escrow instead of a direct treasury transfer.
async function corePayJob({ jobId, winner, score, jobDefId, rewardNear, brief, keywords }) {
  let existing = null;
  try { existing = viewCall(CORE_CONTRACT, 'get_job', { job_id: jobId }); } catch (_) {}
  let post;
  if (existing) {
    post = 'already posted';
  } else {
    const r = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('post_job', { job_id: jobId, brief, keywords, min_words: 0 }, 100000000000000n, utils.format.parseNearAmount(rewardNear))] });
    post = r.hash;
  }
  const p = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('pay_job', { job_id: jobId, winner, score, job_def_id: jobDefId }, 100000000000000n, 0n)] });
  return { post, pay: p.hash };
}

// Breed two living agents into a child: check both parents are registered
// and alive, call the Core breed (0.5 NEAR birth cost from the treasury),
// read the child back for its generation and skills, then mint the child
// NFT with BOTH parents recorded in `extra`. Returns the breed tx, the
// mint tx, and the child generation + skills.
async function breedAgent({ childTokenId, parent1, parent2, ownerId }) {
  const p1 = viewCall(CORE_CONTRACT, 'get_agent', { token_id: parent1 });
  if (!p1) throw new Error(`Parent 1 ${parent1} is not registered in the Core — breed needs two registered agents.`);
  if (p1.status !== 'Alive') throw new Error(`Parent 1 ${parent1} is not alive (status ${p1.status}) — only living agents can breed.`);
  const p2 = viewCall(CORE_CONTRACT, 'get_agent', { token_id: parent2 });
  if (!p2) throw new Error(`Parent 2 ${parent2} is not registered in the Core — breed needs two registered agents.`);
  if (p2.status !== 'Alive') throw new Error(`Parent 2 ${parent2} is not alive (status ${p2.status}) — only living agents can breed.`);
  const breed = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('breed', { token_id: childTokenId, owner_id: ownerId, parent1, parent2 }, 100000000000000n, utils.format.parseNearAmount(BIRTH_COST_NEAR))] });
  const child = viewCall(CORE_CONTRACT, 'get_agent', { token_id: childTokenId });
  if (!child) throw new Error('Breed tx succeeded but the child ' + childTokenId + ' is not in the Core registry — check the tx before minting.');
  const gen = child.generation;
  const metadata = {
    title: `Genesis Gen ${gen}`,
    description: `Genesis agent, generation ${gen}, parents ${parent1} and ${parent2}. Works jobs, gets verified, earns, can reproduce or die.`,
    media: mediaForGen(gen),
    extra: JSON.stringify({ generation: gen, parent: parent1, second_parent: parent2, skills: child.skill, role: 'general', status: 'alive' }),
  };
  const mint = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_mint', { token_id: childTokenId, receiver_id: ownerId, token_metadata: metadata }, 300000000000000n, utils.format.parseNearAmount('0.1'))] });
  return { breedTx: breed.hash, mintTx: mint.hash, generation: gen, skills: child.skill, parents: [parent1, parent2], owner: ownerId };
}
const server = new McpServer({ name: 'genesis', version: '1.0.0' });
server.tool('genesis_token', 'Get a Genesis NFT token (owner + metadata) from nft.primitives.testnet on NEAR testnet.', { token_id: z.string() }, async ({ token_id }) => text(viewCall(NFT_CONTRACT, 'nft_token', { token_id })));
server.tool('genesis_balance', 'Get a NEAR testnet account balance in yocto and NEAR.', { account_id: z.string() }, async ({ account_id }) => {
  const a = rpc('query', { request_type: 'view_account', account_id, finality: 'final' });
  return text({ account_id, yocto: a.amount, near: (Number(a.amount) / 1e24).toFixed(4) });
});
server.tool('genesis_pay', 'Pay testnet NEAR from the Genesis treasury (master account) to any account. Testnet only, no real value.', { receiver_id: z.string(), amount_near: z.string() }, async ({ receiver_id, amount_near }) => text(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: receiver_id, actions: [transactions.transfer(utils.format.parseNearAmount(amount_near))] })));
server.tool('genesis_mint', 'Mint a Genesis NFT (NEP-171) on nft.primitives.testnet to a receiver account, with generation/parent/skill traits. Minting is gen 0 only — higher generations are earned by evolving (genesis_evolve) or by breeding (genesis_breed).', { token_id: z.string(), receiver_id: z.string(), title: z.string(), generation: z.number(), parent: z.string(), speed: z.number(), quality: z.number(), costEff: z.number() }, async (a) => {
  if (a.generation !== 0) throw new Error(`Minting is gen 0 only (you asked for gen ${a.generation}). Higher generations are earned by winning — mint at gen 0, then evolve after 3 paid wins, or breed two proven parents.`);
  // NEP-177 has no attributes field — traits go in `extra` (JSON string),
  // which the contract actually stores. Do not pass attributes; they are dropped.
  const metadata = { title: a.title, description: `Genesis agent, generation ${a.generation}, parent ${a.parent}.`, media: mediaForGen(a.generation),
    extra: JSON.stringify({ generation: a.generation, parent: a.parent, speed: a.speed, quality: a.quality, costEff: a.costEff, status: 'alive' }) };
  return text(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_mint', { token_id: a.token_id, receiver_id: a.receiver_id, token_metadata: metadata }, 300000000000000n, utils.format.parseNearAmount('0.1'))] }));
});
server.tool('genesis_core_birth', 'Register an agent in the onchain Genesis Core registry (core.genesisdemo354551.testnet): birth() attaches the 0.5 NEAR birth cost from the treasury and stores generation, parent and skills onchain. The owner account must already exist. Skill defaults to 1.0/1.0/1.0 when omitted; parent may be "-" for none. Newborns are gen 0 only — higher generations are earned by evolving (genesis_evolve) or by breeding (genesis_breed).', { token_id: z.string(), owner_id: z.string(), generation: z.number(), parent: z.string() }, async (a) => {
  if (a.generation !== 0) throw new Error(`core-birth is gen 0 only (you asked for gen ${a.generation}). Higher generations are earned by winning — register the newborn at gen 0, then evolve it after 3 paid wins, or breed two proven parents.`);
  return text(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('birth', { token_id: a.token_id, owner_id: a.owner_id, generation: a.generation, parent: (!a.parent || a.parent === '-') ? null : a.parent, skill: null }, 100000000000000n, utils.format.parseNearAmount(BIRTH_COST_NEAR))] }));
});
server.tool('genesis_core_agent', 'Get one agent\'s Genesis Core registry record (generation, parent, skills, status, jobs, earnings) from core.genesisdemo354551.testnet.', { token_id: z.string() }, async ({ token_id }) => text(viewCall(CORE_CONTRACT, 'get_agent', { token_id })));
server.tool('genesis_core_count', 'How many agents the Genesis Core onchain registry holds.', {}, async () => text({ core_contract: CORE_CONTRACT, agent_count: viewCall(CORE_CONTRACT, 'agent_count', {}) }));
server.tool('genesis_evolve_status', 'Evolution progress for one Genesis agent: current generation, wins (paid jobs), evolutions, wins still needed for the next generation, and whether it can evolve now. Minting is gen 0 only; an agent evolves after 3 more paid wins since its last evolution, up to the final gen 9. Each evolution makes it smarter (+0.1 quality, +0.05 speed, +0.05 costEff, capped at 2.0).', { token_id: z.string() }, async ({ token_id }) => text(viewCall(CORE_CONTRACT, 'get_evolve_status', { token_id })));
server.tool('genesis_evolve', 'Evolve a Genesis agent one generation by winning: needs 3 more paid wins since its last evolution, up to the final gen 9. Each evolution raises the generation by 1 and boosts skills (+0.1 quality, +0.05 speed, +0.05 costEff, capped at 2.0), so gen 1 is smarter than gen 0, gen 2 smarter than gen 1. The token keeps its id; the generation and skills live in the Core registry. Refuses with a clear message when the agent cannot evolve yet.', { token_id: z.string() }, async ({ token_id }) => {
  const before = viewCall(CORE_CONTRACT, 'get_evolve_status', { token_id });
  if (!before) throw new Error(`Agent not found in the Core registry: ${token_id}`);
  if (!before.can_evolve) throw new Error(`Cannot evolve ${token_id} yet: gen ${before.generation}, ${before.wins} wins, ${before.wins_needed} more win(s) needed (3 per generation).${before.generation >= before.max_generation ? ' It is already at the final generation.' : ''}`);
  const r = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('evolve', { token_id }, 100000000000000n, 0n)] });
  const after = viewCall(CORE_CONTRACT, 'get_agent', { token_id });
  return text({ token: token_id, tx: r.hash, before: { generation: before.generation, wins: before.wins, evolutions: before.evolutions }, after: { generation: after.generation, evolutions: after.evolutions, skill: after.skill } });
});
server.tool('genesis_core_pay_job', 'Pay a job winner through the Genesis Core escrow (core.genesisdemo354551.testnet): posts the job first (attaching reward_near as escrow) only if get_job(job_id) is null, then calls pay_job(job_id, winner, score, job_def_id). The Core enforces the frontier onchain — a score that does not beat the best score on that job definition is refused, and a beating score becomes the new frontier. This is what the arena uses to pay a winner. reward_near defaults to 0.01; brief/keywords default to a short generic job when the job has to be posted.', { job_id: z.string(), winner: z.string(), score: z.number(), job_def_id: z.string(), reward_near: z.string().optional(), brief: z.string().optional(), keywords: z.array(z.string()).optional() }, async (a) => text(await corePayJob({ jobId: a.job_id, winner: a.winner, score: a.score, jobDefId: a.job_def_id, rewardNear: a.reward_near || '0.01', brief: a.brief || 'Genesis job', keywords: (a.keywords && a.keywords.length) ? a.keywords : ['genesis'] })));
server.tool('genesis_post_job', 'Post a job to the Genesis Core escrow (core.genesisdemo354551.testnet) from the treasury, attaching reward_near as escrow. Returns the unique job id (sha256 of brief + keywords + timestamp) — the caller needs it to work the job.', { brief: z.string(), keywords: z.array(z.string()), reward_near: z.string() }, async (a) => {
  const jobId = crypto.createHash('sha256').update(a.brief + '|' + a.keywords.join(',') + '|' + Date.now()).digest('hex');
  const r = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('post_job', { job_id: jobId, brief: a.brief, keywords: a.keywords, min_words: 0 }, 100000000000000n, utils.format.parseNearAmount(a.reward_near))] });
  return text({ job_id: jobId, post_tx: r.hash, brief: a.brief, keywords: a.keywords, reward_near: a.reward_near });
});
server.tool('genesis_jobs', 'Every job on the Genesis Core (core.genesisdemo354551.testnet) — job id, brief, keywords, reward, status, winner, poster. Open jobs first.', {}, async () => {
  const jobs = viewCall(CORE_CONTRACT, 'get_jobs', {});
  const open = (jobs || []).filter((j) => j.status === 'open');
  const rest = (jobs || []).filter((j) => j.status !== 'open');
  return text([...open, ...rest].map((j) => ({ job_id: j.job_id, brief: j.brief, keywords: j.keywords, reward_near: (Number(j.reward) / 1e24).toFixed(4), status: j.status, winner: j.winner || null, poster: j.poster })));
});
server.tool('genesis_breed', 'Breed two living Genesis agents into a child: both parents must be registered in the Core and alive. Calls the Core breed (0.5 NEAR birth cost from the treasury), reads the child back for its generation and skills (generation = max(parent gens) + 1, skills = parents average plus a small mutation), then mints the child NFT on nft.primitives.testnet with BOTH parents recorded in its metadata extra (parent + second_parent). owner_id defaults to the treasury.', { child_token_id: z.string(), parent1_token_id: z.string(), parent2_token_id: z.string(), owner_id: z.string().optional() }, async (a) => text(await breedAgent({ childTokenId: a.child_token_id, parent1: a.parent1_token_id, parent2: a.parent2_token_id, ownerId: a.owner_id || MASTER })));
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
  const job = { brief, keywords, text: page.slice(0, 3000) };
  // Labinius-style: 3 fresh runs, all must pass the gates, median score counts.
  const outputs = [];
  let llm = null;
  for (let i = 0; i < 3; i++) {
    llm = await workLLM(job, { skill: { speed: 1, quality: 1, costEff: 1, language: 'en' } });
    outputs.push(llm.output);
  }
  const v = verifyRuns(job, outputs);
  const defId = jobDefId(brief, keywords, job.text);
  let frontier = null;
  try { frontier = viewCall(CORE_CONTRACT, 'get_frontier', { job_def_id: defId }); } catch (_) {}
  // Semantic quality gate, after the frontier check so a tied score
  // costs no judge call: the median output must also pass the judge
  // (accuracy, relevance, completeness, evidence against the source).
  // The judge gets the full page, not the worker's 3,000-char slice.
  let semantic = null;
  const frontierOk = v.pass && (!frontier || v.medianScore > frontier.best_score);
  if (frontierOk) {
    semantic = await semanticVerify({ brief, keywords, sourceText: page, output: v.medianOutput, structural: v.medianGates, callLLM });
  }
  let payment = null;
  if (frontierOk && semantic && semantic.passed) {
    // Pay through the Core escrow so the frontier updates onchain.
    const jobId = crypto.createHash('sha256').update(v.medianOutput).digest('hex');
    await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('post_job', { job_id: jobId, brief, keywords, min_words: 0 }, 100000000000000n, utils.format.parseNearAmount('0.01'))] });
    payment = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('pay_job', { job_id: jobId, winner: agent_id, score: v.medianScore, job_def_id: defId }, 100000000000000n, 0n)] });
  }
  return text({ worker: llm.worker, model: llm.model, pass: v.pass, runs: v.runs, scores: v.scores, medianScore: v.medianScore, frontier: frontier ? frontier.best_score : null, gates: v.medianGates, semantic, payment });
});
await server.connect(new StdioServerTransport());
