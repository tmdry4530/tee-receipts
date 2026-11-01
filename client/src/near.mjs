// NEAR contract access (local sandbox node or testnet) via near-api-js.
import { readFileSync, existsSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from 'near-api-js';

export const LOCAL_NODE_FILE = new URL('../../.tee-receipts/local-node.json', import.meta.url);

/** Config from env (testnet etc.) or from the running local node written by `node:start`. */
export function loadConfig() {
  if (process.env.TEE_RECEIPTS_CONTRACT_ID && process.env.NEAR_ACCOUNT_ID && process.env.NEAR_PRIVATE_KEY) {
    return {
      network: process.env.NEAR_NETWORK ?? 'testnet',
      rpcUrl: process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org',
      accountId: process.env.NEAR_ACCOUNT_ID, privateKey: process.env.NEAR_PRIVATE_KEY,
      contractId: process.env.TEE_RECEIPTS_CONTRACT_ID,
    };
  }
  if (existsSync(LOCAL_NODE_FILE)) return JSON.parse(readFileSync(LOCAL_NODE_FILE, 'utf8'));
  throw new Error('No NEAR config: run `npm run node:start` in another terminal, or set NEAR_ACCOUNT_ID/NEAR_PRIVATE_KEY/TEE_RECEIPTS_CONTRACT_ID');
}

export function connect(cfg) {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const account = new Account(cfg.accountId, provider, KeyPairSigner.fromSecretKey(cfg.privateKey));
  const view = async (method, args = {}) => {
    const r = await provider.callFunction({ contractId: cfg.contractId, method, args });
    return r === undefined ? null : r;
  };
  /** Sends a function call; returns { value, txHash, gasTgas, logs }. Throws with the contract panic message. */
  const call = async (method, args, tgas = '100') => {
    const outcome = await account.signAndSendTransaction({
      receiverId: cfg.contractId, actions: [actions.functionCall(method, args, teraToGas(tgas), 0n)],
    });
    const failure = outcome.status?.Failure;
    if (failure) throw new Error(JSON.stringify(failure));
    const b64 = outcome.status?.SuccessValue;
    const value = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString() || 'null') : null;
    const all = [outcome.transaction_outcome, ...outcome.receipts_outcome];
    const gas = all.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
    return {
      value, txHash: outcome.transaction.hash,
      gasTgas: Number(gas) / 1e12,
      logs: outcome.receipts_outcome.flatMap((o) => o.outcome.logs),
    };
  };
  return { cfg, provider, account, view, call };
}
