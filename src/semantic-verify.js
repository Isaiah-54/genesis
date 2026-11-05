// Genesis semantic verifier — the quality judge the structural verifier
// cannot be. The strict verifier (src/engine.js verifyStrict) checks
// shape: keywords present, original, three sentences, and the score beats
// the frontier. A beautifully structured but factually wrong answer passes
// all of that. This module checks meaning, against the source text as the
// ONLY ground truth:
//   1. Factual accuracy — every claim in the output must be supported by
//      the source. One invented fact caps accuracy at 40.
//   2. Relevance — the output answers the brief.
//   3. Completeness — the brief and every keyword covered in substance,
//      not just mentioned.
//   4. Originality — deterministic, from the structural gates (copied
//      share under 30%). The judge does not re-decide this.
//   5. Evidence — claims anchored to specifics from the source (names,
//      numbers, steps), not vague generalities.
// The judge is a second model call (same route chain as the worker:
// NEAR AI Cloud first, then a configured endpoint, then Pollinations),
// prompted as a strict judge with the source in context. The judge model
// can differ from the worker model via SEMANTIC_JUDGE_MODEL, so the
// worker does not grade its own homework when a second model is set.
// Fail closed: an unavailable judge, an unparseable answer, or a score
// below threshold all mean NO payment. The median output is the one
// judged — it is the output that would be paid on.
// The payment service (api/pay-job.js) cannot import this module, so it
// carries a duplicated copy of the prompt, thresholds and parser — keep
// the two identical. The prompt text, thresholds and source budget below
// are the source of truth.
const { verifyRuns } = require('./engine');

const SOURCE_BUDGET = 6000; // chars of source text sent to the judge
// The judge reasons before answering (verified live 2026-11-05): 800
// tokens is spent entirely on reasoning and returns empty content, so
// the judge gets 2000 — room to check the claims, then emit the JSON.
const JUDGE_MAX_TOKENS = 2000;

// Minimum score per dimension. Accuracy carries the highest bar: this
// verifier exists because a wrong answer must not be paid.
const THRESHOLDS = { accuracy: 80, relevance: 70, completeness: 70, evidence: 70 };

const JUDGE_SYSTEM = 'You are a strict quality judge for Genesis, an agent economy. You judge a summary against its source text. The source text is the ONLY ground truth: a claim is true only if the source supports it. Do not use outside knowledge. A beautifully written summary with a false claim FAILS. Return JSON only, no other text.';

function judgeMessages({ brief, keywords, sourceText, output }) {
  const src = String(sourceText || '').slice(0, SOURCE_BUDGET);
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    {
      role: 'user',
      content:
        'Brief: ' + (brief || '') + '\n'
        + 'Keywords: ' + (keywords || []).join(', ') + '\n\n'
        + 'Source text (ground truth):\n' + src + '\n\n'
        + 'Output to judge:\n' + (output || '') + '\n\n'
        + 'Judge the output on four dimensions, 0-100 each:\n'
        + '- accuracy: every factual claim in the output is supported by the source. Deduct for each unsupported or contradicted claim. A single invented fact (a wrong number, name, or step) caps accuracy at 40.\n'
        + '- relevance: the output answers the brief.\n'
        + '- completeness: the output covers the brief and every keyword in substance, not just by mentioning them.\n'
        + '- evidence: claims are anchored to specifics from the source (names, numbers, steps), not vague generalities.\n\n'
        + 'Return ONLY this JSON:\n'
        + '{"accuracy": 0-100, "relevance": 0-100, "completeness": 0-100, "evidence": 0-100, "unsupported_claims": ["claim 1", ...], "missing": ["missing point 1", ...], "reason": "one sentence"}',
    },
  ];
}

// Parse the judge's reply into the four scores, or null when the reply
// is not usable JSON. Tolerates markdown fences around the object.
function parseJudgeOutput(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let j;
  try { j = JSON.parse(cleaned.slice(start, end + 1)); } catch (_) { return null; }
  const dims = ['accuracy', 'relevance', 'completeness', 'evidence'];
  for (const d of dims) {
    if (typeof j[d] !== 'number' || !Number.isFinite(j[d]) || j[d] < 0 || j[d] > 100) return null;
  }
  return {
    accuracy: Math.round(j.accuracy),
    relevance: Math.round(j.relevance),
    completeness: Math.round(j.completeness),
    evidence: Math.round(j.evidence),
    unsupported_claims: Array.isArray(j.unsupported_claims) ? j.unsupported_claims.map(String) : [],
    missing: Array.isArray(j.missing) ? j.missing.map(String) : [],
    reason: typeof j.reason === 'string' ? j.reason : '',
  };
}

