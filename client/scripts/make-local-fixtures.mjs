// Day-1 spike: produce signatures in the exact NEAR AI Cloud response-signature format
// with LOCALLY GENERATED throwaway keys (not NEAR AI keys), verify them with the
// docs' reference logic, and write them as test vectors for the Rust contract tests.
import { writeFileSync, mkdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import { responseSignatureText, sha256Hex, verifyResponseSignature } from '../src/signature.mjs';

const outDir = new URL('../../contracts/receipts/tests/fixtures/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const model = 'Qwen/Qwen3.8-27B';
const requestBytes = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'Flag unusual clauses in this fictional contract.' }], stream: false }));
const responseBytes = Buffer.from('{"id":"chatcmpl-local-fixture","object":"chat.completion","model":"Qwen/Qwen3.8-27B","choices":[{"index":0,"message":{"role":"assistant","content":"Clause 7 is unusual."},"finish_reason":"stop"}]}');
const request_hash = sha256Hex(requestBytes);
const response_hash = sha256Hex(responseBytes);

const vectors = [];

for (const kind of ['provider_tee', 'gateway']) {
  const text = responseSignatureText(requestBytes, responseBytes, kind === 'provider_tee' ? model : undefined);
  // ECDSA (EIP-191 personal_sign), like signing_algo=ecdsa
  const wallet = ethers.Wallet.createRandom();
  const ecdsaSig = { text, signature: await wallet.signMessage(text), signing_address: wallet.address, signing_algo: 'ecdsa', signature_kind: kind };
  verifyResponseSignature({ signature: ecdsaSig, expectedText: text, preflightSigner: { signing_algo: 'ecdsa', signing_address: wallet.address } });
  vectors.push({ ...ecdsaSig, model_id: kind === 'provider_tee' ? model : '', request_hash, response_hash,
    signing_public_key: wallet.signingKey.publicKey.slice(4) /* drop 0x04 */ });

  // Ed25519, like signing_algo=ed25519
  const kp = nacl.sign.keyPair();
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(text, 'utf8'), kp.secretKey)).toString('hex');
  const addr = Buffer.from(kp.publicKey).toString('hex');
  const edSig = { text, signature: sig, signing_address: addr, signing_algo: 'ed25519', signature_kind: kind };
  verifyResponseSignature({ signature: edSig, expectedText: text, preflightSigner: { signing_algo: 'ed25519', signing_address: addr } });
  vectors.push({ ...edSig, model_id: kind === 'provider_tee' ? model : '', request_hash, response_hash });
}

writeFileSync(new URL('local_vectors.json', outDir), JSON.stringify({
  note: 'Throwaway keys generated locally by client/scripts/make-local-fixtures.mjs. Same signed-text format and algorithms as NEAR AI Cloud /v1/signature. Not real NEAR AI evidence.',
  vectors,
}, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors; all pass the docs reference verifier (ethers.verifyMessage / nacl)`);
