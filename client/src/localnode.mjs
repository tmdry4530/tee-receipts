// Start a throwaway local NEAR node (near-sandbox) and deploy the TEE Receipts contract to it.
// Uses only near-sandbox's well-known local genesis key; no testnet/mainnet account is touched.
import { readFileSync } from 'node:fs';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPairSigner, actions, nearToYocto, teraToGas } from 'near-api-js';

export const WASM_URL = new URL('../../contracts/receipts/res/tee_receipts_contract.wasm', import.meta.url);

export async function startLocalNode({ wasm = readFileSync(WASM_URL) } = {}) {
  const sandbox = await Sandbox.start({});
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const signer = KeyPairSigner.fromSecretKey(DEFAULT_PRIVATE_KEY);
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, signer);
  const contractId = `receipts.${DEFAULT_ACCOUNT_ID}`;
  const publicKey = await signer.getPublicKey();
  await root.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(), actions.transfer(nearToYocto('20')), actions.addFullAccessKey(publicKey),
      actions.deployContract(wasm),
      actions.functionCall('new', { owner: DEFAULT_ACCOUNT_ID }, teraToGas('30'), 0n),
    ],
  });
  const cfg = { network: 'local-sandbox', rpcUrl: sandbox.rpcUrl, accountId: DEFAULT_ACCOUNT_ID, privateKey: DEFAULT_PRIVATE_KEY, contractId };
  return { sandbox, cfg, stop: () => sandbox.tearDown() };
}
