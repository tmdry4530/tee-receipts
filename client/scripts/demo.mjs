// End-to-end demo on a throwaway local NEAR node.
//   --live       real NEAR AI Cloud: fresh attestation + real completion + real TEE signature (needs NEAR_AI_API_KEY)
//   --replay     offline: replays the saved REAL evidence + receipt from fixtures/demo (no NEAR AI calls, no key)
//   --simulated  offline fallback: local throwaway signer, everything labelled SIMULATED (not NEAR AI)
// Options: --model <id> --prompt <text> --max-tokens <n> --save-fixtures (live only)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { startLocalNode } from '../src/localnode.mjs';
import { connect } from '../src/near.mjs';
import { collectAttestation, verifyEvidence, printRows } from '../src/evidence.mjs';
import { registerSigners, askNearAi, simulatedSetup, checkBundleOffchain, anchor, verifyOnChain, bundleBytes } from '../src/receipts.mjs';
import { apiKey } from '../src/nearai.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const mode = argv.includes('--live') ? 'live' : argv.includes('--simulated') ? 'simulated' : 'replay';
const model = opt('model', 'Qwen/Qwen3.8-27B');
const prompt = opt('prompt', 'In one short sentence: what does a TEE attestation prove?');
const maxTokens = Number(opt('max-tokens', '64'));
const FIX = new URL('../../fixtures/demo/', import.meta.url);

let step = 0;
const say = (s) => console.log(`\n[${++step}] ${s}`);
const die = (m) => { console.error(`\nFAILED: ${m}`); process.exitCode = 1; throw new Error(m); };

console.log(`TEE Receipts demo, mode=${mode}${mode === 'simulated' ? '  *** SIMULATED: NO NEAR AI EVIDENCE ***' : ''}`);
if (mode === 'live' && !apiKey()) die('NEAR_AI_API_KEY is not set; use npm run demo:replay for the offline replay');

