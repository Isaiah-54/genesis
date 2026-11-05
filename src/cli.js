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
const crypto = require('crypto');
const { execSync } = require('child_process');
const { keyStores, KeyPair, transactions, utils, InMemorySigner } = require('near-api-js');
const { work, verify, verifyStrict, jobDefId, verifyRuns } = require('./engine');
const { workLLM, callLLM } = require('./worker-llm');
const { semanticVerify } = require('./semantic-verify');
const { mediaForGen } = require('./nft-media.js');
const MASTER = 'genesisdemo354551.testnet';
const NFT_CONTRACT = 'nft.primitives.testnet';
const CORE_CONTRACT = 'core.genesisdemo354551.testnet';
const BIRTH_COST_NEAR = '0.5';
const TOKENS = ['genesis-gen-0', 'genesis-gen-1', 'genesis-gen-2', 'genesis-gen-3', 'genesis-weak-2', 'genesis-gen-5-weak'];
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
// Post a job to the Core escrow (only if it is not already posted) and
// pay it to a winner. The Core enforces the frontier: pay_job panics
// when the score does not beat the best score on that job definition,
// and records the new frontier when it does. Returns { post, pay } where
// post is the post tx hash, 'already posted', or 'dry-run', and pay is
// the pay tx hash or 'dry-run'. This is what the arena uses to pay a
// winner through the Core escrow instead of a direct treasury transfer.
async function corePayJob({ jobId, winner, score, jobDefId, rewardNear, brief, keywords, dryRun }) {
  let existing = null;
  try { existing = viewCall(CORE_CONTRACT, 'get_job', { job_id: jobId }); } catch (_) {}
  let post;
  if (existing) {
    post = 'already posted';
    console.log('Job', jobId.slice(0, 12) + '…', 'already onchain (status', existing.status + ') — skipping post_job.');
  } else {
    const r = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('post_job', { job_id: jobId, brief, keywords, min_words: 0 }, 100000000000000n, utils.format.parseNearAmount(rewardNear))], dryRun, label: 'post job ' + jobId.slice(0, 12) });
    post = dryRun ? 'dry-run' : r.hash;
    console.log('post_job:', post);
  }
  const p = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('pay_job', { job_id: jobId, winner, score, job_def_id: jobDefId }, 100000000000000n, 0n)], dryRun, label: 'pay job to ' + winner });
  const pay = dryRun ? 'dry-run' : p.hash;
  console.log('pay_job:', pay);
  return { post, pay };
}

