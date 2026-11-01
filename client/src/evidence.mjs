// Attestation evidence files: everything needed to re-check a NEAR AI Cloud attestation later, offline.
// Contains only public data (report, Intel collateral, NVIDIA verdict). No API key, no auth headers.
import { randomBytes } from 'node:crypto';
import { computeAddress } from 'ethers';
import { fetchAttestation } from './nearai.mjs';
import { checkNearReport, checkGpu, sha256Hex } from './attestation.mjs';

export const EVIDENCE_TYPE = 'tee-receipts/attestation-evidence/v1';

function signerOf(report, kind, modelId) {
  return {
    kind, model_id: modelId, signing_algo: report.signing_algo,
    signing_address: String(report.signing_address).toLowerCase(),
    signing_public_key: report.signing_public_key ? String(report.signing_public_key).replace(/^0x/i, '').replace(/^04(?=[0-9a-f]{128}$)/i, '') : null,
  };
}

/** Live: fresh nonce -> fetch report -> verify (fetching collateral + NRAS) -> evidence object. */
export async function collectAttestation(model) {
  const nonce = randomBytes(32).toString('hex');
  const { url, raw, body } = await fetchAttestation(model, nonce);
  const evidence = {
    type: EVIDENCE_TYPE, source: 'NEAR AI Cloud /v1/attestation/report', url, model, nonce,
    fetched_at: new Date().toISOString(), report_sha256: sha256Hex(Buffer.from(raw, 'utf8')),
    report_raw: raw, collateral: {}, nras: {},
  };
  const result = await verifyEvidence(evidence, { live: true, parsed: body });
  return { evidence, result };
}

/**
 * Verify an evidence object. live=true fetches collateral/NRAS and stores them into the evidence;
 * otherwise uses the stored collateral (as of fetched_at) and recorded NRAS verdicts.
 * Returns { ok, rows, signers } where signers passed every check.
 */
export async function verifyEvidence(evidence, { live = false, parsed } = {}) {
  const rows = [];
  const signers = [];
  const ok = (who, c) => { rows.push({ who, ...c }); return c.ok; };
  const body = parsed ?? JSON.parse(evidence.report_raw);
  ok('evidence', { check: 'report_sha256_matches_raw_bytes', ok: sha256Hex(Buffer.from(evidence.report_raw, 'utf8')) === evidence.report_sha256, detail: evidence.report_sha256 });
  const atSecs = live ? undefined : Math.floor(Date.parse(evidence.fetched_at) / 1000);
  const reports = [['gateway', body.gateway_attestation, 'gateway', '']];
  for (const m of body.model_attestations ?? []) reports.push([`model ${m.signing_address.slice(0, 10)}`, m, 'provider_tee', m.model_name ?? evidence.model]);
  if (reports.length < 2) ok('evidence', { check: 'model_attestations_present', ok: false, detail: '' });
  for (const [who, rep, kind, modelId] of reports) {
    if (!rep) { ok(who, { check: 'report_present', ok: false, detail: '' }); continue; }
    const key = String(rep.signing_address).toLowerCase();
    let pass = true;
    const r = await checkNearReport(rep, evidence.nonce, live ? {} : { collateral: evidence.collateral[key], atSecs });
    if (live && r.collateral) evidence.collateral[key] = r.collateral;
    for (const c of r.checks) pass = ok(who, c) && pass;
    const s = signerOf(rep, kind, modelId);
    if (s.signing_algo === 'ecdsa' && s.signing_public_key) {
      pass = ok(who, { check: 'public_key_hashes_to_address', ok: computeAddress('0x04' + s.signing_public_key).toLowerCase() === s.signing_address, detail: '' }) && pass;
    }
    if (kind === 'provider_tee') {
      const g = await checkGpu(rep, evidence.nonce, live ? {} : { recordedNras: evidence.nras[key] });
      if (live && g.nras) evidence.nras[key] = g.nras;
      for (const c of g.checks) pass = ok(who, c) && pass;
    }
    if (pass) signers.push(s);
  }
  return { ok: rows.every((r) => r.ok), rows, signers };
}

export function printRows(rows, log = console.log) {
  for (const r of rows) log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.who.padEnd(18)} ${r.check}${r.detail ? `  (${r.detail})` : ''}`);
}
