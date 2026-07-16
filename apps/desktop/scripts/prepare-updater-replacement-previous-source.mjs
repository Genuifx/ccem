import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assertUpdaterReplacementSmokeAuthorization,
  sha256File,
  writePrivateJsonCreateNew,
} from './updater-replacement-smoke-runner-core.mjs';

const execFileAsync = promisify(execFile);
const INSTRUMENTATION_FILES = Object.freeze([
  'apps/desktop/src-tauri/Cargo.toml',
  'apps/desktop/src-tauri/src/app_updates.rs',
  'apps/desktop/src-tauri/src/main.rs',
  'apps/desktop/src-tauri/src/updater_replacement_smoke/contract.rs',
  'apps/desktop/src-tauri/src/updater_replacement_smoke/mod.rs',
  'apps/desktop/src-tauri/src/updater_replacement_smoke/runtime.rs',
]);

function fail(message) {
  throw new Error(`[prepare-updater-replacement-previous-source] ${message}`);
}

async function git(repo, args, options = {}) {
  try {
    const result = await execFileAsync('git', ['-C', repo, ...args], {
      encoding: options.encoding ?? 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    fail(`git ${args.join(' ')} failed: ${error.stderr?.trim() || error.message}`);
  }
}

function exactGitSha(value, label) {
  const normalized = value.trim();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) fail(`${label} is not an exact Git SHA`);
  return normalized;
}

function parseVersion(cargoToml) {
  const match = cargoToml.match(/^version\s*=\s*"([^"]+)"\s*$/mu);
  if (!match || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(match[1])) {
    fail('previous Cargo.toml package version is missing or invalid');
  }
  return match[1];
}

