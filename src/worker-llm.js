// Genesis LLM worker — a REAL model call, with an honestly labelled fallback.
// How it picks a model, in order:
//  1. If LLM_API_URL + LLM_API_KEY + LLM_MODEL are set in the environment
//     (e.g. an OpenAI-compatible endpoint, or NEAR AI Cloud), it calls that
//     endpoint's /chat/completions API. Keys come from the environment only
//     and are never written to any file in this repo.
//  2. Otherwise it calls the public, no-key Pollinations text API
//     (https://text.pollinations.ai/), which serves open models.
//  3. If both fail, it falls back to the repo's extractive summariser —
//     and the result is labelled worker: 'extractive-fallback', NEVER 'llm'.
// Every job result carries its worker type and model, so a verifier, a
// judge, or a hirer can tell a model-written job from a summarised one.
// Usage: const { workLLM } = require('./worker-llm');
//        const r = await workLLM(job, agent); // { output, worker, model }
const { execSync } = require('child_process');
const { work } = require('./engine');
function postJson(url, body, headers) {
  const payload = JSON.stringify(body).replace(/'/g, `'\\''`);
  const headerArgs = Object.entries(headers || {}).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
  const out = execSync(`curl -s -m 120 ${url} -H 'Content-Type: application/json' ${headerArgs} -d '${payload}'`, { maxBuffer: 4 * 1024 * 1024 });
  return out.toString();
}
function promptFor(job) {
  return [
    { role: 'system', content: 'You are a Genesis agent. Write a clear summary of the job text that answers the brief. Use plain language, at least ' + job.minWords + ' words, and make sure to cover these keywords naturally: ' + job.keywords.join(', ') + '. Do not add facts that are not in the text. Do not mention that you are an AI.' + (job.angle ? ' Angle for this entry: ' + job.angle : '') },
    { role: 'user', content: 'Brief: ' + job.brief + '\n\nText:\n' + job.text.slice(0, 4000) },
  ];
}
async function workLLM(job, agent) {
  const messages = promptFor(job);
  // Route 1: configured OpenAI-compatible endpoint
  if (process.env.LLM_API_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL) {
    try {
      const raw = postJson(process.env.LLM_API_URL.replace(/\/$/, '') + '/chat/completions',
        { model: process.env.LLM_MODEL, messages, temperature: 0.3, max_tokens: 800 },
        { Authorization: 'Bearer ' + process.env.LLM_API_KEY });
      const j = JSON.parse(raw);
      const output = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
      if (output.length > 20) return { output, worker: 'llm', model: process.env.LLM_MODEL, provider: process.env.LLM_API_URL };
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
      if (raw.length > 20 && !raw.startsWith('{')) return { output: raw, worker: 'llm', model: 'openai (pollinations)', provider: 'https://text.pollinations.ai/' };
      throw new Error('Unexpected public endpoint output');
    } catch (e) { console.error(`Public LLM attempt ${attempt} failed:`, e.message.slice(0, 120)); }
  }
  console.error('Public LLM failed, falling back to extractive summariser');
  // Route 3: honest fallback — labelled, never claimed as LLM
  return { output: work(job, agent), worker: 'extractive-fallback', model: 'extractive summariser (repo code)', provider: 'local' };
}
module.exports = { workLLM };
