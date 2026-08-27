/**
 * Compatibility gates for the CCEM → DSH projection.
 *
 * Both floors were read from the installed artifacts, not guessed:
 * - `@deepseek-ai/dsh` itself declares no `engines` field; the binding
 *   constraint in its dependency tree is `@earendil-works/pi-ai`
 *   (`"engines": { "node": ">=22.19.0" }`), which backs the
 *   `anthropic-messages` route ccem depends on.
 * - The patch contract (`--patch` overlays, the `llm-pi-ai` providers dict,
 *   the built-in `headless` profile template, disabling the `settings` row)
 *   was verified against dsh 0.1.1-rc.2 only; older pre-releases shipped the
 *   pre-dict provider shape, and newer releases are untested contracts.
 *   ccem locks to the exact verified version.
 */

/** The only verified dsh version — exact match required. */
export const DSH_REQUIRED_VERSION = '0.1.1-rc.2';
export const DSH_NODE_MIN_VERSION = '22.19.0';

export interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

export function parseVersion(input: string): ParsedVersion | null {
  const value = input.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  const core: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const prerelease = match[4] ? match[4].split('.') : [];
  return { core, prerelease };
}

function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    return Math.sign(Number(a) - Number(b));
  }
  if (aNumeric !== bNumeric) {
    // Numeric identifiers always have lower precedence than alphanumeric.
    return aNumeric ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new Error(`Cannot compare versions '${a}' and '${b}'`);
  }

  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) {
      return Math.sign(left.core[i] - right.core[i]);
    }
  }

  // A version without prerelease identifiers has higher precedence.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }

  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i += 1) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1; // fewer identifiers → lower precedence
    if (r === undefined) return 1;
    const compared = comparePrereleaseIdentifiers(l, r);
    if (compared !== 0) return compared;
  }

  return 0;
}

/** dsh must be exactly the verified contract version. */
export function isDshVersionCompatible(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return compareVersions(version, DSH_REQUIRED_VERSION) === 0;
}

export function isNodeVersionCompatible(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return compareVersions(version, DSH_NODE_MIN_VERSION) >= 0;
}
