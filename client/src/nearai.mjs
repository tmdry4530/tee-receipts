// Thin NEAR AI Cloud client. The API key is read from the environment and only ever placed in the
// Authorization header; it is never written to evidence/receipt files or logs.
import { Buffer } from 'node:buffer';

export const BASE_URL = process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
export const apiKey = () => process.env.NEAR_AI_API_KEY || process.env.NEAR_AI_CLOUD_API_KEY || '';
const auth = () => (apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {});

async function fail(res, what) {
  const body = (await res.text().catch(() => '')).slice(0, 200).replaceAll(apiKey() || '\u0000', '[redacted]');
  return new Error(`${what}: HTTP ${res.status} ${body}`);
}

/** GET /v1/attestation/report. Returns the raw body string (hashed as-is) and the parsed JSON. */
export async function fetchAttestation(model, nonce, signingAlgo = 'ecdsa') {
  const url = `${BASE_URL}/attestation/report?` + new URLSearchParams({ model, provider: 'near', signing_algo: signingAlgo, nonce });
  const res = await fetch(url, { headers: { Accept: 'application/json', 'x-no-aliasing': 'true', ...auth() } });
  if (!res.ok) throw await fail(res, 'attestation request failed');
  const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
  return { url, raw, body: JSON.parse(raw) };
}

/**
 * Non-streaming chat completion. `requestBytes` are exactly the bytes sent and `responseBytes` exactly the
 * bytes received; these are what NEAR AI hashes and signs (provider_tee: "<model>:<sha256 req>:<sha256 resp>").
 */
export async function chatCompletion({ model, prompt, maxTokens = 64 }) {
  if (!apiKey()) throw new Error('NEAR_AI_API_KEY is not set (needed for completions and signatures)');
  const requestBytes = Buffer.from(JSON.stringify({
    model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0, stream: false,
  }), 'utf8');
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', 'x-no-aliasing': 'true', ...auth() },
    body: requestBytes,
  });
  if (!res.ok) throw await fail(res, 'chat completion failed');
  if (res.headers.get('content-encoding') && res.headers.get('content-encoding') !== 'identity') {
    throw new Error(`response was ${res.headers.get('content-encoding')}-encoded; hashes would not match`);
  }
  const responseBytes = Buffer.from(await res.arrayBuffer());
  const json = JSON.parse(responseBytes.toString('utf8'));
  return { requestBytes, responseBytes, chatId: json.id, json };
}

/** GET /v1/signature/{chat_id}; retries 404 because the signature lives on the node that served the reply. */
export async function getSignature(chatId, model, signingAlgo = 'ecdsa', retries = 6) {
  const url = `${BASE_URL}/signature/${encodeURIComponent(chatId)}?` + new URLSearchParams({ model, signing_algo: signingAlgo });
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'x-no-aliasing': 'true', ...auth() } });
    if (res.ok) return res.json();
    if (res.status !== 404 || i >= retries) throw await fail(res, 'signature request failed');
    await new Promise((r) => setTimeout(r, 1000 * i));
  }
}