async function previousEmbeddedUpdaterPublicKeySha256(worktree) {
  const configPath = path.join(worktree, 'apps/desktop/src-tauri/tauri.conf.json');
  let config;
  try {
    config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (error) {
    fail(`read previous tauri.conf.json updater key: ${error.message}`);
  }
  const publicKey = config?.plugins?.updater?.pubkey;
  if (typeof publicKey !== 'string' || publicKey.length === 0 || publicKey.trim() !== publicKey) {
    fail('previous tauri.conf.json lacks an exact embedded updater public key');
  }
  return createHash('sha256').update(publicKey).digest('hex');
}

export function patchPreviousCargoToml(source) {
  let patched = source;
  if (!/^updater-replacement-smoke-harness\s*=\s*\[\]\s*$/mu.test(patched)) {
    const marker = '[features]\n';
    if (!patched.includes(marker)) fail('previous Cargo.toml lacks a unique [features] table');
    patched = patched.replace(marker, `${marker}updater-replacement-smoke-harness = []\n`);
  }
  if (!/^\[target\.'cfg\(windows\)'\.dependencies\]\s*$/mu.test(patched)) {
    const marker = '[features]\n';
    const windowsDependency = [
      "[target.'cfg(windows)'.dependencies]",
      'windows-sys = { version = "0.61", features = ["Win32_System_SystemInformation"] }',
      '',
    ].join('\n');
    patched = patched.replace(marker, `${windowsDependency}${marker}`);
  } else if (!/^windows-sys\s*=/mu.test(patched)) {
    patched = patched.replace(
      /^\[target\.'cfg\(windows\)'\.dependencies\]\s*$/mu,
      `$&\nwindows-sys = { version = "0.61", features = ["Win32_System_SystemInformation"] }`,
    );
  } else if (!/Win32_System_SystemInformation/u.test(patched)) {
    fail('previous Cargo.toml has windows-sys without the required SystemInformation feature');
  }
  for (const dependency of ['chrono', 'libc', 'reqwest', 'serde', 'serde_json', 'sha2', 'tauri', 'tauri-plugin-updater']) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (!new RegExp(`^${escaped}\\s*=`, 'mu').test(patched)) {
      fail(`previous Cargo.toml lacks required existing dependency ${dependency}`);
    }
  }
  return patched;
}

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first === -1 || source.indexOf(needle, first + needle.length) !== -1) {
    fail(`${label} anchor must occur exactly once in previous source`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function patchPreviousMainRs(source) {
  let patched = replaceExactlyOnce(
    source,
    'mod app_updates;\n',
    'mod app_updates;\nmod updater_replacement_smoke;\n',
    'previous main module',
  );
  patched = replaceExactlyOnce(
    patched,
    'fn main() {\n',
    `fn main() {
    if updater_replacement_smoke::is_requested() {
        std::process::exit(updater_replacement_smoke::run_requested(tauri::generate_context!()));
    }

`,
    'previous main entrypoint',
  );
  return patched;
}

export function patchPreviousAppUpdatesRs(source) {
  let patched = replaceExactlyOnce(
    source,
    'pub struct AppUpdateMetadata {\n    version: String,\n',
    'pub struct AppUpdateMetadata {\n    pub(crate) version: String,\n',
    'previous update metadata version',
  );
  patched = replaceExactlyOnce(
    patched,
    `    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
`,
    `    let updater_builder = app.updater_builder().timeout(Duration::from_secs(30));
    #[cfg(feature = "updater-replacement-smoke-harness")]
    let updater_builder =
        crate::updater_replacement_smoke::configure_updater_builder(&app, updater_builder)?;
    let update = updater_builder
        .build()
`,
    'previous production check builder',
  );
  const downloadStart = '    update\n        .download_and_install(';
  const start = patched.indexOf(downloadStart);
  const endMarker = '\n        .await\n        .map_err(|error| error.to_string())?;';
  const end = start === -1 ? -1 : patched.indexOf(endMarker, start);
  if (
    start === -1
    || end === -1
    || patched.indexOf(downloadStart, start + downloadStart.length) !== -1
    || patched.indexOf(endMarker, end + endMarker.length) !== -1
  ) {
    fail('previous production download_and_install block must occur exactly once');
  }
  const original = patched.slice(start, end + endMarker.length);
  const verified = original
    .replace('    update\n        .download_and_install(', '        let bytes = update\n            .download(')
    .replaceAll('\n        ', '\n            ');
  const replacement = `    #[cfg(not(feature = "updater-replacement-smoke-harness"))]
    {
${original.split('\n').map((line) => `    ${line}`).join('\n')}
    }
    #[cfg(feature = "updater-replacement-smoke-harness")]
    {
${verified}
        crate::updater_replacement_smoke::record_verified_download(&bytes)?;
        update.install(bytes).map_err(|error| error.to_string())?;
    }`;
  return patched.slice(0, start) + replacement + patched.slice(end + endMarker.length);
}

function parsePorcelainNull(output) {
  const fields = output.split('\0').filter(Boolean);
  return fields.map((field) => {
    const status = field.slice(0, 2);
    const file = field.slice(3);
    if (!status || !file || file.includes('\0')) fail('invalid git porcelain record');
    return { status, file };
  });
}

async function instrumentationPatchSha256(worktree) {
  const diff = await git(worktree, [
    'diff', '--binary', '--no-ext-diff', '--',
    'apps/desktop/src-tauri/Cargo.toml',
    'apps/desktop/src-tauri/src/app_updates.rs',
    'apps/desktop/src-tauri/src/main.rs',
  ]);
  const hash = createHash('sha256');
  hash.update('ccem-updater-instrumentation-patch-v1\0');
  hash.update(diff);
  for (const relativePath of INSTRUMENTATION_FILES.filter((candidate) => ![
    'apps/desktop/src-tauri/Cargo.toml',
    'apps/desktop/src-tauri/src/app_updates.rs',
    'apps/desktop/src-tauri/src/main.rs',
  ].includes(candidate))) {
    const bytes = await fsp.readFile(path.join(worktree, relativePath));
    hash.update('\0untracked\0');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export async function prepareInstrumentedPreviousSource({
  repositoryRoot,
  currentSourceRoot,
  previousRef,
  destination,
  outputPath,
  currentSourceCommit,
}) {
  const repository = path.resolve(repositoryRoot);
  const currentSource = path.resolve(currentSourceRoot);
  const worktree = path.resolve(destination);
  const output = path.resolve(outputPath);
  if (worktree === repository || worktree.startsWith(`${repository}${path.sep}`)) {
    fail('previous worktree must be runner-owned and outside the current checkout');
  }
  const sourceHead = exactGitSha(
    await git(currentSource, ['rev-parse', 'HEAD']),
    'current source HEAD',
  );
  if (sourceHead !== currentSourceCommit) fail('current source HEAD does not match the release SHA');
  if ((await git(currentSource, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()) {
    fail('current source checkout must be clean before deriving instrumentation');
  }
  const previousCommit = exactGitSha(
    await git(repository, ['rev-parse', `${previousRef}^{commit}`]),
    'previous source commit',
  );
  if (previousCommit === currentSourceCommit) fail('previous and current commits must differ');
  await fsp.lstat(worktree).then(
    () => fail('previous worktree destination must initially be absent'),
    (error) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );
  await fsp.mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
  await git(repository, ['worktree', 'add', '--detach', worktree, previousCommit]);
  const head = exactGitSha(await git(worktree, ['rev-parse', 'HEAD']), 'previous worktree HEAD');
  if (head !== previousCommit) fail('fresh previous worktree HEAD mismatch');
  if ((await git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()) {
    fail('fresh previous worktree is not initially clean');
  }

  const tauriRoot = path.join(worktree, 'apps/desktop/src-tauri');
  const cargoPath = path.join(tauriRoot, 'Cargo.toml');
  const originalCargo = await fsp.readFile(cargoPath, 'utf8');
  const previousVersion = parseVersion(originalCargo);
  const embeddedUpdaterPublicKeySha256 =
    await previousEmbeddedUpdaterPublicKeySha256(worktree);
  await fsp.writeFile(cargoPath, patchPreviousCargoToml(originalCargo), 'utf8');
  const mainPath = path.join(tauriRoot, 'src/main.rs');
  const appUpdatesPath = path.join(tauriRoot, 'src/app_updates.rs');
  await fsp.writeFile(
    mainPath,
    patchPreviousMainRs(await fsp.readFile(mainPath, 'utf8')),
    'utf8',
  );
  await fsp.writeFile(
    appUpdatesPath,
    patchPreviousAppUpdatesRs(await fsp.readFile(appUpdatesPath, 'utf8')),
    'utf8',
  );
  const destinationModule = path.join(tauriRoot, 'src/updater_replacement_smoke');
  await fsp.mkdir(destinationModule, { recursive: false, mode: 0o700 });
  for (const name of ['contract.rs', 'mod.rs', 'runtime.rs']) {
    await fsp.copyFile(
      path.join(currentSource, 'apps/desktop/src-tauri/src/updater_replacement_smoke', name),
      path.join(destinationModule, name),
      fsp.constants.COPYFILE_EXCL,
    );
  }

  const records = parsePorcelainNull(await git(worktree, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ], { encoding: 'utf8' }));
  const actualFiles = records.map((record) => record.file).sort();
  const expectedFiles = [...INSTRUMENTATION_FILES].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail(`instrumentation changed files outside its allowlist: ${actualFiles.join(', ')}`);
  }
  const instrumentationPatchSha256 = await instrumentationPatchSha256(worktree);
  const fileSha256 = Object.fromEntries(await Promise.all(INSTRUMENTATION_FILES.map(async (file) => [
    file,
    await sha256File(path.join(worktree, file)),
  ])));
  const provenance = {
    schemaVersion: 1,
    proofClass: 'instrumented-previous-source',
    currentSourceCommit,
    previousRef,
    previousCommit,
    previousVersion,
    embeddedUpdaterPublicKeySha256,
    freshDetachedWorktree: true,
    initiallyClean: true,
    worktreeRoot: worktree,
    patchAllowlist: [...INSTRUMENTATION_FILES],
    patchStatus: records,
    fileSha256,
    instrumentationPatchSha256,
  };
  await writePrivateJsonCreateNew(output, provenance);
  return provenance;
}

function parseArguments(argv) {
  const values = {};
  const names = new Map([
    ['--repository', 'repositoryRoot'],
    ['--current-source', 'currentSourceRoot'],
    ['--previous-ref', 'previousRef'],
    ['--destination', 'destination'],
    ['--output', 'outputPath'],
    ['--current-source-commit', 'currentSourceCommit'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || value === undefined) fail(`unknown or incomplete argument ${argv[index] ?? '<missing>'}`);
    values[name] = value;
  }
  if (Object.keys(values).length !== names.size) fail('all previous-source arguments are required');
  return values;
}

async function main() {
  assertUpdaterReplacementSmokeAuthorization();
  const provenance = await prepareInstrumentedPreviousSource(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `[prepare-updater-replacement-previous-source] ${provenance.previousRef} ${provenance.instrumentationPatchSha256}\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
