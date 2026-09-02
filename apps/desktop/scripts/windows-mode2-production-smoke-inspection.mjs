import path from 'node:path';

import {
  WINDOWS_LPAC_SID,
  WINDOWS_MODE2_REQUIRED_PROCESS_TYPES,
  createWindowsInstalledTreeInventory,
  validateWindowsInstalledTreeInventory,
} from './windows-mode2-production-smoke-contract.mjs';
import { windowsNativeEvidenceBootstrapPowerShell } from './windows-mode2-native-process-evidence.mjs';

export const WINDOWS_POWERSHELL_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDOWS_SYSTEM_SID = 'S-1-5-18';

function fail(message) {
  throw new Error(`[windows-mode2-smoke-runner] ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields differ: ${actual.join(', ')}`);
  }
  return value;
}

function exactWindowsPath(value, label) {
  if (
    typeof value !== 'string'
    || !path.win32.isAbsolute(value)
    || value.includes('\0')
    || path.win32.normalize(value) !== value
  ) {
    fail(`${label} must be a normalized absolute Windows path`);
  }
  return value;
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function exactSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? '')) fail(`${label} must be an exact SHA-256`);
  return value;
}

function normalizeThumbprint(value) {
  const normalized = (value ?? '').replaceAll(/\s/g, '').toUpperCase();
  if (!/^[A-F0-9]{40}$/u.test(normalized)) fail('Windows signer thumbprint is invalid');
  return normalized;
}

function encodedPowerShell(source) {
  return Buffer.from(source, 'utf16le').toString('base64');
}

function powerShellConfig(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function powerShellCommand(source) {
  return {
    program: WINDOWS_POWERSHELL_PATH,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(source)],
  };
}

export function validateWindowsEvidenceRootAclObservation(observation, plan) {
  exactKeys(observation, [
    'rootPath', 'ownerSid', 'systemSid', 'inheritanceProtected', 'allowedSids',
    'aceCount', 'fullControlOnly', 'reparseFree',
  ], 'evidence-root ACL observation');
  exactWindowsPath(observation.rootPath, 'evidence-root ACL path');
  const allowedSids = Array.isArray(observation.allowedSids)
    ? [...observation.allowedSids].sort()
    : null;
  if (
    !sameWindowsPath(observation.rootPath, plan.paths.evidenceRoot)
    || !/^S-1-(?:\d+-)+\d+$/u.test(observation.ownerSid ?? '')
    || observation.systemSid !== WINDOWS_SYSTEM_SID
    || observation.inheritanceProtected !== true
    || observation.aceCount !== 2
    || observation.fullControlOnly !== true
    || observation.reparseFree !== true
    || JSON.stringify(allowedSids)
      !== JSON.stringify([WINDOWS_SYSTEM_SID, observation.ownerSid].sort())
  ) fail('evidence root is not protected for only the runner owner and SYSTEM');
  return { ...observation, allowedSids };
}

