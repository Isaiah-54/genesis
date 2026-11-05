#!/usr/bin/env python3
"""Stub for the NEAR AI connector helper, used by test/worker-near-ai.cjs.

Reads one JSON object from stdin (model, messages, max_tokens) and prints
a canned result in the shape near-ai-call.py returns. It never touches the
network and never needs a credential, so the connector wiring can be tested
without a real NEAR AI Cloud call.
"""
import json
import sys

req = json.load(sys.stdin)
print(json.dumps({
    "output": "Anyone can mint a new NFT on the NEAR blockchain using the shared contract, and the resulting token is recorded in the caller's wallet for later use. Creating that token means sending an identifier, a destination account, and a small set of descriptive fields to the shared contract, while a storage deposit pays for the data the chain keeps. Because every token follows the public NEP-171 interface, wallets and marketplaces can recognise it without any custom integration code.",
    "worker": "llm",
    "model": req.get("model") or "z-ai/glm-5.3-flash",
    "provider": "near-ai",
    "verifiable": True,
    "attestation": {"nonce": "stub-nonce", "gateway_attestation": None, "model_attestations": None},
    "chat_id": "stub-chat-id",
}))
