// Offline test of the browser verifier logic (web/verify-core.js) on the real testnet receipt bundle.
// On-chain reads are covered by `npm run test:web` (headless browser against real testnet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBundle, b64ToBytes, checkOffchain, recoverEip191Address, tamperOneByte } from '../web/verify-core.js';

const bundle = parseBundle(readFileSync(new URL('../fixtures/testnet/receipt-bundle.json', import.meta.url), 'utf8'));
const req = b64ToBytes(bundle.request_b64), resp = b64ToBytes(bundle.response_b64);

test('browser verifier: real testnet bundle passes every off-chain check', () => {
  const { rows, requestHash, responseHash } = checkOffchain(bundle, req, resp);
  assert.ok(rows.every((r) => r.ok), JSON.stringify(rows, null, 1));
  assert.equal(requestHash, bundle.request_hash);
  assert.equal(responseHash, bundle.response_hash);
  assert.equal(recoverEip191Address(bundle.signature.text, bundle.signature.signature), bundle.signature.signing_address.slice(2));
});

test('browser verifier: one tampered response byte fails the hash and signed-text checks', () => {
  const t = tamperOneByte(resp);
  assert.equal([...t.bytes].filter((b, i) => b !== resp[i]).length, 1);
  JSON.parse(new TextDecoder().decode(t.bytes)); // still valid JSON
  const { rows } = checkOffchain(bundle, req, t.bytes);
  const failed = rows.filter((r) => !r.ok).map((r) => r.check);
  assert.equal(failed.length, 2, failed.join(' | '));
});

test('browser verifier: a signature from another key does not recover to the signer', () => {
  const bad = { ...bundle, signature: { ...bundle.signature, signing_address: '0x' + '11'.repeat(20) } };
  assert.equal(checkOffchain(bad, req, resp).rows.find((r) => r.check.startsWith('TEE signature')).ok, false);
});
