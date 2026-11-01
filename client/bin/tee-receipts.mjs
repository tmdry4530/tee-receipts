#!/usr/bin/env node
// tee-receipts CLI. Network config: `node:start` (local sandbox) or env NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY/TEE_RECEIPTS_CONTRACT_ID.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, loadConfig, LOCAL_NODE_FILE } from '../src/near.mjs';
import { startLocalNode } from '../src/localnode.mjs';
import { collectAttestation, verifyEvidence, printRows } from '../src/evidence.mjs';
import { registerSigners, askNearAi, checkBundleOffchain, anchor, verifyOnChain, bundleBytes } from '../src/receipts.mjs';
import { apiKey } from '../src/nearai.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : dflt; };
const flag = (name) => rest.includes(`--${name}`);
const positional = rest.find((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !['--no-register'].includes(rest[i - 1])));
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJson = (f, o) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(o, null, 1) + '\n'); };
const safeWrite = (f, o) => {
  const s = JSON.stringify(o);
  if (apiKey() && s.includes(apiKey())) throw new Error('refusing to write: API key found in output');
  writeJson(f, o);
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const HELP = `tee-receipts <command>
  node:start                         start a local NEAR node with the contract (keep it running)
  attest --model <id> [--save f]     fresh NEAR AI attestation -> verify off-chain -> register signers on-chain
  attest --evidence <f>              re-verify saved evidence offline -> register signers
         [--no-register] [--ttl <s>]
  ask --model <id> --prompt <text>   REAL completion + TEE signature (needs NEAR_AI_API_KEY) -> receipt bundle
      [--max-tokens 64] [--evidence f] [--out f]
  anchor <bundle.json>               submit_receipt on-chain (contract re-checks the signature)
  verify <bundle.json> [--request f --response f]
                                     re-hash bytes, verify signature off-chain, look up on-chain
  history --model <id>               attested signer-key history ("" = gateway)`;

async function main() {
  switch (cmd) {
    case 'node:start': {
      const node = await startLocalNode();
      mkdirSync(dirname(fileURLToPath(LOCAL_NODE_FILE)), { recursive: true });
      writeFileSync(LOCAL_NODE_FILE, JSON.stringify(node.cfg, null, 1));
      console.log(`local NEAR node ${node.cfg.rpcUrl}, contract ${node.cfg.contractId}; config in .tee-receipts/local-node.json. Ctrl-C to stop.`);
      const stop = async () => { rmSync(LOCAL_NODE_FILE, { force: true }); await node.stop(); process.exit(0); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      await new Promise(() => {});
      break;
    }
    case 'attest': {
      let evidence, result;
      if (opt('evidence')) {
        evidence = readJson(opt('evidence'));
        console.log(`re-verifying saved evidence OFFLINE (fetched ${evidence.fetched_at}, model ${evidence.model})`);
        result = await verifyEvidence(evidence);
      } else {
        const model = opt('model'); if (!model) throw new Error('--model required');
        console.log(`fetching a fresh attestation for ${model} ...`);
        ({ evidence, result } = await collectAttestation(model));
        const out = opt('save', `.tee-receipts/evidence/${model.replace(/[^A-Za-z0-9.-]/g, '_')}-${stamp()}.json`);
        safeWrite(out, evidence);
        console.log(`evidence saved: ${out}`);
      }
      printRows(result.rows);
      console.log(`report_sha256 ${evidence.report_sha256}  nonce ${evidence.nonce}`);
      if (!result.ok) { process.exitCode = 1; console.log('NOT registering: some checks failed'); return; }
      if (flag('no-register')) return;
      const near = connect(loadConfig());
      for (const t of await registerSigners(near, evidence, result.signers, Number(opt('ttl', '3600')))) {
        console.log(`registered ${t.signer.kind} ${t.signer.signing_address} model '${t.signer.model_id}' tx ${t.txHash}`);
      }
      break;
    }
    case 'ask': {
      const model = opt('model'); const prompt = opt('prompt');
      if (!model || !prompt) throw new Error('--model and --prompt required');
      const evidence = opt('evidence') ? readJson(opt('evidence')) : null;
      const bundle = await askNearAi({ model, prompt, maxTokens: Number(opt('max-tokens', '64')), evidence });
      const rows = checkBundleOffchain(bundle); printRows(rows);
      const out = opt('out', `.tee-receipts/receipts/${bundle.chat_id}.json`);
      safeWrite(out, bundle);
      console.log(`receipt bundle saved: ${out}\nsigned text: ${bundle.signature.text}`);
      break;
    }
    case 'anchor': {
      const f = positional; if (!f) throw new Error('bundle file required');
      const bundle = readJson(f);
      const rows = checkBundleOffchain(bundle); printRows(rows);
      if (!rows.every((r) => r.ok)) throw new Error('off-chain checks failed; not anchoring');
      const near = connect(loadConfig());
      const a = await anchor(near, bundle);
      bundle.anchored = { network: near.cfg.network, contract: near.cfg.contractId, receipt_id: a.receiptId, tx_hash: a.txHash };
      safeWrite(f, bundle);
      console.log(`anchored receipt #${a.receiptId} tx ${a.txHash} (${a.gasTgas.toFixed(2)} Tgas)`);
      break;
    }
    case 'verify': {
      const f = positional; if (!f) throw new Error('bundle file required');
      const bundle = readJson(f);
      const bytes = opt('request') || opt('response')
        ? { requestBytes: opt('request') ? readFileSync(opt('request')) : bundleBytes(bundle).requestBytes,
            responseBytes: opt('response') ? readFileSync(opt('response')) : bundleBytes(bundle).responseBytes }
        : bundleBytes(bundle);
      if (bundle.simulated) console.log('*** SIMULATED bundle: not signed by NEAR AI ***');
      const off = checkBundleOffchain(bundle, bytes);
      const on = await verifyOnChain(connect(loadConfig()), bundle, bytes);
      printRows([...off, ...on.rows]);
      const ok = [...off, ...on.rows].every((r) => r.ok);
      console.log(ok ? 'VERIFIED' : 'NOT VERIFIED');
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case 'history': {
      const model = opt('model', '');
      const near = connect(loadConfig());
      const n = await near.view('signer_history_len', { model_id: model });
      const hist = await near.view('get_signer_history', { model_id: model, from_index: null, limit: 100 });
      console.log(`${n} registration(s) for '${model}'`);
      for (const h of hist) console.log(`  ${h.signing_algo} ${h.signing_address} attestation ${h.attestation_hash} nonce ${h.nonce} registered ${new Date(h.registered_at_ms).toISOString()} expires ${new Date(h.expires_at_ms).toISOString()}`);
      break;
    }
    default:
      console.log(HELP);
  }
}
main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
