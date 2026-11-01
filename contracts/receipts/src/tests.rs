use super::*;
use k256::ecdsa::SigningKey;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;
use rand_core::OsRng;
use serde_json::Value;
use sha3::{Digest, Keccak256};

const NONCE: &str = "06e1c8d43eb0626192e0b99126fc248f73f5b7b6eabea359aa8f64983fa4dab7";
const ATT: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn ctx(predecessor: usize, ts_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(accounts(predecessor)).block_timestamp(ts_ms * 1_000_000);
    testing_env!(b.build());
}

fn vectors() -> Vec<Value> {
    let raw = include_str!("../tests/fixtures/local_vectors.json");
    let v: Value = serde_json::from_str(raw).unwrap();
    v["vectors"].as_array().unwrap().clone()
}

fn algo(v: &Value) -> SigningAlgo {
    if v["signing_algo"] == "ecdsa" { SigningAlgo::Ecdsa } else { SigningAlgo::Ed25519 }
}
fn kind(v: &Value) -> SignatureKind {
    if v["signature_kind"] == "provider_tee" { SignatureKind::ProviderTee } else { SignatureKind::Gateway }
}
fn s(v: &Value, k: &str) -> String { v[k].as_str().unwrap().to_string() }

fn register(c: &mut Contract, v: &Value) {
    c.register_signer(algo(v), s(v, "signing_address"), kind(v), s(v, "model_id"), ATT.into(), NONCE.into(), 3600, None);
}

/// Rust-side EIP-191 signer with a fresh k256 key (independent of ethers.js).
fn rust_eip191_sign(sk: &SigningKey, text: &str) -> (String, String) {
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let digest = Keccak256::digest(&msg);
    let (sig, recid) = sk.sign_prehash_recoverable(&digest).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + recid.to_byte());
    let pubkey = sk.verifying_key().to_encoded_point(false);
    let addr = &Keccak256::digest(&pubkey.as_bytes()[1..])[12..];
    (hex::encode(addr), hex::encode(out))
}

#[test]
fn ethers_and_nacl_vectors_verify_on_chain_and_are_stored() {
    ctx(0, 1_000);
    let mut c = Contract::new(accounts(0));
    for v in vectors() {
        // text built on-chain must equal what the signer signed
        assert_eq!(signed_text(kind(&v), &s(&v, "model_id"), &s(&v, "request_hash"), &s(&v, "response_hash")), s(&v, "text"));
        assert!(c.check_response_signature(algo(&v), s(&v, "signing_address"), kind(&v), s(&v, "model_id"),
            s(&v, "request_hash"), s(&v, "response_hash"), s(&v, "signature")), "vector failed: {v}");
    }
    // anchor one of each algo (distinct response hashes are required, so only the first two)
    let vs = vectors();
    let v = &vs[0];
    register(&mut c, v);
    let id = c.submit_receipt(algo(v), s(v, "signing_address"), s(v, "model_id"), s(v, "request_hash"), s(v, "response_hash"), s(v, "signature"));
    let r = c.verify_receipt(s(v, "request_hash"), s(v, "response_hash")).expect("receipt");
    assert_eq!(r.id, id);
    assert_eq!(r.attestation_hash, ATT);
    assert!(c.verify_receipt("00".repeat(32), s(v, "response_hash")).is_none());
}

#[test]
fn ed25519_vector_anchors() {
    ctx(0, 1_000);
    let mut c = Contract::new(accounts(0));
    let v = vectors().into_iter().find(|v| v["signing_algo"] == "ed25519").unwrap();
    register(&mut c, &v);
    c.submit_receipt(algo(&v), s(&v, "signing_address"), s(&v, "model_id"), s(&v, "request_hash"), s(&v, "response_hash"), s(&v, "signature"));
    assert_eq!(c.receipt_count(), 1);
}

