// Zero-credit probe: fetch a FRESH NEAR AI Cloud attestation (gateway + NEAR model) with our own nonce,
// WITHOUT an API key (works as of 2026-11-01; the docs show an Authorization header, so this may change),
// then verify it: Intel TDX quote (dcap-qvl), nonce + signer binding, MRCONFIGID, RTMR3, NVIDIA NRAS.
// Usage: node scripts/probe-attestation.mjs [MODEL_ID] [--save]
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { checkNearReport, checkGpu, sha256Hex } from '../src/attestation.mjs';

const model = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'Qwen/Qwen3.8-27B';
const nonce = randomBytes(32).toString('hex');
const url = 'https://cloud-api.near.ai/v1/attestation/report?' +
  new URLSearchParams({ model, provider: 'near', signing_algo: 'ecdsa', nonce });
const headers = { Accept: 'application/json', 'x-no-aliasing': 'true' };
if (process.env.NEAR_AI_CLOUD_API_KEY) headers.Authorization = `Bearer ${process.env.NEAR_AI_CLOUD_API_KEY}`;
const res = await fetch(url, { headers });
const raw = Buffer.from(await res.arrayBuffer());
if (!res.ok) { console.error(`attestation HTTP ${res.status}`); process.exit(1); }
const body = JSON.parse(raw);
console.log(`model=${model} nonce=${nonce} report_sha256=${sha256Hex(raw)} (api key used: ${!!headers.Authorization})`);

let allOk = true;
const print = (who, checks) => { for (const c of checks) { allOk &&= c.ok; console.log(`${c.ok ? 'PASS' : 'FAIL'} ${who} ${c.check} ${c.detail}`); } };
print('gateway', await checkNearReport(body.gateway_attestation, nonce));
console.log(`     gateway signer ${body.gateway_attestation.signing_algo} ${body.gateway_attestation.signing_address}`);
const cands = body.model_attestations ?? [];
if (!cands.length) { console.log('FAIL model no model_attestations'); allOk = false; }
for (const m of cands) {
  print('model  ', await checkNearReport(m, nonce));
  print('model  ', await checkGpu(m, nonce));
  console.log(`     model signer ${m.signing_algo} ${m.signing_address} (${m.model_name})`);
}
if (process.argv.includes('--save')) {
  const dir = new URL('../../fixtures/attestation/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const name = `${model.replace(/[^A-Za-z0-9.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(new URL(name, dir), JSON.stringify({ fetched_at: new Date().toISOString(), model, nonce, report_sha256: sha256Hex(raw), report: body }));
  console.log(`saved fixtures/attestation/${name}`);
}
console.log(allOk ? 'ALL ATTESTATION CHECKS PASSED' : 'SOME CHECKS FAILED');
process.exit(allOk ? 0 : 1);
