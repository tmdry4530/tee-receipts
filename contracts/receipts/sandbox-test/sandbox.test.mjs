// Deploys target/near/tee_receipts_contract.wasm to a LOCAL near-sandbox node (no testnet,
// no real keys) and checks the on-chain signature path with the real NEAR runtime.
// Build first:  (cd .. && cargo near build non-reproducible-wasm --no-abi)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPairSigner, teraToGas } from 'near-api-js';

const wasm = readFileSync(new URL('../target/near/tee_receipts_contract.wasm', import.meta.url));
const { vectors } = JSON.parse(readFileSync(new URL('../tests/fixtures/local_vectors.json', import.meta.url)));
const ATT = '11'.repeat(32);
const NONCE = '06e1c8d43eb0626192e0b99126fc248f73f5b7b6eabea359aa8f64983fa4dab7';

let sandbox, provider, root;
before(async () => {
  sandbox = await Sandbox.start({});
  provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  root = new Account(DEFAULT_ACCOUNT_ID, provider, KeyPairSigner.fromSecretKey(DEFAULT_PRIVATE_KEY));
  await root.deployContract(wasm);
  await root.callFunction({ contractId: DEFAULT_ACCOUNT_ID, methodName: 'new', args: { owner: DEFAULT_ACCOUNT_ID } });
});
after(async () => { await sandbox?.tearDown(); });

const call = (methodName, args) =>
  root.callFunction({ contractId: DEFAULT_ACCOUNT_ID, methodName, args, gas: teraToGas('100') });
const view = async (method, args) => { const r = await provider.callFunction({ contractId: DEFAULT_ACCOUNT_ID, method, args }); return r === undefined ? null : r; };

test('view: every vector (ecdsa+ed25519, provider_tee+gateway) verifies in the wasm runtime', async () => {
  for (const v of vectors) {
    const ok = await view('check_response_signature', {
      signing_algo: v.signing_algo, signing_address: v.signing_address, kind: v.signature_kind,
      model_id: v.model_id, request_hash: v.request_hash, response_hash: v.response_hash, signature: v.signature,
    });
    assert.equal(ok, true, `${v.signing_algo}/${v.signature_kind}`);
  }
  const v = vectors[0];
  const bad = await view('check_response_signature', {
    signing_algo: v.signing_algo, signing_address: v.signing_address, kind: v.signature_kind,
    model_id: 'other/model', request_hash: v.request_hash, response_hash: v.response_hash, signature: v.signature,
  });
  assert.equal(bad, false);
});

test('tx: register signer (pubkey checked) + submit receipt with on-chain ecrecover', async () => {
  const v = vectors.find((x) => x.signing_algo === 'ecdsa' && x.signature_kind === 'provider_tee');
  await call('register_signer', {
    signing_algo: 'ecdsa', signing_address: v.signing_address, kind: 'provider_tee', model_id: v.model_id,
    attestation_hash: ATT, nonce: NONCE, ttl_seconds: 3600, signing_public_key: v.signing_public_key,
  });
  const outcome = await root.signAndSendTransaction({
    receiverId: DEFAULT_ACCOUNT_ID,
    actions: [(await import('near-api-js')).actions.functionCall('submit_receipt', {
      signing_algo: 'ecdsa', signing_address: v.signing_address, model_id: v.model_id,
      request_hash: v.request_hash, response_hash: v.response_hash, signature: v.signature,
    }, teraToGas('100'), 0n)],
  });
  const burnt = outcome.receipts_outcome.reduce((s, r) => s + BigInt(r.outcome.gas_burnt), BigInt(outcome.transaction_outcome.outcome.gas_burnt));
  console.log(`submit_receipt total gas burnt: ${(Number(burnt) / 1e12).toFixed(2)} Tgas`);
  const r = await view('verify_receipt', { request_hash: v.request_hash, response_hash: v.response_hash });
  assert.equal(r.id, 0);
  assert.equal(r.signing_address, v.signing_address.toLowerCase().replace(/^0x/, ''));
  assert.equal(await view('verify_receipt', { request_hash: '00'.repeat(32), response_hash: v.response_hash }), null);
});

test('tx: tampered response hash is rejected on-chain', async () => {
  const v = vectors.find((x) => x.signing_algo === 'ecdsa' && x.signature_kind === 'provider_tee');
  await assert.rejects(call('submit_receipt', {
    signing_algo: 'ecdsa', signing_address: v.signing_address, model_id: v.model_id,
    request_hash: v.request_hash, response_hash: 'ff' + v.response_hash.slice(2), signature: v.signature,
  }), /signature does not verify/);
});
