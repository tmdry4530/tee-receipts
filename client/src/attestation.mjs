// NEAR AI Cloud attestation checks. Logic follows
// https://docs.near.ai/cloud/verification/reference/quote-nonce-signer (dcap-qvl + RTMR3 replay + NVIDIA NRAS).
// Live mode fetches Intel collateral and asks NRAS; replay mode re-checks the quote OFFLINE against the
// collateral saved at fetch time (as of that time) and shows the recorded NRAS verdict.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { getCollateral, verify as dcapVerify, PHALA_PCCS_URL } from '@phala/dcap-qvl';

const hexBytes = (v) => Buffer.from(String(v).replace(/^0x/i, ''), 'hex');
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const hash = (alg, ...parts) => { const h = createHash(alg); for (const p of parts) h.update(p); return h.digest(); };
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';

export function replayRtmr3(eventLog) {
  let rtmr3 = Buffer.alloc(48);
  for (const ev of parse(eventLog)) {
    if (ev.imr !== 3) continue;
    const t = Buffer.alloc(4); t.writeUInt32LE(ev.event_type);
    const digest = hash('sha384', t, ':', Buffer.from(ev.event, 'utf8'), ':', hexBytes(ev.event_payload ?? ''));
    if (ev.digest && !hexBytes(ev.digest).equals(digest)) throw new Error(`digest mismatch for event ${ev.event}`);
    rtmr3 = hash('sha384', rtmr3, digest);
  }
  return rtmr3;
}

/**
 * Check one NEAR report (gateway_attestation or a model_attestations[] entry).
 * opts.collateral + opts.atSecs => offline; otherwise collateral is fetched (returned for saving).
 * Returns { checks: [{check, ok, detail}], collateral }.
 */
export async function checkNearReport(report, nonceHex, opts = {}) {
  const acceptedTcb = opts.acceptedTcb ?? ['UpToDate'];
  const checks = [];
  const add = (check, ok, detail = '') => checks.push({ check, ok: !!ok, detail });
  const quoteBytes = hexBytes(report.intel_quote);
  let collateral = opts.collateral;
  let quote;
  try {
    collateral ??= await getCollateral(PHALA_PCCS_URL, quoteBytes);
    const at = opts.atSecs ?? Math.floor(Date.now() / 1000);
    const verified = dcapVerify(quoteBytes, collateral, at);
    const when = opts.atSecs ? ` (offline, as of ${new Date(at * 1000).toISOString()})` : '';
    add('intel_tdx_quote_signature', true, `dcap-qvl${when}`);
    add('tcb_status_accepted', acceptedTcb.includes(verified.status), `${verified.status} ${(verified.advisory_ids ?? []).join(',')}`.trim());
    add('quote_type_td10', verified.report.type === 'td10');
    quote = verified.report.data;
  } catch (e) {
    add('intel_tdx_quote_signature', false, e.message);
    return { checks, collateral };
  }
  add('tdx_debug_off', !(quote.tdAttributes[0] & 1));
  const id = hexBytes(report.signing_address);
  const bound = report.tls_cert_fingerprint
    ? hash('sha256', id, hexBytes(report.tls_cert_fingerprint))
    : Buffer.concat([id, Buffer.alloc(32 - id.length)]);
  add('report_data_binds_signer_and_nonce', Buffer.from(quote.reportData).equals(Buffer.concat([bound, hexBytes(nonceHex)])));
  add('echoed_nonce_matches', String(report.request_nonce).toLowerCase() === nonceHex.toLowerCase());
  const appCompose = parse(report.info.tcb_info).app_compose;
  const expectedCfg = Buffer.concat([Buffer.from([1]), hash('sha256', Buffer.from(appCompose, 'utf8')), Buffer.alloc(15)]);
  add('mrconfigid_matches_app_compose', Buffer.from(quote.mrConfigId).equals(expectedCfg));
  try { add('rtmr3_event_log_replay', replayRtmr3(report.event_log).equals(Buffer.from(quote.rtMr3))); }
  catch (e) { add('rtmr3_event_log_replay', false, e.message); }
  return { checks, collateral };
}

const jwtClaims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

/** NVIDIA GPU evidence. opts.recordedNras => offline (shows the recorded verdict; JWT signature not re-checked). */
export async function checkGpu(report, nonceHex, opts = {}) {
  if (!report.nvidia_payload) return { checks: [{ check: 'nvidia_gpu_evidence_present', ok: false, detail: 'absent' }] };
  const payload = parse(report.nvidia_payload);
  const checks = [{ check: 'gpu_payload_nonce_matches', ok: String(payload.nonce).toLowerCase() === nonceHex.toLowerCase(), detail: '' }];
  if (!checks[0].ok) return { checks };
  let nras = opts.recordedNras;
  let detail = 'recorded NRAS verdict (offline; JWT signature not re-checked)';
  if (!nras) {
    const res = await fetch(NRAS_URL, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    nras = await res.json();
    detail = `live NRAS http ${res.status}`;
  }
  const jwt = nras?.[0]?.[1];
  const claims = jwt ? jwtClaims(jwt) : {};
  checks.push({ check: 'nvidia_nras_overall_result', ok: claims['x-nvidia-overall-att-result'] === true, detail });
  checks.push({ check: 'nvidia_eat_nonce_matches', ok: String(claims.eat_nonce ?? '').toLowerCase() === nonceHex.toLowerCase(), detail: '' });
  return { checks, nras };
}
