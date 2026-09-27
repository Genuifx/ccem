#!/usr/bin/env python3
"""Build-side only: a relocatable, locked Hermes package for CCEM (macOS arm64).

End users never run this script, pip, uv or a system interpreter. The output zip contains its own
Python and dependency closure. Signing keys belong in CI secrets or ignored local artifacts.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

COMMIT = "bc1330eebc0aa8a443501b5f62586eb7361353a5"
LOCK_HASH = "6393f09ee88cc5683f0e563306f96b5c068f901a8baa60f7209f302c1ac602d9"
PYTHON_VERSION = "3.11.16"
PYTHON_URL = "https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.11.16%2B20260901-aarch64-apple-darwin-install_only_stripped.tar.gz"
PYTHON_SHA256 = "768f05cf200273bbdda9a5955a5a6892a4b22f2a0b1e4b0a9160f5c7fce86816"
PYTHON_SIZE = 26961472
KEY_ID = "ccem-hermes-runtime-2026-01"
REPO = Path(__file__).resolve().parents[2]


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def run(args: list[str], *, cwd: Path | None = None, env: dict | None = None) -> str:
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"Build command failed ({args[0]}): {result.stderr[-4000:]}")
    return result.stdout


def fetch_python(cache: Path) -> Path:
    archive = cache / "cpython-3.11.16-20260901-macos-aarch64.tar.gz"
    if archive.exists() and archive.stat().st_size == PYTHON_SIZE and sha256(archive) == PYTHON_SHA256:
        return archive
    temporary = archive.with_suffix(".part")
    with urllib.request.urlopen(PYTHON_URL, timeout=60) as response, temporary.open("wb") as target:
        downloaded = 0
        while chunk := response.read(1024 * 1024):
            downloaded += len(chunk)
            if downloaded > PYTHON_SIZE:
                raise ValueError("Python download exceeds pinned size")
            target.write(chunk)
    if temporary.stat().st_size != PYTHON_SIZE or sha256(temporary) != PYTHON_SHA256:
        raise ValueError("Python release size/SHA-256 mismatch")
    temporary.replace(archive)
    return archive


def safe_tar(archive: Path, target: Path) -> None:
    """The build also refuses absolute/escaping paths, device files and escaping links."""
    with tarfile.open(archive) as handle:
        for member in handle.getmembers():
            destination = (target / member.name).resolve()
            if not destination.is_relative_to(target.resolve()):
                raise ValueError(f"Escaping archive path: {member.name}")
            if member.isdev() or member.isfifo():
                raise ValueError("Unsupported archive entry")
            if member.issym() or member.islnk():
                base = destination.parent if member.issym() else target
                if not (base / member.linkname).resolve().is_relative_to(target.resolve()):
                    raise ValueError("Escaping archive link")
        handle.extractall(target, filter="data")


def regularize_links(root: Path) -> None:
    """Ship regular files only. This avoids relying on arbitrary client symlink interpretation."""
    links = [p for p in root.rglob("*") if p.is_symlink()]
    for path in links:
        target = path.resolve(strict=True)
        if not target.is_relative_to(root.resolve()):
            raise ValueError(f"External package symlink: {path.relative_to(root)}")
        if not target.is_file():
            raise ValueError(f"Directory symlink is not supported: {path.relative_to(root)}")
        data, mode = target.read_bytes(), target.stat().st_mode
        path.unlink()
        path.write_bytes(data)
        path.chmod(stat.S_IMODE(mode))


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")


def sign(data: bytes, private_key_path: Path) -> tuple[str, str]:
    """Minisign ED prehashed envelope, verified by the same minisign-verify used by CCEM.

    Build secret is a raw 32-byte Ed25519 seed. Production can instead sign the emitted manifest
    with the publisher's minisign process; this utility never generates a production key.
    """
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
    if not private_key_path.is_file() or private_key_path.is_symlink() or private_key_path.stat().st_mode & 0o077:
        raise ValueError("Signing seed must be a private regular file (mode 0600)")
    seed = private_key_path.read_bytes()
    if len(seed) != 32:
        raise ValueError("Signing seed must have exactly 32 bytes")
    private = Ed25519PrivateKey.from_private_bytes(seed)
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    key_id = hashlib.sha256(public).digest()[:8]
    signature = private.sign(hashlib.blake2b(data).digest())
    trusted = "CCEM Hermes runtime manifest"
    packet = b"ED" + key_id + signature
    encoded = "\n".join(["untrusted comment: CCEM Hermes runtime signature",
        base64.b64encode(packet).decode(), "trusted comment: " + trusted,
        base64.b64encode(private.sign(signature + trusted.encode())).decode(), ""])
    public_text = "untrusted comment: minisign public key: " + key_id.hex().upper() + "\n" + base64.b64encode(b"Ed" + key_id + public).decode() + "\n"
    return encoded, public_text


def inventory(root: Path) -> list[dict]:
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Package must not retain symbolic links")
        if path.is_file():
            files.append({"path": path.relative_to(root).as_posix(), "size": path.stat().st_size, "sha256": sha256(path)})
    return files


def native_audit(root: Path) -> dict:
    """Inspect actual load commands; LC_ID_DYLIB is an identity, not a loaded dependency."""
    count, versions, external = 0, [], []
    for path in root.rglob("*"):
        if not path.is_file() or (path.suffix not in {".so", ".dylib"} and path.parent != root / "python/bin"):
            continue
        result = subprocess.run(["/usr/bin/otool", "-l", str(path)], text=True, capture_output=True)
        if result.returncode:
            continue
        count += 1
        for block in result.stdout.split("Load command "):
            if re.search(r"\bcmd LC_(?:LOAD|LOAD_WEAK|REEXPORT|LAZY_LOAD|LOAD_UPWARD)_DYLIB\b", block):
                match = re.search(r"\bname (.+?) \(offset", block)
                if match and match[1].startswith("/") and not match[1].startswith(("/usr/lib/", "/System/Library/")):
                    external.append({"file": path.relative_to(root).as_posix(), "dependency": match[1]})
            for command, field in [("LC_VERSION_MIN_MACOSX", "version"), ("LC_BUILD_VERSION", "minos")]:
                match = re.search(rf"\b{field} ([\d.]+)", block) if command in block else None
                if match:
                    versions.append(match[1])
    if external:
        raise ValueError(f"Runtime depends on external native libraries: {external}")
    minimum = max(versions, key=lambda v: tuple(map(int, v.split(".")))) if versions else None
    if not count or minimum is None or tuple(map(int, minimum.split("."))) > (14, 0):
        raise ValueError(f"Native runtime minimum macOS exceeds supported 14.0: {minimum}")
    return {"nativeFiles": count, "externalLoadPaths": external, "maxMinimumOS": minimum}


def prepare(args: argparse.Namespace) -> dict:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("Only macOS arm64 is a verified build target")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache = output / "build-cache"
    cache.mkdir(exist_ok=True)
    package = output / "hermes-runtime"
    if args.restart_prepare and package.exists() and not package.is_symlink():
        shutil.rmtree(package)
    if package.exists():
        raise ValueError("Output runtime already exists; use a fresh output directory")
    package.mkdir(mode=0o700)
    archive = fetch_python(cache)
    safe_tar(archive, package)
    regularize_links(package)
    python = package / "python/bin/python3.11"
    if run([str(python), "-I", "-c", "import platform; print(platform.python_version())"]).strip() != PYTHON_VERSION:
        raise ValueError("Unexpected portable Python version")
    source = package / "source"
    source.mkdir()
    source_tar = cache / "hermes-source.tar"
    with source_tar.open("wb") as target:
        subprocess.run(["git", "-C", str(args.hermes_source.resolve()), "archive", COMMIT], check=True, stdout=target)
    safe_tar(source_tar, source)
    if sha256(source / "uv.lock") != LOCK_HASH:
        raise ValueError("Hermes lock does not match the reviewed baseline")
    # Export the exact dependency solution before applying CCEM's reviewed gateway patch.
    # The upstream messaging extra supplies Telegram, Discord and Slack plus
    # their shared transport. Keep the original lock, including wheel hashes.
    requirements = cache / "requirements.lock.txt"
    requirements.write_text(run([args.uv, "export", "--frozen", "--no-dev", "--no-emit-project",
        "--extra", "wecom", "--extra", "feishu", "--extra", "messaging", "--extra", "anthropic", "--format", "requirements-txt"], cwd=source))
    site = package / "python/lib/python3.11/site-packages"
    print("Installing the locked wheel closure in the build artifact", flush=True)
    subprocess.run([args.uv, "pip", "install", "--python", str(python), "--target", str(site),
        "--require-hashes", "--only-binary", ":all:", "--no-deps", "-r", str(requirements)], check=True)
    shutil.copy2(requirements, package / "requirements.lock.txt")
    # All dependency license/metadata files remain in site-packages; no compile/install occurs
    # after the artifact leaves this builder. Remove generated launchers with absolute shebangs.
    for directory in [site / "bin", package / "python/bin"]:
        if directory == site / "bin" and directory.exists():
            shutil.rmtree(directory)
    for path in package.rglob("__pycache__"):
        shutil.rmtree(path)
    regularize_links(package)
    shutil.copy2(source / "LICENSE", package / "LICENSE")
    (package / "NOTICE").write_text(
        "CCEM managed Hermes runtime\nHermes Agent: Nous Research and contributors, MIT.\n"
        f"Source revision: {COMMIT}\nPython: CPython {PYTHON_VERSION} via Astral python-build-standalone 20260901.\n"
        "Python and bundled library licenses are retained under python/share and python/lib/python3.11/site-packages.\n"
        "requirements.lock.txt records the pinned dependency closure and wheel integrity hashes.\n"
        "This local artifact is not an Apple Developer ID signed/notarized production release.\n")
    receipt = {"pythonSource": PYTHON_URL, "pythonSha256": PYTHON_SHA256, "pythonDownloadBytes": PYTHON_SIZE,
        "hermesCommit": COMMIT, "uvLockSha256": LOCK_HASH, "uvVersion": run([args.uv, "--version"]).strip(),
        "preparedAt": int(time.time()), "buildState": "prepared"}
    write_json(output / "build-receipt.json", receipt)
    return receipt


def finalize(args: argparse.Namespace) -> dict:
    output = args.output.resolve()
    package = output / "hermes-runtime"
    source = package / "source"
    patch = args.patch.resolve()
    host = args.host.resolve()
    if not patch.is_file() or not host.is_file():
        raise ValueError("Reviewed gateway patch and host must both exist before finalization")
    patch_env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(source.parent)}
    stamp = output / "build-cache/applied-patch.json"
    previous = json.loads(stamp.read_text()) if stamp.exists() else None
    if previous and previous["sha256"] != sha256(patch):
        # Rebuild source from the pinned archive, preserving the already verified Python/wheels.
        shutil.rmtree(source)
        source.mkdir()
        safe_tar(output / "build-cache/hermes-source.tar", source)
        previous = None
    if not previous:
        run(["git", "apply", "--check", str(patch)], cwd=source, env=patch_env)
        run(["git", "apply", str(patch)], cwd=source, env=patch_env)
        write_json(stamp, {"sha256": sha256(patch)})
    shutil.copy2(host, package / "ccem_gateway_host.py")
    shutil.copy2(host.with_name("ccem_gateway_onboarding.py"), package / "ccem_gateway_onboarding.py")
    shutil.copy2(host.with_name("ccem_session_advisor.py"), package / "ccem_session_advisor.py")
    regularize_links(package)
    for path in package.rglob("__pycache__"):
        shutil.rmtree(path)
    (package / "runtime.json").unlink(missing_ok=True)
    python = package / "python/bin/python3.11"
    # Relocation is part of the build gate. No system Python/Node or user Hermes is in PATH.
    relocated = output / "relocation-proof"
    package.rename(relocated)
    try:
        command = [str(relocated / "python/bin/python3.11"), "-I", "-B", str(relocated / "ccem_gateway_host.py"), "--self-test"]
        raw = run(command, cwd=relocated, env={"PATH": "/usr/bin:/bin", "HOME": str(output / "unused-profile"), "LANG": "en_US.UTF-8"})
        result = json.loads(raw)
        if result.get("ok") is not True or result.get("protocolVersion") != 1:
            raise ValueError("Relocated host health/protocol gate failed")
        channels = result.get("channels")
        if not isinstance(channels, list) or not channels or any(not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", name) for name in channels) or len(set(channels)) != len(channels):
            raise ValueError("Relocated host did not attest its managed channel capabilities")
    finally:
        relocated.rename(package)
    audit = native_audit(package)
    files = inventory(package)
    write_json(package / "runtime.json", {"schemaVersion": 1, "protocolVersion": 1, "hermesCommit": COMMIT,
        "uvLockSha256": LOCK_HASH, "pythonVersion": PYTHON_VERSION, "platform": "macos", "architecture": "aarch64",
        "channels": channels, "files": files})
    files = inventory(package)
    version_dir = output / args.version
    version_dir.mkdir(exist_ok=True)
    archive = version_dir / "hermes-macos-aarch64.zip"
    source_url = args.source_base_url.rstrip("/") + "/" + args.version + "/" + archive.name
    parsed = urllib.parse.urlparse(source_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("A fixed HTTPS artifact source is required (development manifests use https://127.0.0.1:<port>)")
    if archive.exists() and parsed.hostname not in {"127.0.0.1", "::1"}:
        raise ValueError("A production artifact is immutable; publish a new version/sequence")
    # ZIP32 keeps the client parser's existing bounded central-directory validation applicable.
    temporary_archive = archive.with_suffix(".zip.build-part")
    with zipfile.ZipFile(temporary_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=False) as target:
        for item in files:
            path = package / item["path"]
            target.write(path, "hermes-runtime/" + item["path"])
    temporary_archive.replace(archive)
    archive_size = archive.stat().st_size
    unpacked = sum(item["size"] for item in files)
    manifest = {"schema_version": 1, "signing_key_id": KEY_ID, "sequence": args.sequence, "minimum_protocol_version": 1,
        "artifact": {"platform": "macos", "architecture": "aarch64", "version": args.version, "minimum_os_version": "14.0",
            "source_url": source_url, "archive": {"format": "zip", "byte_size": archive_size, "sha256": sha256(archive),
                "max_entries": len(files) + 1, "max_unpacked_bytes": max(unpacked, archive_size),
                "max_file_bytes": max(item["size"] for item in files)},
            "layout": {"root_directory": "hermes-runtime", "executable": {"relative_path": "python/bin/python3.11",
                "byte_size": python.stat().st_size, "sha256": sha256(python)}, "symlinks": []},
            "product_identity": {"product_name": "CCEM Hermes Runtime", "product_version": args.version,
                "bundle_identifier": None, "publisher": "CCEM"}}}
    manifest_path = output / "manifest.json"
    write_json(manifest_path, manifest)
    signature, public = sign(manifest_path.read_bytes(), args.signing_seed.resolve())
    (output / "manifest.json.sig").write_text(signature)
    (output / "public-key.pub").write_text(public)
    receipt = json.loads((output / "build-receipt.json").read_text())
    receipt.update({"buildState": "complete", "version": args.version, "sequence": args.sequence, "artifactBytes": archive_size,
        "unpackedBytes": unpacked, "fileCount": len(files), "archiveSha256": manifest["artifact"]["archive"]["sha256"],
        "patchSha256": sha256(patch), "hostSha256": sha256(host), "relocatedSelfTest": result,
        "nativeAudit": audit,
        "installContentBytes": archive_size + unpacked,
        "installSpaceBudgetBytesAt4KiB": archive_size + unpacked + (len(files) + 1) * 8192 + 64 * 1024 * 1024,
        "productionSignedNotarized": False})
    write_json(output / "build-receipt.json", receipt)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--uv", default="uv")
    parser.add_argument("--stage", choices=["prepare", "finalize", "all"], default="all")
    parser.add_argument("--restart-prepare", action="store_true", help="Delete only this builder's output runtime directory and prepare it again")
    parser.add_argument("--patch", type=Path, default=REPO / "scripts/hermes/patches/0001-managed-gateway-contracts.patch")
    parser.add_argument("--host", type=Path, default=REPO / "scripts/hermes/ccem_gateway_host.py")
    parser.add_argument("--version", default="2026.9.10.1")
    parser.add_argument("--sequence", type=int, default=1)
    parser.add_argument("--source-base-url", default="https://127.0.0.1:57890")
    parser.add_argument("--signing-seed", type=Path)
    args = parser.parse_args()
    if args.stage != "prepare" and (args.signing_seed is None or args.sequence < 1):
        parser.error("finalization requires --signing-seed and a positive sequence")
    if args.stage in {"prepare", "all"}:
        print(json.dumps(prepare(args), indent=2))
    if args.stage in {"finalize", "all"}:
        print(json.dumps(finalize(args), indent=2))


if __name__ == "__main__":
    main()
