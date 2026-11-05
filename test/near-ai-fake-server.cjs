// Fake NEAR AI Cloud API server for test/worker-near-ai.cjs.
// Runs as its OWN process (spawned by the test) — it must NOT share the
// test process, because the worker calls curl via execSync, which blocks
// the test process's event loop; a server in the same process could never
// answer while the worker waits for it (deadlock).
// Usage: node test/near-ai-fake-server.cjs <port>  (0 = random; prints
//   "LISTENING <port>" on stdout once ready)
// Endpoints:
//   GET  /v1/attestation/report?model=...&signing_algo=ecdsa&nonce=...
//        -> gateway_attestation + model_attestations, echoing the nonce.
//        Requires x-no-aliasing: true and a Bearer sk- key.
//   POST /v1/chat/completions
//        -> an OpenAI-compatible completion. Requires x-no-aliasing: true
//        and a Bearer sk- key.
//   POST /__test/control  { attestationShouldFail, completionCarriesAttestation }
//        -> sets the flags for the next scenario (test-only).
// The fake attestation values are clearly fake ("fake-intel-quote-...") —
// they only prove the worker captures and returns whatever evidence the
// API returns.
const http = require('http');

const state = { attestationShouldFail: false, completionCarriesAttestation: false, lastCompletionNoAliasing: null };
const FAKE_SUMMARY = 'Anyone can mint a new NFT on the NEAR blockchain using the shared contract, and the resulting token is recorded in the caller\'s wallet for later use. Creating that token means sending an identifier, a destination account, and a small set of descriptive fields to the shared contract, while a storage deposit pays for the data the chain keeps. Because every token follows the public NEP-171 interface, wallets and marketplaces can recognise it without any custom integration code.';

function evidenceFor(nonce) {
  return {
    gateway_attestation: {
      request_nonce: nonce,
      report_data: 'fake-report-data-' + nonce.slice(0, 8),
      intel_quote: 'fake-intel-quote-gateway-' + nonce.slice(0, 8),
      signing_address: 'fake-gateway-signing-address',
      signing_algo: 'ecdsa',
      event_log: [],
    },
    model_attestations: [{
      request_nonce: nonce,
      intel_quote: 'fake-intel-quote-model-' + nonce.slice(0, 8),
      signing_address: 'fake-model-signing-address',
      signing_algo: 'ecdsa',
      nvidia_payload: 'fake-nvidia-payload-' + nonce.slice(0, 8),
    }],
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/__test/control') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const flags = JSON.parse(body);
        if (typeof flags.attestationShouldFail === 'boolean') state.attestationShouldFail = flags.attestationShouldFail;
        if (typeof flags.completionCarriesAttestation === 'boolean') state.completionCarriesAttestation = flags.completionCarriesAttestation;
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__test/control') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/attestation/report') {
    if (state.attestationShouldFail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'attestation unavailable' }));
      return;
    }
    if (req.headers['x-no-aliasing'] !== 'true') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'x-no-aliasing header missing' }));
      return;
    }
    if (!String(req.headers.authorization || '').startsWith('Bearer sk-')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad auth' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(evidenceFor(url.searchParams.get('nonce') || '')));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      // Record whether the caller sent x-no-aliasing (the NEAR AI route
      // must; the generic configured-endpoint route does not). The
      // attestation endpoint enforces it; here it is only recorded, so
      // the generic route can use this fake server too.
      state.lastCompletionNoAliasing = req.headers['x-no-aliasing'] === 'true';
      if (!String(req.headers.authorization || '').startsWith('Bearer sk-')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad auth' }));
        return;
      }
      const out = {
        id: 'fake-chat-id-123',
        object: 'chat.completion',
        created: 1780405025,
        model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: FAKE_SUMMARY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 70, total_tokens: 81 },
      };
      if (state.completionCarriesAttestation) {
        out.gateway_attestation = { request_nonce: 'fake-response-nonce', intel_quote: 'fake-intel-quote-response' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const port = parseInt(process.argv[2] || '0', 10);
server.listen(port, '127.0.0.1', () => {
  console.log('LISTENING ' + server.address().port);
});
