// Tests for src/semantic-verify.js — the quality judge the structural
// verifier cannot be. The central scenario is the one the feedback
// names: a beautifully structured but factually wrong answer passes the
// strict gates (keywords, originality, sentences) and must still fail.
// The model call is stubbed throughout: no network, deterministic.
const { verifyStrict, verifyRuns } = require('../src/engine');
const {
  THRESHOLDS,
  judgeMessages,
  parseJudgeOutput,
  semanticVerify,
  verifyRunsWithSemantics,
} = require('../src/semantic-verify');

const SOURCE = 'NEAR has a shared NFT contract that anyone can mint on. The testnet contract is nft.primitives.testnet. To mint, call nft_mint with a token id, a receiver id, and token metadata including title, description and media. A deposit covers storage. NFTs on NEAR follow the NEP-177 standard with metadata under NEP-177.';
const GOOD = 'Anyone can mint a new NFT on the NEAR blockchain, and the resulting token is recorded in the caller\'s wallet for later use. Creating that token means sending an identifier, a destination account, and a small set of descriptive fields to the shared contract, while a storage deposit pays for the data the chain keeps. Because every token follows the public NEP-171 interface, wallets and marketplaces can recognise it without any custom integration code.';
// Structurally perfect, factually invented: a 100 NEAR fee and an
// nft_burn step appear nowhere in the source.
const LIE = 'Anyone can mint a new NFT on the NEAR blockchain by paying a fee of exactly 100 NEAR to the contract owner before any token is created. Creating that token means calling nft_burn with your private key and a token id, and the network then destroys the original asset forever. Because every token follows the public NEP-171 interface, wallets and marketplaces can recognise it without any custom integration code.';
const JOB = { brief: 'NEAR NFTs global contract mint', keywords: ['near', 'nft', 'mint'], text: SOURCE };

function fail(msg) { console.log('FAIL:', msg); process.exit(1); }
function check(name, cond, detail) {
  console.log((cond ? 'ok  ' : 'BAD ') + name + (cond ? '' : ' — ' + detail));
  if (!cond) fail(name + ': ' + detail);
}
function judgeStub(json, capture) {
  return async (messages) => {
    if (capture) capture.messages = messages;
    return { output: typeof json === 'string' ? json : JSON.stringify(json), model: 'stub-judge', provider: 'stub', verifiable: false, attestation: null };
  };
}
const PASS_JUDGE = { accuracy: 92, relevance: 88, completeness: 85, evidence: 90, unsupported_claims: [], missing: [], reason: 'All claims supported by the source.' };

