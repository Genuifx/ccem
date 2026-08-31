use super::*;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

const ARTIFACT_ID: &str = "shot-0123456789abcdef0123456789abcdef";

fn contract(path: &Path, bytes: &[u8]) -> serde_json::Value {
    serde_json::json!({
        "result": "screenshot",
        "artifact_id": ARTIFACT_ID,
        "path": path,
        "byte_size": bytes.len(),
        "sha256": hex::encode(Sha256::digest(bytes)),
    })
}

fn valid_png() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0x24, 0x68, 0xac, 0xff]).unwrap();
    }
    bytes
}

fn png_with_text_chunk() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .add_text_chunk("Comment".to_string(), "Mode 2 proof".to_string())
            .unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0x24, 0x68, 0xac, 0xff]).unwrap();
    }
    bytes
}

fn png_with_iccp_chunk() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut info = png::Info::with_size(1, 1);
        info.color_type = png::ColorType::Rgba;
        info.bit_depth = png::BitDepth::Eight;
        info.icc_profile = Some(b"CCEM Mode 2 test profile".as_slice().into());
        let encoder = png::Encoder::with_info(&mut bytes, info).unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0x24, 0x68, 0xac, 0xff]).unwrap();
    }
    bytes
}

fn corrupt_chunk_crc(bytes: &[u8], wanted_chunk_type: &[u8; 4]) -> Vec<u8> {
    let mut corrupted = bytes.to_vec();
    let mut offset = 8usize;
    while offset + 12 <= corrupted.len() {
        let length = u32::from_be_bytes(corrupted[offset..offset + 4].try_into().unwrap()) as usize;
        let chunk_type = &corrupted[offset + 4..offset + 8];
        let chunk_end = offset + 12 + length;
        if chunk_type == wanted_chunk_type {
            corrupted[chunk_end - 1] ^= 0x01;
            return corrupted;
        }
        offset = chunk_end;
    }
    panic!(
        "encoded fixture omitted {}",
        String::from_utf8_lossy(wanted_chunk_type)
    );
}

#[test]
fn screenshot_proof_binds_canonical_owned_png_bytes() {
    let png = valid_png();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("artifacts");
    fs::create_dir(&root).unwrap();
    let path = root.join(format!("{ARTIFACT_ID}.png"));
    fs::write(&path, &png).unwrap();

    let proof = verify_screenshot_artifact_contract(&root, &contract(&path, &png)).unwrap();
    assert_eq!(
        proof.canonical_path,
        path.canonicalize().unwrap().to_string_lossy()
    );
    assert_eq!(proof.byte_size, png.len() as u64);
    assert_eq!(proof.sha256, hex::encode(Sha256::digest(&png)));
    assert!(proof.png_magic_verified && proof.png_structure_verified);
    assert!(proof.png_decoded_verified && proof.byte_size_verified);
    assert!(proof.sha256_verified && proof.app_owned_canonical_path_verified);
}

#[test]
fn screenshot_proof_rejects_escape_digest_drift_and_symlink() {
    let png = valid_png();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("artifacts");
    fs::create_dir(&root).unwrap();
    let outside = temp.path().join(format!("{ARTIFACT_ID}.png"));
    fs::write(&outside, &png).unwrap();
    assert!(verify_screenshot_artifact_contract(&root, &contract(&outside, &png)).is_err());

    let owned = root.join(format!("{ARTIFACT_ID}.png"));
    fs::write(&owned, &png).unwrap();
    let expected = contract(&owned, &png);
    fs::write(&owned, b"\x89PNG\r\n\x1a\nnot-the-same-png").unwrap();
    assert!(verify_screenshot_artifact_contract(&root, &expected).is_err());

    #[cfg(unix)]
    {
        fs::remove_file(&owned).unwrap();
        std::os::unix::fs::symlink(&outside, &owned).unwrap();
        assert!(verify_screenshot_artifact_contract(&root, &contract(&owned, &png)).is_err());
    }
}

#[test]
fn screenshot_proof_rejects_fake_truncated_and_bad_crc_pngs() {
    let png = valid_png();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("artifacts");
    fs::create_dir(&root).unwrap();
    let path = root.join(format!("{ARTIFACT_ID}.png"));

    for invalid in [
        b"\x89PNG\r\n\x1a\nmode2-proof".to_vec(),
        png[..png.len() - 12].to_vec(),
        corrupt_chunk_crc(&png, b"IDAT"),
    ] {
        fs::write(&path, &invalid).unwrap();
        assert!(verify_screenshot_artifact_contract(&root, &contract(&path, &invalid)).is_err());
    }
}

#[test]
fn screenshot_proof_rejects_bad_ancillary_chunk_crcs() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("artifacts");
    fs::create_dir(&root).unwrap();
    let path = root.join(format!("{ARTIFACT_ID}.png"));

    for invalid in [
        corrupt_chunk_crc(&png_with_text_chunk(), b"tEXt"),
        corrupt_chunk_crc(&png_with_iccp_chunk(), b"iCCP"),
    ] {
        fs::write(&path, &invalid).unwrap();
        assert!(verify_screenshot_artifact_contract(&root, &contract(&path, &invalid)).is_err());
    }
}
