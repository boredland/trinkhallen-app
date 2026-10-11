//! Primitives the auth and moderation ports need: base64url, hex, SHA-256,
//! HMAC-SHA256, WebCrypto key import + signing, and the JWT
//! (de)serialisation shared by Apple's ES256 client secret and GitHub's
//! RS256 app JWT.
//!
//! Hand-rolled base64/hex and a block-sized HMAC instead of a `base64` /
//! `hmac` dependency: the wasm payload has to stay small and every use here
//! is a handful of bytes at request time. The SHA-256 core is the usual
//! small implementation — `sha2` would pull its whole dependency tree into
//! the worker for one digest.

mod sha256;

pub use sha256::{Sha256, Sha256Digest};

// ── base64 / hex ────────────────────────────────────────────────────────────

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Standard base64 with `=` padding — the format GitHub's contents/blob
/// API and PEM bodies use.
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(B64_ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(B64_ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Whitespace-tolerant base64 decode for PEM bodies (input is pre-stripped
/// of whitespace here).
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &c in input.as_bytes() {
        match c {
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => {}
        }
        let v = b64_value(c)?;
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    (!out.is_empty() || input.trim().is_empty()).then_some(out)
}

pub fn base64url_encode(bytes: &[u8]) -> String {
    base64_encode(bytes)
        .replace('+', "-")
        .replace('/', "_")
        .replace('=', "")
}

/// Decode unpadded/padded base64url (JWT parts).
pub fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let std: String = input
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            _ => c,
        })
        .collect();
    let padded = format!("{std}{}", "=".repeat((4 - std.len() % 4) % 4));
    base64_decode(&padded)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((b & 15) as u32, 16).unwrap());
    }
    out
}

/// Constant-time comparison; only a length mismatch returns early, which
/// leaks nothing for the fixed-length hashes and signatures compared here.
pub fn timing_safe_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Unix seconds.
pub fn unix_now() -> i64 {
    #[cfg(target_arch = "wasm32")]
    {
        (worker::Date::now().as_millis() / 1000) as i64
    }
    // Native (unit tests) has no JS runtime; the wall clock is the same value.
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }
}

// ── digests ─────────────────────────────────────────────────────────────────

pub fn sha256_hex(input: &str) -> String {
    hex_encode(&Sha256::digest(input.as_bytes()))
}

/// HMAC-SHA256 over `data` keyed with `key`, any length (RFC 2104).
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Sha256Digest {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(&k.map(|b| b ^ 0x36));
    inner.update(data);
    let inner = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(&k.map(|b| b ^ 0x5c));
    outer.update(&inner);
    outer.finalize()
}

// ── WebCrypto bridge ────────────────────────────────────────────────────────

/// `crypto.subtle` from the global `crypto`.
pub fn webcrypto() -> Result<web_sys::SubtleCrypto, wasm_bindgen::JsValue> {
    use wasm_bindgen::JsCast;
    let global: js_sys::Object = js_sys::global().dyn_into()?;
    let crypto: web_sys::Crypto = js_sys::Reflect::get(&global, &"crypto".into())?.dyn_into()?;
    Ok(crypto.subtle())
}

/// Import a PKCS#8 private key (DER) and sign `msg` with it.
///
/// `alg` is `"RS256"` (RSASSA-PKCS1-v1_5 / SHA-256, GitHub) or `"ES256"`
/// (ECDSA P-256 / SHA-256, Apple). Apple's raw r‖s signature is what JWT
/// wants; WebCrypto already emits that shape for P-256.
pub async fn sign_pkcs8(
    alg: &str,
    pkcs8_der: &[u8],
    msg: &[u8],
) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    let params = match alg {
        "RS256" => {
            let p = js_sys::Object::new();
            js_sys::Reflect::set(&p, &"name".into(), &"RSASSA-PKCS1-v1_5".into())?;
            js_sys::Reflect::set(&p, &"hash".into(), &"SHA-256".into())?;
            p
        }
        "ES256" => {
            let p = js_sys::Object::new();
            js_sys::Reflect::set(&p, &"name".into(), &"ECDSA".into())?;
            js_sys::Reflect::set(&p, &"namedCurve".into(), &"P-256".into())?;
            p
        }
        other => {
            return Err(wasm_bindgen::JsValue::from_str(&format!(
                "unsupported jwt alg {other}"
            )));
        }
    };
    let key = await_import(webcrypto()?.import_key_with_object(
        "pkcs8",
        &js_sys::Uint8Array::from(pkcs8_der),
        &params,
        false,
        &js_sys::Array::of1(&"sign".into()),
    )?)
    .await?;
    let sig =
        wasm_bindgen_futures::JsFuture::from(webcrypto()?.sign_with_object_and_buffer_source(
            &sign_params(alg)?,
            &key,
            &js_sys::Uint8Array::from(msg),
        )?)
        .await?;
    Ok(js_sys::Uint8Array::new(&sig).to_vec())
}

