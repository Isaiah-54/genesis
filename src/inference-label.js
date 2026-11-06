// Genesis inference labels — one honest name for how a job's work was done.
// Every job run records its inference route (provider, verifiable,
// attestation); this module turns a route into the visible label. The
// rule is strict: NEAR AI is claimed ONLY when the record proves it
// (provider 'near-ai' + verifiable true + an attestation whose nonce
// echoes the request — the worker only keeps attestation when the nonce
// echoes, see src/worker-llm.js). A model name alone never proves the
// route: the same model string can come from a configured endpoint, so a
// legacy record with only { worker, model } can only ever yield a
// fallback label or 'route not recorded'.
//
// Labels:
//   'NEAR AI Cloud — attested'      NEAR AI + verifiable + trusted attestation
//   'NEAR AI Cloud — unattested'    NEAR AI without a trusted attestation
//   'Fallback: Pollinations'        the public Pollinations route
//   'Fallback: extractive'          the local extractive summariser
//   'Fallback: <model>'             a configured OpenAI-compatible endpoint
//   'route not recorded'            the record says nothing about the route
//
// Attestation status is 'attested' | 'unattested' | 'not recorded'.
// 'not recorded' covers every non-NEAR-AI route and every legacy record:
// a Pollinations run has no attestation to report, and a record that
// never stored one cannot claim otherwise.
//
// The browser (app.js) and the serverless function (api/pay-job.js) carry
// small copies of this mapping because they cannot import src/ — keep the
// three identical: same inputs, same labels, same order of checks.
const POLLINATIONS_URL = 'https://text.pollinations.ai/';
const POLLINATIONS_MODEL = 'openai (pollinations)';

// True only when the attestation is bound to the request: a non-null
// object carrying the client nonce that the evidence echoed back.
function hasTrustedAttestation(route) {
  const a = route && route.attestation;
  return !!a && typeof a === 'object' && typeof a.nonce === 'string' && a.nonce.length > 0;
}

function isNearAI(route) {
  return !!route && route.provider === 'near-ai';
}

function inferenceLabel(route) {
  const r = route || {};
  if (isNearAI(r)) {
    return r.verifiable === true && hasTrustedAttestation(r)
      ? 'NEAR AI Cloud — attested'
      : 'NEAR AI Cloud — unattested';
  }
  if (r.worker === 'extractive-fallback' || r.provider === 'local') {
    return 'Fallback: extractive';
  }
  if (r.provider === POLLINATIONS_URL
    || r.model === POLLINATIONS_MODEL
    || (typeof r.provider === 'string' && r.provider.includes('pollinations'))) {
    return 'Fallback: Pollinations';
  }
  if (typeof r.provider === 'string' && /^https?:\/\//.test(r.provider)) {
    return 'Fallback: ' + (typeof r.model === 'string' && r.model ? r.model : 'configured endpoint');
  }
  return 'route not recorded';
}

function attestationStatus(route) {
  const r = route || {};
  if (isNearAI(r)) {
    return r.verifiable === true && hasTrustedAttestation(r) ? 'attested' : 'unattested';
  }
  return 'not recorded';
}

// The attestation as it is recorded: the nonce only, never the full
// evidence blob (Intel quote + GPU evidence). The nonce is the reference
// that ties the evidence to the request; the blob itself is not needed
// to say whether a run was attested.
function attestationSummary(attestation) {
  if (!attestation || typeof attestation !== 'object') return null;
  if (typeof attestation.nonce === 'string' && attestation.nonce.length > 0) {
    return { nonce: attestation.nonce };
  }
  return null;
}

// Build the record a job run saves, from a workLLM/callLLM result.
// Keeps provider, model, worker, verifiable and the nonce-only
// attestation summary, plus the display label and attestation status.
function inferenceRecord(result) {
  const r = result || {};
  const route = {
    provider: typeof r.provider === 'string' ? r.provider : null,
    model: typeof r.model === 'string' ? r.model : null,
    worker: typeof r.worker === 'string' ? r.worker : null,
    verifiable: r.verifiable === true,
    attestation: attestationSummary(r.attestation),
  };
  return {
    ...route,
    label: inferenceLabel(route),
    attestation_status: attestationStatus(route),
  };
}

// Derive a route from a legacy record that only stored { worker, model }
// (e.g. demo/arena-run.json before this change). Only what the record
// supports: the Pollinations model string proves the Pollinations route
// (the codebase returns that model string only from that route), and the
// extractive worker proves the extractive route. Anything else —
// including a NEAR AI model name with no provider — is 'route not
// recorded': a model name alone never proves NEAR AI.
function routeFromLegacy(record) {
  const r = record || {};
  if (r.model === POLLINATIONS_MODEL || r.worker === 'llm (pollinations, in your browser)') {
    return {
      provider: 'pollinations', model: POLLINATIONS_MODEL, worker: r.worker || 'llm',
      verifiable: false, attestation: null,
      label: 'Fallback: Pollinations', attestation_status: 'not recorded',
    };
  }
  if (r.worker === 'extractive-fallback' || r.model === 'extractive summariser (repo code)') {
    return {
      provider: 'local', model: 'extractive summariser (repo code)', worker: 'extractive-fallback',
      verifiable: false, attestation: null,
      label: 'Fallback: extractive', attestation_status: 'not recorded',
    };
  }
  return {
    provider: null, model: typeof r.model === 'string' ? r.model : null,
    worker: typeof r.worker === 'string' ? r.worker : null,
    verifiable: false, attestation: null,
    label: 'route not recorded', attestation_status: 'not recorded',
  };
}

module.exports = {
  inferenceLabel, attestationStatus, attestationSummary,
  inferenceRecord, routeFromLegacy,
  POLLINATIONS_URL, POLLINATIONS_MODEL,
};
