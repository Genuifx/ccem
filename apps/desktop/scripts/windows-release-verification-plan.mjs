import path from 'node:path';

export const WINDOWS_POWERSHELL_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const WINDOWS_7ZIP_PATH = 'C:\\Program Files\\7-Zip\\7z.exe';

function powershellEncoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function authenticodeInspectionCommand(candidates) {
  const paths = JSON.stringify(candidates).replaceAll("'", "''");
  const script = [
    `$paths = ConvertFrom-Json '${paths}'`,
    '$results = foreach ($path in $paths) {',
    '  $signature = Get-AuthenticodeSignature -LiteralPath $path',
    '  [PSCustomObject]@{',
    '    Path = $path',
    '    Status = [string]$signature.Status',
    '    SignerThumbprint = $signature.SignerCertificate.Thumbprint',
    '    SignerSubject = $signature.SignerCertificate.Subject',
    '    TimestampThumbprint = $signature.TimeStamperCertificate.Thumbprint',
    '  }',
    '}',
    '$results | ConvertTo-Json -Compress',
  ].join('\n');
  return {
    program: WINDOWS_POWERSHELL_PATH,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', powershellEncoded(script)],
  };
}

export function createWindowsVerificationPlan({
  appPath,
  installerPath,
  sandboxClientPath,
  chromeElfPath,
}) {
  const libcefPath = path.join(path.dirname(sandboxClientPath), 'libcef.dll').replaceAll("'", "''");
  return {
    extractInstaller: {
      program: WINDOWS_7ZIP_PATH,
      args: ['x', '-y', installerPath, '-o<temporary-directory>'],
    },
    authenticode: authenticodeInspectionCommand([
      appPath,
      sandboxClientPath,
      chromeElfPath,
      installerPath,
    ]),
    cefVersion: {
      program: WINDOWS_POWERSHELL_PATH,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        powershellEncoded(`(Get-Item -LiteralPath '${libcefPath}').VersionInfo.ProductVersion`),
      ],
    },
  };
}
