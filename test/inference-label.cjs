// Test src/inference-label.js and the honest labelling of saved jobs.
// Covers: the label mapping (NEAR AI attested/unattested, the two
// fallbacks, configured endpoint, missing route), the nonce-only
// attestation record, legacy derivation (a model name alone never proves
// NEAR AI), and the saved evidence — the demo arena runs are Pollinations
// (labelled as a fallback), the league carries no route, and the guided
// demo's judge is NEAR AI attested with its nonce echoed in its own
// evidence. Also locks in the exact NEAR AI sentence on the site and README.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  inferenceLabel, attestationStatus, attestationSummary,
  inferenceRecord, routeFromLegacy,
} = require('../src/inference-label');

const SENTENCE = 'Job work runs on NEAR AI Cloud (attested when available), Agents work with NEAR AI Cloud inference; payment and selection pressure live on-chain.';

let n = 0;
function check(name, cond, extra) {
  n += 1;
  assert.ok(cond, name + (extra ? ' — ' + extra : ''));
  console.log(n + '. ' + name + ': ok');
}

// --- Label mapping ---
check('NEAR AI + verifiable + nonce attestation is attested',
  inferenceLabel({ provider: 'near-ai', verifiable: true, attestation: { nonce: 'abc' } }) === 'NEAR AI Cloud — attested');
check('NEAR AI attested status',
  attestationStatus({ provider: 'near-ai', verifiable: true, attestation: { nonce: 'abc' } }) === 'attested');
check('NEAR AI without attestation is unattested',
  inferenceLabel({ provider: 'near-ai', verifiable: true, attestation: null }) === 'NEAR AI Cloud — unattested');
check('NEAR AI unattested status',
  attestationStatus({ provider: 'near-ai', verifiable: true, attestation: null }) === 'unattested');
check('NEAR AI with verifiable false is unattested even with evidence',
  inferenceLabel({ provider: 'near-ai', verifiable: false, attestation: { nonce: 'abc' } }) === 'NEAR AI Cloud — unattested');
check('NEAR AI with attestation but no nonce is unattested',
  inferenceLabel({ provider: 'near-ai', verifiable: true, attestation: { response: {} } }) === 'NEAR AI Cloud — unattested');
check('Pollinations provider is a labelled fallback',
  inferenceLabel({ provider: 'https://text.pollinations.ai/', verifiable: false, attestation: null }) === 'Fallback: Pollinations');
check('Pollinations model string is a labelled fallback',
  inferenceLabel({ model: 'openai (pollinations)' }) === 'Fallback: Pollinations');
check('extractive worker is a labelled fallback',
  inferenceLabel({ worker: 'extractive-fallback', model: 'extractive summariser (repo code)' }) === 'Fallback: extractive');
check('configured endpoint is a labelled fallback with its model',
  inferenceLabel({ provider: 'https://llm.example.com', model: 'some-model' }) === 'Fallback: some-model');
check('empty route is not recorded',
  inferenceLabel({}) === 'route not recorded');
check('empty route attestation is not recorded',
  attestationStatus({}) === 'not recorded');
check('Pollinations attestation is not recorded, not claimed',
  attestationStatus({ provider: 'https://text.pollinations.ai/' }) === 'not recorded');

// --- Attestation record: nonce only, never the blob ---
check('attestation summary keeps the nonce only',
  JSON.stringify(attestationSummary({ nonce: 'n1', gateway_attestation: { big: 'blob' }, model_attestations: [{ big: 'blob' }] })) === JSON.stringify({ nonce: 'n1' }));
check('null attestation stays null', attestationSummary(null) === null);
check('attestation without a nonce is not recorded', attestationSummary({ response: {} }) === null);

// --- inferenceRecord: what a run saves ---
const nearAIResult = {
  output: 'x', worker: 'llm', model: 'z-ai/glm-5.3-flash', provider: 'near-ai',
  verifiable: true,
  attestation: { nonce: 'n2', gateway_attestation: { big: 'blob' }, model_attestations: [] },
  chat_id: 'c1',
};
const rec = inferenceRecord(nearAIResult);
check('record labels a NEAR AI run attested', rec.label === 'NEAR AI Cloud — attested');
check('record keeps the nonce, drops the blob',
  JSON.stringify(rec.attestation) === JSON.stringify({ nonce: 'n2' }));
check('record keeps provider/model/worker/verifiable',
  rec.provider === 'near-ai' && rec.model === 'z-ai/glm-5.3-flash' && rec.worker === 'llm' && rec.verifiable === true);
