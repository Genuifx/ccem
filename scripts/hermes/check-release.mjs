#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadReleaseConfig, fetchReleaseAsset, verifyManifest, verifyLocalRelease } from './release-contract.mjs';

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
try {
  const config = await loadReleaseConfig();
  if (args.includes('--published')) {
    const manifest = await fetchReleaseAsset(config.manifestUrl);
    const signature = await fetchReleaseAsset(`${config.manifestUrl}.sig`, { maximum: 16 * 1024 });
    const verified = verifyManifest(config, manifest.bytes, signature.bytes.toString('utf8'));
    const probe = await fetchReleaseAsset(verified.artifact.source_url, { maximum: 1, range: true });
    if (probe.bytes.length !== 1 || probe.headers.get('content-range') !== `bytes 0-0/${verified.artifact.archive.byte_size}`) {
      throw new Error('the published ZIP does not attest its exact size and Range support');
    }
  } else if (value('--local-root')) {
    await verifyLocalRelease(config, value('--local-root'));
    if (args.includes('--record-verification')) {
      const receiptPath = path.join(value('--local-root'), 'build-receipt.json');
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      const manifest = await fs.readFile(path.join(value('--local-root'), 'manifest.json'));
      Object.assign(receipt, { buildState: 'complete', manifestSignatureVerified: true,
        manifestSha256: createHash('sha256').update(manifest).digest('hex') });
      await fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    }
  }
  const envFile = value('--github-env');
  if (envFile) {
    const delimiter = `HERMES_${randomUUID().replaceAll('-', '')}`;
    await fs.appendFile(envFile, `CCEM_HERMES_RUNTIME_MANIFEST_URL=${config.manifestUrl}\nCCEM_HERMES_RUNTIME_PUBLIC_KEY<<${delimiter}\n${config.publicKey.trim()}\n${delimiter}\n`);
  }
  const outputs = value('--github-output');
  if (outputs) await fs.appendFile(outputs, `version=${config.version}\nsequence=${config.sequence}\n`);
  console.log(`Hermes ${config.version}: ${args.includes('--published') ? 'published manifest, signature and archive verified' : value('--local-root') ? 'local signed archive verified' : 'source configuration verified'}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
