# Day 1 feasibility (2026-11-01/02 KST)

## Verdict: on-chain verification of NEAR AI Cloud response signatures is FEASIBLE
| Algo | NEAR host function | Status |
| --- | --- | --- |
| `ecdsa` (EIP-191 personal_sign, 65-byte r‖s‖v, 20-byte address) | `env::keccak256` + `env::ecrecover` (near-sdk feature `unstable` gates the SDK wrapper; the host function itself is part of the protocol) | proven in unit tests **and** on a real near-sandbox node |
| `ed25519` (64-byte sig, 32-byte pubkey) | `env::ed25519_verify` | proven in unit tests and sandbox |

The signed text is rebuilt on-chain: provider_tee = `<model_id>:<sha256(req)>:<sha256(resp)>`, gateway = `<sha256(req)>:<sha256(resp)>`.

**Cannot run on-chain:** Intel TDX quote (DCAP) and NVIDIA GPU verification. These run off-chain in `client/src/attestation.mjs`; the contract owner (registrar) registers the verified signer with attestation hash, nonce, and TTL ≤ 7 days. Trust assumption: the registrar ran the verifier honestly. Anyone can re-run it from the stored attestation hash and nonce.

## Evidence
- `cargo test` (contracts/receipts): 8 passed. Cross-implementation vectors: ethers.js EIP-191 + tweetnacl ed25519 (JS) and k256 (Rust) signatures verify through NEAR VM-logic `ecrecover`/`ed25519_verify`.
- `contracts/receipts/sandbox-test` (near-sandbox 2.13.4, wasm 150,769 B built with cargo-near 0.22): 3/3 passed. All four vectors verify in the real wasm runtime. register_signer + submit_receipt works, a tampered hash is rejected, and `submit_receipt` burns about 2.43 Tgas in total.
- Keyless live attestation (`client/scripts/probe-attestation.mjs`, model Qwen/Qwen3.8-27B): gateway and model TDX quotes UpToDate, debug off, report_data binds signer and nonce, MRCONFIGID, RTMR3 replay, NVIDIA NRAS true, all PASS. Fixture saved in `fixtures/attestation/`. Signer addresses were the same in two fetches hours apart (gateway 0xb98a…e779, model 0x835a…aa26).

Docs: https://docs.near.ai/cloud/verification/cloud-api/response-signatures · https://docs.near.ai/cloud/verification/reference/response-signature-verification · https://docs.near.ai/cloud/verification/reference/quote-nonce-signer · https://docs.near.ai/cloud/verification/cloud-api/model-attestations · https://docs.near.ai/cloud/verification/verification-center

## Zero-credit facts (checked 2026-11-01, no sign-up)
| Endpoint | No API key |
| --- | --- |
| `GET /v1/models` | 200 |
| `GET /v1/attestation/report` (gateway and direct `*.completions.near.ai`) | 200. The docs/verifier README say the gateway needs a key, so this may change. Save fixtures. |
| `POST /v1/chat/completions` (gateway and direct) | 401 |
| `GET /v1/signature/{id}` | 401 |
| NVIDIA NRAS `/v3/attest/gpu`, Intel/Phala PCCS collateral | public, free |

A real response signature needs an API key **with credits** (pay-as-you-go; no free tier is documented). The NEAR Builders credit and staking-for-inference options both need a wallet, which the user declined.
