// Response-signature helpers. Logic follows the NEAR AI Cloud docs:
// https://docs.near.ai/cloud/verification/reference/response-signature-verification
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// provider_tee: "<MODEL_ID>:<req>:<resp>", gateway: "<req>:<resp>" (omit modelName)
export function responseSignatureText(requestBytes, responseBytes, modelName) {
  const hashes = `${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`;
  if (modelName === undefined) return hashes;
  if (typeof modelName !== 'string' || !modelName) throw new Error('modelName must be a non-empty string');
  return `${modelName}:${hashes}`;
}

function requireHex(value, label, expectedBytes) {
  if (typeof value !== 'string') throw new Error(`${label} must be hex`);
  const hex = value.replace(/^0x/i, '');
  if (!hex || !/^[0-9a-f]*$/i.test(hex) || hex.length % 2) throw new Error(`${label} must be hexadecimal`);
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length !== expectedBytes) throw new Error(`${label} must be ${expectedBytes} bytes`);
  return bytes;
}

function signerIdentity(value, label) {
  const algorithm = value?.signing_algo;
  if (algorithm !== 'ecdsa' && algorithm !== 'ed25519') throw new Error(`${label}.signing_algo is unsupported`);
  return {
    algorithm,
    address: requireHex(value.signing_address, `${label}.signing_address`, algorithm === 'ecdsa' ? 20 : 32),
  };
}

const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// signature = JSON from GET /v1/signature/<chat_id>; preflightSigner = verified attestation report identity.
export function verifyResponseSignature({ signature, expectedText, preflightSigner }) {
  if (typeof signature?.text !== 'string' || signature.text !== expectedText) {
    throw new Error('signature text does not match the exact request/response bytes');
  }
  const signer = signerIdentity(signature, 'signature');
  const sigBytes = requireHex(signature.signature, 'signature.signature', signer.algorithm === 'ecdsa' ? 65 : 64);
  if (signer.algorithm === 'ecdsa') {
    const recovered = requireHex(
      ethers.verifyMessage(Buffer.from(signature.text, 'utf8'), ethers.hexlify(sigBytes)),
      'recovered signer',
      20,
    );
    if (!sameBytes(recovered, signer.address)) throw new Error('ECDSA signature does not match signing_address');
  } else if (!nacl.sign.detached.verify(Buffer.from(signature.text, 'utf8'), sigBytes, signer.address)) {
    throw new Error('Ed25519 signature does not match signing_address');
  }
  const preflight = signerIdentity(preflightSigner, 'preflightSigner');
  if (preflight.algorithm !== signer.algorithm || !sameBytes(preflight.address, signer.address)) {
    throw new Error('signature signer does not match verified preflight evidence');
  }
  return true;
}