say('Start a throwaway local NEAR node and deploy the contract');
const node = await startLocalNode();
try {
  const near = connect(node.cfg);
  console.log(`  rpc ${node.cfg.rpcUrl}  contract ${node.cfg.contractId}  owner/registrar ${node.cfg.accountId}`);

  let evidence, signers, bundle;
  if (mode === 'simulated') {
    say('SIMULATED signer (local throwaway key; no attestation exists for it)');
    const sim = await simulatedSetup();
    evidence = sim.evidence; signers = [sim.signer];
    console.log(`  signer ${sim.signer.signing_address}, model_id ${sim.signer.model_id}, attestation_hash = zeros`);
    var simAsk = sim.ask;
  } else if (mode === 'live') {
    say(`Fetch a FRESH attestation for ${model} with our own nonce and verify it off-chain (Intel TDX + NVIDIA)`);
    const r = await collectAttestation(model);
    evidence = r.evidence; printRows(r.result.rows);
    if (!r.result.ok) die('attestation checks failed');
    signers = r.result.signers;
  } else {
    say('Load the saved REAL evidence and re-verify it OFFLINE (Intel collateral as of fetch time, recorded NVIDIA verdict)');
    evidence = JSON.parse(readFileSync(new URL('attestation-evidence.json', FIX), 'utf8'));
    if (existsSync(new URL('receipt-bundle.json', FIX))) bundle = JSON.parse(readFileSync(new URL('receipt-bundle.json', FIX), 'utf8'));
    console.log(`  fetched_at ${evidence.fetched_at}  model ${evidence.model}  report_sha256 ${evidence.report_sha256}`);
    const r = await verifyEvidence(evidence);
    printRows(r.rows);
    if (!r.ok) die('attestation evidence checks failed');
    signers = r.signers;
  }

  say(`Register the ${mode === 'simulated' ? 'SIMULATED' : 'verified'} signer keys on-chain (owner only; stores attestation hash + nonce + expiry)`);
  for (const t of await registerSigners(near, evidence, signers)) {
    console.log(`  ${t.signer.kind.padEnd(12)} ${t.signer.signing_address} model '${t.signer.model_id}'  tx ${t.txHash}  ${t.gasTgas.toFixed(2)} Tgas`);
  }

  if (mode === 'live') {
    say(`Ask NEAR AI Cloud (${model}, non-streaming, x-no-aliasing, max_tokens ${maxTokens}) and fetch GET /v1/signature (ecdsa)`);
    bundle = await askNearAi({ model, prompt, maxTokens, evidence });
  } else if (mode === 'simulated') {
    say('SIMULATED reply + signature (no model was called)');
    bundle = await simAsk(prompt);
  } else if (bundle) {
    say('Use the saved REAL NEAR AI reply + TEE signature');
  } else {
    say('No saved REAL receipt yet (NEAR AI completions need account credits) -> SIMULATED receipt, labelled');
    console.log('  *** The attestation + signer registration above are REAL; the receipt below is SIMULATED (local key, not NEAR AI). ***');
    const sim = await simulatedSetup();
    const t = (await registerSigners(near, sim.evidence, [sim.signer]))[0];
    console.log(`  registered SIMULATED signer ${sim.signer.signing_address} model '${sim.signer.model_id}' tx ${t.txHash}`);
    signers = [...signers, sim.signer];
    bundle = await sim.ask(prompt);
  }
  const answer = JSON.parse(bundleBytes(bundle).responseBytes.toString('utf8'));
  console.log(`  chat_id ${bundle.chat_id}  usage ${JSON.stringify(bundle.usage)}`);
  console.log(`  answer: ${JSON.stringify(answer.choices?.[0]?.message?.content ?? '').slice(0, 160)}`);
  console.log(`  signed text: ${bundle.signature.text}`);
  console.log(`  signer ${bundle.signature.signing_address} (${bundle.signature.signature_kind}, ${bundle.signature.signing_algo})`);

  say('Re-check off-chain: recompute sha256 of the exact bytes, rebuild the signed text, verify the signature');
  const off = checkBundleOffchain(bundle); printRows(off);
  const attested = signers.some((s) => s.signing_address === bundle.signature.signing_address);
  printRows([{ who: 'receipt', check: 'signer_is_attested_signer', ok: attested, detail: '' }]);
  if (!off.every((r) => r.ok) || !attested) die('off-chain receipt checks failed');

  say('Anchor: submit_receipt (anyone can call; the contract re-checks the signature with ecrecover)');
  const a = await anchor(near, bundle);
  console.log(`  receipt #${a.receiptId}  tx ${a.txHash}  ${a.gasTgas.toFixed(2)} Tgas  logs ${JSON.stringify(a.logs)}`);
  bundle.anchored = { network: node.cfg.network, contract: node.cfg.contractId, receipt_id: a.receiptId, tx_hash: a.txHash, note: 'local sandbox; gone when the node stops' };

  say('Verify: re-hash the local bytes and look them up on-chain');
  const v = await verifyOnChain(near, bundle); printRows(v.rows);
  if (!v.rows.every((r) => r.ok)) die('on-chain verification failed');

  say('Negative: one changed byte in the response');
  const { requestBytes, responseBytes } = bundleBytes(bundle);
  const tampered = Buffer.from(responseBytes); tampered[tampered.length - 2] ^= 1;
  const vt = await verifyOnChain(near, bundle, { requestBytes, responseBytes: tampered });
  printRows([{ who: 'on-chain', check: 'verify_receipt(tampered bytes) finds nothing', ok: !vt.receipt, detail: vt.rows[0].detail }]);
  if (vt.receipt) die('tampered bytes matched a receipt');
  const tamperedHashes = { request_hash: bundle.request_hash, response_hash: (await import('../src/signature.mjs')).sha256Hex(tampered) };
  try {
    await anchor(near, bundle, tamperedHashes);
    die('tampered receipt was accepted');
  } catch (e) {
    const m = /signature does not verify/.test(e.message);
    printRows([{ who: 'on-chain', check: 'submit_receipt(tampered) rejected', ok: m, detail: m ? 'signature does not verify' : e.message.slice(0, 120) }]);
    if (!m) throw e;
  }

  say('Signer-key history for the model (stays after key rotation)');
  for (const m of [...new Set([evidence.model, bundle.model].filter(Boolean))]) {
  const hist = await near.view('get_signer_history', { model_id: m, from_index: null, limit: 10 });
  console.log(`  model '${m}':`);
  for (const h of hist) console.log(`  ${h.signing_address}  attestation ${h.attestation_hash.slice(0, 16)}…  registered ${new Date(h.registered_at_ms).toISOString()}  expires ${new Date(h.expires_at_ms).toISOString()}`);
  }

  if (mode === 'live' && argv.includes('--save-fixtures')) {
    const key = apiKey();
    const ev = JSON.stringify(evidence, null, 1), bu = JSON.stringify(bundle, null, 2);
    if (key && (ev.includes(key) || bu.includes(key))) die('refusing to save: API key found in output');
    if (/Bearer |authorization/i.test(bu)) die('refusing to save: auth header text found in bundle');
    mkdirSync(FIX, { recursive: true });
    writeFileSync(new URL('attestation-evidence.json', FIX), ev + '\n');
    writeFileSync(new URL('receipt-bundle.json', FIX), bu + '\n');
    console.log('\nsaved fixtures/demo/attestation-evidence.json and fixtures/demo/receipt-bundle.json (checked: no API key, no auth headers)');
  }
  console.log(`\nDONE (${mode}${bundle.simulated ? ', receipt SIMULATED, not NEAR AI evidence' : ', real NEAR AI receipt'}): receipt anchored and verified; tampered response rejected.`);
} finally {
  await node.stop();
}
