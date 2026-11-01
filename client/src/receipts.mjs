// Receipt bundles and the attest -> register -> ask -> anchor -> verify flow.
// A bundle holds the exact request/response bytes locally; only hashes + signature go on-chain.
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { chatCompletion, getSignature } from './nearai.mjs';
import { responseSignatureText, sha256Hex, verifyResponseSignature } from './signature.mjs';

export const BUNDLE_TYPE = 'tee-receipts/receipt-bundle/v1';
export const SIMULATED_MODEL = 'SIMULATED/not-near-ai';
const ZERO32 = '00'.repeat(32);

export async function registerSigners(near, evidence, signers, ttlSeconds = 3600) {
  const out = [];
  for (const s of signers) {
    const tx = await near.call('register_signer', {
      signing_algo: s.signing_algo, signing_address: s.signing_address, kind: s.kind, model_id: s.model_id,
      attestation_hash: evidence.report_sha256, nonce: evidence.nonce, ttl_seconds: ttlSeconds,
      signing_public_key: s.signing_algo === 'ecdsa' ? s.signing_public_key : null,
    });
    out.push({ signer: s, ...tx });
  }
  return out;
}

/** Real NEAR AI Cloud completion + its TEE signature. */
export async function askNearAi({ model, prompt, maxTokens = 64, evidence }) {
  const c = await chatCompletion({ model, prompt, maxTokens });
  const sig = await getSignature(c.chatId, model, 'ecdsa');
  return makeBundle({ model, chatId: c.chatId, requestBytes: c.requestBytes, responseBytes: c.responseBytes, sig, evidence, simulated: false, usage: c.json.usage });
}

function makeBundle({ model, chatId, requestBytes, responseBytes, sig, evidence, simulated, usage }) {
  const kind = sig.signature_kind ?? 'provider_tee';
  return {
    type: BUNDLE_TYPE,
    simulated,
    ...(simulated ? { warning: 'SIMULATED: signed by a local throwaway key, NOT by NEAR AI Cloud. Not evidence of anything.' } : {}),
    model, chat_id: chatId, created_at: new Date().toISOString(), usage: usage ?? null,
    request_b64: Buffer.from(requestBytes).toString('base64'),
    response_b64: Buffer.from(responseBytes).toString('base64'),
    request_hash: sha256Hex(requestBytes), response_hash: sha256Hex(responseBytes),
    signature: { text: sig.text, signature: sig.signature, signing_address: String(sig.signing_address).toLowerCase(), signing_algo: sig.signing_algo, signature_kind: kind },
    attestation: evidence ? { report_sha256: evidence.report_sha256, nonce: evidence.nonce, fetched_at: evidence.fetched_at } : null,
    anchored: null,
  };
}

/** Offline fallback: a local key signs in the NEAR AI format. Everything is labelled SIMULATED. */
export async function simulatedSetup() {
  const wallet = Wallet.createRandom();
  const evidence = { type: 'SIMULATED', report_sha256: ZERO32, nonce: randomBytes(32).toString('hex'), fetched_at: new Date().toISOString() };
  const signer = { kind: 'provider_tee', model_id: SIMULATED_MODEL, signing_algo: 'ecdsa', signing_address: wallet.address.toLowerCase(), signing_public_key: wallet.signingKey.publicKey.slice(4) };
  const ask = async (prompt) => {
    const requestBytes = Buffer.from(JSON.stringify({ model: SIMULATED_MODEL, messages: [{ role: 'user', content: prompt }], stream: false }));
    const responseBytes = Buffer.from(JSON.stringify({ id: `simulated-${Date.now()}`, object: 'chat.completion', model: SIMULATED_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: '[SIMULATED reply, no model was called]' }, finish_reason: 'stop' }] }));
    const text = responseSignatureText(requestBytes, responseBytes, SIMULATED_MODEL);
    const sig = { text, signature: await wallet.signMessage(text), signing_address: wallet.address, signing_algo: 'ecdsa', signature_kind: 'provider_tee' };
    return makeBundle({ model: SIMULATED_MODEL, chatId: JSON.parse(responseBytes).id, requestBytes, responseBytes, sig, evidence, simulated: true });
  };
  return { evidence, signer, ask };
}

export const bundleBytes = (b) => ({ requestBytes: Buffer.from(b.request_b64, 'base64'), responseBytes: Buffer.from(b.response_b64, 'base64') });

/** Off-chain re-check: recompute hashes from bytes, rebuild signed text, verify the signature. */
export function checkBundleOffchain(bundle, { requestBytes, responseBytes } = bundleBytes(bundle)) {
  const rows = [];
  const add = (check, ok, detail = '') => rows.push({ who: 'receipt', check, ok: !!ok, detail });
  const reqH = sha256Hex(requestBytes), respH = sha256Hex(responseBytes);
  add('request_sha256_recomputed', reqH === bundle.request_hash, reqH);
  add('response_sha256_recomputed', respH === bundle.response_hash, respH);
  const kind = bundle.signature.signature_kind;
  const expected = responseSignatureText(requestBytes, responseBytes, kind === 'gateway' ? undefined : bundle.model);
  try {
    verifyResponseSignature({ signature: bundle.signature, expectedText: expected, preflightSigner: bundle.signature });
    add('signature_text_and_signer_verify_offchain', true, `${kind} ${bundle.signature.signing_algo} ${bundle.signature.signing_address}`);
  } catch (e) { add('signature_text_and_signer_verify_offchain', false, e.message); }
  return rows;
}

export async function anchor(near, bundle, hashes = bundle) {
  const s = bundle.signature;
  const tx = await near.call('submit_receipt', {
    signing_algo: s.signing_algo, signing_address: s.signing_address,
    model_id: s.signature_kind === 'gateway' ? '' : bundle.model,
    request_hash: hashes.request_hash, response_hash: hashes.response_hash, signature: s.signature,
  });
  return { receiptId: tx.value, ...tx };
}

/** On-chain check: receipt exists for these exact hashes, and its attestation is in the signer history. */
export async function verifyOnChain(near, bundle, { requestBytes, responseBytes } = bundleBytes(bundle)) {
  const rows = [];
  const add = (check, ok, detail = '') => rows.push({ who: 'on-chain', check, ok: !!ok, detail });
  const r = await near.view('verify_receipt', { request_hash: sha256Hex(requestBytes), response_hash: sha256Hex(responseBytes) });
  add('verify_receipt(sha256 req, sha256 resp)', !!r, r ? `receipt #${r.id} block ${r.block_height} by ${r.submitted_by}` : 'no receipt for these bytes');
  if (r) {
    add('signer_matches_signature', r.signing_address === bundle.signature.signing_address.replace(/^0x/, ''), r.signing_address);
    const hist = await near.view('get_signer_history', { model_id: r.model_id, from_index: null, limit: 100 });
    const h = hist.find((x) => x.signing_address === r.signing_address && x.attestation_hash === r.attestation_hash);
    add('attested_signer_in_history', !!h, h ? `attestation ${r.attestation_hash.slice(0, 16)}… nonce ${h.nonce.slice(0, 16)}…` : '');
    if (bundle.attestation) add('attestation_hash_matches_local_evidence', r.attestation_hash === bundle.attestation.report_sha256, '');
  }
  return { rows, receipt: r };
}
