// Deploy contracts/receipts/res/tee_receipts_contract.wasm to an existing NEAR account and call `new { owner }`.
// Env: NEAR_ACCOUNT_ID (the contract account), NEAR_CREDENTIALS_FILE or NEAR_PRIVATE_KEY, optional NEAR_RPC_URL, OWNER.
// The key is read from env/file and never printed.
import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from 'near-api-js';
import { WASM_URL } from '../src/localnode.mjs';

const env = process.env;
const accountId = env.NEAR_ACCOUNT_ID;
const privateKey = env.NEAR_PRIVATE_KEY
  || (env.NEAR_CREDENTIALS_FILE ? JSON.parse(readFileSync(env.NEAR_CREDENTIALS_FILE, 'utf8')).private_key : undefined);
if (!accountId || !privateKey) throw new Error('set NEAR_ACCOUNT_ID and NEAR_CREDENTIALS_FILE (or NEAR_PRIVATE_KEY)');
const rpcUrl = env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org';
const owner = env.OWNER ?? accountId;
const account = new Account(accountId, new JsonRpcProvider({ url: rpcUrl }), KeyPairSigner.fromSecretKey(privateKey));
const wasm = readFileSync(WASM_URL);

const send = async (label, acts) => {
  const o = await account.signAndSendTransaction({ receiverId: accountId, actions: acts });
  if (o.status?.Failure) throw new Error(`${label} failed: ${JSON.stringify(o.status.Failure)}`);
  console.log(`${label} tx ${o.transaction.hash}`);
  return o.transaction.hash;
};
const deployTx = await send(`deploy (${wasm.length} bytes) to ${accountId}`, [actions.deployContract(wasm)]);
const initTx = await send(`init new { owner: ${owner} }`, [actions.functionCall('new', { owner }, teraToGas('30'), 0n)]);
console.log(JSON.stringify({ contract: accountId, owner, deployTx, initTx }));
