# TEE Receipts

> **Status: work in progress (NEAR hackathon, tracks: privacy + open).** Sections marked TODO are filled in as the build progresses.

## 1. One line
Turn a NEAR AI Cloud answer into a permanent, third-party-checkable receipt on NEAR: the contract re-checks the TEE signature on-chain and keeps a timestamped history of attested signer keys, so a receipt still verifies after the enclave rotates its key.

**Problem.** NEAR AI Cloud signs every private-inference reply inside a TEE, but the signature is only fetchable for a while, the signer key can rotate, and checking it requires a verifier the reader must trust and re-run.
**Not.** This is not a new TEE, not a model host, and it does not verify Intel TDX / NVIDIA evidence on-chain (that runs off-chain; see §6).

## 2. Try it in 2 minutes
```bash
npm ci
npm run demo:replay   # TODO: offline replay against a local NEAR sandbox
```

## 3. Do X → see Y
| Do | See |
| --- | --- |
| `node client/scripts/probe-attestation.mjs` | Fresh NEAR AI Cloud attestation (no API key) verified: TDX quote, nonce, signer binding, RTMR3, NVIDIA GPU |
| TODO `register` | Signer stored on-chain with attestation hash, nonce, expiry |
| TODO `anchor` | Receipt stored only if the signature recovers to a registered signer |
| TODO tampered response | Rejected on-chain: `signature does not verify` |

## 4. How NEAR is used
- NEAR AI Cloud: TEE inference, attestation reports, response signatures.
- NEAR smart contract (Rust, near-sdk 5.30): on-chain EIP-191 `ecrecover` and `ed25519_verify` of the response signature, signer registry, receipt storage.

## 5. Architecture / contract methods / data retention
TODO. Only hashes, model id, signer, and signature go on-chain. Prompts and answers never leave the user's machine.

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
cd contracts/receipts && cargo test                      # unit tests (NEAR VM logic)
cargo near build non-reproducible-wasm --no-abi
cd sandbox-test && npm ci && npm test                     # real wasm on a local near-sandbox node
```

## 9. Honesty about the demo (read this)
- **Attestation is real.** Reports are fetched live from `cloud-api.near.ai` with our own nonce and fully verified.
- **Response signatures need a NEAR AI Cloud API key with credits.** The author had none during the hackathon. Unless you set `NEAR_AI_CLOUD_API_KEY`, receipts in the demo are signed by a **local simulated signer**, are labelled `SIMULATED` everywhere they appear, and are **not** evidence that NEAR AI produced anything.
- Test vectors in `contracts/receipts/tests/fixtures/local_vectors.json` use throwaway local keys in the NEAR AI signature format.

## 10. Built during the hackathon / libraries / AI tools
All code in this repo was written during the hackathon. Libraries: near-sdk, near-api-js, near-sandbox, ethers, tweetnacl, @phala/dcap-qvl. Verification logic follows the NEAR AI Cloud docs (https://docs.near.ai/cloud/verification). AI coding assistants were used. TODO: MIT notice for any ported example code.

## 11. Disclosure
The same author also submitted agent-pay (https://github.com/tmdry4530/agent-pay-public, tracks security + agents). The projects share no code and solve different problems.

## 12. Limitations / License
TODO limitations. MIT, see [LICENSE](LICENSE).