export function createWindowsEvidenceRootAclCommand({ plan }) {
  const config = powerShellConfig({ evidenceRoot: plan.paths.evidenceRoot });
  return powerShellCommand([
    "$ErrorActionPreference = 'Stop'",
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json`,
    '$root = [IO.Path]::GetFullPath([string]$config.evidenceRoot)',
    'function Assert-NoReparseAncestors([string]$candidate) {',
    '  $current = [IO.Path]::GetFullPath($candidate)',
    '  while (-not [string]::IsNullOrWhiteSpace($current)) {',
    '    $ancestor = Get-Item -LiteralPath $current -Force -ErrorAction Stop',
    '    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "evidence root ancestor contains a reparse point" }',
    '    $current = [IO.Path]::GetDirectoryName($current)',
    '  }',
    '}',
    'Assert-NoReparseAncestors $root',
    '$item = Get-Item -LiteralPath $root -Force -ErrorAction Stop',
    'if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "evidence root is not a plain directory" }',
    '$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")',
    '$inheritance = [Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit',
    '$security = [Security.AccessControl.DirectorySecurity]::new()',
    '$security.SetAccessRuleProtection($true, $false)',
    '$security.SetOwner($ownerSid)',
    'foreach ($sid in @($ownerSid, $systemSid)) {',
    '  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)',
    '  [void]$security.AddAccessRule($rule)',
    '}',
    'Set-Acl -LiteralPath $root -AclObject $security',
    '$actual = Get-Acl -LiteralPath $root',
    '$actualRules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    '$allowed = @($actualRules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)',
    '$full = [int64][Security.AccessControl.FileSystemRights]::FullControl',
    '$valid = @($actualRules | Where-Object { -not $_.IsInherited -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ([int64]$_.FileSystemRights -band $full) -eq $full -and $_.InheritanceFlags -eq $inheritance -and $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None })',
    '$actualOwnerSid = $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value',
    'if (-not $actual.AreAccessRulesProtected -or $actualOwnerSid -ne $ownerSid.Value -or $actualRules.Count -ne 2 -or $valid.Count -ne 2 -or -not ($allowed -contains $ownerSid.Value) -or -not ($allowed -contains $systemSid.Value)) { throw "evidence root DACL verification failed" }',
    '[PSCustomObject]@{ rootPath = [string]$config.evidenceRoot; ownerSid = $ownerSid.Value; systemSid = $systemSid.Value; inheritanceProtected = $true; allowedSids = @($allowed); aceCount = $actualRules.Count; fullControlOnly = $true; reparseFree = $true } | ConvertTo-Json -Compress',
  ].join('\n'));
}

export function validateWindowsUpgradeAclSeedObservation(observation, plan) {
  exactKeys(observation, [
    'nonce', 'runId', 'runAttempt', 'rootPath', 'sid', 'accessControlType',
    'rights', 'objectInherit', 'containerInherit', 'propagation', 'inherited',
    'writeGranted', 'aceCount', 'ancestorReparseFree',
  ], 'upgrade ACL seed observation');
  exactWindowsPath(observation.rootPath, 'upgrade ACL seed root');
  if (
    observation.nonce !== plan.nonce
    || observation.runId !== plan.run.id
    || observation.runAttempt !== plan.run.attempt
    || !sameWindowsPath(observation.rootPath, plan.paths.installRoot)
    || observation.sid !== WINDOWS_LPAC_SID
    || observation.accessControlType !== 'Allow'
    || observation.rights !== 'modify'
    || observation.objectInherit !== true
    || observation.containerInherit !== true
    || observation.propagation !== 'none'
    || observation.inherited !== false
    || observation.writeGranted !== true
    || observation.aceCount !== 1
    || observation.ancestorReparseFree !== true
  ) {
    fail('upgrade ACL seed is not the exact current-run inherited Modify grant');
  }
  return observation;
}

export function createWindowsUpgradeAclSeedCommand({ plan }) {
  const config = powerShellConfig({
    smokeRoot: plan.paths.smokeRoot,
    installRoot: plan.paths.installRoot,
    nonce: plan.nonce,
    runId: plan.run.id,
    runAttempt: plan.run.attempt,
    lpacSid: WINDOWS_LPAC_SID,
  });
  return powerShellCommand([
    "$ErrorActionPreference = 'Stop'",
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json`,
    '$smokeRoot = [IO.Path]::GetFullPath([string]$config.smokeRoot)',
    '$installRoot = [IO.Path]::GetFullPath([string]$config.installRoot)',
    '$installParent = [IO.Path]::GetDirectoryName($installRoot)',
    'if ([string]::IsNullOrWhiteSpace($installParent) -or -not $installParent.Equals($smokeRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "upgrade ACL seed escaped the isolated smoke root" }',
    'function Assert-NoReparseAncestors([string]$candidate) {',
    '  $current = [IO.Path]::GetFullPath($candidate)',
    '  while (-not [string]::IsNullOrWhiteSpace($current)) {',
    '    $item = Get-Item -LiteralPath $current -Force',
    '    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "upgrade ACL seed ancestor contains a reparse point" }',
    '    $current = [IO.Path]::GetDirectoryName($current)',
    '  }',
    '}',
    'Assert-NoReparseAncestors $smokeRoot',
    'if (Test-Path -LiteralPath $installRoot) { throw "upgrade ACL seed install root already exists" }',
    'New-Item -ItemType Directory -Path $installRoot -ErrorAction Stop | Out-Null',
    '$rootItem = Get-Item -LiteralPath $installRoot -Force',
    'if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "upgrade ACL seed root is not a plain directory" }',
    '$grant = "*" + [string]$config.lpacSid + ":(OI)(CI)(M)"',
    '$icacls = Join-Path $env:SystemRoot "System32\\icacls.exe"',
    '& $icacls $installRoot /grant $grant /L /Q | Out-Null',
    'if ($LASTEXITCODE -ne 0) { throw "seed LPAC Modify ACL failed with exit code $LASTEXITCODE" }',
    '$acl = Get-Acl -LiteralPath $installRoot',
    '$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq [string]$config.lpacSid })',
    '$explicit = @($rules | Where-Object { -not $_.IsInherited })',
    '$inheritance = [Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit',
    '$modify = [int64][Security.AccessControl.FileSystemRights]::Modify',
    'if ($rules.Count -ne 1 -or $explicit.Count -ne 1) { throw "upgrade ACL seed did not create one explicit LPAC ACE" }',
    '$rule = $explicit[0]',
    'if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or (([int64]$rule.FileSystemRights -band $modify) -ne $modify)) { throw "upgrade ACL seed is not inherited Modify" }',
    '[PSCustomObject]@{ nonce = [string]$config.nonce; runId = [string]$config.runId; runAttempt = [string]$config.runAttempt; rootPath = $installRoot; sid = [string]$config.lpacSid; accessControlType = "Allow"; rights = "modify"; objectInherit = $true; containerInherit = $true; propagation = "none"; inherited = $false; writeGranted = $true; aceCount = $rules.Count; ancestorReparseFree = $true } | ConvertTo-Json -Compress',
  ].join('\n'));
}

