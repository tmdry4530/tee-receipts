# TEE Receipts

> **Status: work in progress (NEAR hackathon, tracks: privacy + open).** Testnet deployment is pending.

## 1. One line
Turn a NEAR AI Cloud answer into a permanent, third-party-checkable receipt on NEAR: the contract re-checks the TEE signature on-chain and keeps a timestamped history of attested signer keys, so a receipt still verifies after the enclave rotates its key.

**Problem.** NEAR AI Cloud signs every private-inference reply inside a TEE, but the signature is only fetchable for a while, the signer key can rotate, and checking it requires a verifier the reader must trust and re-run.
**Not.** This is not a new TEE, not a model host, and it does not verify Intel TDX / NVIDIA evidence on-chain (that runs off-chain; see §6).

## 2. Try it in 2 minutes
Needs Node 22+. No API key, no NEAR account, no Rust (the built wasm is committed).
```bash
npm ci
npm run demo:replay      # offline: re-verifies saved real evidence, runs a local NEAR node, anchors + verifies a receipt
```
The first run downloads the `near-sandbox` node binary (needs internet once). After that the replay makes no network calls.

Other modes:
```bash
NEAR_AI_API_KEY=... npm run demo:live -- [--model Qwen/Qwen3.8-27B] [--max-tokens 64] [--save-fixtures]
                         # REAL: fresh attestation, real completion, real TEE signature, anchored on a local node
npm run demo:simulated   # offline fallback: local throwaway signer, labelled SIMULATED everywhere
```

## 3. Do X → see Y
| Do | See |
| --- | --- |
| `npm run cli -- node:start` | Local NEAR node with the contract; config in `.tee-receipts/local-node.json` (keep it running) |
| `npm run cli -- attest --model Qwen/Qwen3.8-27B` | Fresh attestation with our nonce, verified (TDX quote, TCB, report data = signer + nonce, MRCONFIGID, RTMR3, NVIDIA GPU), then gateway + model signers registered on-chain with attestation hash, nonce, expiry |
| `npm run cli -- attest --evidence fixtures/demo/attestation-evidence.json` | Same, from saved evidence, offline |
| `npm run cli -- ask --model Qwen/Qwen3.8-27B --prompt "..."` | Real completion (non-streaming, `x-no-aliasing`, exact model id, raw bytes kept) + `GET /v1/signature` (ecdsa) → receipt bundle in `.tee-receipts/receipts/` |
| `npm run cli -- anchor <bundle>` | `submit_receipt`: stored only if the signature recovers to a registered, unexpired signer for that model |
| `npm run cli -- verify <bundle> [--response f]` | Re-hash the bytes, check the signature off-chain, `verify_receipt` on-chain, signer + attestation in history |
| Change one byte of the response | No receipt matches; `submit_receipt` rejects it: `signature does not verify` |
| `npm run cli -- history --model Qwen/Qwen3.8-27B` | Every attested signer key ever registered for the model (`--model ""` = gateway), kept after rotation |

## 4. How NEAR is used
- NEAR AI Cloud: TEE inference, attestation reports, response signatures.
- NEAR smart contract (Rust, near-sdk 5.30): on-chain EIP-191 `ecrecover` and `ed25519_verify` of the response signature, signer registry, receipt storage.

## 5. Architecture / contract methods / data retention
```
NEAR AI Cloud ──attestation report──▶ client: verify TDX + NVIDIA off-chain ──register_signer──▶ contract (owner)
NEAR AI Cloud ──reply bytes + TEE signature──▶ client: receipt bundle ──submit_receipt──▶ contract (anyone)
verifier: bytes ──sha256──▶ verify_receipt ──▶ receipt + signer + attestation hash from history
```
Contract (`contracts/receipts`):
- `register_signer(signing_algo, signing_address, kind, model_id, attestation_hash, nonce, ttl_seconds, signing_public_key?)`, owner only. It appends to the signer history.
- `submit_receipt(signing_algo, signing_address, model_id, request_hash, response_hash, signature) -> id`. Anyone can call it. It rebuilds `model:req:resp` (or `req:resp` for gateway) and runs `ecrecover` / `ed25519_verify` on-chain.
- Views: `verify_receipt(request_hash, response_hash)`, `get_receipt(id)`, `receipt_count`, `get_signer(algo, addr)`, `get_signer_history(model_id, from_index?, limit?)`, `signer_history_len(model_id)`, `check_response_signature(...)`.

