# NEAR AI Cloud — verifiable inference for Genesis

The Genesis worker (`src/worker-llm.js`) can run jobs on NEAR AI Cloud
instead of the public Pollinations API. NEAR AI Cloud runs open-weight
models inside hardware Trusted Execution Environments (TEEs) and returns a
hardware-signed attestation with every request — proof of exactly which
model and code ran, verifiable by anyone. That is the last big piece that
makes Genesis's inference verifiable rather than "trust the API".

## Status

Wired and tested (2026-11-05). The worker tries NEAR AI first when the
key is set, and falls back to the configured endpoint, then Pollinations,
then the honestly-labelled extractive summariser. **Until Isaiah sets his
own NEAR AI API key, the worker keeps using Pollinations** — the wiring is
done, the key is the only missing step, and nobody else can create it for
him.

## How Isaiah gets a key

1. Sign up at https://cloud.near.ai
2. Add credits — Dashboard → "Credits" (pay-per-use; see Pricing below).
3. Generate an API key — Dashboard → "API Keys" → create a key. It
   starts with `sk-`.
4. Keep it safe: never share it, never commit it, never paste it into
   chat. If it leaks, regenerate it from the dashboard.

## Env vars

Set these in the shell (or a local `.env` file that is gitignored — never
in the repo, never in a chat message):

```
NEAR_AI_API_KEY=sk-...          # required — your NEAR AI Cloud API key
NEAR_AI_MODEL=z-ai/glm-5.3-flash # optional — default is z-ai/glm-5.3-flash
NEAR_AI_API_URL=https://cloud-api.near.ai/v1  # optional — only for tests
```

**Where the key lives:** the worker runs in Node — the CLI (`src/cli.js
job`), the MCP server (`src/mcp-server.mjs`), and the arena
(`src/arena-run.js`). The key is a **local** env var on the machine that
runs those. It does **not** go in the Vercel project env vars:
`api/pay-job.js` (the Vercel function) never calls a model — it only
verifies outputs the site sends it. The site's in-browser job runs the
model from the visitor's browser, not through this worker.

## How the worker uses it

Route 0 in `src/worker-llm.js` (takes priority when `NEAR_AI_API_KEY`
is set):