export function createWindowsPreflightInspectionCommand({ plan, stableCefResources, signer }) {
  const signaturePaths = [...new Set([
    plan.paths.installerPath,
    plan.paths.installedExecutablePath,
    ...signer.signedFiles.map((relative) => path.win32.join(plan.paths.installRoot, relative)),
  ].map((candidate) => path.win32.normalize(candidate).toLowerCase()))]
    .map((identity) => {
      if (sameWindowsPath(identity, plan.paths.installerPath)) return plan.paths.installerPath;
      if (sameWindowsPath(identity, plan.paths.installedExecutablePath)) return plan.paths.installedExecutablePath;
      return path.win32.join(
        plan.paths.installRoot,
        signer.signedFiles.find((relative) => sameWindowsPath(
          path.win32.join(plan.paths.installRoot, relative),
          identity,
        )),
      );
    });
  const config = powerShellConfig({
    smokeRoot: plan.paths.smokeRoot,
    installRoot: plan.paths.installRoot,
    installerPath: plan.paths.installerPath,
    executablePath: plan.paths.installedExecutablePath,
    resources: stableCefResources,
    signaturePaths,
    thumbprint: signer.thumbprint,
    publisher: signer.publisher,
    lpacSid: WINDOWS_LPAC_SID,
  });
  return powerShellCommand([
    "$ErrorActionPreference = 'Stop'",
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json`,
    '$smokeRoot = [IO.Path]::GetFullPath([string]$config.smokeRoot).TrimEnd("\\")',
    '$installRoot = [IO.Path]::GetFullPath([string]$config.installRoot).TrimEnd("\\")',
    '$installParent = [IO.Path]::GetDirectoryName($installRoot)',
    'if ([string]::IsNullOrWhiteSpace($installParent) -or -not $installParent.Equals($smokeRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "installed tree escaped the isolated smoke root" }',
    '$config.installRoot = $installRoot',
    'function Get-Rules([string]$candidate) {',
    '  $acl = Get-Acl -LiteralPath $candidate',
    '  return @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    '}',
    'function Assert-NoReparsePath([string]$candidate) {',
    '  $root = [IO.Path]::GetFullPath([string]$config.installRoot).TrimEnd("\\")',
    '  $current = [IO.Path]::GetFullPath($candidate)',
    '  if (-not $current.Equals($root, [StringComparison]::OrdinalIgnoreCase) -and -not $current.StartsWith(($root + "\\"), [StringComparison]::OrdinalIgnoreCase)) { throw "runtime path escaped install root" }',
    '  while ($true) {',
    '    $item = Get-Item -LiteralPath $current -Force',
    '    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "runtime path contains a reparse point" }',
    '    if ($current.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { break }',
    '    $parent = [IO.Path]::GetDirectoryName($current)',
    '    if ([string]::IsNullOrWhiteSpace($parent)) { throw "runtime path escaped install root" }',
    '    $current = [IO.Path]::GetFullPath($parent)',
    '  }',
    '}',
    'function Assert-NoReparseAncestors([string]$candidate) {',
    '  $current = [IO.Path]::GetFullPath($candidate)',
    '  while (-not [string]::IsNullOrWhiteSpace($current)) {',
    '    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop',
    '    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "installed tree ancestor contains a reparse point" }',
    '    $current = [IO.Path]::GetDirectoryName($current)',
    '  }',
    '}',
    'function Assert-SafeRelativePath([string]$relative) {',
    '  if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Length -gt 32000 -or $relative.Contains("\\")) { throw "installed tree contains an unsupported relative path" }',
    '  foreach ($segment in $relative.Split("/")) {',
    "    if ([string]::IsNullOrEmpty($segment) -or $segment -eq '.' -or $segment -eq '..' -or $segment -match '[\\x00-\\x1f<>:\"\\\\|?*]' -or $segment -match '[ .]$' -or $segment -match '(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)') { throw 'installed tree contains a reserved or unsupported path' }",
    '  }',
    '}',
    'function Assert-NoAlternateDataStreams([string]$candidate) {',
    '  $streams = @(Get-Item -LiteralPath $candidate -Stream * -ErrorAction Stop)',
    '  $unexpected = @($streams | Where-Object { [string]$_.Stream -ne ":`$DATA" -and [string]$_.Stream -ne "::`$DATA" })',
    '  if ($unexpected.Count -ne 0) { throw "installed tree contains an alternate data stream" }',
    '}',
    '$readExecute = [int64][Security.AccessControl.FileSystemRights]::ReadAndExecute',
    '$writeMask = 0L',
    'foreach ($right in @(',
    '  [Security.AccessControl.FileSystemRights]::WriteData,',
    '  [Security.AccessControl.FileSystemRights]::AppendData,',
    '  [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes,',
    '  [Security.AccessControl.FileSystemRights]::WriteAttributes,',
    '  [Security.AccessControl.FileSystemRights]::Delete,',
    '  [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,',
    '  [Security.AccessControl.FileSystemRights]::ChangePermissions,',
    '  [Security.AccessControl.FileSystemRights]::TakeOwnership',
    ')) { $writeMask = $writeMask -bor [int64]$right }',
    'function Assert-LpacReadExecute([string]$candidate) {',
    '  $allRules = @(Get-Rules $candidate | Where-Object { $_.IdentityReference.Value -eq $config.lpacSid })',
    '  $allowRules = @($allRules | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow })',
    '  if ($allRules.Count -ne 1 -or $allowRules.Count -ne 1) { throw "installed tree path does not have one exact LPAC Allow ACE" }',
    '  $rule = $allowRules[0]',
    '  if (-not $rule.IsInherited -or ([int64]$rule.FileSystemRights -band $readExecute) -ne $readExecute -or ([int64]$rule.FileSystemRights -band $writeMask) -ne 0) { throw "installed tree path does not inherit LPAC read-execute without write" }',
    '}',
    'Assert-NoReparseAncestors $installRoot',
    '$rootItem = Get-Item -LiteralPath $config.installRoot -Force',
    'if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "install root is not a plain directory" }',
    'Assert-NoAlternateDataStreams $config.installRoot',
    '$rootAllRules = @(Get-Rules $config.installRoot | Where-Object { $_.IdentityReference.Value -eq $config.lpacSid })',
    '$rootRules = @($rootAllRules | Where-Object { $_.AccessControlType -eq "Allow" })',
    'if ($rootAllRules.Count -ne 1 -or $rootRules.Count -ne 1) { throw "LPAC install root must contain one replacement ACE" }',
    'if (@($rootAllRules | Where-Object { $_.AccessControlType -eq "Deny" -and ([int64]$_.FileSystemRights -band $readExecute) -ne 0 }).Count -gt 0) { throw "LPAC read-execute is denied at install root" }',
    '$writeGranted = @($rootRules | Where-Object { ([int64]$_.FileSystemRights -band $writeMask) -ne 0 }).Count -gt 0',
    '$rootRule = @($rootRules | Where-Object {',
    '  -not $_.IsInherited -and ([int64]$_.FileSystemRights -band $readExecute) -eq $readExecute -and',
    '  ([int64]$_.FileSystemRights -band $writeMask) -eq 0 -and',
    '  ($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0 -and',
    '  ($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0 -and',
    '  $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None',
    '}) | Select-Object -First 1',
    'if ($null -eq $rootRule -or $writeGranted) { throw "LPAC root rule is not exact inherited read-execute" }',
    '$actualResources = [ordered]@{}',
    'foreach ($property in $config.resources.PSObject.Properties) {',
    '  $relative = [string]$property.Name',
    '  $candidate = [IO.Path]::GetFullPath((Join-Path $config.installRoot ($relative -replace "/", "\\")))',
    '  if (-not $candidate.StartsWith(($config.installRoot + "\\"), [StringComparison]::OrdinalIgnoreCase)) { throw "runtime path escaped install root" }',
    '  Assert-NoReparsePath $candidate',
    '  $item = Get-Item -LiteralPath $candidate -Force',
    '  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer) { throw "runtime resource is not a regular file" }',
    '  $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash.ToLowerInvariant()',
    '  if ($digest -ne ([string]$property.Value).ToLowerInvariant()) { throw "installed runtime digest mismatch: $relative" }',
    '  $actualResources[$relative] = $digest',
    '}',
    '$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)',
    '$directories = [Collections.Generic.List[string]]::new()',
    '$files = [Collections.Generic.List[object]]::new()',
    '$fileByPath = @{}',
    '$filePaths = [Collections.Generic.List[string]]::new()',
    '$pending = [Collections.Generic.Stack[string]]::new()',
    '$pending.Push($installRoot)',
    'while ($pending.Count -gt 0) {',
    '  $current = $pending.Pop()',
    '  foreach ($child in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {',
    '    $childPath = [IO.Path]::GetFullPath([string]$child.FullName)',
    '    if (-not $childPath.StartsWith(($installRoot + "\\"), [StringComparison]::OrdinalIgnoreCase)) { throw "installed tree path escaped install root" }',
    '    $relative = $childPath.Substring($installRoot.Length).TrimStart([char[]]"\\").Replace("\\", "/")',
    '    Assert-SafeRelativePath $relative',
    '    if (-not $seen.Add($relative)) { throw "installed tree contains a case-insensitive duplicate path" }',
    '    if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "installed tree contains a reparse point" }',
    '    Assert-NoAlternateDataStreams $childPath',
    '    Assert-LpacReadExecute $childPath',
    '    if ($child.PSIsContainer) {',
    '      $directories.Add($relative)',
    '      $pending.Push($childPath)',
    '    } elseif ($child -is [IO.FileInfo]) {',
    '      $entry = [PSCustomObject]@{ relativePath = $relative; size = [int64]$child.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $childPath).Hash.ToLowerInvariant() }',
    '      $files.Add($entry)',
    '      $filePaths.Add($relative)',
    '      $fileByPath[$relative] = $entry',
    '    } else { throw "installed tree contains an unsupported filesystem entry" }',
    '  }',
    '}',
    '$directoryArray = [string[]]$directories.ToArray()',
    '$filePathArray = [string[]]$filePaths.ToArray()',
    '[Array]::Sort($directoryArray, [StringComparer]::OrdinalIgnoreCase)',
    '[Array]::Sort($filePathArray, [StringComparer]::OrdinalIgnoreCase)',
    '$fileArray = @($filePathArray | ForEach-Object { $fileByPath[$_] })',
    'if ($fileArray.Count -eq 0) { throw "installed tree contains no regular files" }',
    '$signatures = foreach ($candidate in $config.signaturePaths) {',
    '  $signature = Get-AuthenticodeSignature -LiteralPath $candidate',
    '  [PSCustomObject]@{ path = [string]$candidate; status = [string]$signature.Status; signerThumbprint = [string]$signature.SignerCertificate.Thumbprint; signerSubject = [string]$signature.SignerCertificate.Subject; timestampThumbprint = [string]$signature.TimeStamperCertificate.Thumbprint }',
    '}',
    '$result = [PSCustomObject]@{',
    '  installerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $config.installerPath).Hash.ToLowerInvariant()',
    '  installedExecutableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $config.executablePath).Hash.ToLowerInvariant()',
    '  stableCefResources = $actualResources',
    '  authenticode = @($signatures)',
    '  installedTree = [PSCustomObject]@{ directories = @($directoryArray); files = @($fileArray) }',
    '  installedTreeSafety = [PSCustomObject]@{ rootPath = $installRoot; rootType = "directory"; rootNoReparsePoint = $true; ancestorReparseFree = $true; pathCount = $directoryArray.Count + $fileArray.Count; reparsePoints = @(); alternateDataStreams = @(); reservedPaths = @(); unsupportedEntries = @() }',
    '  lpacAcl = [PSCustomObject]@{ rootPath = [string]$config.installRoot; sid = [string]$config.lpacSid; accessControlType = "Allow"; rights = "read_execute"; objectInherit = $true; containerInherit = $true; propagation = "none"; writeGranted = $false; rootAceCount = $rootAllRules.Count; rootExplicitAceCount = 1; descendantAcesInherited = $true; descendantExplicitAceCount = 0; rootNoReparsePoint = $true; ancestorReparseFree = $true; verifiedDirectoryCount = $directoryArray.Count; verifiedFileCount = $fileArray.Count; verifiedPathCount = $directoryArray.Count + $fileArray.Count; verifiedDirectories = @($directoryArray); verifiedFiles = @($filePathArray); missingPaths = @() }',
    '}',
    '$result | ConvertTo-Json -Depth 12 -Compress',
  ].join('\n'));
}

export function createWindowsProcessObservationCommand({ plan, checkpoint }) {
  const config = powerShellConfig({
    mainPid: checkpoint.mainPid,
    executablePath: plan.paths.installedExecutablePath,
    requiredTypes: WINDOWS_MODE2_REQUIRED_PROCESS_TYPES,
    nativeWindow: checkpoint.productionPath.nativeWindow,
  });
  return powerShellCommand([
    "$ErrorActionPreference = 'Stop'",
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json`,
    ...windowsNativeEvidenceBootstrapPowerShell(),
    'function Get-DescendantClosure([object[]]$snapshot, [int]$rootPid) {',
    '  $byPid = @{}',
    '  foreach ($candidate in $snapshot) { $byPid[[int]$candidate.ProcessId] = $candidate }',
    '  if (-not $byPid.ContainsKey($rootPid)) { throw "browser root is absent from the CIM process snapshot" }',
    '  $included = [Collections.Generic.HashSet[int]]::new()',
    '  [void]$included.Add($rootPid)',
    '  $changed = $true',
    '  while ($changed) {',
    '    $changed = $false',
    '    foreach ($candidate in $snapshot) {',
    '      $candidatePid = [int]$candidate.ProcessId',
    '      $candidateParent = [int]$candidate.ParentProcessId',
    '      if ($included.Contains($candidateParent) -and $included.Add($candidatePid)) { $changed = $true }',
    '    }',
    '  }',
    '  return @($snapshot | Where-Object { $included.Contains([int]$_.ProcessId) } | Sort-Object ProcessId)',
    '}',
    'function Get-ClosureKey([object]$entry) {',
    '  return "{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}" -f $entry.pid, $entry.nativePid, $entry.parentPid, $entry.creationTime100ns, ([string]$entry.nativeImagePath).ToLowerInvariant(), $entry.runtimeKind, $entry.signerThumbprint, $entry.signerSubject',
    '}',
    '$wrySignatures = @{}',
    'function Get-RuntimeClassification([string]$nativeImagePath) {',
    '  if ($nativeImagePath.Equals([string]$config.executablePath, [StringComparison]::OrdinalIgnoreCase)) {',
    '    return [PSCustomObject]@{ runtimeKind = "cef"; signerThumbprint = $null; signerSubject = $null }',
    '  }',
    '  if (-not [IO.Path]::GetFileName($nativeImagePath).Equals("msedgewebview2.exe", [StringComparison]::OrdinalIgnoreCase)) { throw "unknown non-CEF descendant executable" }',
    '  $identity = $nativeImagePath.ToLowerInvariant()',
    '  if (-not $wrySignatures.ContainsKey($identity)) {',
    '    $signature = Get-AuthenticodeSignature -LiteralPath $nativeImagePath',
    '    $thumbprint = ([string]$signature.SignerCertificate.Thumbprint).Replace(" ", "").ToUpperInvariant()',
    '    $subject = [string]$signature.SignerCertificate.Subject',
    '    if ([string]$signature.Status -ne "Valid" -or $thumbprint -notmatch "^[A-F0-9]{40}$" -or $subject -notmatch "(?i)Microsoft Corporation") { throw "Wry WebView2 descendant is not a valid Microsoft runtime" }',
    '    $wrySignatures[$identity] = [PSCustomObject]@{ runtimeKind = "wry-webview2"; signerThumbprint = $thumbprint; signerSubject = $subject }',
    '  }',
    '  return $wrySignatures[$identity]',
    '}',
    '$allBefore = @(Get-CimInstance -ClassName Win32_Process)',
    '$closureBefore = @(Get-DescendantClosure $allBefore ([int]$config.mainPid))',
    '$closureFacts = [Collections.Generic.List[object]]::new()',
    '$records = [Collections.Generic.List[object]]::new()',
    'foreach ($candidate in $closureBefore) {',
    '  $pidValue = [int]$candidate.ProcessId',
    '  $identityBefore = [CcemMode2NativeEvidence]::ReadProcessIdentity($pidValue)',
    '  if ([int64]$identityBefore.nativePid -ne [int64]$pidValue) { throw "native process handle PID mismatch" }',
    '  $classification = Get-RuntimeClassification ([string]$identityBefore.nativeImagePath)',
    '  $closureFacts.Add([PSCustomObject]@{ pid = $pidValue; nativePid = [int64]$identityBefore.nativePid; parentPid = [int]$candidate.ParentProcessId; creationTime100ns = [string]$identityBefore.creationTime100ns; nativeImagePath = [string]$identityBefore.nativeImagePath; runtimeKind = [string]$classification.runtimeKind; signerThumbprint = $classification.signerThumbprint; signerSubject = $classification.signerSubject })',
    '  if ([string]$classification.runtimeKind -ne "cef") { continue }',
    '  if ($pidValue -ne [int]$config.mainPid -and [int]$candidate.ParentProcessId -ne [int]$config.mainPid) { throw "same-executable CEF descendant is not a direct browser child" }',
    '  $commandLine = [string]$candidate.CommandLine',
    '  if ([string]::IsNullOrWhiteSpace($commandLine)) { throw "owned process command line is missing" }',
    "  if ($commandLine -match '(?i)(?:^|\\s)\"?--no-sandbox\"?(?:=|\\s|$)|\\bno_sandbox=1\\b|(?:^|\\s)\"?--disable-(?:gpu-|seccomp-filter-|setuid-|namespace-)?sandbox\"?(?:=|\\s|$)') { throw \"owned process disabled a Chromium sandbox\" }",
    '  $type = "browser"',
    '  $utilitySubtype = $null',
    '  if ($pidValue -ne [int]$config.mainPid) {',
    '    $match = [regex]::Match($commandLine, "(?:^|\\s)--type=([^\\s`\"]+)")',
    '    if (-not $match.Success -or -not (@($config.requiredTypes) -contains $match.Groups[1].Value)) { throw "unexpected owned CEF child type" }',
    '    $type = $match.Groups[1].Value',
    '    if ($type -eq "utility") { $utilityMatch = [regex]::Match($commandLine, "(?:^|\\s)--utility-sub-type=([^\\s`\"]+)"); if (-not $utilityMatch.Success) { throw "utility process subtype is missing" }; $utilitySubtype = $utilityMatch.Groups[1].Value }',
    '  }',
    '  $inJob = [CcemMode2NativeEvidence]::ReadInJob($pidValue)',
    '  $token = [CcemMode2NativeEvidence]::ReadToken($pidValue)',
    '  $mitigations = [CcemMode2NativeEvidence]::ReadMitigations($pidValue)',
    '  $currentCim = @(Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $pidValue))',
    '  if ($currentCim.Count -ne 1 -or [int]$currentCim[0].ParentProcessId -ne [int]$candidate.ParentProcessId -or [string]$currentCim[0].CommandLine -cne $commandLine) { throw "CIM process identity changed during native evidence capture" }',
    '  $identityAfter = [CcemMode2NativeEvidence]::ReadProcessIdentity($pidValue)',
    '  if ([int64]$identityAfter.nativePid -ne [int64]$pidValue -or [string]$identityAfter.creationTime100ns -ne [string]$identityBefore.creationTime100ns -or -not ([string]$identityAfter.nativeImagePath).Equals([string]$identityBefore.nativeImagePath, [StringComparison]::OrdinalIgnoreCase)) { throw "process identity changed during native evidence capture" }',
    '  if (-not ([string]$identityAfter.nativeImagePath).Equals([string]$config.executablePath, [StringComparison]::OrdinalIgnoreCase)) { throw "native process image escaped the installed executable" }',
    '  $nativeDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath ([string]$identityAfter.nativeImagePath)).Hash.ToLowerInvariant()',
    '  $records.Add([PSCustomObject]@{ pid = $pidValue; nativePid = [int64]$identityAfter.nativePid; parentPid = [int]$candidate.ParentProcessId; creationTime100ns = [string]$identityAfter.creationTime100ns; type = $type; utilitySubtype = $utilitySubtype; executablePath = [string]$identityAfter.nativeImagePath; nativeImagePath = [string]$identityAfter.nativeImagePath; executableSha256 = $nativeDigest; commandLine = $commandLine; inJob = $inJob; token = $token; mitigations = $mitigations })',
    '}',
    '$allAfter = @(Get-CimInstance -ClassName Win32_Process)',
    '$closureAfter = @(Get-DescendantClosure $allAfter ([int]$config.mainPid))',
    '$closureAfterFacts = [Collections.Generic.List[object]]::new()',
    'foreach ($candidate in $closureAfter) {',
    '  $pidValue = [int]$candidate.ProcessId',
    '  $identity = [CcemMode2NativeEvidence]::ReadProcessIdentity($pidValue)',
    '  $classification = Get-RuntimeClassification ([string]$identity.nativeImagePath)',
    '  $closureAfterFacts.Add([PSCustomObject]@{ pid = $pidValue; nativePid = [int64]$identity.nativePid; parentPid = [int]$candidate.ParentProcessId; creationTime100ns = [string]$identity.creationTime100ns; nativeImagePath = [string]$identity.nativeImagePath; runtimeKind = [string]$classification.runtimeKind; signerThumbprint = $classification.signerThumbprint; signerSubject = $classification.signerSubject })',
    '}',
    '$beforeKeys = @($closureFacts | ForEach-Object { Get-ClosureKey $_ } | Sort-Object)',
    '$afterKeys = @($closureAfterFacts | ForEach-Object { Get-ClosureKey $_ } | Sort-Object)',
    'if (@(Compare-Object -ReferenceObject $beforeKeys -DifferenceObject $afterKeys -CaseSensitive).Count -ne 0) { throw "full descendant closure changed during native evidence capture" }',
    '$window = [CcemMode2NativeEvidence]::ReadWindow([string]$config.nativeWindow.hwnd)',
    '[PSCustomObject]@{ window = $window; processClosure = @($closureFacts | Sort-Object pid); processes = @($records | Sort-Object pid) } | ConvertTo-Json -Depth 10 -Compress',
  ].join('\n'));
}

