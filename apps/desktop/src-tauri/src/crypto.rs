use aes::cipher::{BlockDecryptMut, KeyIvInit};
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};
use rand::Rng;
use scrypt::{scrypt, Params};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

const PASSWORD: &[u8] = b"claude-code-env-manager-secret";
const SALT: &[u8] = b"salt";
static LOCAL_KEY: OnceLock<[u8; 32]> = OnceLock::new();
// Install key cache: `Some(key)` only after a successful load-or-create. `None`
// means "not yet initialized or last attempt failed" — failures are NOT cached,
// so the next call retries from scratch. This avoids std's unstable
// `OnceLock::get_or_try_init` while still preventing repeated IO on success.
static INSTALL_KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);

struct V2CiphertextParts {
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
    tag: [u8; 16],
}

/// Derive the same 32-byte key as Node.js crypto.scryptSync (legacy, migration only)
fn derive_key() -> [u8; 32] {
    *LOCAL_KEY.get_or_init(|| {
        let mut key = [0u8; 32];
        // Node.js scrypt defaults: N=16384, r=8, p=1
        let params = Params::new(14, 8, 1, 32).unwrap(); // log2(16384) = 14
        scrypt(PASSWORD, SALT, &params, &mut key).unwrap();
        key
    })
}

/// Resolve the install key path under the user's ~/.ccem directory.
fn install_key_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".ccem").join(".install-key"))
}

/// Load an existing install key from `key_path`, or create a new random key
/// and persist it (dir + file + 0600 perms on Unix) before returning.
///
/// Fail-closed contract: every IO / decode / chmod failure is surfaced as an
/// `Err`. We never return an in-memory-only key — if persistence fails the
/// caller must abort the write so no credential is encrypted with an
/// unpersisted key that the next launch cannot recover.
///
/// Error messages describe the failed operation only and never include the
/// key bytes themselves.
fn load_or_create_install_key_at(key_path: &Path) -> Result<[u8; 32], String> {
    if key_path.exists() {
        let content = std::fs::read_to_string(key_path)
            .map_err(|e| format!("Failed to read install key: {}", e))?;
        let trimmed = content.trim();
        let bytes = hex::decode(trimmed)
            .map_err(|_| "Install key is not valid hex".to_string())?;
        if bytes.len() != 32 {
            return Err(format!(
                "Install key has wrong length: expected 32 bytes, got {}",
                bytes.len()
            ));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        return Ok(arr);
    }

    let key_dir = key_path
        .parent()
        .ok_or_else(|| "Install key path has no parent directory".to_string())?;
    std::fs::create_dir_all(key_dir)
        .map_err(|e| format!("Failed to create config directory for install key: {}", e))?;

    let mut rng = rand::thread_rng();
    let new_key: [u8; 32] = rng.gen();
    std::fs::write(key_path, hex::encode(new_key))
        .map_err(|e| format!("Failed to persist install key: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to restrict install key permissions: {}", e))?;
    }

    Ok(new_key)
}

/// Get or create the per-install encryption key from ~/.ccem/.install-key.
/// Shared with the CLI (Node.js) since both use the same config directory.
///
/// Caching strategy: a successful key is cached for the process lifetime.
/// A failed load/create is **not** cached — the mutex stays `None`, so the
/// next call retries from scratch. This prevents a single IO hiccup from
/// poisoning the entire process with an unrecoverable pseudo-key while
/// avoiding repeated IO on the success path.
fn get_or_create_install_key() -> Result<[u8; 32], String> {
    let mut slot = INSTALL_KEY.lock().expect("install key mutex poisoned");
    if let Some(cached) = *slot {
        return Ok(cached);
    }
    let key_path = install_key_path()
        .ok_or_else(|| "Could not resolve home directory for install key".to_string())?;
    let key = load_or_create_install_key_at(&key_path)?;
    *slot = Some(key);
    Ok(key)
}

fn encrypt_v2_with_key(
    plaintext: &str,
    key: &[u8; 32],
    nonce: &[u8; 12],
) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("fixed AES-256-GCM key length");
    let ciphertext = cipher
        .encrypt(aes_gcm::Nonce::from_slice(nonce), plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    // aes-gcm appends the 16-byte tag to the ciphertext.
    let ct_len = ciphertext.len().saturating_sub(16);
    let ct = &ciphertext[..ct_len];
    let tag = &ciphertext[ct_len..];

    Ok(format!(
        "enc:v2:{}:{}:{}",
        hex::encode(nonce),
        hex::encode(ct),
        hex::encode(tag)
    ))
}

