import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve filesystem segments after decoding the module URL. In particular,
// a fixture named "#" or "%" is a filename, not a URL fragment or escape.
export function fixturePath(moduleUrl, ...segments) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), ...segments);
}

// Node treats a raw Windows drive path as a URL scheme. Keep path-to-URL
// conversion here, including escaping spaces, Unicode, percent signs and #.
export function importFixture(filePath) {
  return import(pathToFileURL(filePath).href);
}