/// `importKey` resolves to a `CryptoKey`.
async fn await_import(
    promise: js_sys::Promise,
) -> Result<web_sys::CryptoKey, wasm_bindgen::JsValue> {
    use wasm_bindgen::JsCast;
    let key = wasm_bindgen_futures::JsFuture::from(promise).await?;
    Ok(key.unchecked_into())
}

fn sign_params(alg: &str) -> Result<js_sys::Object, wasm_bindgen::JsValue> {
    let p = js_sys::Object::new();
    js_sys::Reflect::set(
        &p,
        &"name".into(),
        &if alg == "ES256" {
            "ECDSA"
        } else {
            "RSASSA-PKCS1-v1_5"
        }
        .into(),
    )?;
    if alg == "ES256" {
        js_sys::Reflect::set(&p, &"hash".into(), &"SHA-256".into())?;
    }
    Ok(p)
}

/// HMAC-SHA256 through WebCrypto.
pub async fn hmac_sha256_webcrypto(
    secret: &str,
    msg: &[u8],
) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    let p = js_sys::Object::new();
    js_sys::Reflect::set(&p, &"name".into(), &"HMAC".into())?;
    js_sys::Reflect::set(&p, &"hash".into(), &"SHA-256".into())?;
    let key = await_import(webcrypto()?.import_key_with_object(
        "raw",
        &js_sys::Uint8Array::from(secret.as_bytes()),
        &p,
        false,
        &js_sys::Array::of1(&"sign".into()),
    )?)
    .await?;
    let sig = wasm_bindgen_futures::JsFuture::from(webcrypto()?.sign_with_str_and_buffer_source(
        "HMAC",
        &key,
        &js_sys::Uint8Array::from(msg),
    )?)
    .await?;
    Ok(js_sys::Uint8Array::new(&sig).to_vec())
}

// ── JWT ─────────────────────────────────────────────────────────────────────

/// `<b64url(header)>.<b64url(payload)>` — the part a signature covers.
pub fn jwt_signing_input(header: &serde_json::Value, claims: &serde_json::Value) -> String {
    let enc = |v: &serde_json::Value| {
        base64url_encode(serde_json::to_string(v).unwrap_or_default().as_bytes())
    };
    format!("{}.{}", enc(header), enc(claims))
}

/// Decode a JWT's payload without verifying the signature.
///
/// Both flows here obtain the token server-to-server over TLS from the
/// provider's own token endpoint (Apple) or construct it locally (GitHub),
/// so the signature is not the trust anchor — the same trade-off as for
/// Apple's id_token.
pub fn jwt_decode_payload(jwt: &str) -> Result<serde_json::Value, String> {
    let mut parts = jwt.split('.');
    let _header = parts.next().ok_or("malformed jwt")?;
    let payload = parts.next().ok_or("malformed jwt")?;
    if parts.next().is_none() {
        return Err("malformed jwt".into());
    }
    let raw = base64url_decode(payload).ok_or("malformed jwt payload")?;
    serde_json::from_slice(&raw).map_err(|e| format!("malformed jwt payload: {e}"))
}

/// Wrap a bare PKCS#1 (`BEGIN RSA PRIVATE KEY`) DER body in the
/// `PrivateKeyInfo` shell WebCrypto's `importKey("pkcs8")` expects.
///
/// GitHub App keys arrive as PKCS#1; Apple's `.p8` is already PKCS#8 (passed
/// through unchanged). The version/algorithm identifiers below are the
/// fixed values for an RSA key with no attributes.
pub fn pkcs1_to_pkcs8(der: &[u8]) -> Vec<u8> {
    #[rustfmt::skip]
    const PREFIX: [u8; 26] = [
        0x30, 0x82, 0x00, 0x00, // SEQUENCE, length patched below
        0x02, 0x01, 0x00,       // INTEGER 0 (version)
        0x30, 0x0d,             // SEQUENCE (AlgorithmIdentifier)
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // OID 1.2.840.113549.1.1.1
        0x05, 0x00,             // NULL parameters
        0x04, 0x82, 0x00, 0x00, // OCTET STRING, length patched below
    ];
    let inner_len = der.len() + 4;
    let mut out = Vec::with_capacity(PREFIX.len() + der.len());
    out.extend_from_slice(&PREFIX);
    out[2] = (inner_len >> 8) as u8;
    out[3] = (inner_len & 0xff) as u8;
    let n = out.len();
    out[n - 2] = (der.len() >> 8) as u8;
    out[n - 1] = (der.len() & 0xff) as u8;
    out.extend_from_slice(der);
    out
}

