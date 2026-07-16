import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CEF_LEGAL_DIRECTORY } from './cef-runtime-contract.mjs';

const scriptPath = fileURLToPath(import.meta.url);

function fail(message) {
  throw new Error(`[release-signing-config] ${message}`);
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

export function normalizeThumbprint(value) {
  const normalized = value.replaceAll(/\s/g, '').toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(normalized)) {
    fail('WINDOWS_CERTIFICATE_THUMBPRINT must be an exact 40-character SHA-1 thumbprint');
  }
  return normalized;
}

export function validateMacReleaseSigning(environment = process.env) {
  const certificate = required(environment, 'APPLE_CERTIFICATE');
  const certificatePassword = required(environment, 'APPLE_CERTIFICATE_PASSWORD');
  const identity = required(environment, 'APPLE_SIGNING_IDENTITY');
  const appleTeamId = required(environment, 'APPLE_TEAM_ID');
  const officialTeamId = required(environment, 'CCEM_OFFICIAL_APPLE_TEAM_ID');
  const appleId = required(environment, 'APPLE_ID');
  const applePassword = required(environment, 'APPLE_PASSWORD');
  const notaryPrivateKey = required(environment, 'APPLE_NOTARY_API_PRIVATE_KEY');
  const notaryKeyId = required(environment, 'APPLE_NOTARY_API_KEY_ID');
  const notaryIssuer = required(environment, 'APPLE_NOTARY_API_ISSUER');

  if (!/^[A-Z0-9]{10}$/.test(officialTeamId)) {
    fail('CCEM_OFFICIAL_APPLE_TEAM_ID must pin the official 10-character Apple Team ID');
  }
  if (appleTeamId !== officialTeamId) {
    fail('APPLE_TEAM_ID does not match CCEM_OFFICIAL_APPLE_TEAM_ID');
  }
  const identityMatch = identity.match(/^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/);
  if (!identityMatch || identityMatch[1] !== officialTeamId) {
    fail('APPLE_SIGNING_IDENTITY must be the exact official Developer ID Application identity');
  }
  if (!appleId.includes('@')) fail('APPLE_ID must be an Apple account email address');
  if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/u.test(notaryPrivateKey)) {
    fail('APPLE_NOTARY_API_PRIVATE_KEY must be an App Store Connect API private key');
  }
  if (!/^[A-Z0-9]{10}$/u.test(notaryKeyId)) {
    fail('APPLE_NOTARY_API_KEY_ID must be an exact 10-character App Store Connect key ID');
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(notaryIssuer)) {
    fail('APPLE_NOTARY_API_ISSUER must be an exact App Store Connect issuer UUID');
  }

  return {
    platform: 'macos',
    certificateConfigured: Boolean(certificate),
    certificatePasswordConfigured: Boolean(certificatePassword),
    identity,
    teamId: officialTeamId,
    notarization: {
      provider: 'apple-id',
      appleIdConfigured: Boolean(appleId),
      appSpecificPasswordConfigured: Boolean(applePassword),
      waitForCompletion: true,
      staple: true,
    },
    dmgNotarization: {
      provider: 'app-store-connect-api-key',
      privateKeyConfigured: Boolean(notaryPrivateKey),
      keyId: notaryKeyId,
      issuer: notaryIssuer,
      waitForCompletion: true,
      staple: true,
    },
  };
}