#[test]
fn rust_k256_signature_verifies_with_env_ecrecover() {
    ctx(0, 1_000);
    let c = Contract::new(accounts(0));
    let sk = SigningKey::random(&mut OsRng);
    let (req, resp) = ("ab".repeat(32), "cd".repeat(32));
    let text = signed_text(SignatureKind::ProviderTee, "Qwen/Qwen3.8-27B", &req, &resp);
    let (addr, sig) = rust_eip191_sign(&sk, &text);
    assert!(c.check_response_signature(SigningAlgo::Ecdsa, format!("0x{addr}"), SignatureKind::ProviderTee,
        "Qwen/Qwen3.8-27B".into(), req.clone(), resp.clone(), format!("0x{sig}")));
    // wrong model id => different text => fails
    assert!(!c.check_response_signature(SigningAlgo::Ecdsa, addr, SignatureKind::ProviderTee,
        "other/model".into(), req, resp, sig));
}

#[test]
fn public_key_must_match_address() {
    ctx(0, 1_000);
    let mut c = Contract::new(accounts(0));
    let v = &vectors()[0];
    c.register_signer(SigningAlgo::Ecdsa, s(v, "signing_address"), SignatureKind::ProviderTee, s(v, "model_id"),
        ATT.into(), NONCE.into(), 60, Some(s(v, "signing_public_key")));
}

#[test]
#[should_panic(expected = "signature does not verify")]
fn tampered_response_hash_is_rejected() {
    ctx(0, 1_000);
    let mut c = Contract::new(accounts(0));
    let v = &vectors()[0];
    register(&mut c, v);
    let mut resp = s(v, "response_hash");
    resp.replace_range(0..2, if &resp[0..2] == "00" { "01" } else { "00" });
    c.submit_receipt(algo(v), s(v, "signing_address"), s(v, "model_id"), s(v, "request_hash"), resp, s(v, "signature"));
}

#[test]
#[should_panic(expected = "signer not registered")]
fn unregistered_signer_is_rejected() {
    ctx(0, 1_000);
    let mut c = Contract::new(accounts(0));
    let v = &vectors()[0];
    c.submit_receipt(algo(v), s(v, "signing_address"), s(v, "model_id"), s(v, "request_hash"), s(v, "response_hash"), s(v, "signature"));
}

#[test]
#[should_panic(expected = "signer registration expired")]
fn expired_signer_is_rejected() {
    ctx(0, 1_000);
    let mut c = Contract::new(accounts(0));
    let v = &vectors()[0];
    register(&mut c, v);
    ctx(1, 1_000 + 3601 * 1000);
    c.submit_receipt(algo(v), s(v, "signing_address"), s(v, "model_id"), s(v, "request_hash"), s(v, "response_hash"), s(v, "signature"));
}

#[test]
#[should_panic(expected = "only owner")]
fn only_owner_registers() {
    ctx(0, 1_000);
    let mut c = Contract::new(accounts(0));
    ctx(1, 1_000);
    register(&mut c, &vectors()[0]);
}

#[test]
fn signer_history_keeps_rotated_keys() {
    ctx(0, 1_000);
    let mut c = Contract::new(accounts(0));
    let vs: Vec<Value> = vectors().into_iter().filter(|v| v["signature_kind"] == "provider_tee").collect();
    for v in &vs { register(&mut c, v); }
    // re-register the first key (fresh attestation) -> history grows, current entry updated
    ctx(0, 2_000);
    c.register_signer(algo(&vs[0]), s(&vs[0], "signing_address"), kind(&vs[0]), s(&vs[0], "model_id"),
        "22".repeat(32), NONCE.into(), 3600, None);
    let model = s(&vs[0], "model_id");
    assert_eq!(c.signer_history_len(model.clone()), 3);
    let h = c.get_signer_history(model.clone(), None, None);
    assert_eq!(h[0].attestation_hash, ATT);
    assert_eq!(h[2].attestation_hash, "22".repeat(32));
    assert_eq!(c.get_signer_history(model, Some(1), Some(1)).len(), 1);
    assert_eq!(c.signer_history_len("other".into()), 0);
}