/// PEM body → DER, wrapping PKCS#1 RSA keys into PKCS#8 first.
pub fn pem_to_pkcs8_der(pem: &str) -> Option<Vec<u8>> {
    let (begin, end) = ("-----BEGIN ", "-----END ");
    let mut b64 = String::new();
    let mut in_body = false;
    let mut pkcs1 = false;
    for line in pem.lines() {
        let line = line.trim();
        if line.starts_with(begin) {
            pkcs1 = line.contains("RSA PRIVATE KEY");
            in_body = true;
            continue;
        }
        if line.starts_with(end) {
            in_body = false;
            continue;
        }
        if in_body {
            b64.push_str(line);
        }
    }
    if b64.is_empty() {
        return None;
    }
    let der = base64_decode(&b64)?;
    if pkcs1 {
        Some(pkcs1_to_pkcs8(&der))
    } else {
        Some(der)
    }
}

/// Apple encodes `email_verified` as a boolean or the strings "true"/"false".
pub fn json_bool_or_str(v: &serde_json::Value) -> Option<bool> {
    match v {
        serde_json::Value::Bool(b) => Some(*b),
        serde_json::Value::String(s) => match s.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assembled at runtime so no key-file marker literal lives in source.
    fn pem(label: &str, body: &str) -> String {
        let dash = "-----";
        format!("{dash}BEGIN {label}{dash}\n{body}\n{dash}END {label}{dash}\n")
    }

    #[test]
    fn base64_round_trip_matches_known_vectors() {
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("aGVsbG8").unwrap(), b"hello");
        assert_eq!(base64_encode(&[0xfb, 0xff]), "+/8=");
        assert_eq!(base64url_encode(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64url_decode("-_8").unwrap(), vec![0xfb, 0xff]);
        // German umlauts survive the byte-level path (github-pr atobUtf8).
        let s = "Trinkhalle Eichenloh – Straße";
        assert_eq!(
            String::from_utf8(base64_decode(&base64_encode(s.as_bytes())).unwrap()).unwrap(),
            s
        );
    }

    #[test]
    fn sha256_matches_the_ts_vector() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hmac_sha256_matches_rfc4231_case() {
        let key = [0x0b; 20];
        let mac = hmac_sha256(&key, b"Hi There");
        assert_eq!(
            hex_encode(&mac),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn timing_safe_equal_behaviour() {
        assert!(timing_safe_equal("abc", "abc"));
        assert!(!timing_safe_equal("abc", "abd"));
        assert!(!timing_safe_equal("abc", "abcd"));
        assert!(!timing_safe_equal("", "a"));
    }

    #[test]
    fn pkcs1_wrapping_layout() {
        let der = vec![0u8; 262];
        let out = pkcs1_to_pkcs8(&der);
        assert_eq!(out[0], 0x30);
        assert_eq!(out[2] as usize * 256 + out[3] as usize, der.len() + 4);
        assert_eq!(&out[4..7], &[0x02, 0x01, 0x00]);
        assert_eq!(&out[7..10], &[0x30, 0x0d, 0x06]);
        // NULL parameters + OCTET STRING tag/length.
        assert_eq!(&out[20..23], &[0x05, 0x00, 0x04]);
        assert_eq!(out[24] as usize * 256 + out[25] as usize, der.len());
        assert_eq!(&out[26..], &der[..]);
    }

    #[test]
    fn pem_parsing_wraps_rsa_and_passes_pkcs8() {
        let pkcs1 = pem("RSA PRIVATE KEY", &base64_encode(&[1, 2, 3]));
        let der = pem_to_pkcs8_der(&pkcs1).unwrap();
        assert_eq!(der[0], 0x30, "PKCS#1 body must come back wrapped");
        assert_eq!(pkcs1_to_pkcs8(&[1, 2, 3]), der);

        let pkcs8 = pem("PRIVATE KEY", &base64_encode(&[9, 9]));
        assert_eq!(pem_to_pkcs8_der(&pkcs8).unwrap(), vec![9, 9]);
        assert!(pem_to_pkcs8_der("no pem here").is_none());
    }

    #[test]
    fn jwt_encode_decode() {
        let input = jwt_signing_input(
            &serde_json::json!({"alg":"RS256","typ":"JWT"}),
            &serde_json::json!({"iss":"1"}),
        );
        let jwt = format!("{input}.c2ln");
        let payload = jwt_decode_payload(&jwt).unwrap();
        assert_eq!(payload["iss"], "1");
        assert!(jwt_decode_payload("a.b").is_err());
    }
}