(async () => {
  // 0. The premise: the lie PASSES the structural verifier. Without the
  // semantic judge, this answer would be paid.
  const lieStrict = verifyStrict(JOB, LIE);
  check('the structured lie passes the strict gates (the gap this fixes)', lieStrict.pass === true, JSON.stringify(lieStrict.gates));
  check('the good summary passes the strict gates too', verifyStrict(JOB, GOOD).pass === true, '');

  // 1. The lie fails the semantic judge on accuracy, with its invented
  // claims named.
  let r = await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: SOURCE, output: LIE,
    structural: lieStrict.gates,
    callLLM: judgeStub({ accuracy: 30, relevance: 85, completeness: 80, evidence: 40, unsupported_claims: ['minting costs exactly 100 NEAR', 'nft_burn destroys the original asset'], missing: [], reason: 'The output invents a 100 NEAR fee and a burn step the source never mentions.' }),
  });
  check('structured lie fails semantic verification', r.passed === false, JSON.stringify(r));
  check('lie accuracy is 30', r.scores && r.scores.accuracy === 30, JSON.stringify(r.scores));
  check('lie names its unsupported claims', r.unsupported_claims.length === 2, JSON.stringify(r.unsupported_claims));
  check('lie reason names the failing dimension', /accuracy 30 < 80/.test(r.reason), r.reason);
  check('lie keeps the deterministic originality score', r.scores && typeof r.scores.originality === 'number' && r.scores.originality >= 70, JSON.stringify(r.scores));

  // 2. The good summary passes all five dimensions.
  r = await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: SOURCE, output: GOOD,
    structural: verifyStrict(JOB, GOOD).gates,
    callLLM: judgeStub(PASS_JUDGE),
  });
  check('good summary passes semantic verification', r.passed === true, JSON.stringify(r));
  check('good summary scores all five dimensions', r.scores && r.scores.accuracy === 92 && r.scores.originality !== null, JSON.stringify(r.scores));

  // 3. Irrelevant and incomplete outputs fail on their own dimension.
  r = await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: SOURCE, output: GOOD,
    structural: verifyStrict(JOB, GOOD).gates,
    callLLM: judgeStub({ ...PASS_JUDGE, relevance: 40, reason: 'The output does not answer the brief.' }),
  });
  check('irrelevant output fails on relevance', r.passed === false && /relevance 40 < 70/.test(r.reason), r.reason);
  r = await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: SOURCE, output: GOOD,
    structural: verifyStrict(JOB, GOOD).gates,
    callLLM: judgeStub({ ...PASS_JUDGE, completeness: 50, missing: ['the storage deposit'], reason: 'The storage deposit is missing.' }),
  });
  check('incomplete output fails on completeness', r.passed === false && /completeness 50 < 70/.test(r.reason), r.reason);
  check('incomplete output lists what is missing', r.missing.includes('the storage deposit'), JSON.stringify(r.missing));

  // 4. Fail closed: unparseable judge output and a throwing judge both
  // refuse payment.
  r = await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: SOURCE, output: GOOD,
    structural: verifyStrict(JOB, GOOD).gates,
    callLLM: judgeStub('not json at all'),
  });
  check('unparseable judge output fails closed', r.passed === false && /unusable output/.test(r.reason), r.reason);
  r = await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: SOURCE, output: GOOD,
    structural: verifyStrict(JOB, GOOD).gates,
    callLLM: async () => { throw new Error('network down'); },
  });
  check('throwing judge fails closed', r.passed === false && /unavailable/.test(r.reason), r.reason);
  r = await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: SOURCE, output: GOOD,
    structural: verifyStrict(JOB, GOOD).gates,
    callLLM: null,
  });
  check('missing model call fails closed', r.passed === false, JSON.stringify(r));

  // 5. The judge prompt is grounded in the source text.
  const capture = {};
  await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: SOURCE, output: GOOD,
    structural: verifyStrict(JOB, GOOD).gates,
    callLLM: judgeStub(PASS_JUDGE, capture),
  });
  const promptText = JSON.stringify(capture.messages);
  check('judge prompt contains the source text', promptText.includes('nft.primitives.testnet'), 'source missing from judge prompt');
  check('judge prompt contains the output', promptText.includes('Anyone can mint a new NFT'), 'output missing from judge prompt');
  check('judge prompt names the five dimensions', /accuracy/.test(promptText) && /evidence/.test(promptText), 'dimensions missing');

  // 6. The parser tolerates fences and rejects bad shapes.
  check('parser accepts fenced JSON', parseJudgeOutput('```json\n' + JSON.stringify(PASS_JUDGE) + '\n```') !== null, '');
  check('parser rejects garbage', parseJudgeOutput('nope') === null, '');
  check('parser rejects an out-of-range score', parseJudgeOutput(JSON.stringify({ ...PASS_JUDGE, accuracy: 140 })) === null, '');
  check('parser rejects a missing dimension', parseJudgeOutput(JSON.stringify({ accuracy: 90, relevance: 90, completeness: 90 })) === null, '');

  // 7. verifyRunsWithSemantics: structural failure skips the judge
  // entirely (no wasted call); structural pass + judge pass pays;
  // structural pass + judge fail does not.
  let calls = 0;
  const counting = judgeStub(PASS_JUDGE);
  const countingCall = async (m) => { calls += 1; return counting(m); };
  let v = await verifyRunsWithSemantics(JOB, [SOURCE, SOURCE, SOURCE], countingCall);
  check('structural failure skips the judge', calls === 0 && v.pass === false && v.semantic === null, 'calls=' + calls);
  calls = 0;
  v = await verifyRunsWithSemantics(JOB, [GOOD, GOOD, GOOD], countingCall);
  check('structural pass + judge pass pays', calls === 1 && v.pass === true && v.semantic && v.semantic.passed === true, 'calls=' + calls + ' ' + JSON.stringify(v.semantic));
  check('combined result keeps the median score', v.medianScore === 476, 'median=' + v.medianScore);
  v = await verifyRunsWithSemantics(JOB, [LIE, LIE, LIE], judgeStub({ ...PASS_JUDGE, accuracy: 30 }));
  check('structural pass + judge fail does not pay', v.pass === false && v.semantic.passed === false, JSON.stringify(v.semantic));

  // 8. Thresholds are the documented ones.
  check('accuracy bar is 80', THRESHOLDS.accuracy === 80, JSON.stringify(THRESHOLDS));
  check('other bars are 70', THRESHOLDS.relevance === 70 && THRESHOLDS.completeness === 70 && THRESHOLDS.evidence === 70, JSON.stringify(THRESHOLDS));

  // 9. The judge gets the longer view: a fact sitting beyond the
  // worker's 3,000-char slice must reach the judge. Proven live on the
  // run-3 answer, whose deploy-command details sit at char 9,599 of the
  // source — a 3,000-char judge view flagged a correct answer.
  const LONG_SOURCE = 'filler '.repeat(1500) + ' the global contract is nft.globals.primitives.testnet and the deploy metadata includes reference_hash';
  check('long source reaches past char 3000', LONG_SOURCE.indexOf('reference_hash') > 3000, String(LONG_SOURCE.indexOf('reference_hash')));
  const longCapture = {};
  await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: LONG_SOURCE, output: GOOD,
    structural: verifyStrict(JOB, GOOD).gates,
    callLLM: judgeStub(PASS_JUDGE, longCapture),
  });
  check('judge prompt contains a fact from beyond char 3000', JSON.stringify(longCapture.messages).includes('reference_hash'), 'fact missing from judge prompt');
  check('judge prompt caps the source at the budget', JSON.stringify(longCapture.messages).length < 20000, 'source not capped');
  // verifyRunsWithSemantics hands the judge the longer source when the
  // caller supplies it, while the worker keeps the short slice.
  const runCapture = {};
  v = await verifyRunsWithSemantics(JOB, [GOOD, GOOD, GOOD], judgeStub(PASS_JUDGE, runCapture), { judgeSource: LONG_SOURCE });
  check('verifyRunsWithSemantics passes the longer source to the judge', JSON.stringify(runCapture.messages).includes('reference_hash'), 'judgeSource not used');
  check('verifyRunsWithSemantics still pays on judge pass', v.pass === true, JSON.stringify(v.semantic));

  // 10. The judge reads a decoded source: fetched pages are tag-stripped
  // but not entity-decoded, so a code example reads `&quot;decimals&quot;`
  // and a live judge claimed the field is nowhere in the source. The
  // worker's source (and the job_def_id built from it) must not change.
  const ENTITY_SOURCE = 'filler '.repeat(600) + ' the init args are {&quot;decimals&quot;:0, &quot;media&quot;:&quot;x&quot;}';
  const entityCapture = {};
  await semanticVerify({
    brief: JOB.brief, keywords: JOB.keywords, sourceText: ENTITY_SOURCE, output: GOOD,
    structural: verifyStrict(JOB, GOOD).gates,
    callLLM: judgeStub(PASS_JUDGE, entityCapture),
  });
  const entityPrompt = entityCapture.messages.map((m) => m.content).join('\n');
  check('judge prompt decodes entities', entityPrompt.includes('"decimals":0'), 'decoded field missing from judge prompt');
  check('judge prompt carries no raw entities', !entityPrompt.includes('&quot;'), 'raw entities left in judge prompt');

  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
