# TEE Receipts

> **Status: NEAR hackathon (tracks: privacy + open). Live on NEAR testnet:** contract [`tee-receipts-chamdom.testnet`](https://testnet.nearblocks.io/address/tee-receipts-chamdom.testnet), with a real NEAR AI Cloud receipt anchored and verified (see §2a).

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

## 2a. Live on NEAR testnet
Contract: [`tee-receipts-chamdom.testnet`](https://testnet.nearblocks.io/address/tee-receipts-chamdom.testnet) (owner = same account). Real run on 2026-11-02 (KST), model `Qwen/Qwen3.8-27B`, 16 completion tokens:

| Step | Tx |
| --- | --- |
| Deploy wasm (`contracts/receipts/res/`) | [`5GKh9fQH…`](https://testnet.nearblocks.io/txns/5GKh9fQHgsQ9HmuWzDF3ckvXTKxbdDXP175kxZp2RZpg) |
| `new { owner }` | [`R2s36BHL…`](https://testnet.nearblocks.io/txns/R2s36BHLC2UhKag774GUQsjuG86KVcUoKvZjLRjNkMF) |
| `register_signer` gateway `0xb98a789c…` (fresh attestation, all TDX + NVIDIA checks PASS) | [`3w4XHJQc…`](https://testnet.nearblocks.io/txns/3w4XHJQc4mZKfybm6Xjf6TRf7aLb1hpUZjEVwUs7RE9J) |
| `register_signer` model signer `0x835ab53d…` for `Qwen/Qwen3.8-27B` | [`EJtPscTW…`](https://testnet.nearblocks.io/txns/EJtPscTW2EJjuktH56TKYS9hrr2VbvQrq3Mw5mGyXkRs) |
| `submit_receipt` → receipt #0 (signature re-checked on-chain, 2.52 Tgas) | [`BGqt67iv…`](https://testnet.nearblocks.io/txns/BGqt67ivp3aGNKLwBMtyjJdhLnzZs1m1pyo8r7hpNGiK) |

The receipt bundle (exact request/response bytes + TEE signature) is `fixtures/testnet/receipt-bundle.json`; the attestation it was registered from is `fixtures/testnet/attestation-evidence.json` (attestation hash `fd320d9f…`).

Verify it yourself (read-only, no key, no NEAR account):
```bash
npm ci
TEE_RECEIPTS_CONTRACT_ID=tee-receipts-chamdom.testnet npm run cli -- verify fixtures/testnet/receipt-bundle.json
# -> re-hashes the bytes, checks the signature off-chain, then verify_receipt / get_signer_history on testnet: VERIFIED
```
Change one byte of the response (`--response tampered.json`) and it prints `NOT VERIFIED` (`no receipt for these bytes`).
Note: signer registrations expire (this one at 2026-11-09 01:56 KST). Receipt #0 and the signer history stay on-chain after that; anchoring *new* receipts needs a fresh `attest`.

### 2b. Verify in your browser (no install beyond Node, no key, no wallet)
```bash
npm ci && npm run web      # static server for web/ -> open http://127.0.0.1:8787/web/
```
The page loads `fixtures/testnet/receipt-bundle.json` and shows a **VERIFIED / NOT VERIFIED** checklist:
| Where | Check |
| --- | --- |
| browser | `sha256` of the exact request and response bytes equals the bundle hashes |
| browser | the signed text `model:sha256(req):sha256(resp)` rebuilt from those bytes equals the TEE-signed text |
| browser | EIP-191 `ecrecover` of the TEE signature gives the signer address (vendored `@noble/curves`, `web/vendor/`) |
| NEAR (view) | `verify_receipt(sha256 req, sha256 resp)` returns the anchored receipt (#0) |
| NEAR (view) | `check_response_signature`: the contract re-runs the signature check itself |
| NEAR (view) | receipt signer / signature equal the bundle's; the signer was in `get_signer_history` with this attestation hash when the receipt was anchored; attestation hash equals the saved report hash |

Buttons: **Tamper one byte** flips one letter in the response (e.g. byte 160 `u` → `U`) and re-checks: the response hash, the signed text, `verify_receipt` and `check_response_signature` fail → **NOT VERIFIED**. **Reset bytes** restores it. You can also edit the response text by hand, open another bundle file, or paste one. The signer-history table lists every attested key for the model and the gateway, marked `active` or `expired (kept)`.
The page only sends read-only JSON-RPC `query` calls to `https://rpc.testnet.near.org` (change RPC/contract under "Network", or `?rpc=…&contract=…&bundle=…`). Prompt and reply never leave the browser.
Plain HTML + ES modules, no build step, relative paths only: it also works from GitHub Pages (branch `main`, folder `/`) at `https://tmdry4530.github.io/tee-receipts/web/` once Pages is enabled (it is not enabled yet).

Deploy your own:
```bash
NEAR_ACCOUNT_ID=<you>.testnet NEAR_CREDENTIALS_FILE=~/.near-credentials/testnet/<you>.testnet.json npm run deploy:testnet
export TEE_RECEIPTS_CONTRACT_ID=<you>.testnet NEAR_ACCOUNT_ID=<you>.testnet NEAR_CREDENTIALS_FILE=...
npm run cli -- attest --model Qwen/Qwen3.8-27B && NEAR_AI_API_KEY=... npm run cli -- ask --model Qwen/Qwen3.8-27B --prompt "hi" --max-tokens 16
npm run cli -- anchor .tee-receipts/receipts/<chat_id>.json && npm run cli -- verify .tee-receipts/receipts/<chat_id>.json
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
| `npm run web`, open `/web/` | Browser verify page: receipt #0 on testnet → VERIFIED; **Tamper one byte** → NOT VERIFIED (§2b) |
| `npm run cli -- history --model Qwen/Qwen3.8-27B` | Every attested signer key ever registered for the model (`--model ""` = gateway), kept after rotation |

## 4. How NEAR is used
- NEAR AI Cloud: TEE inference, attestation reports, response signatures.
- NEAR smart contract (Rust, near-sdk 5.30): on-chain EIP-191 `ecrecover` and `ed25519_verify` of the response signature, signer registry, receipt storage.

## 5. Architecture / contract methods / data retention
```
NEAR AI Cloud ──attestation report──▶ client: verify TDX + NVIDIA off-chain ──register_signer──▶ contract (owner)
NEAR AI Cloud ──reply bytes + TEE signature──▶ client: receipt bundle ──submit_receipt──▶ contract (anyone)
verifier (CLI or web/ page): bytes ──sha256──▶ verify_receipt ──▶ receipt + signer + attestation hash from history
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
npm test                 # offline: browser verifier logic on the testnet bundle, saved evidence re-verifies, no secrets in fixtures, real wasm on a local node (anchor, verify, tamper rejected)
npm run test:web         # headless Chromium (playwright-core) on web/ against REAL testnet: VERIFIED, tamper -> NOT VERIFIED, reset -> VERIFIED
                         # needs network + a Chromium: `npx playwright-core install chromium` or CHROME_PATH=/usr/bin/google-chrome
npm run test:contract    # cargo unit tests (needs Rust)
npm run build:contract   # rebuild the wasm into contracts/receipts/res/ (needs cargo-near)
```

## 9. Honesty about the demo (read this)
- **The primary path is real.** `demo:live` and the CLI fetch a fresh attestation with our own nonce, run a real NEAR AI Cloud completion, fetch its real TEE signature, and anchor it.
- **Saved fixtures.** `fixtures/demo/attestation-evidence.json` is a real attestation report fetched from `cloud-api.near.ai`. `fixtures/demo/receipt-bundle.json` is saved by `demo:live --save-fixtures`; it holds the exact request/response bytes and the real signature, and never an API key or auth header (`npm test` checks this).
- **What replay re-checks offline.** It re-checks the Intel TDX quote against the Intel collateral saved at fetch time ("as of" that time, not now). It reuses the recorded NVIDIA NRAS verdict without re-checking the JWT signature offline. The response signature and every on-chain check run for real.
- **Fallback when no real receipt is saved.** If no real receipt fixture exists, replay uses a SIMULATED receipt on top of the real attestation and says so. **Current state:** real receipts are saved: `fixtures/demo/receipt-bundle.json` (anchored on a local node) and `fixtures/testnet/receipt-bundle.json` (anchored on NEAR testnet, §2a). Replay uses the real one.
- **`--simulated`** uses a local throwaway key and model id `SIMULATED/not-near-ai` with a zero attestation hash. It is labelled everywhere and is not evidence that NEAR AI produced anything.
- Contract unit-test vectors (`contracts/receipts/tests/fixtures/local_vectors.json`) use throwaway local keys in the NEAR AI signature format.
- The local node is a throwaway sandbox. Tx hashes and receipt ids from it are not on a public network. The testnet run in §2a is on the public NEAR testnet; the contract owner (who registers signers) is our own account, so trust in a registered signer rests on that account having run the off-chain checks, which anyone can redo from the saved evidence.

## 10. Built during the hackathon / libraries / AI tools
All code in this repo was written during the hackathon. Libraries: near-sdk, near-api-js, near-sandbox, ethers, tweetnacl, @phala/dcap-qvl; verify page: @noble/curves + @noble/hashes 2.4.0 (MIT, vendored unmodified as an esbuild bundle in `web/vendor/`, license in `web/vendor/LICENSE-noble`); playwright-core (dev, headless test only). Verification logic follows the NEAR AI Cloud docs (https://docs.near.ai/cloud/verification). AI coding assistants were used. TODO: MIT notice for any ported example code.

## 11. Disclosure
The same author also submitted agent-pay (https://github.com/tmdry4530/agent-pay-public, tracks security + agents). The projects share no code and solve different problems.

## 12. Limitations / License
Limitations:
- TDX and NVIDIA evidence is checked off-chain. On-chain trust in a signer rests on the owner who registered it, and the stored attestation hash lets anyone re-check that registration.
- A receipt proves which attested key signed which bytes. It does not prove the answer is correct.
- Signer registrations expire (max 7 days), so keys must be re-attested.

MIT, see [LICENSE](LICENSE).