Data retention: only the hashes, model id, signer, signature, and attestation hash go on-chain. Prompts and answers stay in the local bundle file.

## 6. What is checked where
| Check | Where |
| --- | --- |
| Intel TDX quote, TCB, debug off, report data (signer + nonce), MRCONFIGID, RTMR3 | off-chain (`client/src/attestation.mjs`, dcap-qvl) |
| NVIDIA GPU evidence | off-chain (NVIDIA NRAS) |
| Response signature over `model:sha256(req):sha256(resp)` | **on-chain** |
| Signer registered, unexpired, model matches | **on-chain** |

## 7. Function-call key limits
TODO.

## 8. Tests
```bash
npm test                 # offline: saved evidence re-verifies, no secrets in fixtures, real wasm on a local node (anchor, verify, tamper rejected)
npm run test:contract    # cargo unit tests (needs Rust)
npm run build:contract   # rebuild the wasm into contracts/receipts/res/ (needs cargo-near)
```

## 9. Honesty about the demo (read this)
- **The primary path is real.** `demo:live` and the CLI fetch a fresh attestation with our own nonce, run a real NEAR AI Cloud completion, fetch its real TEE signature, and anchor it.
- **Saved fixtures.** `fixtures/demo/attestation-evidence.json` is a real attestation report fetched from `cloud-api.near.ai`. `fixtures/demo/receipt-bundle.json` is saved by `demo:live --save-fixtures`; it holds the exact request/response bytes and the real signature, and never an API key or auth header (`npm test` checks this).
- **What replay re-checks offline.** It re-checks the Intel TDX quote against the Intel collateral saved at fetch time ("as of" that time, not now). It reuses the recorded NVIDIA NRAS verdict without re-checking the JWT signature offline. The response signature and every on-chain check run for real.
- **Fallback when no real receipt is saved.** If no real receipt fixture exists, replay uses a SIMULATED receipt on top of the real attestation and says so. **Current state:** our NEAR AI account's key works for attestation, but completions return `402 no_limit_configured` (no spending limit / credits set). No real receipt is saved yet.
- **`--simulated`** uses a local throwaway key and model id `SIMULATED/not-near-ai` with a zero attestation hash. It is labelled everywhere and is not evidence that NEAR AI produced anything.
- Contract unit-test vectors (`contracts/receipts/tests/fixtures/local_vectors.json`) use throwaway local keys in the NEAR AI signature format.
- The local node is a throwaway sandbox. Tx hashes and receipt ids from it are not on a public network.

## 10. Built during the hackathon / libraries / AI tools
All code in this repo was written during the hackathon. Libraries: near-sdk, near-api-js, near-sandbox, ethers, tweetnacl, @phala/dcap-qvl. Verification logic follows the NEAR AI Cloud docs (https://docs.near.ai/cloud/verification). AI coding assistants were used. TODO: MIT notice for any ported example code.

## 11. Disclosure
The same author also submitted agent-pay (https://github.com/tmdry4530/agent-pay-public, tracks security + agents). The projects share no code and solve different problems.

## 12. Limitations / License
Limitations:
- TDX and NVIDIA evidence is checked off-chain. On-chain trust in a signer rests on the owner who registered it, and the stored attestation hash lets anyone re-check that registration.
- A receipt proves which attested key signed which bytes. It does not prove the answer is correct.
- Signer registrations expire (max 7 days), so keys must be re-attested.

MIT, see [LICENSE](LICENSE).
