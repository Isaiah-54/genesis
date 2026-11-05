// Test the NEAR AI Cloud route in src/worker-llm.js (Route 0).
// Spawns test/near-ai-fake-server.cjs as its OWN process (it must not
// share this process: the worker calls curl via execSync, which blocks
// this process's event loop, so a server in the same process could never
// answer while the worker waits for it). The fake server implements:
//   GET  /v1/attestation/report?model=...&signing_algo=ecdsa&nonce=...
//        -> gateway_attestation + model_attestations, echoing the nonce
//   POST /v1/chat/completions -> an OpenAI-compatible completion
//        (optionally carrying a gateway_attestation field)
// The worker is pointed at the local server via NEAR_AI_API_URL, so no
// real key and no real NEAR AI call is needed. The fake attestation
// values are clearly fake ("fake-intel-quote-...") — they only prove the
// worker captures and returns whatever evidence the API returns.
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { workLLM } = require('../src/worker-llm');

const JOB = {
  brief: 'NEAR NFTs global contract mint',
  keywords: ['near', 'nft', 'mint'],
  text: 'NEAR has a shared NFT contract that anyone can mint on. The testnet contract is nft.primitives.testnet. To mint, call nft_mint with a token id, a receiver id, and token metadata including title, description and media. A deposit covers storage. NFTs on NEAR follow the NEP-177 standard with metadata under NEP-177. The contract is shared, so many projects use the same contract and their tokens are all visible in one place.',
};
const AGENT = { skill: { speed: 1, quality: 1, costEff: 1, language: 'en' } };
const FAKE_SUMMARY = 'Anyone can mint a new NFT on the NEAR blockchain using the shared contract, and the resulting token is recorded in the caller\'s wallet for later use. Creating that token means sending an identifier, a destination account, and a small set of descriptive fields to the shared contract, while a storage deposit pays for the data the chain keeps. Because every token follows the public NEP-171 interface, wallets and marketplaces can recognise it without any custom integration code.';

let child = null;

async function setControl(base, flags) {
  const res = await fetch(base + '/__test/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flags),
  });
  if (!res.ok) throw new Error('control endpoint failed: ' + res.status);
}

async function getControl(base) {
  const res = await fetch(base + '/__test/control');
  if (!res.ok) throw new Error('control endpoint failed: ' + res.status);
  return res.json();
}

async function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, 'near-ai-fake-server.cjs'), '0'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('fake server did not start')), 15000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/LISTENING (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(parseInt(m[1], 10));
      }
    });
    child.on('exit', (code) => reject(new Error('fake server exited: ' + code)));
  });
}