export function createWindowsOwnedProcessCommand(
  plan,
  action = 'inspect',
  processClosure = [],
  virtualRoot = undefined,
) {
  const virtualRootPid = virtualRoot?.pid ?? 0;
  const virtualRootNotBeforeCreationTime100ns = virtualRoot?.notBeforeCreationTime100ns ?? null;
  if (
    (virtualRootPid !== 0 || virtualRootNotBeforeCreationTime100ns !== null)
    && (
      !Number.isSafeInteger(virtualRootPid)
      || virtualRootPid <= 0
      || !/^[1-9]\d{10,19}$/u.test(virtualRootNotBeforeCreationTime100ns ?? '')
    )
  ) fail('owned-process virtual root identity is invalid');
  const config = powerShellConfig({
    executablePath: plan.paths.installedExecutablePath,
    action,
    virtualRootPid,
    virtualRootNotBeforeCreationTime100ns,
    processClosure: processClosure.map((entry) => ({
      pid: entry.pid,
      creationTime100ns: entry.creationTime100ns,
      nativeImagePath: entry.nativeImagePath,
    })),
  });
  return powerShellCommand([
    "$ErrorActionPreference = 'Stop'",
    `$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json`,
    ...windowsNativeEvidenceBootstrapPowerShell(),
    'function Get-OwnedProcesses {',
    '  return @(Get-CimInstance -ClassName Win32_Process | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -and ([string]$_.ExecutablePath).Equals([string]$config.executablePath, [StringComparison]::OrdinalIgnoreCase) })',
    '}',
    '$wrySignatures = @{}',
    'function Get-TrustedRuntimeClassification([string]$nativeImagePath) {',
    '  if ($nativeImagePath.Equals([string]$config.executablePath, [StringComparison]::OrdinalIgnoreCase)) { return [PSCustomObject]@{ runtimeKind = "cef"; signerThumbprint = $null; signerSubject = $null } }',
    '  if (-not [IO.Path]::GetFileName($nativeImagePath).Equals("msedgewebview2.exe", [StringComparison]::OrdinalIgnoreCase)) { throw "owned descendant has an unknown runtime executable" }',
    '  $identity = $nativeImagePath.ToLowerInvariant()',
    '  if (-not $wrySignatures.ContainsKey($identity)) {',
    '    $signature = Get-AuthenticodeSignature -LiteralPath $nativeImagePath',
    '    $thumbprint = ([string]$signature.SignerCertificate.Thumbprint).Replace(" ", "").ToUpperInvariant()',
    '    $subject = [string]$signature.SignerCertificate.Subject',
    '    if ([string]$signature.Status -ne "Valid" -or $thumbprint -notmatch "^[A-F0-9]{40}$" -or $subject -notmatch "(?i)Microsoft Corporation") { throw "owned Wry descendant is not a valid Microsoft runtime" }',
    '    $wrySignatures[$identity] = [PSCustomObject]@{ runtimeKind = "wry-webview2"; signerThumbprint = $thumbprint; signerSubject = $subject }',
    '  }',
    '  return $wrySignatures[$identity]',
    '}',
    'function Get-CurrentOwnedClosureFacts {',
    '  $all = @(Get-CimInstance -ClassName Win32_Process)',
    '  $exactPids = [Collections.Generic.HashSet[int]]::new()',
    '  foreach ($candidate in $all) {',
    '    if ([string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath) -or -not ([string]$candidate.ExecutablePath).Equals([string]$config.executablePath, [StringComparison]::OrdinalIgnoreCase)) { continue }',
    '    $identity = [CcemMode2NativeEvidence]::ReadProcessIdentity([int]$candidate.ProcessId)',
    '    if ([int64]$identity.nativePid -ne [int64]$candidate.ProcessId -or -not ([string]$identity.nativeImagePath).Equals([string]$config.executablePath, [StringComparison]::OrdinalIgnoreCase)) { throw "owned executable CIM identity does not match its native process handle" }',
    '    [void]$exactPids.Add([int]$candidate.ProcessId)',
    '  }',
    '  $virtualRootPid = [int]$config.virtualRootPid',
    '  $virtualRootMissing = $false',
    '  if ($virtualRootPid -gt 0) {',
    '    $virtualRootEntry = @($all | Where-Object { [int]$_.ProcessId -eq $virtualRootPid })',
    '    if ($virtualRootEntry.Count -gt 1) { throw "owned virtual root PID is ambiguous" }',
    '    if ($virtualRootEntry.Count -eq 1 -and -not $exactPids.Contains($virtualRootPid)) { throw "owned virtual root PID was reused by a foreign executable" }',
    '    if ($virtualRootEntry.Count -eq 1) {',
    '      $virtualRootIdentity = [CcemMode2NativeEvidence]::ReadProcessIdentity($virtualRootPid)',
    '      if ([int64]$virtualRootIdentity.nativePid -ne [int64]$virtualRootPid -or [UInt64]::Parse([string]$virtualRootIdentity.creationTime100ns) -lt [UInt64]::Parse([string]$config.virtualRootNotBeforeCreationTime100ns)) { throw "owned virtual root identity predates this launch" }',
    '    }',
    '    $virtualRootMissing = $virtualRootEntry.Count -eq 0',
    '  }',
    '  $depthByPid = @{}',
    '  foreach ($candidate in $all) {',
    '    $candidatePid = [int]$candidate.ProcessId',
    '    $candidateParent = [int]$candidate.ParentProcessId',
    '    if ($exactPids.Contains($candidatePid) -and -not $exactPids.Contains($candidateParent) -and -not ($virtualRootMissing -and $candidateParent -eq $virtualRootPid)) { $depthByPid[$candidatePid] = 0 }',
    '  }',
    '  if ($virtualRootMissing) {',
    '    foreach ($candidate in $all) {',
    '      if ([int]$candidate.ParentProcessId -ne $virtualRootPid) { continue }',
    '      $candidatePid = [int]$candidate.ProcessId',
    '      $identity = [CcemMode2NativeEvidence]::ReadProcessIdentity($candidatePid)',
    '      if ([int64]$identity.nativePid -ne [int64]$candidatePid) { throw "owned virtual-root child native PID mismatch" }',
    '      [void](Get-TrustedRuntimeClassification ([string]$identity.nativeImagePath))',
    '      if ([UInt64]::Parse([string]$identity.creationTime100ns) -lt [UInt64]::Parse([string]$config.virtualRootNotBeforeCreationTime100ns)) { throw "owned virtual-root child predates this launch" }',
    '      $depthByPid[$candidatePid] = 1',
    '    }',
    '  }',
    '  if ($exactPids.Count -gt 0 -and $depthByPid.Count -eq 0) { throw "owned executable process roots are cyclic or detached" }',
    '  $changed = $true',
    '  while ($changed) {',
    '    $changed = $false',
    '    foreach ($candidate in $all) {',
    '      $candidatePid = [int]$candidate.ProcessId',
    '      $parentPid = [int]$candidate.ParentProcessId',
    '      if (-not $depthByPid.ContainsKey($candidatePid) -and $depthByPid.ContainsKey($parentPid)) { $depthByPid[$candidatePid] = [int]$depthByPid[$parentPid] + 1; $changed = $true }',
    '    }',
    '  }',
    '  $facts = [Collections.Generic.List[object]]::new()',
    '  foreach ($candidate in $all) {',
    '    $candidatePid = [int]$candidate.ProcessId',
    '    if (-not $depthByPid.ContainsKey($candidatePid)) { continue }',
    '    $identity = [CcemMode2NativeEvidence]::ReadProcessIdentity($candidatePid)',
    '    if ([int64]$identity.nativePid -ne [int64]$candidatePid) { throw "owned closure native PID mismatch" }',
    '    $classification = Get-TrustedRuntimeClassification ([string]$identity.nativeImagePath)',
    '    if ($virtualRootMissing -and [UInt64]::Parse([string]$identity.creationTime100ns) -lt [UInt64]::Parse([string]$config.virtualRootNotBeforeCreationTime100ns)) { throw "owned virtual-root descendant predates this launch" }',
    '    $facts.Add([PSCustomObject]@{ pid = $candidatePid; creationTime100ns = [string]$identity.creationTime100ns; nativeImagePath = [string]$identity.nativeImagePath; depth = [int]$depthByPid[$candidatePid]; runtimeKind = [string]$classification.runtimeKind; signerThumbprint = $classification.signerThumbprint; signerSubject = $classification.signerSubject })',
    '  }',
    '  return @($facts)',
    '}',
    'function Get-RemainingClosurePids([object[]]$expectedClosure) {',
    '  $all = @(Get-CimInstance -ClassName Win32_Process)',
    '  $remaining = [Collections.Generic.List[int]]::new()',
    '  foreach ($expected in @($expectedClosure)) {',
    '    $candidate = @($all | Where-Object { [int]$_.ProcessId -eq [int]$expected.pid })',
    '    if ($candidate.Count -ne 1) { continue }',
    '    $identity = [CcemMode2NativeEvidence]::ReadProcessIdentity([int]$expected.pid)',
    '    if ([string]$identity.creationTime100ns -eq [string]$expected.creationTime100ns -and ([string]$identity.nativeImagePath).Equals([string]$expected.nativeImagePath, [StringComparison]::OrdinalIgnoreCase)) { $remaining.Add([int]$expected.pid) }',
    '  }',
    '  return @($remaining | Sort-Object)',
    '}',
    '$tracked = [Collections.Generic.List[object]]::new()',
    '$trackedKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)',
    'foreach ($expected in @($config.processClosure)) {',
    '  $key = "{0}|{1}|{2}" -f [int]$expected.pid, [string]$expected.creationTime100ns, [string]$expected.nativeImagePath',
    '  if ($trackedKeys.Add($key)) { $tracked.Add([PSCustomObject]@{ pid = [int]$expected.pid; creationTime100ns = [string]$expected.creationTime100ns; nativeImagePath = [string]$expected.nativeImagePath; depth = 0 }) }',
    '}',
    '$owned = @(Get-OwnedProcesses)',
    '$remainingClosure = @(Get-RemainingClosurePids @($tracked))',
    'if ($config.action -eq "terminate") {',
    '  for ($pass = 0; $pass -lt 3; $pass++) {',
    '    $currentClosure = @(Get-CurrentOwnedClosureFacts)',
    '    foreach ($fact in $currentClosure) {',
    '      $key = "{0}|{1}|{2}" -f [int]$fact.pid, [string]$fact.creationTime100ns, [string]$fact.nativeImagePath',
    '      if ($trackedKeys.Add($key)) { $tracked.Add($fact) }',
    '    }',
    '    foreach ($expected in @($tracked | Sort-Object @{ Expression = "depth"; Descending = $true }, @{ Expression = "pid"; Descending = $true })) {',
    '      $candidate = @(Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f [int]$expected.pid))',
    '      if ($candidate.Count -ne 1) { continue }',
    '      $identity = [CcemMode2NativeEvidence]::ReadProcessIdentity([int]$expected.pid)',
    '      if ([string]$identity.creationTime100ns -ne [string]$expected.creationTime100ns -or -not ([string]$identity.nativeImagePath).Equals([string]$expected.nativeImagePath, [StringComparison]::OrdinalIgnoreCase)) { continue }',
    '      Stop-Process -Id ([int]$expected.pid) -Force -ErrorAction Stop',
    '    }',
    '    Start-Sleep -Milliseconds 100',
    '  }',
    '  $owned = @(Get-OwnedProcesses)',
    '  $remainingClosure = @(Get-RemainingClosurePids @($tracked))',
    '}',
    '[PSCustomObject]@{ remainingOwnedPids = @($owned | ForEach-Object { [int]$_.ProcessId } | Sort-Object); remainingClosurePids = @($remainingClosure) } | ConvertTo-Json -Compress',
  ].join('\n'));
}

