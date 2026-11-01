// Browser (and Node 22+) receipt verifier. No build step, no server: hashes and signatures are checked
// here with the vendored noble libs; the chain is read with plain JSON-RPC view calls (read-only, no key).
import { secp256k1, ed25519, keccak_256, sha256 } from './vendor/noble.js';

export const DEFAULTS = {
  rpcUrl: 'https://rpc.testnet.near.org',
  contractId: 'tee-receipts-chamdom.testnet',
  network: 'testnet',
};

const enc = new TextEncoder();
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('not hex');
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}
export const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const sha256Hex = (bytes) => toHex(sha256(bytes));
const strip = (h) => String(h ?? '').replace(/^0x/i, '').toLowerCase();

/** EIP-191 personal_sign recovery -> lowercase 20-byte address hex (no 0x). */
export function recoverEip191Address(text, sigHex) {
  const msg = enc.encode(text);
  const digest = keccak_256(new Uint8Array([...enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const sig = fromHex(sigHex);
  if (sig.length !== 65) throw new Error('ECDSA signature must be 65 bytes');
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v > 1) throw new Error('bad recovery id');
  const pub = secp256k1.recoverPublicKey(new Uint8Array([v, ...sig.subarray(0, 64)]), digest, { prehash: false });
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
  return toHex(keccak_256(uncompressed.subarray(1)).subarray(-20));
}

export function parseBundle(json) {
  const b = typeof json === 'string' ? JSON.parse(json) : json;
  if (b?.type !== 'tee-receipts/receipt-bundle/v1') throw new Error('not a tee-receipts/receipt-bundle/v1 JSON');
  for (const k of ['request_b64', 'response_b64', 'signature', 'model']) if (!b[k]) throw new Error(`bundle is missing ${k}`);
  return b;
}

/** Off-chain checks on the exact bytes. Returns { rows, requestHash, responseHash }. */
export function checkOffchain(bundle, requestBytes, responseBytes) {
  const rows = [];
  const add = (group, check, ok, detail = '') => rows.push({ group, check, ok: !!ok, detail });
  const requestHash = sha256Hex(requestBytes);
  const responseHash = sha256Hex(responseBytes);
  add('browser', 'sha256(request bytes) equals the bundle request_hash', requestHash === strip(bundle.request_hash), requestHash);
  add('browser', 'sha256(response bytes) equals the bundle response_hash', responseHash === strip(bundle.response_hash), responseHash);
  const s = bundle.signature;
  const kind = s.signature_kind ?? 'provider_tee';
  const expected = kind === 'gateway' ? `${requestHash}:${responseHash}` : `${bundle.model}:${requestHash}:${responseHash}`;
  add('browser', 'signed text rebuilt from these bytes equals the TEE-signed text', s.text === expected,
    s.text === expected ? expected : `expected ${expected}`);
  let sigOk = false, detail = '';
  try {
    if (s.signing_algo === 'ecdsa') {
      const rec = recoverEip191Address(s.text, s.signature);
      sigOk = rec === strip(s.signing_address);
      detail = `ecrecover -> 0x${rec}${sigOk ? '' : ` (bundle says 0x${strip(s.signing_address)})`}`;
    } else if (s.signing_algo === 'ed25519') {
      sigOk = ed25519.verify(fromHex(s.signature), enc.encode(s.text), fromHex(s.signing_address));
      detail = `ed25519 key ${strip(s.signing_address)}`;
    } else detail = `unsupported signing_algo ${s.signing_algo}`;
  } catch (e) { detail = e.message; }
  add('browser', `TEE signature (${s.signing_algo}) over the signed text recovers to the bundle signer`, sigOk, detail);
  return { rows, requestHash, responseHash };
}

/** Read-only NEAR view call over JSON-RPC. */
export async function view(rpcUrl, contractId, method, args = {}, fetchImpl = fetch) {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'tee-receipts', method: 'query', params: {
      request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method,
      args_base64: bytesToB64(enc.encode(JSON.stringify(args))) } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.cause?.name ?? j.error.message ?? JSON.stringify(j.error)}`);
  if (j.result?.error) throw new Error(`${method}: ${j.result.error}`);
  const text = new TextDecoder().decode(Uint8Array.from(j.result.result));
  return text ? JSON.parse(text) : null;
}

/** On-chain checks (testnet by default). Returns { rows, receipt, history, gatewayHistory }. */
export async function checkOnchain(bundle, requestHash, responseHash, { rpcUrl, contractId } = DEFAULTS, fetchImpl = fetch) {
  const rows = [];
  const add = (group, check, ok, detail = '') => rows.push({ group, check, ok: !!ok, detail });
  const v = (m, a) => view(rpcUrl, contractId, m, a, fetchImpl);
  const s = bundle.signature;
  const kind = s.signature_kind ?? 'provider_tee';
  const modelId = kind === 'gateway' ? '' : bundle.model;
  const safe = (p) => p.catch(() => []);
  // All reads in parallel: public RPCs are slow, the checks are independent.
  const [receipt, onchainSig, history, gatewayHistory] = await Promise.all([
    v('verify_receipt', { request_hash: requestHash, response_hash: responseHash }),
    // The contract itself re-runs ecrecover / ed25519 over these bytes' hashes (works with or without a receipt).
    v('check_response_signature', { signing_algo: s.signing_algo, signing_address: strip(s.signing_address), kind,
      model_id: modelId, request_hash: requestHash, response_hash: responseHash, signature: strip(s.signature) }),
    safe(v('get_signer_history', { model_id: modelId, from_index: null, limit: 100 })),
    modelId ? safe(v('get_signer_history', { model_id: '', from_index: null, limit: 100 })) : [],
  ]);
  add('NEAR', 'verify_receipt(sha256 req, sha256 resp) finds an anchored receipt', !!receipt,
    receipt ? `receipt #${receipt.id}, block ${receipt.block_height}, by ${receipt.submitted_by}` : 'no receipt for these bytes');
  add('NEAR', 'contract re-runs the signature check on-chain (check_response_signature)', onchainSig === true,
    onchainSig === true ? 'true' : 'false: the TEE signature does not cover these bytes');
  if (receipt) {
    add('NEAR', 'receipt signer and signature equal the bundle\'s',
      receipt.signing_address === strip(s.signing_address) && receipt.signature === strip(s.signature) && receipt.model_id === modelId,
      `0x${receipt.signing_address} · ${receipt.model_id || '(gateway)'}`);
    const h = history.find((x) => x.signing_address === receipt.signing_address && x.attestation_hash === receipt.attestation_hash);
    const inWindow = h && h.registered_at_ms <= receipt.timestamp_ms && receipt.timestamp_ms < h.expires_at_ms;
    add('NEAR', 'signer was attested + registered when the receipt was anchored (signer history)', !!inWindow,
      h ? `registered ${new Date(h.registered_at_ms).toISOString()}, receipt ${new Date(receipt.timestamp_ms).toISOString()}, expires ${new Date(h.expires_at_ms).toISOString()}` : 'signer/attestation not in history');
    if (bundle.attestation?.report_sha256) {
      add('NEAR', 'attestation hash on-chain equals the bundle\'s saved attestation report hash',
        receipt.attestation_hash === strip(bundle.attestation.report_sha256), receipt.attestation_hash);
    }
  }
  return { rows, receipt, history, gatewayHistory };
}

/** Full check. verdict = every row ok. */
export async function verifyBundle(bundle, { requestBytes, responseBytes, ...opts } = {}, fetchImpl = fetch) {
  const req = requestBytes ?? b64ToBytes(bundle.request_b64);
  const resp = responseBytes ?? b64ToBytes(bundle.response_b64);
  const off = checkOffchain(bundle, req, resp);
  let on;
  try { on = await checkOnchain(bundle, off.requestHash, off.responseHash, { ...DEFAULTS, ...opts }, fetchImpl); }
  catch (e) { on = { rows: [{ group: 'NEAR', check: 'read the contract over RPC', ok: false, detail: e.message }], receipt: null, history: [], gatewayHistory: [] }; }
  const rows = [...off.rows, ...on.rows];
  return { ...off, ...on, verified: rows.every((r) => r.ok), rows };
}

/** Flip one byte of the response JSON inside a string value (keeps it valid JSON) -> new bytes + position. */
export function tamperOneByte(bytes) {
  const out = new Uint8Array(bytes);
  const text = new TextDecoder().decode(out);
  // Prefer a letter inside the assistant text so the change is visible; fall back to the middle byte.
  const anchor = ['"reasoning_content":"', '"content":"'].map((k) => text.indexOf(k)).find((i) => i >= 0);
  let pos = -1;
  if (anchor !== undefined) {
    for (let i = anchor + 25; i < out.length; i++) if (/[a-zA-Z]/.test(String.fromCharCode(out[i]))) { pos = i; break; }
  }
  if (pos < 0) pos = out.length >> 1;
  const c = out[pos];
  out[pos] = /[a-z]/.test(String.fromCharCode(c)) ? c - 32 : /[A-Z]/.test(String.fromCharCode(c)) ? c + 32 : c ^ 1;
  return { bytes: out, pos, from: String.fromCharCode(c), to: String.fromCharCode(out[pos]) };
}
