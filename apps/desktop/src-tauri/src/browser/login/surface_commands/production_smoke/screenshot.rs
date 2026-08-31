use png::{Decoder, Limits};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_PNG_BYTES: u64 = 24 * 1024 * 1024;
const MAX_DECODED_PNG_BYTES: usize = 128 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION: u32 = 16_384;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::browser::login) struct ProductionSmokeScreenshotProof {
    pub(in crate::browser::login) canonical_path: String,
    pub(in crate::browser::login) byte_size: u64,
    pub(in crate::browser::login) sha256: String,
    pub(in crate::browser::login) png_magic_verified: bool,
    pub(in crate::browser::login) png_structure_verified: bool,
    pub(in crate::browser::login) png_decoded_verified: bool,
    pub(in crate::browser::login) byte_size_verified: bool,
    pub(in crate::browser::login) sha256_verified: bool,
    pub(in crate::browser::login) app_owned_canonical_path_verified: bool,
}

pub(super) fn verify_screenshot_artifact_contract(
    artifact_root: &Path,
    result: &serde_json::Value,
) -> Result<ProductionSmokeScreenshotProof, String> {
    if result.get("result").and_then(serde_json::Value::as_str) != Some("screenshot") {
        return Err("Windows Mode 2 screenshot result kind is invalid".to_string());
    }
    let artifact_id = result
        .get("artifact_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| value.starts_with("shot-") && value.len() <= 256)
        .ok_or_else(|| "Windows Mode 2 screenshot artifact id is invalid".to_string())?;
    let path = result
        .get("path")
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "Windows Mode 2 screenshot omitted its app-owned path".to_string())?;
    let expected_size = result
        .get("byte_size")
        .and_then(serde_json::Value::as_u64)
        .filter(|size| *size > PNG_SIGNATURE.len() as u64 && *size <= MAX_PNG_BYTES)
        .ok_or_else(|| "Windows Mode 2 screenshot size is invalid".to_string())?;
    let expected_sha = result
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .filter(|sha| sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "Windows Mode 2 screenshot digest is invalid".to_string())?;
    let canonical_root = artifact_root
        .canonicalize()
        .map_err(|_| "Windows Mode 2 screenshot artifact root is unavailable".to_string())?;
    let provided_metadata = fs::symlink_metadata(&path)
        .map_err(|_| "Windows Mode 2 screenshot metadata is unavailable".to_string())?;
    if provided_metadata.file_type().is_symlink() || !provided_metadata.file_type().is_file() {
        return Err("Windows Mode 2 screenshot artifact identity changed".to_string());
    }
    let canonical_path = path
        .canonicalize()
        .map_err(|_| "Windows Mode 2 screenshot artifact is unavailable".to_string())?;
    if canonical_path.parent() != Some(canonical_root.as_path()) {
        return Err("Windows Mode 2 screenshot escaped its app-owned artifact root".to_string());
    }
    let expected_file_name = format!("{artifact_id}.png");
    if canonical_path.file_name().and_then(|name| name.to_str())
        != Some(expected_file_name.as_str())
    {
        return Err("Windows Mode 2 screenshot file name did not bind its artifact id".to_string());
    }
    let metadata = fs::symlink_metadata(&canonical_path)
        .map_err(|_| "Windows Mode 2 screenshot metadata is unavailable".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() != expected_size
    {
        return Err("Windows Mode 2 screenshot artifact identity changed".to_string());
    }
    let bytes = fs::read(&canonical_path)
        .map_err(|_| "Windows Mode 2 screenshot artifact is unreadable".to_string())?;
    if hex::encode(Sha256::digest(&bytes)) != expected_sha.to_ascii_lowercase() {
        return Err("Windows Mode 2 screenshot digest contract failed".to_string());
    }
    verify_decodable_png(&bytes)?;
    Ok(ProductionSmokeScreenshotProof {
        canonical_path: canonical_path.to_string_lossy().into_owned(),
        byte_size: expected_size,
        sha256: expected_sha.to_ascii_lowercase(),
        png_magic_verified: true,
        png_structure_verified: true,
        png_decoded_verified: true,
        byte_size_verified: true,
        sha256_verified: true,
        app_owned_canonical_path_verified: true,
    })
}

fn verify_decodable_png(bytes: &[u8]) -> Result<(), String> {
    if !has_strict_png_chunk_envelope(bytes) {
        return Err("Windows Mode 2 screenshot PNG chunk structure is invalid".to_string());
    }
    let decoder = Decoder::new_with_limits(
        Cursor::new(bytes),
        Limits {
            bytes: MAX_DECODED_PNG_BYTES,
        },
    );
    let mut reader = decoder
        .read_info()
        .map_err(|_| "Windows Mode 2 screenshot PNG header or CRC is invalid".to_string())?;
    let width = reader.info().width;
    let height = reader.info().height;
    if width == 0
        || height == 0
        || width > MAX_SCREENSHOT_DIMENSION
        || height > MAX_SCREENSHOT_DIMENSION
        || reader.info().animation_control.is_some()
    {
        return Err(
            "Windows Mode 2 screenshot PNG dimensions or animation are invalid".to_string(),
        );
    }
    let output_size = reader
        .output_buffer_size()
        .filter(|size| *size > 0 && *size <= MAX_DECODED_PNG_BYTES)
        .ok_or_else(|| "Windows Mode 2 screenshot decoded size is invalid".to_string())?;
    let mut output = vec![0; output_size];
    let frame = reader
        .next_frame(&mut output)
        .map_err(|_| "Windows Mode 2 screenshot PNG pixels or CRC are invalid".to_string())?;
    if frame.width != width || frame.height != height {
        return Err("Windows Mode 2 screenshot decoded frame dimensions changed".to_string());
    }
    reader
        .finish()
        .map_err(|_| "Windows Mode 2 screenshot PNG terminator or CRC is invalid".to_string())
}

fn has_strict_png_chunk_envelope(bytes: &[u8]) -> bool {
    if !bytes.starts_with(PNG_SIGNATURE) {
        return false;
    }
    let mut offset = PNG_SIGNATURE.len();
    let mut chunk_index = 0usize;
    let mut saw_idat = false;
    let mut saw_iend = false;
    while offset < bytes.len() {
        let Some(header_end) = offset.checked_add(8) else {
            return false;
        };
        if header_end > bytes.len() {
            return false;
        }
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let Some(chunk_end) = header_end
            .checked_add(length)
            .and_then(|value| value.checked_add(4))
        else {
            return false;
        };
        if chunk_end > bytes.len() || saw_iend {
            return false;
        }
        let chunk_type = &bytes[offset + 4..header_end];
        let chunk_data_end = header_end + length;
        let expected_crc = u32::from_be_bytes(
            bytes[chunk_data_end..chunk_data_end + 4]
                .try_into()
                .unwrap(),
        );
        let mut crc = crc32fast::Hasher::new();
        crc.update(chunk_type);
        crc.update(&bytes[header_end..chunk_data_end]);
        if crc.finalize() != expected_crc {
            return false;
        }
        if chunk_index == 0 {
            if chunk_type != b"IHDR" || length != 13 {
                return false;
            }
        } else if chunk_type == b"IHDR" {
            return false;
        }
        if chunk_type == b"IDAT" {
            saw_idat = true;
        } else if chunk_type == b"IEND" {
            if length != 0 || !saw_idat || chunk_end != bytes.len() {
                return false;
            }
            saw_iend = true;
        }
        offset = chunk_end;
        chunk_index += 1;
    }
    saw_iend
}