1. **Preflight attestation evidence** — before the completion, it fetches
   `GET https://cloud-api.near.ai/v1/attestation/report?model=<MODEL>&signing_algo=ecdsa&nonce=<NONCE>`
   with `Authorization: Bearer <key>` and `x-no-aliasing: true`. The
   nonce is 32 random bytes as 64 hex characters; the evidence echoes it
   back (replay protection). The response carries `gateway_attestation`
   (the gateway TEE's Intel TDX quote) and `model_attestations[]` (the
   model TEE's quote + NVIDIA GPU evidence). The worker keeps the
   evidence only when the echoed nonce matches its own — otherwise it
   records `attestation: null` rather than holding proof it cannot tie
   to the call.
2. **The completion** — `POST https://cloud-api.near.ai/v1/chat/completions`
   with the same auth and the `x-no-aliasing: true` header, so the
   gateway never substitutes a different model for the one requested.
   The completion response itself does **not** carry the attestation in
   its JSON body — the evidence comes from the preflight request above.
3. **Result** — `{ output, worker: 'llm', model, provider: 'near-ai',
   verifiable: true, attestation, chat_id }`. `chat_id` is the completion
   id, usable for the signature lookup
   (`GET /v1/signature/{chatId}?model=<MODEL>&signing_algo=ecdsa`).
   Existing callers (CLI job, arena, MCP) only read
   `output`/`worker`/`model`, so the extra fields do not break them.

If the NEAR AI call fails at any point, the worker logs it and falls
through to the existing routes — the job is never failed by a model
outage.

## Models (verified live 2026-11-05)

Model ids are `<vendor>/<model>`. The live catalog
(`GET https://cloud-api.near.ai/v1/models`) holds 64 models. Only the
**Confidential TEE** tier (owned by `nearai`) runs inside a TEE and
supports attestation and signatures. The other tiers do not give the
same proof:

- **Confidential TEE** — NEAR AI's own GPU fleet, inside a TEE. Supports
  attestation, signatures, verification. Nobody, not even NEAR, can see
  prompts or outputs.
- **3P Confidential TEE** (owner `attested 3p`) — a third-party provider's
  TEE, with its own attestation evidence.
- **Incognito** (OpenAI, Anthropic, Gemini, …) — routed through the
  gateway TEE but the model runs on the provider's infrastructure
  outside a TEE, so verifiability does not extend to the upstream model.

Confidential TEE chat models in the live catalog (2026-11-05):

| Model | Context | Use |
|---|---|---|
| `z-ai/glm-5.3-flash` **(default)** | 1,048,576 | Fast, cheap, long context — the current GLM flash model |
| `Qwen/Qwen3.8-27B` | 262,144 | Cheapest input; good general purpose |
| `Qwen/Qwen3.6-35B-A3B-FP8` | 262,144 | Larger Qwen |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 1,048,576 | DeepSeek flash, 1M context |
| `Qwen/Qwen3-VL-30B-A3B-Instruct` | 16,384 | Vision-language |

(There are also embedding, reranker, image and audio models in the
catalog; they are not chat models.)

**Note on the docs' example model:** the quickstart
(https://docs.near.ai/cloud/quickstart) uses `zai-org/GLM-5.1-FP8`.
That model is **not in the live catalog** (verified 2026-11-05) — the
vendor renamed to `z-ai` and the version moved to 5.3. The worker
defaults to `z-ai/glm-5.3-flash` for that reason. If you set
`NEAR_AI_MODEL` to a model that is not in the catalog, the call fails
with 404 and the worker falls back to Pollinations.

## Pricing (per-token, pay-per-use)

From the NEAR AI model catalog (rates per 1M tokens, input / output):

- `z-ai/glm-5.3-flash`: $0.08 / $0.50
- `Qwen/Qwen3.8-27B`: $0.04 / $1.35
- `deepseek-ai/DeepSeek-V4.1-Flash-1017`: $0.30 / $1.20
- `Qwen/Qwen3.6-35B-A3B-FP8`: $0.17 / $1.10

A Genesis job is a few hundred input tokens and ~100 output tokens, so
a single job costs a fraction of a cent. Credits are bought in the
dashboard (Credits section). Prices change — check the live catalog at
https://near.ai (model catalog) or `GET /v1/models` before budgeting.

## How the attestation works

1. The prompt is sent over TLS and only decrypted inside the enclave.
2. Inference runs in an Intel TDX + NVIDIA confidential-GPU enclave.
   Memory is sealed from the host and operators.
3. The TEE produces a cryptographic attestation quote binding the exact
   model and code that ran. The quote's measurements (RTMR3 event log,
   MRCONFIGID from the measured `app_compose` config) identify the
   enclave image.
4. The gateway returns the evidence as `gateway_attestation` (gateway
   TEE) and `model_attestations[]` (model TEE). Each carries
   `intel_quote` (the Intel TDX quote), `event_log`, `request_nonce`,
   `report_data`, `signing_address` and `signing_algo`, and the model
   reports also carry `nvidia_payload` (NVIDIA GPU evidence) when
   present.
5. The response can also be signed: `GET /v1/signature/{chatId}` returns
   a `signature_kind` of `provider_tee` (signed by the model TEE over
   `{model_id}:{request_hash}:{response_hash}`) or `gateway` (signed by
   the gateway TEE over `{request_hash}:{response_hash}`). Match the
   signer to the attestation report's `signing_address`.

## How to verify an attestation

The worker captures the evidence; it does not yet run the full
cryptographic verification (that needs an Intel DCAP quote verifier and
an NVIDIA attestation check, which are heavyweight dependencies). To
verify a captured attestation yourself:

- **Full verifier (recommended):** the NEAR AI Cloud Verifier —
  https://github.com/near-examples/nearai-cloud-verification-example
  (Node.js example; also a Python/TypeScript verifier linked from the
  docs). It fetches the attestation report, checks the nonce echo,
  verifies the NVIDIA GPU payload against NVIDIA's attestation service,
  fetches the chat signature, and matches the signer to the TEE key.
- **Intel TDX quote:** verify `intel_quote` with an Intel DCAP quote
  verifier such as `dcap-qvl`, apply your TCB and advisory policy, read
  `report_data` and measurements from the verified quote (not only from
  the HTTP fields), replay `event_log` and require it to equal the
  quote's RTMR3, and hash the raw `info.tcb_info.app_compose` string and
  require the quote's MRCONFIGID to equal `01` + that SHA-256 hash + 15
  zero bytes. Full steps:
  https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation
  and
  https://docs.near.ai/cloud/verification/cloud-api/model-attestations
- **NVIDIA GPU evidence:** send `nvidia_payload` to NVIDIA's attestation
  service (`https://nras.attestation.nvidia.com/v3/attest/gpu`) and
  require a passing verdict and a matching nonce.

**Caveat:** an independent audit of NEAR AI private inference (March–
April 2026, https://github.com/amiller/devproof-audits-guide/blob/HEAD/case-studies/near-ai-private-inference/DEVPROOF-REPORT.md)
found NVIDIA GPU attestation failing at that time (NRAS returning
persistent FAIL verdicts), while the Intel TDX gateway attestation
verified. Treat the Intel TDX quote as the primary evidence, and check
the current NVIDIA status before relying on GPU evidence.

## Docs

- Quickstart: https://docs.near.ai/cloud/quickstart
- API reference: https://docs.near.ai/api-reference/introduction
- Models: https://docs.near.ai/cloud/models
- Gateway attestation: https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation
- Model attestations: https://docs.near.ai/cloud/verification/cloud-api/model-attestations
- Verification example (open verifier): https://github.com/near-examples/nearai-cloud-verification-example
- NEAR AI Cloud: https://cloud.near.ai