fn parse_v2_ciphertext(ciphertext: &str) -> Result<V2CiphertextParts, String> {
    let parts: Vec<&str> = ciphertext.split(':').collect();
    if parts.len() != 5 {
        return Err("Invalid v2 encrypted format".to_string());
    }

    let nonce_bytes = hex::decode(parts[2]).map_err(|e| format!("Invalid nonce: {}", e))?;
    let ct_bytes = hex::decode(parts[3]).map_err(|e| format!("Invalid ciphertext: {}", e))?;
    let tag_bytes = hex::decode(parts[4]).map_err(|e| format!("Invalid tag: {}", e))?;

    if nonce_bytes.len() != 12 || ct_bytes.is_empty() || tag_bytes.len() != 16 {
        return Err("Invalid v2 encrypted format".to_string());
    }

    let nonce = nonce_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "Invalid v2 encrypted format".to_string())?;
    let tag = tag_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "Invalid v2 encrypted format".to_string())?;

    Ok(V2CiphertextParts {
        nonce,
        ciphertext: ct_bytes,
        tag,
    })
}

fn decrypt_v2_parts(parts: V2CiphertextParts, key: &[u8; 32]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("fixed AES-256-GCM key length");
    let mut combined = parts.ciphertext;
    combined.extend_from_slice(&parts.tag);

    let plaintext = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&parts.nonce), combined.as_ref())
        .map_err(|_| "Decryption failed (wrong key or tampered data)".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8: {}", e))
}

fn decrypt_v2_with_key(ciphertext: &str, key: &[u8; 32]) -> Result<String, String> {
    decrypt_v2_parts(parse_v2_ciphertext(ciphertext)?, key)
}

/// Encrypt plaintext using AES-256-GCM with install-bound key.
/// Format: enc:v2:<nonce_hex>:<ciphertext_hex>:<tag_hex>
///
/// Returns Err if the install key cannot be loaded/persisted or AES-GCM
/// encryption itself fails. Empty plaintext short-circuits to an empty
/// string (no key material needed).
pub fn encrypt(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }

    let key = get_or_create_install_key()?;
    let nonce: [u8; 12] = rand::thread_rng().gen();
    encrypt_v2_with_key(plaintext, &key, &nonce)
}

/// Decrypt ciphertext. Auto-detects v2 (AES-256-GCM) vs legacy (AES-256-CBC).
pub fn decrypt(ciphertext: &str) -> Result<String, String> {
    // If not encrypted, return as-is
    if !ciphertext.starts_with("enc:") {
        return Ok(ciphertext.to_string());
    }

    // v2 format: enc:v2:nonce_hex:ciphertext_hex:tag_hex
    if ciphertext.starts_with("enc:v2:") {
        let parts = parse_v2_ciphertext(ciphertext)?;
        let key = get_or_create_install_key()?;
        decrypt_v2_parts(parts, &key)
    } else {
        // Legacy format: enc:iv_hex:ciphertext_hex (AES-256-CBC with hardcoded key)
        decrypt_legacy(ciphertext)
    }
}

/// Decrypt a locally stored secret value with sanitized field context.
pub fn decrypt_local_secret(field_name: &str, value: &str) -> Result<String, String> {
    decrypt(value).map_err(|error| format!("Failed to decrypt {}: {}", field_name, error))
}

/// Decrypt legacy "enc:iv_hex:ciphertext_hex" format (AES-256-CBC).
/// Used only for migration — values are re-encrypted as v2 on next save.
fn decrypt_legacy(ciphertext: &str) -> Result<String, String> {
    let parts: Vec<&str> = ciphertext.split(':').collect();
    if parts.len() != 3 {
        return Ok(ciphertext.to_string());
    }

    let iv = hex::decode(parts[1]).map_err(|e| format!("Invalid IV: {}", e))?;
    let encrypted = hex::decode(parts[2]).map_err(|e| format!("Invalid ciphertext: {}", e))?;

    if iv.len() != 16 {
        return Err("Invalid IV length".to_string());
    }

    let key = derive_key();
    let iv_array: [u8; 16] = iv.try_into().unwrap();

    let mut buffer = encrypted.clone();
    let cipher = Aes256CbcDec::new(&key.into(), &iv_array.into());

    cipher
        .decrypt_padded_mut::<aes::cipher::block_padding::NoPadding>(&mut buffer)
        .map_err(|e| format!("Decryption failed: {}", e))?;

    // Remove PKCS7 padding
    if let Some(&padding_len) = buffer.last() {
        let padding_len = padding_len as usize;
        if padding_len > 0 && padding_len <= 16 {
            buffer.truncate(buffer.len() - padding_len);
        }
    }

    String::from_utf8(buffer).map_err(|e| format!("Invalid UTF-8: {}", e))
}

