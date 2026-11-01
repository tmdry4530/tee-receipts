// DOM glue for the verify page. All checks live in verify-core.js.
import { DEFAULTS, parseBundle, b64ToBytes, verifyBundle, tamperOneByte } from './verify-core.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEFAULT_BUNDLE = params.get('bundle') ?? '../fixtures/testnet/receipt-bundle.json';
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const state = { bundle: null, req: null, resp: null, editable: true, run: 0 };

$('rpc').value = params.get('rpc') ?? DEFAULTS.rpcUrl;
$('contract').value = params.get('contract') ?? DEFAULTS.contractId;

const isTestnet = () => /testnet/.test($('rpc').value) || $('contract').value.endsWith('.testnet');
const explorer = (path) => `https://${isTestnet() ? 'testnet.' : ''}nearblocks.io/${path}`;
const short = (h, n = 10) => (h && h.length > 2 * n ? `${h.slice(0, n)}…${h.slice(-4)}` : h ?? '');
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
}
function utf8OrNull(bytes) {
  try { const s = dec.decode(bytes); return enc.encode(s).length === bytes.length ? s : null; } catch { return null; }
}

function setBytes(req, resp) {
  state.req = req; state.resp = resp;
  const rs = utf8OrNull(resp), qs = utf8OrNull(req);
  state.editable = rs !== null && qs !== null && !/\r/.test(rs + qs);
  $('resp').value = rs ?? '(not UTF-8: shown as base64, read-only)\n' + state.bundle.response_b64;
  $('req').value = qs ?? state.bundle.request_b64;
  $('resp').readOnly = $('req').readOnly = !state.editable;
  showMeta();
}

function showMeta() {
  const b = state.bundle;
  let prompt = '–', reply = '–';
  try { prompt = JSON.parse(dec.decode(state.req)).messages.map((m) => `${m.role}: ${m.content}`).join('\n'); } catch { /* raw */ }
  try {
    const m = JSON.parse(dec.decode(state.resp)).choices[0].message;
    reply = m.content ?? (m.reasoning_content ? `(reasoning) ${m.reasoning_content}` : '–');
  } catch { reply = '(response bytes are not valid JSON any more)'; }
  $('m-model').textContent = b.model + (b.simulated ? '  ⚠ SIMULATED bundle: not signed by NEAR AI' : '');
  $('m-prompt').textContent = prompt;
  $('m-reply').textContent = reply;
  $('m-signer').textContent = `${b.signature.signing_algo} ${b.signature.signing_address} (${b.signature.signature_kind ?? 'provider_tee'})`;
}

function loadBundle(json, source) {
  try {
    state.bundle = parseBundle(json);
    $('load-status').textContent = `Loaded ${source} · chat ${state.bundle.chat_id ?? '?'} · created ${state.bundle.created_at ?? '?'}`;
    $('tamper-note').textContent = '';
    setBytes(b64ToBytes(state.bundle.request_b64), b64ToBytes(state.bundle.response_b64));
    return verify();
  } catch (e) {
    $('load-status').textContent = `Could not load ${source}: ${e.message}`;
  }
}

