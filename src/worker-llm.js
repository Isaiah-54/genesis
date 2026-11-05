// Genesis LLM worker — a REAL model call, with an honestly labelled fallback.
// How it picks a model, in order:
//  0. NEAR AI Cloud (verifiable inference) — if NEAR_AI_API_KEY is set
//     (sk-..., created in the Developer Dashboard at cloud.near.ai → API
//     Keys). Base URL https://cloud-api.near.ai/v1 (override with
//     NEAR_AI_API_URL, e.g. for tests); model from NEAR_AI_MODEL, default
//     z-ai/glm-5.3-flash — the current Confidential TEE GLM model in the
//     live catalog (verified 2026-11-05). The docs' quickstart example,
//     zai-org/GLM-5.1-FP8, is NOT in the live catalog any more, so it is
//     not the default. Calls /chat/completions with the x-no-aliasing:
//     true header so the gateway never substitutes a different model.
//     Before the completion it fetches the attestation evidence (GET
//     /v1/attestation/report?model=...&signing_algo=ecdsa&nonce=...) and
//     keeps it in the result; the completion response itself does not
//     carry the attestation in its JSON body. The evidence is an Intel
//     TDX quote (intel_quote) + NVIDIA GPU evidence (nvidia_payload)
//     bound to a client-generated nonce — verify it with an Intel DCAP
//     quote verifier (dcap-qvl) or the NEAR AI Cloud Verifier
//     (github.com/near-examples/nearai-cloud-verification-example).
//     See docs/NEAR_AI.md. If the NEAR AI call fails, it logs and falls
//     through to the routes below (never fails the job).
//  1. If LLM_API_URL + LLM_API_KEY + LLM_MODEL are set in the environment
//     (e.g. an OpenAI-compatible endpoint), it calls that endpoint's
//     /chat/completions API. Keys come from the environment only and are
//     never written to any file in this repo.
//  2. Otherwise it calls the public, no-key Pollinations text API
//     (https://text.pollinations.ai/), which serves open models.
//  3. If both fail, it falls back to the repo's extractive summariser —
//     and the result is labelled worker: 'extractive-fallback', NEVER 'llm'.
// Every job result carries its worker type and model, so a verifier, a
// judge, or a hirer can tell a model-written job from a summarised one.
// Results also carry verifiable (true only for the NEAR AI route) and
// attestation (the TEE evidence, or null) — existing callers only read
// output/worker/model, so these are extras.
// Usage: const { workLLM } = require('./worker-llm');
//        const r = await workLLM(job, agent); // { output, worker, model }
const { execSync } = require('child_process');
const crypto = require('crypto');
const { work } = require('./engine');
function postJson(url, body, headers) {
  const payload = JSON.stringify(body).replace(/'/g, `'\\''`);
  const headerArgs = Object.entries(headers || {}).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
  const out = execSync(`curl -s -m 120 ${url} -H 'Content-Type: application/json' ${headerArgs} -d '${payload}'`, { maxBuffer: 4 * 1024 * 1024 });
  return out.toString();
}
function getJson(url, headers) {
  const headerArgs = Object.entries(headers || {}).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
  // The URL is single-quoted: the attestation URL carries a query string
  // and its & must not reach the shell.
  const out = execSync(`curl -s -m 60 '${url}' ${headerArgs}`, { maxBuffer: 4 * 1024 * 1024 });
  return out.toString();
}
function promptFor(job, quality) {
  // The agent's quality shapes the brief, so a higher generation is
  // genuinely smarter: a gen 1 agent (quality 1.1) gets a more thorough
  // brief than a gen 0 (quality 1.0), and a gen 9 (quality ~1.9) gets
  // the most thorough one. The verifier gates do not change — a smarter
  // agent does not get an easier pass, it gets a better brief.
  const q = typeof quality === 'number' && quality > 0 ? quality : 1.0;
  const thoroughness = q >= 1.8
    ? ' Write a thorough, well-structured summary: cover every keyword in depth, with a clear sentence for each, and make the summary complete and precise.'
    : q >= 1.4
      ? ' Write a detailed summary: cover every keyword fully, in its own full sentence, and keep the summary organised.'
      : q >= 1.1
        ? ' Write a clear summary: cover every keyword in its own full sentence, with a little more detail than the minimum.'
        : '';
  return [
    { role: 'system', content: 'You are a Genesis agent. Write a clear summary of the job text that answers the brief. Use plain language. Cover every one of these keywords, each inside a full sentence of its own: ' + job.keywords.join(', ') + '. Write in your own words — do not copy sentences from the text. Write at least three sentences. Do not add facts that are not in the text. Do not mention that you are an AI.' + thoroughness + (job.angle ? ' Angle for this entry: ' + job.angle : '') },
    { role: 'user', content: 'Brief: ' + job.brief + '\n\nText:\n' + job.text.slice(0, 4000) },
  ];
}

// Max tokens for the LLM call, scaled by the agent's quality so a
// smarter agent can write a longer, more thorough summary. Gen 0
// (quality 1.0) gets 800; gen 9 (quality ~1.9) gets ~1520.
function maxTokensFor(quality) {
  const q = typeof quality === 'number' && quality > 0 ? quality : 1.0;
  return Math.round(800 * Math.min(q, 2.0));
}

// NEAR AI Cloud (Route 0). Env vars are read at call time, not at module
// load, so a test can set them after requiring this module.
// Returns null when NEAR_AI_API_KEY is not set (caller falls through);
// throws when the key is set but the call fails (caller logs and falls
// through). On success returns { output, worker, model, provider,
// verifiable, attestation, chat_id }.
async function workNearAI(messages, maxTokens) {
  const apiKey = process.env.NEAR_AI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.NEAR_AI_MODEL || 'z-ai/glm-5.3-flash';
  const base = (process.env.NEAR_AI_API_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, '');
  // Preflight: fetch the attestation evidence for this model BEFORE the
  // completion (the docs: a report fetched after the completion cannot
  // replace preflight evidence). The nonce is 32 random bytes as 64 hex
  // characters; the evidence echoes it back (replay protection).
  let attestation = null;
  try {
    const nonce = crypto.randomBytes(32).toString('hex');
    const evidenceUrl = base + '/attestation/report?model=' + encodeURIComponent(model)
      + '&signing_algo=ecdsa&nonce=' + nonce;
    const ev = JSON.parse(getJson(evidenceUrl, {
      Authorization: 'Bearer ' + apiKey,
      'x-no-aliasing': 'true',
    }));
    // Trust the evidence only if it echoes our nonce — in the gateway
    // report and/or the first model report. If neither echoes it, the
    // evidence is not bound to our request: keep attestation null rather
    // than holding proof we cannot tie to this call.
    if (!ev.gateway_attestation && !ev.model_attestations) {
      console.error('NEAR AI attestation evidence returned no report — continuing without it');
    } else {
      const gatewayNonce = ev.gateway_attestation && ev.gateway_attestation.request_nonce;
      const modelNonce = ev.model_attestations && ev.model_attestations[0] && ev.model_attestations[0].request_nonce;
      if (gatewayNonce === nonce || modelNonce === nonce) {
        attestation = {
          nonce,
          gateway_attestation: ev.gateway_attestation || null,
          model_attestations: ev.model_attestations || null,
        };
      } else {
        console.error('NEAR AI attestation nonce mismatch — evidence not trusted, continuing without it');
      }
    }
  } catch (e) {
    console.error('NEAR AI attestation evidence fetch failed, continuing without it:', e.message.slice(0, 200));
  }
  // The completion. x-no-aliasing stops the gateway substituting a
  // different model for the one requested.
  const raw = postJson(base + '/chat/completions',
    { model, messages, temperature: 0.3, max_tokens: maxTokens },
    { Authorization: 'Bearer ' + apiKey, 'x-no-aliasing': 'true' });
  const j = JSON.parse(raw);
  const output = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
  if (output.length <= 20) throw new Error('Empty model output');
  // The standard completion response does not carry the attestation in
  // its JSON body — the evidence comes from the preflight request above.
  // Keep the field if a future response includes one.
  const responseAttestation = j.gateway_attestation || j.model_attestations || j.attestation || null;
  return {
    output,
    worker: 'llm',
    model,
    provider: 'near-ai',
    verifiable: true,
    attestation: attestation || (responseAttestation ? { response: responseAttestation } : null),
    chat_id: j.id || null,
  };
}
async function workLLM(job, agent) {
  const quality = agent && agent.skill && typeof agent.skill.quality === 'number' ? agent.skill.quality : 1.0;
  const messages = promptFor(job, quality);
  const maxTokens = maxTokensFor(quality);
  // Route 0: NEAR AI Cloud (verifiable inference). On any failure, log
  // and fall through to the existing routes — never fail the job.
  try {
    const near = await workNearAI(messages, maxTokens);
    if (near) return near;
  } catch (e) { console.error('NEAR AI failed, trying configured endpoint:', e.message.slice(0, 200)); }
  // Route 1: configured OpenAI-compatible endpoint
  if (process.env.LLM_API_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL) {
    try {
      const raw = postJson(process.env.LLM_API_URL.replace(/\/$/, '') + '/chat/completions',
        { model: process.env.LLM_MODEL, messages, temperature: 0.3, max_tokens: maxTokens },
        { Authorization: 'Bearer ' + process.env.LLM_API_KEY });
      const j = JSON.parse(raw);
      const output = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
      if (output.length > 20) return { output, worker: 'llm', model: process.env.LLM_MODEL, provider: process.env.LLM_API_URL, verifiable: false, attestation: null };
      throw new Error('Empty model output');
    } catch (e) { console.error('Configured LLM failed, trying public endpoint:', e.message.slice(0, 200)); }
  }
  // Route 2: public Pollinations text API (no key). GET, not POST: the POST
  // route timed out on a large job payload from this host, while GET answers
  // in seconds. One retry, then the honest fallback.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const prompt = messages.map(m => m.role + ': ' + m.content).join('\n\n');
      const url = 'https://text.pollinations.ai/' + encodeURIComponent(prompt);
      const raw = execSync(`curl -s -m 90 '${url}'`, { maxBuffer: 4 * 1024 * 1024 }).toString().trim();
      if (raw.length > 20 && !raw.startsWith('{')) return { output: raw, worker: 'llm', model: 'openai (pollinations)', provider: 'https://text.pollinations.ai/', verifiable: false, attestation: null };
      throw new Error('Unexpected public endpoint output');
    } catch (e) { console.error(`Public LLM attempt ${attempt} failed:`, e.message.slice(0, 120)); }
  }
  console.error('Public LLM failed, falling back to extractive summariser');
  // Route 3: honest fallback — labelled, never claimed as LLM
  return { output: work(job, agent), worker: 'extractive-fallback', model: 'extractive summariser (repo code)', provider: 'local', verifiable: false, attestation: null };
}
module.exports = { workLLM };