// Judge one output. structural is the median output's gates from
// verifyStrict (its originality gate is the deterministic originality
// score). callLLM is the shared model call from worker-llm.js
// ({ output, model, provider, verifiable, attestation }); callers pass
// their own stub in tests. Never throws: every failure mode returns a
// failed verdict (fail closed).
async function semanticVerify({ brief, keywords, sourceText, output, structural, callLLM, model }) {
  const failed = (reason, extra = {}) => ({
    passed: false,
    scores: null,
    thresholds: { ...THRESHOLDS },
    unsupported_claims: [],
    missing: [],
    reason,
    model: null,
    provider: null,
    verifiable: false,
    attestation: null,
    ...extra,
  });
  if (typeof callLLM !== 'function') return failed('no model call available to judge the output');
  const originalityScore = structural && structural.originality
    ? Math.round((1 - structural.originality.copiedShare) * 100)
    : null;
  const originalityPassed = structural && structural.originality ? structural.originality.passed : false;
  let judged;
  try {
    judged = await callLLM(judgeMessages({ brief, keywords, sourceText, output }), JUDGE_MAX_TOKENS, { model: model || process.env.SEMANTIC_JUDGE_MODEL || null });
  } catch (e) {
    return failed('semantic judge unavailable: ' + String(e && e.message || e).slice(0, 200));
  }
  const parsed = parseJudgeOutput(judged && judged.output);
  if (!parsed) return failed('semantic judge returned unusable output', { model: judged.model || null, provider: judged.provider || null });
  const scores = {
    accuracy: parsed.accuracy,
    relevance: parsed.relevance,
    completeness: parsed.completeness,
    originality: originalityScore,
    evidence: parsed.evidence,
  };
  const dimsPass = parsed.accuracy >= THRESHOLDS.accuracy
    && parsed.relevance >= THRESHOLDS.relevance
    && parsed.completeness >= THRESHOLDS.completeness
    && parsed.evidence >= THRESHOLDS.evidence;
  const passed = dimsPass && originalityPassed;
  const failing = [];
  if (parsed.accuracy < THRESHOLDS.accuracy) failing.push(`accuracy ${parsed.accuracy} < ${THRESHOLDS.accuracy}`);
  if (parsed.relevance < THRESHOLDS.relevance) failing.push(`relevance ${parsed.relevance} < ${THRESHOLDS.relevance}`);
  if (parsed.completeness < THRESHOLDS.completeness) failing.push(`completeness ${parsed.completeness} < ${THRESHOLDS.completeness}`);
  if (parsed.evidence < THRESHOLDS.evidence) failing.push(`evidence ${parsed.evidence} < ${THRESHOLDS.evidence}`);
  if (!originalityPassed) failing.push('originality gate failed (copied share 30% or more)');
  return {
    passed,
    scores,
    thresholds: { ...THRESHOLDS },
    unsupported_claims: parsed.unsupported_claims,
    missing: parsed.missing,
    reason: passed ? (parsed.reason || 'semantic verification passed') : ('semantic verification failed: ' + failing.join('; ') + (parsed.reason ? ' — ' + parsed.reason : '')),
    model: judged.model || null,
    provider: judged.provider || null,
    verifiable: !!judged.verifiable,
    attestation: judged.attestation || null,
  };
}

// Full paid-attempt check: structural gates on every run (median score),
// then the semantic judge on the median output only. The judge is
// skipped — and no call is made — when the structural gates fail, so a
// structurally bad attempt costs no judge call. Returns the verifyRuns
// shape plus `semantic` and a combined `pass`.
async function verifyRunsWithSemantics(job, outputs, callLLM, opts = {}) {
  const structural = verifyRuns(job, outputs);
  if (!structural.pass) {
    return { ...structural, semantic: null, semanticSkipped: 'structural gates failed', pass: false };
  }
  const semantic = await semanticVerify({
    brief: job.brief,
    keywords: job.keywords,
    sourceText: job.text,
    output: structural.medianOutput,
    structural: structural.medianGates,
    callLLM,
    model: opts.model || null,
  });
  return { ...structural, semantic, pass: semantic.passed };
}

module.exports = {
  SOURCE_BUDGET,
  JUDGE_MAX_TOKENS,
  THRESHOLDS,
  JUDGE_SYSTEM,
  judgeMessages,
  parseJudgeOutput,
  semanticVerify,
  verifyRunsWithSemantics,
};