/// Decrypt a remote server payload.
/// Key: scrypt(secret, "ccem-salt", 32) with N=16384,r=8,p=1
/// Input: base64(IV_16_bytes || ciphertext), AES-256-CBC
pub fn decrypt_remote(encrypted_base64: &str, secret: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let mut key = [0u8; 32];
    let params = Params::new(14, 8, 1, 32).unwrap();
    scrypt(secret.as_bytes(), b"ccem-salt", &params, &mut key).unwrap();

    let data = STANDARD
        .decode(encrypted_base64)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    if data.len() < 17 {
        return Err("Encrypted data too short".to_string());
    }

    let iv: [u8; 16] = data[..16].try_into().unwrap();
    let mut buffer = data[16..].to_vec();

    let cipher = Aes256CbcDec::new(&key.into(), &iv.into());
    cipher
        .decrypt_padded_mut::<aes::cipher::block_padding::NoPadding>(&mut buffer)
        .map_err(|e| format!("Decryption failed: {}", e))?;

    // Remove PKCS7 padding
    if let Some(&padding_len) = buffer.last() {
        let padding_len = padding_len as usize;
        if padding_len > 0 && padding_len <= 16 {
            buffer.truncate(buffer.len() - padding_len);
        }
    }

    String::from_utf8(buffer).map_err(|e| format!("Invalid UTF-8: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plaintext = "sk-ant-api03-test-key";
        let encrypted = encrypt(plaintext).expect("encrypt should succeed with valid install key");
        assert!(encrypted.starts_with("enc:v2:"));

        let decrypted = decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_unencrypted() {
        let plaintext = "plain-text";
        let result = decrypt(plaintext).unwrap();
        assert_eq!(result, plaintext);
    }

    #[test]
    fn test_encrypt_empty() {
        let result = encrypt("").expect("empty plaintext should short-circuit without key IO");
        assert_eq!(result, "");
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenVectors {
        key_hex: String,
        plaintext: String,
        typescript: GoldenVector,
        rust: GoldenVector,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenVector {
        nonce_hex: String,
        ciphertext: String,
    }

    #[test]
    fn cross_language_enc_v2_golden_vectors() {
        let vectors: GoldenVectors = serde_json::from_str(include_str!(
            "../../../../packages/core/test-fixtures/enc-v2-golden-vectors.json"
        ))
        .expect("golden vector fixture should parse");
        let key: [u8; 32] = hex::decode(&vectors.key_hex)
            .expect("fixture key should be hex")
            .try_into()
            .expect("fixture key should be 32 bytes");

        assert_eq!(
            decrypt_v2_with_key(&vectors.typescript.ciphertext, &key).unwrap(),
            vectors.plaintext
        );
        assert_eq!(
            decrypt_v2_with_key(&vectors.rust.ciphertext, &key).unwrap(),
            vectors.plaintext
        );

        let typescript_nonce: [u8; 12] = hex::decode(&vectors.typescript.nonce_hex)
            .expect("TypeScript nonce should be hex")
            .try_into()
            .expect("TypeScript nonce should be 12 bytes");
        assert_eq!(
            encrypt_v2_with_key(&vectors.plaintext, &key, &typescript_nonce).unwrap(),
            vectors.typescript.ciphertext
        );

        let rust_nonce: [u8; 12] = hex::decode(&vectors.rust.nonce_hex)
            .expect("Rust nonce should be hex")
            .try_into()
            .expect("Rust nonce should be 12 bytes");
        assert_eq!(
            encrypt_v2_with_key(&vectors.plaintext, &key, &rust_nonce).unwrap(),
            vectors.rust.ciphertext
        );
    }

    #[test]
    fn test_v2_format_structure() {
        let encrypted = encrypt("test-secret-key").expect("encrypt should succeed");
        assert!(encrypted.starts_with("enc:v2:"));
        let parts: Vec<&str> = encrypted.split(':').collect();
        // enc, v2, nonce, ciphertext, tag
        assert_eq!(parts.len(), 5);
        // nonce: 12 bytes = 24 hex chars
        assert_eq!(parts[2].len(), 24);
        // tag: 16 bytes = 32 hex chars
        assert_eq!(parts[4].len(), 32);
    }

    #[test]
    fn test_tamper_detection() {
        let encrypted = encrypt("sensitive-token-value").expect("encrypt should succeed");
        let parts: Vec<&str> = encrypted.split(':').collect();

        // Flip a bit in the ciphertext
        let mut tampered_ct = parts[3].to_string();
        let mut chars = tampered_ct.chars().collect::<Vec<_>>();
        chars[0] = if chars[0] == '0' { '1' } else { '0' };
        tampered_ct = chars.into_iter().collect();
        let _tampered = format!("{}:{}:{}:{}", parts[0], parts[1], parts[2], tampered_ct);

        // Tampered ciphertext should not have the tag part, so it won't parse correctly
        // But let's also test with a wrong tag
        let tampered_full = format!(
            "{}:{}:{}:{}:{}",
            parts[0], parts[1], parts[2], parts[3], "00000000000000000000000000000000"
        );

        let result = decrypt(&tampered_full);
        assert!(
            result.is_err(),
            "Tampered ciphertext should fail decryption"
        );
    }

    #[test]
    fn test_decrypt_malformed_v2_fails_closed() {
        let malformed = "enc:v2:not-enough-fields";

        let result = decrypt(malformed);

        assert!(result.is_err(), "Malformed v2 ciphertext should fail");
        let error = result.unwrap_err();
        assert!(
            !error.contains(malformed),
            "Error should not include encrypted secret material"
        );
    }

    #[test]
    fn test_decrypt_legacy_format() {
        // Create a legacy-format encrypted value using the old CBC method
        let plaintext = "legacy-api-key-12345";
        let key = derive_key();
        let iv: [u8; 16] = rand::thread_rng().gen();

        let block_size = 16;
        let padding_len = block_size - (plaintext.len() % block_size);
        let mut buffer = plaintext.as_bytes().to_vec();
        buffer.extend(std::iter::repeat_n(padding_len as u8, padding_len));
        let len = buffer.len();
        let cipher = Aes256CbcEnc::new(&key.into(), &iv.into());
        cipher
            .encrypt_padded_mut::<aes::cipher::block_padding::NoPadding>(&mut buffer, len)
            .unwrap();

        let legacy_encrypted = format!("enc:{}:{}", hex::encode(iv), hex::encode(&buffer));

        // Legacy decrypt should work
        let decrypted = decrypt(&legacy_encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_migration_legacy_to_v2() {
        // Step 1: Create legacy encrypted value
        let plaintext = "migration-test-key";
        let key = derive_key();
        let iv: [u8; 16] = rand::thread_rng().gen();

        let block_size = 16;
        let padding_len = block_size - (plaintext.len() % block_size);
        let mut buffer = plaintext.as_bytes().to_vec();
        buffer.extend(std::iter::repeat_n(padding_len as u8, padding_len));
        let len = buffer.len();
        let cipher = Aes256CbcEnc::new(&key.into(), &iv.into());
        cipher
            .encrypt_padded_mut::<aes::cipher::block_padding::NoPadding>(&mut buffer, len)
            .unwrap();

        let legacy_encrypted = format!("enc:{}:{}", hex::encode(iv), hex::encode(&buffer));

        // Step 2: Decrypt legacy value
        let decrypted = decrypt(&legacy_encrypted).unwrap();
        assert_eq!(decrypted, plaintext);

        // Step 3: Re-encrypt with v2
        let v2_encrypted = encrypt(&decrypted).expect("encrypt should succeed");
        assert!(v2_encrypted.starts_with("enc:v2:"));

        // Step 4: Decrypt v2 value — should match original
        let final_decrypted = decrypt(&v2_encrypted).unwrap();
        assert_eq!(final_decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_remote_roundtrip() {
        use aes::cipher::{BlockEncryptMut, KeyIvInit};
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let secret = "my-test-secret";
        let plaintext = r#"{"environments":{"test":{"ANTHROPIC_BASE_URL":"https://example.com"}}}"#;

        // Derive key with same params
        let mut key = [0u8; 32];
        let params = Params::new(14, 8, 1, 32).unwrap();
        scrypt(secret.as_bytes(), b"ccem-salt", &params, &mut key).unwrap();

        // Encrypt: PKCS7 pad, AES-256-CBC, prepend IV, base64
        let iv: [u8; 16] = rand::thread_rng().gen();
        let block_size = 16;
        let padding_len = block_size - (plaintext.len() % block_size);
        let mut buffer = plaintext.as_bytes().to_vec();
        buffer.extend(std::iter::repeat_n(padding_len as u8, padding_len));
        let len = buffer.len();
        let cipher = Aes256CbcEnc::new(&key.into(), &iv.into());
        cipher
            .encrypt_padded_mut::<aes::cipher::block_padding::NoPadding>(&mut buffer, len)
            .unwrap();

        let mut combined = iv.to_vec();
        combined.extend_from_slice(&buffer);
        let encoded = STANDARD.encode(&combined);

        // Decrypt and verify
        let decrypted = decrypt_remote(&encoded, secret).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    // ---- install key IO failure-mode tests ----
    //
    // These tests exercise `load_or_create_install_key_at` directly (bypassing
    // the process-global OnceLock) so each scenario starts from a clean slate
    // in its own tempdir. The contract under test: every IO / decode / chmod
    // failure must surface as `Err`; we never return an in-memory-only key.

    #[test]
    fn install_key_create_then_read_roundtrip() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let key_path = dir.path().join(".install-key");
        let created = load_or_create_install_key_at(&key_path).expect("first call creates key");

        // File must now exist on disk with hex-encoded 32-byte key
        assert!(key_path.exists(), "key file should be persisted");
        let persisted = std::fs::read_to_string(&key_path).expect("read persisted key");
        let decoded = hex::decode(persisted.trim()).expect("persisted key is hex");
        assert_eq!(decoded.len(), 32, "persisted key has 32 bytes");
        assert_eq!(decoded, created.to_vec(), "persisted bytes match returned key");

        // Second call must load the same key (not generate a new one)
        let reloaded = load_or_create_install_key_at(&key_path).expect("second call reads key");
        assert_eq!(reloaded, created, "reloaded key must match created key");
    }

    #[cfg(unix)]
    #[test]
    fn install_key_unix_permissions_are_restricted() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let key_path = dir.path().join(".install-key");
        load_or_create_install_key_at(&key_path).expect("create key");

        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&key_path)
            .expect("stat key")
            .permissions()
            .mode();
        let perm_bits = mode & 0o777;
        assert_eq!(
            perm_bits, 0o600,
            "install key must be 0600 after creation, got {:o}",
            perm_bits
        );
    }

    #[test]
    fn install_key_rejects_non_hex_content() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let key_path = dir.path().join(".install-key");
        std::fs::write(&key_path, "this-is-not-hex!!")
            .expect("seed malformed key file");

        let error = load_or_create_install_key_at(&key_path)
            .expect_err("non-hex key should fail");
        assert!(
            !error.contains("this-is-not-hex"),
            "error must not echo file contents: {}",
            error
        );
        assert!(
            error.contains("not valid hex"),
            "error should describe the decode failure: {}",
            error
        );
    }

    #[test]
    fn install_key_rejects_wrong_length() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let key_path = dir.path().join(".install-key");
        // 16 bytes instead of 32 — valid hex, wrong length.
        std::fs::write(&key_path, hex::encode([0u8; 16]))
            .expect("seed short key");

        let error = load_or_create_install_key_at(&key_path)
            .expect_err("short key should fail");
        assert!(
            error.contains("wrong length") && error.contains("32"),
            "error should mention expected length: {}",
            error
        );
        // Must not include the actual bytes.
        assert!(
            !error.contains(&hex::encode([0u8; 16])),
            "error must not leak key bytes"
        );
    }

    #[test]
    fn install_key_create_fails_when_parent_is_a_file() {
        // If the parent "directory" is actually a regular file, create_dir_all
        // fails — we must surface that error rather than silently writing the
        // key to a nonsensical location.
        let dir = tempfile::tempdir().expect("create tempdir");
        let parent = dir.path().join("blocking-file");
        std::fs::write(&parent, b"blocker").expect("seed blocker file");
        let key_path = parent.join(".install-key");

        let error = load_or_create_install_key_at(&key_path)
            .expect_err("should fail when parent is not a directory");
        assert!(
            error.contains("config directory"),
            "error should describe dir-create failure: {}",
            error
        );
        // Crucially: no key file was created, no key returned.
        assert!(!key_path.exists(), "key file must not be created on failure");
    }

    #[test]
    fn install_key_read_fails_when_path_is_a_directory() {
        // If the key path itself is a directory, read_to_string fails.
        let dir = tempfile::tempdir().expect("create tempdir");
        let key_path = dir.path().join(".install-key");
        std::fs::create_dir(&key_path).expect("seed key-as-directory");

        let error = load_or_create_install_key_at(&key_path)
            .expect_err("should fail when key path is a directory");
        assert!(
            error.contains("Failed to read install key"),
            "error should describe read failure: {}",
            error
        );
    }
}