// Breed two living agents into a child: check both parents are registered
// and alive, call the Core breed (0.5 NEAR birth cost from the treasury),
// read the child back for its generation and skills, then mint the child
// NFT with BOTH parents recorded in `extra`. Returns the breed tx, the
// mint tx, and the child generation + skills.
async function breedAgent({ childTokenId, parent1, parent2, ownerId, dryRun }) {
  const p1 = viewCall(CORE_CONTRACT, 'get_agent', { token_id: parent1 });
  if (!p1) throw new Error(`Parent 1 ${parent1} is not registered in the Core — breed needs two registered agents.`);
  if (p1.status !== 'Alive') throw new Error(`Parent 1 ${parent1} is not alive (status ${p1.status}) — only living agents can breed.`);
  const p2 = viewCall(CORE_CONTRACT, 'get_agent', { token_id: parent2 });
  if (!p2) throw new Error(`Parent 2 ${parent2} is not registered in the Core — breed needs two registered agents.`);
  if (p2.status !== 'Alive') throw new Error(`Parent 2 ${parent2} is not alive (status ${p2.status}) — only living agents can breed.`);
  const breed = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('breed', { token_id: childTokenId, owner_id: ownerId, parent1, parent2 }, 100000000000000n, utils.format.parseNearAmount(BIRTH_COST_NEAR))], dryRun, label: 'breed ' + childTokenId });
  const breedTx = dryRun ? 'dry-run' : breed.hash;
  console.log('breed tx:', breedTx);
  // Read the child back: the Core sets generation = max(parent gens) + 1
  // and skills = the parents' average plus a small mutation.
  let child;
  if (dryRun) {
    // Nothing was broadcast, so the child does not exist yet: show the
    // expected values (plain average; the onchain child adds a small
    // mutation from the block timestamp).
    const gen = Math.max(p1.generation, p2.generation) + 1;
    const avg = (f) => +(((p1.skill[f] + p2.skill[f]) / 2).toFixed(2));
    child = { generation: gen, skill: { speed: avg('speed'), quality: avg('quality'), cost_eff: avg('cost_eff') } };
    console.log('Child (expected, dry-run): generation', gen, '| skills', JSON.stringify(child.skill), '(the onchain child adds a small mutation)');
  } else {
    child = viewCall(CORE_CONTRACT, 'get_agent', { token_id: childTokenId });
    if (!child) throw new Error('Breed tx succeeded but the child ' + childTokenId + ' is not in the Core registry — check the tx before minting.');
  }
  const gen = child.generation;
  const metadata = {
    title: `Genesis Gen ${gen}`,
    description: `Genesis agent, generation ${gen}, parents ${parent1} and ${parent2}. Works jobs, gets verified, earns, can reproduce or die.`,
    media: mediaForGen(gen),
    extra: JSON.stringify({ generation: gen, parent: parent1, second_parent: parent2, skills: child.skill, role: 'general', status: 'alive' }),
  };
  const mint = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_mint', { token_id: childTokenId, receiver_id: ownerId, token_metadata: metadata }, 300000000000000n, utils.format.parseNearAmount('0.1'))], dryRun, label: 'mint ' + childTokenId });
  const mintTx = dryRun ? 'dry-run' : mint.hash;
  console.log('mint tx:', mintTx);
  console.log('Child:', childTokenId, '| generation', gen, '| skills', JSON.stringify(child.skill), '| parents', parent1, '+', parent2, '| owner', ownerId);
  return { breedTx, mintTx, generation: gen, skills: child.skill };
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
  mint <token> <receiver> <title> <gen> <parent> [parent2]   Mint a Genesis NFT (parent2 records a second parent, e.g. a bred child)
  core-birth <token> <owner> <gen> <parent|->  Register an agent in the onchain Core registry (0.5 NEAR from treasury)
  core-agent <token>  One agent's Core registry record
  core-count          How many agents the Core registry holds
  core-pay-job <job_id> <winner> <score> <job_def_id> [reward_near] [brief] [keywords]  Pay a winner through the Core escrow (posts the job first if needed; the frontier is checked and updated onchain)
  post-job <brief> <keywords> <reward_near>  Post a job to the Core escrow and print its job id
  jobs                Every job on the Core (open first)
  breed <child> <parent1> <parent2> [owner]  Breed two living agents into a child (0.5 NEAR birth cost) and mint the child NFT with both parents recorded
  pay <receiver> <amount> Pay testnet NEAR from treasury
  transfer-nft <token> <receiver>  Transfer NFT (refuses locked tokens)
  job <agent> <page_url>  Real job: fetch, verify, pay 0.01 on PASS
  Add --dry-run to any write command to preview without broadcasting.`);
    return;
  }
  if (cmd === 'status') {
    console.log('Treasury:', MASTER, balanceOf(MASTER), 'NEAR');
    try { console.log('Core registry:', CORE_CONTRACT, viewCall(CORE_CONTRACT, 'agent_count', {}), 'agents'); } catch { console.log('Core registry:', CORE_CONTRACT, '(unreachable)'); }
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
  if (cmd === 'league') { for (const r of require('./league').standings()) console.log(`${r.agent} (${r.token}): ${r.wins}W-${r.losses}L, win rate ${r.win_rate}, best score ${r.best_score}, arena earnings ${r.arena_earnings}`); return; }
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
    const [, tokenId, receiver, title, gen, parent, parent2] = a;
    // Minting is gen 0 only. A higher generation is EARNED — an agent
    // evolves by winning 3 paid jobs per generation (see `evolve`), or
    // is born by breeding two proven parents (see `breed`). Minting a
    // high gen directly would make generations meaningless.
    if (Number(gen) !== 0) throw new Error(`Minting is gen 0 only (you asked for gen ${gen}). Higher generations are earned by winning — run 'evolve' after 3 paid wins, or 'breed' two proven parents.`);
    const metadata = { title, description: `Genesis agent, generation ${gen}, parent ${parent}${parent2 ? ' and ' + parent2 : ''}.`, media: mediaForGen(gen), extra: JSON.stringify({ generation: gen, parent, ...(parent2 ? { second_parent: parent2 } : {}), status: 'alive' }) };
    console.log(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: NFT_CONTRACT, actions: [transactions.functionCall('nft_mint', { token_id: tokenId, receiver_id: receiver, token_metadata: metadata }, 300000000000000n, utils.format.parseNearAmount('0.1'))], dryRun, label: 'mint ' + tokenId }));
    return;
  }
  if (cmd === 'evolve') {
    // Evolve one generation by winning: needs 3 more paid wins since the
    // last evolution, up to the final gen 9. Each evolution makes the
    // agent smarter (+0.1 quality, +0.05 speed, +0.05 costEff, capped
    // at 2.0). The token keeps its id; the generation and skills live in
    // the Core registry.
    const [, tokenId] = a;
    if (!tokenId) throw new Error('Usage: node src/cli.js evolve <token_id>');
    const before = viewCall(CORE_CONTRACT, 'get_evolve_status', { token_id: tokenId });
    if (!before) throw new Error(`Agent not found in the Core registry: ${tokenId}`);
    if (!before.can_evolve) throw new Error(`Cannot evolve ${tokenId} yet: gen ${before.generation}, ${before.wins} wins, ${before.wins_needed} more win(s) needed (3 per generation).${before.generation >= before.max_generation ? ' It is already at the final generation.' : ''}`);
    const r = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('evolve', { token_id: tokenId }, 100000000000000n, 0n)], dryRun, label: 'evolve ' + tokenId });
    const after = dryRun ? null : viewCall(CORE_CONTRACT, 'get_agent', { token_id: tokenId });
    console.log(JSON.stringify({ token: tokenId, before: { generation: before.generation, wins: before.wins, evolutions: before.evolutions }, tx: dryRun ? 'dry-run' : r.hash, after: after ? { generation: after.generation, evolutions: after.evolutions, skill: after.skill } : 'dry-run — no onchain change' }));
    return;
  }
  if (cmd === 'evolve-status') {
    const [, tokenId] = a;
    if (!tokenId) throw new Error('Usage: node src/cli.js evolve-status <token_id>');
    const s = viewCall(CORE_CONTRACT, 'get_evolve_status', { token_id: tokenId });
    if (!s) { console.log(`Agent not found in the Core registry: ${tokenId}`); return; }
    console.log(`${s.token_id}: gen ${s.generation} (max ${s.max_generation}) | wins ${s.wins} | evolutions ${s.evolutions} | ${s.can_evolve ? 'CAN EVOLVE NOW — run: node src/cli.js evolve ' + s.token_id : s.wins_needed + ' more win(s) to the next generation (' + s.wins_to_evolve + ' wins per generation)'}`);
    return;
  }
  if (cmd === 'core-birth') {
    // Register an agent in the onchain Core registry: birth() attaches the
    // 0.5 NEAR birth cost from the treasury and stores generation, parent
    // and skills onchain. The owner account must already exist (create it
    // with create-agent first). Skill defaults to 1.0/1.0/1.0 when omitted.
    // Newborns are gen 0 only — higher generations are earned by evolving
    // or by breeding (see `evolve` / `breed`).
    const [, tokenId, ownerId, gen, parent] = a;
    if (Number(gen) !== 0) throw new Error(`core-birth is gen 0 only (you asked for gen ${gen}). Higher generations are earned by winning — register the newborn at gen 0, then 'evolve' it after 3 paid wins, or 'breed' two proven parents.`);
    console.log(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('birth', { token_id: tokenId, owner_id: ownerId, generation: Number(gen), parent: (!parent || parent === '-') ? null : parent, skill: null }, 100000000000000n, utils.format.parseNearAmount(BIRTH_COST_NEAR))], dryRun, label: 'core-birth ' + tokenId }));
    return;
  }
  if (cmd === 'core-agent') { console.log(JSON.stringify(viewCall(CORE_CONTRACT, 'get_agent', { token_id: a[1] }), null, 2)); return; }
  if (cmd === 'core-count') { console.log('Core registry agents:', viewCall(CORE_CONTRACT, 'agent_count', {})); return; }
  if (cmd === 'core-pay-job') {
    const [, jobId, winner, score, jobDefId, rewardNear, brief, keywords] = a;
    if (!jobId || !winner || score === undefined || !jobDefId) throw new Error('Usage: node src/cli.js core-pay-job <job_id> <winner> <score> <job_def_id> [reward_near] [brief] [keywords]');
    const r = await corePayJob({ jobId, winner, score: Number(score), jobDefId, rewardNear: rewardNear || '0.01', brief: brief || 'Genesis job', keywords: keywords ? keywords.split(',').map(s => s.trim()).filter(Boolean) : ['genesis'], dryRun });
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === 'post-job') {
    const [, brief, keywords, rewardNear] = a;
    if (!brief || !keywords || !rewardNear) throw new Error('Usage: node src/cli.js post-job <brief> <keywords-comma-separated> <reward_near>');
    const kw = keywords.split(',').map(s => s.trim()).filter(Boolean);
    if (!kw.length) throw new Error('Give at least one keyword, comma separated.');
    // Unique job id: the caller needs it to work the job. Same shape as
    // the job-definition id, plus a timestamp so two identical briefs
    // never collide.
    const jobId = crypto.createHash('sha256').update(brief + '|' + kw.join(',') + '|' + Date.now()).digest('hex');
    const r = await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('post_job', { job_id: jobId, brief, keywords: kw, min_words: 0 }, 100000000000000n, utils.format.parseNearAmount(rewardNear))], dryRun, label: 'post job ' + jobId.slice(0, 12) });
    console.log('job_id:', jobId);
    console.log('post tx:', dryRun ? 'dry-run' : r.hash);
    return;
  }
  if (cmd === 'jobs') {
    const jobs = viewCall(CORE_CONTRACT, 'get_jobs', {});
    if (!jobs || !jobs.length) { console.log('No jobs on the Core yet.'); return; }
    const open = jobs.filter(j => j.status === 'open');
    const rest = jobs.filter(j => j.status !== 'open');
    for (const j of [...open, ...rest]) {
      console.log(`${j.job_id} | [${j.status}] ${String(j.brief || '').slice(0, 60)} | keywords: ${(j.keywords || []).join(', ')} | reward ${(Number(j.reward) / 1e24).toFixed(4)} NEAR | poster ${j.poster} | winner ${j.winner || '-'}`);
    }
    return;
  }
  if (cmd === 'breed') {
    const [, childTokenId, parent1, parent2, ownerId] = a;
    if (!childTokenId || !parent1 || !parent2) throw new Error('Usage: node src/cli.js breed <child_token_id> <parent1_token_id> <parent2_token_id> [owner_id]');
    const r = await breedAgent({ childTokenId, parent1, parent2, ownerId: ownerId || MASTER, dryRun });
    console.log(JSON.stringify(r));
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
    const page = execSync(`curl -s -m 30 ${a[2]} | perl -0777 -pe 's/<script.*?<\\/script>//gs; s/<style.*?<\\/style>//gs' | sed -e 's/<[^>]*>/ /g' | tr -s ' \\n' ' '`, { maxBuffer: 4 * 1024 * 1024 }).toString();
    if (page.length < 500) throw new Error('Fetched page too short for a real job');
    const job = { brief: 'NEAR NFTs global contract mint', keywords: ['near', 'nft', 'mint'], text: page.slice(0, 3000) };
    // The agent's REAL onchain skill (from the Core), not a hardcoded
    // 1.0: a higher generation is genuinely smarter — its quality shapes
    // the worker's brief and token budget. Falls back to 1.0 if the
    // Core read fails (e.g. the token is not registered yet).
    let skill = { speed: 1, quality: 1, cost_eff: 1 };
    try {
      const rec = viewCall(CORE_CONTRACT, 'get_agent', { token_id: a[1] });
      if (rec && rec.skill) skill = rec.skill;
    } catch (_) {}
    // Labinius-style: 3 fresh runs, all must pass the gates, median score counts.
    const outputs = [];
    for (let i = 0; i < 3; i++) {
      const llm = await workLLM(job, { skill: { speed: skill.speed, quality: skill.quality, costEff: skill.cost_eff, language: 'en' } });
      console.log(`Run ${i + 1}/3 — worker:`, llm.worker, '| model:', llm.model, '| quality:', skill.quality);
      outputs.push(llm.output);
    }
    const v = verifyRuns(job, outputs);
    const defId = jobDefId(job.brief, job.keywords, job.text);
    let frontier = null;
    try { frontier = viewCall(CORE_CONTRACT, 'get_frontier', { job_def_id: defId }); } catch (_) {}
    console.log('Output preview:', v.medianOutput.slice(0, 300));
    console.log('Verify:', v.pass ? 'PASS' : 'FAIL',
      '| runs:', v.runs, 'scores:', JSON.stringify(v.scores), '| median score:', v.medianScore,
      '| frontier:', frontier ? frontier.best_score : 'none yet',
      '| gates:', JSON.stringify(v.medianGates));
    if (!v.pass) { console.log('No payment — a run failed verification.'); return; }
    if (frontier && v.medianScore <= frontier.best_score) {
      console.log('No payment — median score', v.medianScore, 'does not beat the frontier', frontier.best_score + '.');
      return;
    }
    // Semantic quality gate: the structural gates cannot tell a
    // beautifully structured lie from a true summary. The judge checks
    // the median output against the source (accuracy, relevance,
    // completeness, evidence); a failure means no payment. It runs
    // after the frontier check so a tied score costs no judge call.
    // The judge gets the full page, not the worker's 3,000-char slice:
    // the facts an answer draws on can live further down the page.
    const sem = await semanticVerify({ brief: job.brief, keywords: job.keywords, sourceText: page, output: v.medianOutput, structural: v.medianGates, callLLM });
    console.log('Semantic:', sem.passed ? 'PASS' : 'FAIL', '| scores:', JSON.stringify(sem.scores), '|', sem.reason);
    if (!sem.passed) { console.log('No payment — semantic verification failed.'); return; }
    // Pay through the Core escrow so the frontier updates onchain:
    // post the job (median output hash is the job id), then settle it.
    // The winner must be the agent's OWNER ACCOUNT (gen3.genesisdemo…),
    // NOT the token id (genesis-gen-3): pay_job transfers the reward to
    // the winner account and credits the win to the agent whose owner
    // matches it. Passing the token id "pays" a non-existent account —
    // the transfer fails, the reward stays in the Core, and the agent
    // gets no win. (This bug bit once on 2026-11-05: a passing job for
    // genesis-gen-3 was paid to the token id, so gen3 got no win and the
    // 0.01 NEAR stayed in the Core.)
    let winner = a[1];
    try {
      const rec = viewCall(CORE_CONTRACT, 'get_agent', { token_id: a[1] });
      if (rec && rec.owner_id) winner = rec.owner_id;
    } catch (_) {}
    const jobId = crypto.createHash('sha256').update(v.medianOutput).digest('hex');
    console.log(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('post_job', { job_id: jobId, brief: job.brief, keywords: job.keywords, min_words: 0 }, 100000000000000n, utils.format.parseNearAmount('0.01'))], dryRun, label: 'post job ' + jobId.slice(0, 12) }));
    console.log(await sendTx({ signerId: MASTER, keyPair: masterKey(), receiverId: CORE_CONTRACT, actions: [transactions.functionCall('pay_job', { job_id: jobId, winner, score: v.medianScore, job_def_id: defId }, 100000000000000n, 0n)], dryRun, label: 'pay job to ' + winner }));
    return;
  }
  throw new Error('Unknown command: ' + cmd + ' — run: node src/cli.js help');
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