(async () => {
  const port = await startServer();
  const base = `http://127.0.0.1:${port}/v1`;
  // The control endpoint lives at the server root, not under /v1.
  const controlBase = `http://127.0.0.1:${port}`;
  try {
    // 1. NEAR AI route: preflight evidence is fetched and captured, the
    //    completion is used, verifiable is true, provider is near-ai.
    process.env.NEAR_AI_API_KEY = 'sk-test-fake-key';
    process.env.NEAR_AI_MODEL = 'z-ai/glm-5.3-flash';
    process.env.NEAR_AI_API_URL = base;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    await setControl(controlBase, { attestationShouldFail: false, completionCarriesAttestation: false });
    let r = await workLLM(JOB, AGENT);
    assert.strictEqual(r.provider, 'near-ai', 'provider is not near-ai');
    assert.strictEqual(r.verifiable, true, 'verifiable is not true');
    assert.strictEqual(r.model, 'z-ai/glm-5.3-flash');
    assert.strictEqual(r.worker, 'llm');
    assert.strictEqual(r.output, FAKE_SUMMARY);
    assert.ok(r.attestation, 'attestation not captured');
    assert.ok(r.attestation.gateway_attestation, 'gateway attestation missing');
    assert.match(r.attestation.gateway_attestation.intel_quote, /^fake-intel-quote-gateway-/);
    assert.ok(Array.isArray(r.attestation.model_attestations) && r.attestation.model_attestations.length === 1, 'model attestations missing');
    assert.match(r.attestation.model_attestations[0].intel_quote, /^fake-intel-quote-model-/);
    assert.strictEqual(r.attestation.model_attestations[0].signing_address, 'fake-model-signing-address');
    assert.strictEqual(r.attestation.nonce.length, 64, 'nonce is not 64 hex chars');
    assert.strictEqual(r.attestation.gateway_attestation.request_nonce, r.attestation.nonce, 'gateway nonce echo mismatch');
    assert.strictEqual(r.chat_id, 'fake-chat-id-123');
    // The completion itself was sent with x-no-aliasing: true (the
    // gateway must never substitute a different model).
    const st = await getControl(controlBase);
    assert.strictEqual(st.lastCompletionNoAliasing, true, 'completion was not sent with x-no-aliasing: true');
    console.log('1. NEAR AI route: evidence captured, verifiable:true, provider near-ai: ok');

    // 1b. With NEAR_AI_MODEL unset, the default model is used
    // (z-ai/glm-5.3-flash — the current Confidential TEE GLM model).
    delete process.env.NEAR_AI_MODEL;
    r = await workLLM(JOB, AGENT);
    assert.strictEqual(r.provider, 'near-ai');
    assert.strictEqual(r.verifiable, true);
    assert.strictEqual(r.model, 'z-ai/glm-5.3-flash', 'default model is not z-ai/glm-5.3-flash');
    assert.ok(r.attestation, 'attestation not captured for the default model');
    console.log('1b. default model (NEAR_AI_MODEL unset) is z-ai/glm-5.3-flash: ok');
    process.env.NEAR_AI_MODEL = 'z-ai/glm-5.3-flash';

    // 2. Preflight evidence fails but the completion response carries a
    //    gateway_attestation: the worker still returns the output with
    //    verifiable:true and the response-carried attestation.
    await setControl(controlBase, { attestationShouldFail: true, completionCarriesAttestation: true });
    r = await workLLM(JOB, AGENT);
    assert.strictEqual(r.provider, 'near-ai');
    assert.strictEqual(r.verifiable, true);
    assert.strictEqual(r.output, FAKE_SUMMARY);
    assert.ok(r.attestation, 'response-carried attestation not captured');
    assert.strictEqual(r.attestation.response.intel_quote, 'fake-intel-quote-response');
    console.log('2. preflight fails, response carries attestation: captured from the response: ok');

    // 3. Without NEAR_AI_API_KEY the worker falls through to the existing
    //    routes and does NOT claim verifiable:true. (Pointed at the local
    //    server via the configured-endpoint route so the test stays fast
    //    and does not depend on the public Pollinations API.)
    await setControl(controlBase, { attestationShouldFail: false, completionCarriesAttestation: false });
    delete process.env.NEAR_AI_API_KEY;
    delete process.env.NEAR_AI_MODEL;
    delete process.env.NEAR_AI_API_URL;
    process.env.LLM_API_URL = base;
    process.env.LLM_API_KEY = 'sk-test-fake-key';
    process.env.LLM_MODEL = 'test-model';
    r = await workLLM(JOB, AGENT);
    assert.notStrictEqual(r.verifiable, true, 'fall-through route claimed verifiable:true');
    assert.strictEqual(r.verifiable, false);
    assert.strictEqual(r.provider, base);
    assert.strictEqual(r.output, FAKE_SUMMARY);
    console.log('3. without NEAR_AI_API_KEY: falls through, does not claim verifiable:true: ok');

    console.log('worker-near-ai: all 4 scenarios pass');
  } finally {
    child.kill();
  }
})().catch((e) => {
  console.error('FAILED', e);
  try { if (child) child.kill(); } catch (_) {}
  process.exit(1);
});