function canonicalEntries(value) {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

export function validatePreflightObservation(observation, plan, manifestIdentity) {
  exactKeys(observation, [
    'installerSha256', 'installedExecutableSha256', 'stableCefResources',
    'authenticode', 'installedTree', 'installedTreeSafety', 'lpacAcl',
  ], 'preflight observation');
  exactSha256(observation.installerSha256, 'installed NSIS installer');
  exactSha256(observation.installedExecutableSha256, 'installed main executable');
  if (
    JSON.stringify(canonicalEntries(observation.stableCefResources ?? {}))
    !== JSON.stringify(canonicalEntries(manifestIdentity.stableCefResources))
  ) fail('installed stable CEF resource hashes differ from the signed stage');

  const expectedSignaturePaths = [...new Set([
    plan.paths.installerPath,
    plan.paths.installedExecutablePath,
    ...manifestIdentity.signer.signedFiles.map((relative) => (
      path.win32.join(plan.paths.installRoot, relative)
    )),
  ].map((candidate) => path.win32.normalize(candidate).toLowerCase()))].sort();
  if (!Array.isArray(observation.authenticode) || observation.authenticode.length !== expectedSignaturePaths.length) {
    fail('Authenticode observation did not cover the exact signed path set');
  }
  const actualSignaturePaths = observation.authenticode.map((signature) => {
    exactKeys(signature, [
      'path', 'status', 'signerThumbprint', 'signerSubject', 'timestampThumbprint',
    ], 'Authenticode observation');
    const candidate = exactWindowsPath(signature.path, 'Authenticode path');
    if (
      signature.status !== 'Valid'
      || normalizeThumbprint(signature.signerThumbprint) !== manifestIdentity.signer.thumbprint
      || signature.signerSubject !== manifestIdentity.signer.publisher
      || !/^[A-Fa-f0-9]{40}$/u.test(signature.timestampThumbprint ?? '')
    ) fail(`Authenticode identity is invalid: ${candidate}`);
    return path.win32.normalize(candidate).toLowerCase();
  }).sort();
  if (JSON.stringify(actualSignaturePaths) !== JSON.stringify(expectedSignaturePaths)) {
    fail('Authenticode observation path set mismatch');
  }

  exactKeys(observation.installedTree, ['directories', 'files'], 'installed-tree scan');
  const installedTree = validateWindowsInstalledTreeInventory(createWindowsInstalledTreeInventory({
    directories: observation.installedTree.directories,
    files: observation.installedTree.files,
  }), 'installed-tree inventory');
  const fileByPath = new Map(installedTree.files.map((file) => [
    file.relativePath.toUpperCase(),
    file,
  ]));
  const mainRelativePath = path.win32.basename(plan.paths.installedExecutablePath);
  if (fileByPath.get(mainRelativePath.toUpperCase())?.sha256 !== observation.installedExecutableSha256) {
    fail('installed-tree inventory does not bind the inspected main executable bytes');
  }
  for (const [relativePath, digest] of Object.entries(observation.stableCefResources)) {
    if (fileByPath.get(relativePath.toUpperCase())?.sha256 !== digest) {
      fail(`installed-tree inventory does not bind stable CEF resource ${relativePath}`);
    }
  }
  const safety = observation.installedTreeSafety;
  exactKeys(safety, [
    'rootPath', 'rootType', 'rootNoReparsePoint', 'ancestorReparseFree', 'pathCount',
    'reparsePoints', 'alternateDataStreams', 'reservedPaths', 'unsupportedEntries',
  ], 'installed-tree safety proof');
  exactWindowsPath(safety.rootPath, 'installed-tree safety root');
  if (
    !sameWindowsPath(safety.rootPath, plan.paths.installRoot)
    || safety.rootType !== 'directory'
    || safety.rootNoReparsePoint !== true
    || safety.ancestorReparseFree !== true
    || safety.pathCount !== installedTree.pathCount
    || !['reparsePoints', 'alternateDataStreams', 'reservedPaths', 'unsupportedEntries']
      .every((field) => Array.isArray(safety[field]) && safety[field].length === 0)
  ) fail('installed-tree scan did not prove a plain safe no-follow tree');

  const acl = observation.lpacAcl;
  exactKeys(acl, [
    'rootPath', 'sid', 'accessControlType', 'rights', 'objectInherit', 'containerInherit',
    'propagation', 'writeGranted', 'rootAceCount', 'rootNoReparsePoint',
    'rootExplicitAceCount', 'descendantAcesInherited', 'descendantExplicitAceCount',
    'ancestorReparseFree', 'verifiedDirectoryCount', 'verifiedFileCount',
    'verifiedPathCount', 'verifiedDirectories', 'verifiedFiles', 'missingPaths',
  ], 'preflight LPAC ACL');
  exactWindowsPath(acl.rootPath, 'preflight LPAC root');
  if (
    !sameWindowsPath(acl.rootPath, plan.paths.installRoot)
    || acl.sid !== WINDOWS_LPAC_SID
    || acl.accessControlType !== 'Allow'
    || acl.rights !== 'read_execute'
    || acl.objectInherit !== true
    || acl.containerInherit !== true
    || acl.propagation !== 'none'
    || acl.writeGranted !== false
    || acl.rootAceCount !== 1
    || acl.rootExplicitAceCount !== 1
    || acl.descendantAcesInherited !== true
    || acl.descendantExplicitAceCount !== 0
    || acl.rootNoReparsePoint !== true
    || acl.ancestorReparseFree !== true
    || acl.verifiedDirectoryCount !== installedTree.directoryCount
    || acl.verifiedFileCount !== installedTree.fileCount
    || acl.verifiedPathCount !== installedTree.pathCount
    || JSON.stringify(acl.verifiedDirectories) !== JSON.stringify(installedTree.directories)
    || JSON.stringify(acl.verifiedFiles) !== JSON.stringify(
      installedTree.files.map((file) => file.relativePath),
    )
    || !Array.isArray(acl.missingPaths)
    || acl.missingPaths.length !== 0
  ) fail('preflight LPAC ACL does not cover the exact installed tree');
  return {
    ...observation,
    installedTree,
    lpacAcl: {
      ...acl,
      installedTreeInventorySha256: installedTree.inventorySha256,
      installedTreePathSetSha256: installedTree.pathSetSha256,
    },
  };
}