export function validateWindowsReleaseSigning(environment = process.env) {
  const certificate = required(environment, 'WINDOWS_CERTIFICATE');
  const certificatePassword = required(environment, 'WINDOWS_CERTIFICATE_PASSWORD');
  const thumbprint = normalizeThumbprint(required(environment, 'WINDOWS_CERTIFICATE_THUMBPRINT'));
  const timestampUrl = required(environment, 'WINDOWS_TIMESTAMP_URL');
  const publisher = required(environment, 'CCEM_OFFICIAL_WINDOWS_PUBLISHER');

  let timestamp;
  try {
    timestamp = new URL(timestampUrl);
  } catch {
    fail('WINDOWS_TIMESTAMP_URL must be a valid HTTPS URL');
  }
  if (timestamp.protocol !== 'https:' || timestamp.username || timestamp.password) {
    fail('WINDOWS_TIMESTAMP_URL must be a credential-free HTTPS URL');
  }
  if (!/^CN=[^,]+(?:,\s*(?:O|OU|L|S|C)=[^,]+)*$/u.test(publisher)) {
    fail('CCEM_OFFICIAL_WINDOWS_PUBLISHER must be an exact X.509 subject beginning with CN=');
  }

  return {
    platform: 'windows',
    certificateConfigured: Boolean(certificate),
    certificatePasswordConfigured: Boolean(certificatePassword),
    thumbprint,
    timestampUrl: timestamp.href,
    publisher,
    digestAlgorithm: 'sha256',
    tsp: true,
  };
}

export function windowsSigningOverlay(validated) {
  if (validated.platform !== 'windows') fail('Windows signing overlay requires Windows validation');
  const releaseRoot = 'target/cef-bundle/windows';
  const cefResources = [
    'cef-windows-staging-manifest.json',
    'cef-windows-sandbox-artifact.json',
    'ccem-desktop.dll',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'chrome_elf.dll',
    'd3dcompiler_47.dll',
    'dxcompiler.dll',
    'dxil.dll',
    'icudtl.dat',
    'libcef.dll',
    'libEGL.dll',
    'libGLESv2.dll',
    'resources.pak',
    'v8_context_snapshot.bin',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
  ];
  const resources = Object.fromEntries(cefResources.map((name) => [
    `${releaseRoot}/${name}`,
    name,
  ]));
  resources[`${releaseRoot}/locales/`] = 'locales';
  resources[`${releaseRoot}/${CEF_LEGAL_DIRECTORY}/`] = CEF_LEGAL_DIRECTORY;
  // The generated overlay changes bundle.resources from the base array into a
  // destination map, so it must carry the existing application resource too.
  resources['resources/native-runtime-helper.mjs'] = 'resources/native-runtime-helper.mjs';
  return {
    build: {
      beforeBundleCommand: 'node scripts/prepare-cef-before-bundle.mjs',
    },
    bundle: {
      resources,
      windows: {
        certificateThumbprint: validated.thumbprint,
        digestAlgorithm: validated.digestAlgorithm,
        timestampUrl: validated.timestampUrl,
        tsp: validated.tsp,
        nsis: {
          installerHooks: './windows/nsis-mode2-hooks.nsh',
        },
      },
    },
  };
}

async function writeJsonAtomically(outputPath, value) {
  const absolute = path.resolve(outputPath);
  const directory = path.dirname(absolute);
  await fsp.mkdir(directory, { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, absolute);
  return absolute;
}

function parseArgs(argv) {
  const options = { platform: null, dryRun: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (['--platform', '--output'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      index += 1;
      if (argument === '--platform') options.platform = value;
      if (argument === '--output') options.output = value;
    } else if (argument === '--help') {
      options.help = true;
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return options;
}

export async function run(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node scripts/validate-release-signing-config.mjs --platform <macos|windows> [--dry-run] [--output <json>]\n');
    return { status: 'help' };
  }
  if (!['macos', 'windows'].includes(options.platform)) {
    fail('--platform must be macos or windows');
  }
  const validation = options.platform === 'macos'
    ? validateMacReleaseSigning(environment)
    : validateWindowsReleaseSigning(environment);
  const output = options.platform === 'windows' ? windowsSigningOverlay(validation) : validation;
  if (options.output) {
    if (options.dryRun) fail('--dry-run cannot write --output');
    const outputPath = await writeJsonAtomically(options.output, output);
    process.stdout.write(`[release-signing-config] wrote ${outputPath}\n`);
    return { status: 'written', validation, outputPath };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return { status: options.dryRun ? 'dry-run' : 'validated', validation };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