const pollResult = {
  output: 'x', worker: 'llm', model: 'openai (pollinations)',
  provider: 'https://text.pollinations.ai/', verifiable: false, attestation: null, chat_id: null,
};
check('record labels a Pollinations run as a fallback',
  inferenceRecord(pollResult).label === 'Fallback: Pollinations');

// --- Legacy derivation: only what the record supports ---
const legacyPoll = routeFromLegacy({ worker: 'llm', model: 'openai (pollinations)' });
check('legacy Pollinations model derives the fallback label',
  legacyPoll.label === 'Fallback: Pollinations' && legacyPoll.attestation_status === 'not recorded');
check('legacy Pollinations derivation never claims verifiable',
  legacyPoll.verifiable === false && legacyPoll.attestation === null);
const legacyExtractive = routeFromLegacy({ worker: 'extractive-fallback', model: 'extractive summariser (repo code)' });
check('legacy extractive worker derives the fallback label',
  legacyExtractive.label === 'Fallback: extractive');
const legacyNearModel = routeFromLegacy({ worker: 'llm', model: 'z-ai/glm-5.3-flash' });
check('a NEAR AI model name alone is NEVER claimed as NEAR AI',
  legacyNearModel.label === 'route not recorded');
const legacyEmpty = routeFromLegacy({});
check('legacy record with no route is not recorded',
  legacyEmpty.label === 'route not recorded' && legacyEmpty.attestation_status === 'not recorded');

// --- Saved evidence: honest labels on what is already recorded ---
const arena = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'arena-run.json'), 'utf8'));
assert.strictEqual(arena.entries.length, 2, 'arena run has two entries');
for (const e of arena.entries) {
  check('saved arena entry ' + e.agent.split('.')[0] + ' is labelled Fallback: Pollinations',
    e.inference && e.inference.label === 'Fallback: Pollinations', JSON.stringify(e.inference));
  check('saved arena entry attestation is not recorded',
    e.inference && e.inference.attestation_status === 'not recorded');
  check('saved arena entry never claims verifiable',
    e.inference && e.inference.verifiable === false);
  for (const r of e.runs) {
    assert.strictEqual(r.inference.label, 'Fallback: Pollinations', 'run ' + r.run + ' label');
  }
}
check('every saved arena run is labelled Fallback: Pollinations',
  arena.entries.every((e) => e.runs.every((r) => r.inference.label === 'Fallback: Pollinations')));
const league = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'league.json'), 'utf8'));
check('every saved league result says route not recorded',
  league.matches.every((m) => m.results.every((r) => r.inference === 'route not recorded')));
check('league standings untouched by the labelling',
  league.standings[0].agent.includes('gen3') && league.standings[0].wins === 3);

const tour = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'guided-tour.json'), 'utf8'));
check('guided demo worker runs are labelled Fallback: Pollinations',
  tour.gen2.inference.label === 'Fallback: Pollinations' && tour.gen3.inference.label === 'Fallback: Pollinations');
const sem = tour.gen3.semantic;
check('guided demo judge is labelled NEAR AI Cloud — attested',
  sem.label === 'NEAR AI Cloud — attested' && sem.provider === 'near-ai' && sem.verifiable === true);
check('guided demo judge attestation nonce echoes in its own evidence',
  sem.attestation && sem.attestation.nonce
  && sem.attestation.gateway_attestation.request_nonce === sem.attestation.nonce
  && sem.attestation.model_attestations[0].request_nonce === sem.attestation.nonce);
const demoHtml = fs.readFileSync(path.join(__dirname, '..', 'demo.html'), 'utf8');
const inlined = JSON.parse(demoHtml.split('\n')[85].match(/^const TOUR = (.*);$/)[1]);
check('demo.html inlined tour carries the same labels as guided-tour.json',
  inlined.gen3.inference.label === 'Fallback: Pollinations' && inlined.gen3.semantic.label === 'NEAR AI Cloud — attested');
check('demo.html no longer claims the worker ran on NEAR AI Cloud',
  !demoHtml.includes('through NEAR AI Cloud — verifiable inference'));

// --- The exact sentence, verbatim, on the site and README ---
for (const f of ['README.md', 'index.html', 'how-it-works.html', 'arena.html', 'demo.html']) {
  const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  check('exact NEAR AI sentence appears verbatim in ' + f, text.includes(SENTENCE));
}

console.log('inference-label: all ' + n + ' checks pass');
