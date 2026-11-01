// Offline tests over the saved fixtures: no NEAR AI calls, no API key needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { verifyEvidence } from '../client/src/evidence.mjs';
import { simulatedSetup, checkBundleOffchain, registerSigners, anchor, verifyOnChain, bundleBytes } from '../client/src/receipts.mjs';
import { startLocalNode } from '../client/src/localnode.mjs';
import { connect } from '../client/src/near.mjs';
import { sha256Hex } from '../client/src/signature.mjs';

const FIX = new URL('../fixtures/demo/', import.meta.url);
const evidence = JSON.parse(readFileSync(new URL('attestation-evidence.json', FIX), 'utf8'));
const realBundleFile = new URL('receipt-bundle.json', FIX);

test('saved REAL attestation evidence re-verifies offline (Intel collateral as of fetch time)', async () => {
  const r = await verifyEvidence(evidence);
  assert.ok(r.ok, r.rows.filter((x) => !x.ok).map((x) => `${x.who} ${x.check} ${x.detail}`).join('; '));
  assert.ok(r.signers.some((s) => s.kind === 'gateway' && s.model_id === ''));
  assert.ok(r.signers.some((s) => s.kind === 'provider_tee' && s.model_id === evidence.model));
});

test('evidence fails if one byte of the saved report changes', async () => {
  const bad = { ...evidence, report_raw: evidence.report_raw.replace(/"signing_address":"0x./, (m) => m.slice(0, -1) + (m.at(-1) === 'a' ? 'b' : 'a')) };
  const r = await verifyEvidence(bad);
  assert.equal(r.ok, false);
});

test('fixtures contain no secrets (no API key, no auth header in receipt bundles)', () => {
  const key = process.env.NEAR_AI_API_KEY || process.env.NEAR_AI_CLOUD_API_KEY;
  for (const f of readdirSync(FIX)) {
    const s = readFileSync(new URL(f, FIX), 'utf8');
    if (key) assert.ok(!s.includes(key), `${f} contains the API key`);
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(s), `${f} has an sk- token`);
    if (f.startsWith('receipt')) assert.ok(!/authorization|bearer/i.test(s), `${f} has auth header text`);
  }
});

test('saved REAL receipt bundle verifies off-chain', () => {
  assert.ok(existsSync(realBundleFile), 'fixtures/demo/receipt-bundle.json (real NEAR AI receipt) is missing');
  const b = JSON.parse(readFileSync(realBundleFile, 'utf8'));
  assert.equal(b.simulated, false);
  assert.ok(!b.warning);
  assert.equal(b.signature.signature_kind, 'provider_tee');
  assert.equal(b.attestation.report_sha256, evidence.report_sha256);
  assert.ok(checkBundleOffchain(b).every((r) => r.ok));
});

test('local node: register real signers, anchor a receipt, verify, reject tampered', async () => {
  const node = await startLocalNode();
  try {
    const near = connect(node.cfg);
    const { signers } = await verifyEvidence(evidence);
    await registerSigners(near, evidence, signers);
    let bundle;
    if (existsSync(realBundleFile)) bundle = JSON.parse(readFileSync(realBundleFile, 'utf8'));
    else {
      const sim = await simulatedSetup();
      await registerSigners(near, sim.evidence, [sim.signer]);
      bundle = await sim.ask('test');
    }
    const a = await anchor(near, bundle);
    assert.equal(a.receiptId, 0);
    const v = await verifyOnChain(near, bundle);
    assert.ok(v.rows.every((r) => r.ok), JSON.stringify(v.rows));
    const { requestBytes, responseBytes } = bundleBytes(bundle);
    const t = Buffer.from(responseBytes); t[5] ^= 1;
    assert.equal((await verifyOnChain(near, bundle, { requestBytes, responseBytes: t })).receipt, null);
    await assert.rejects(anchor(near, bundle, { request_hash: bundle.request_hash, response_hash: sha256Hex(t) }), /signature does not verify/);
    await assert.rejects(anchor(near, bundle), /receipt already exists/);
    assert.equal(await near.view('signer_history_len', { model_id: evidence.model }), 1);
    assert.equal(await near.view('signer_history_len', { model_id: '' }), 1);
  } finally { await node.stop(); }
});