async function loadDefault() {
  try {
    const r = await fetch(DEFAULT_BUNDLE, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return loadBundle(await r.text(), DEFAULT_BUNDLE);
  } catch (e) {
    $('load-status').textContent = `Could not fetch ${DEFAULT_BUNDLE} (${e.message}). Serve the repo over http (npm run web), or open/paste a bundle.`;
  }
}

function syncFromTextareas() {
  if (!state.editable) return;
  state.req = enc.encode($('req').value);
  state.resp = enc.encode($('resp').value);
}

async function verify() {
  if (!state.bundle) return;
  const run = ++state.run;
  for (const id of ['verify', 'tamper', 'reset']) $(id).disabled = true;
  const v = $('verdict');
  v.className = 'verdict busy'; v.textContent = 'Checking…';
  document.body.dataset.verdict = 'busy';
  $('checks').replaceChildren(); $('receipt').replaceChildren();
  try {
    const res = await verifyBundle(state.bundle, { requestBytes: state.req, responseBytes: state.resp, rpcUrl: $('rpc').value.trim(), contractId: $('contract').value.trim() });
    if (run !== state.run) return;
    render(res);
  } finally {
    if (run === state.run) for (const id of ['verify', 'tamper', 'reset']) $(id).disabled = false;
  }
}

function render(res) {
  const v = $('verdict');
  v.className = `verdict ${res.verified ? 'ok' : 'bad'}`;
  v.textContent = res.verified ? '✔ VERIFIED' : '✘ NOT VERIFIED';
  document.body.dataset.verdict = res.verified ? 'verified' : 'not-verified';
  $('checks').replaceChildren(...res.rows.map((r) => el('li', { className: r.ok ? 'ok' : 'bad' },
    el('span', { className: 'mark', textContent: r.ok ? '✔' : '✘' }),
    el('span', { className: 'grp', textContent: r.group }),
    el('span', {}, r.check, el('span', { className: 'detail', textContent: r.detail })))));
  const rc = res.receipt, b = state.bundle;
  const box = $('receipt');
  if (rc) {
    box.append(`Receipt #${rc.id} on ${$('contract').value} · block ${rc.block_height} · anchored ${new Date(rc.timestamp_ms).toISOString()} · `,
      el('a', { href: explorer(`address/${$('contract').value}`), target: '_blank', rel: 'noopener', textContent: 'contract' }));
    if (b.anchored?.tx_hash) box.append(' · ', el('a', { href: explorer(`txns/${b.anchored.tx_hash}`), target: '_blank', rel: 'noopener', textContent: `tx ${short(b.anchored.tx_hash, 8)}` }));
  } else {
    box.append('No receipt on-chain matches these exact bytes. Changing even one byte changes sha256, so the stored receipt and the TEE signature no longer apply.');
  }
  const all = [...res.history, ...res.gatewayHistory];
  $('hist-body').replaceChildren(...(all.length ? all.map((h, i) => {
    const active = Date.now() < h.expires_at_ms;
    const hit = rc && h.signing_address === rc.signing_address && h.attestation_hash === rc.attestation_hash;
    return el('tr', { className: hit ? 'hit' : '' },
      el('td', { textContent: String(i) }),
      el('td', { textContent: `${h.kind}${h.model_id ? ` · ${h.model_id}` : ''}` }),
      el('td', { className: 'mono', textContent: `0x${h.signing_address}` }),
      el('td', { className: 'mono', textContent: short(h.attestation_hash, 12) }),
      el('td', { textContent: new Date(h.registered_at_ms).toISOString().replace('.000Z', 'Z') }),
      el('td', { textContent: new Date(h.expires_at_ms).toISOString().replace(/\.\d+Z/, 'Z') }),
      el('td', {}, el('span', { className: `tag ${active ? 'on' : 'off'}`, textContent: active ? 'active' : 'expired (kept)' }),
        hit ? el('span', { textContent: ' ← signed this receipt' }) : ''));
  }) : [el('tr', {}, el('td', { colSpan: 7, className: 'muted', textContent: 'No signer history returned.' }))]));
}

$('load-default').onclick = loadDefault;
$('file').onchange = async (e) => { const f = e.target.files[0]; if (f) loadBundle(await f.text(), f.name); };
$('load-paste').onclick = () => loadBundle($('paste').value, 'pasted JSON');
$('verify').onclick = () => { syncFromTextareas(); showMeta(); verify(); };
$('reset').onclick = () => { if (state.bundle) { $('tamper-note').textContent = ''; setBytes(b64ToBytes(state.bundle.request_b64), b64ToBytes(state.bundle.response_b64)); verify(); } };
$('tamper').onclick = () => {
  if (!state.bundle) return;
  syncFromTextareas();
  const t = tamperOneByte(state.resp);
  $('tamper-note').textContent = `Changed response byte ${t.pos}: '${t.from}' → '${t.to}'`;
  setBytes(state.req, t.bytes);
  verify();
};
for (const id of ['resp', 'req']) $(id).addEventListener('input', () => { $('tamper-note').textContent = 'Bytes edited: press Verify'; });

window.teeReceipts = { state, verify, loadBundle };
loadDefault();
