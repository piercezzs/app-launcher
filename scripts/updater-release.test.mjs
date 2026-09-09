import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManifest, verifyManifest, verifyMinisign, advanceChannel, fileNames, compareVersions } from './updater-release.mjs';

const pair = generateKeyPairSync('ed25519');
const keyId = Buffer.from('12345678');
const keyPacket = Buffer.concat([Buffer.from('Ed'), keyId, pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]);
const publicKey = Buffer.from(`untrusted comment: test key\n${keyPacket.toString('base64')}\n`).toString('base64');
const signatureFor = bytes => {
  const signature = sign(null, createHash('blake2b512').update(bytes).digest(), pair.privateKey);
  const packet = Buffer.concat([Buffer.from('ED'), keyId, signature]);
  const trusted = 'timestamp:1234567890';
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), pair.privateKey);
  return Buffer.from(`untrusted comment: signature\n${packet.toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`).toString('base64');
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'hatch-updater-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of Object.values(fileNames('0.4.0'))) {
    const bytes = Buffer.from(`archive:${file}`);
    writeFileSync(join(directory, file), bytes); writeFileSync(join(directory, `${file}.sig`), signatureFor(bytes));
  }
  for (const file of ['Hatch_0.4.0_aarch64.dmg', 'Hatch_0.4.0_x64.dmg', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) writeFileSync(join(directory, file), file);
  const create = () => createManifest(directory, 'piercezzs/hatch', '0.4.0', 'a'.repeat(40), publicKey);
  return { directory, create };
}
function persist(directory, manifest) {
  writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, 'SHA256SUMS'), [...Object.keys(manifest.hatch.assets), 'latest.json'].sort().map(file => `${createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')}  ${file}\n`).join(''));
}
test('complete three-platform signed release verifies and has deterministic URLs', t => {
  const { directory, create } = fixture(t); const manifest = create(); persist(directory, manifest);
  assert.deepEqual(Object.keys(manifest.platforms), ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']);
  assert.match(manifest.platforms['darwin-aarch64'].url, /\/v0.4.0\/Hatch_0.4.0_aarch64.app.tar.gz$/);
  assert.deepEqual(verifyManifest(directory, manifest, publicKey), manifest);
});
test('missing architecture is rejected', t => {
  const { directory, create } = fixture(t); rmSync(join(directory, 'Hatch_0.4.0_x64.app.tar.gz'));
  assert.throws(create, /Incomplete/);
});
test('corrupted archive is rejected before it enters the manifest', t => {
  const { directory, create } = fixture(t); writeFileSync(join(directory, 'Hatch_0.4.0_x64-setup.exe'), 'tampered');
  assert.throws(create, /signature verification failed/);
});
test('invalid signature and mismatched signing key are rejected', () => {
  assert.throws(() => verifyMinisign(Buffer.from('x'), 'not a signature', publicKey), /base64/);
  const changedKey = Buffer.from(Buffer.from(publicKey, 'base64').toString().replace(keyPacket.toString('base64'), Buffer.concat([Buffer.from('Ed'), Buffer.from('87654321'), keyPacket.subarray(10)]).toString('base64'))).toString('base64');
  assert.throws(() => verifyMinisign(Buffer.from('x'), signatureFor(Buffer.from('x')), changedKey), /key ID/);
});
test('trusted comment tampering fails', () => {
  const original = signatureFor(Buffer.from('x'));
  const altered = Buffer.from(Buffer.from(original, 'base64').toString().replace('timestamp:1234567890', 'timestamp:0000000000')).toString('base64');
  assert.throws(() => verifyMinisign(Buffer.from('x'), altered, publicKey), /Trusted comment/);
});
test('unsafe URLs, platform versions and checksums are rejected', t => {
  const { directory, create } = fixture(t); const manifest = create(); persist(directory, manifest);
  const altered = structuredClone(manifest); altered.platforms['windows-x86_64'].url = 'https://example.com/evil.exe';
  assert.throws(() => verifyManifest(directory, altered, publicKey), /does not match/);
  assert.throws(() => verifyManifest(directory, { ...manifest, version: '0.5.0' }, publicKey), /Incomplete/);
  writeFileSync(join(directory, 'SHA256SUMS'), 'wrong');
  assert.throws(() => verifyManifest(directory, manifest, publicKey), /checksum/);
});
test('unexpected assets and zero-byte installers are rejected', t => {
  const { directory, create } = fixture(t); writeFileSync(join(directory, 'extra.exe'), 'extra');
  assert.throws(create, /unexpected/); rmSync(join(directory, 'extra.exe'));
  writeFileSync(join(directory, 'Hatch_0.4.0_x64-setup.exe'), ''); assert.throws(create, /size/);
});
test('channels are monotonic; equal versions must be byte-equivalent', () => {
  const previous = { version: '0.4.0', platforms: {} };
  assert.deepEqual(advanceChannel(null, previous), previous);
  assert.deepEqual(advanceChannel(previous, structuredClone(previous)), previous);
  assert.throws(() => advanceChannel(previous, { version: '0.3.0' }), /downgrade/);
  assert.throws(() => advanceChannel(previous, { ...previous, notes: 'changed' }), /existing channel version/);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.throws(() => fileNames('../../x'), /version/);
});

test('published metadata rejects drafts, unsafe links, partial assets and unreasonable sizes', async t => {
  const { validateReleaseMetadata } = await import('./updater-release.mjs');
  const { directory, create } = fixture(t); const manifest = create(); persist(directory, manifest);
  const release = {
    draft: false, prerelease: false, published_at: '2026-09-09T00:00:00Z', tag_name: 'v0.4.0',
    assets: [...Object.keys(manifest.hatch.assets), 'latest.json', 'SHA256SUMS'].map(name => ({ name, size: readFileSync(join(directory, name)).length, state: 'uploaded', browser_download_url: `https://github.com/piercezzs/hatch/releases/download/v0.4.0/${name}` })),
  };
  assert.equal(validateReleaseMetadata(release), release);
  assert.throws(() => validateReleaseMetadata({ ...release, draft: true }), /published/);
  assert.throws(() => validateReleaseMetadata({ ...release, prerelease: true }), /prerelease/);
  assert.throws(() => validateReleaseMetadata({ ...release, assets: release.assets.slice(1) }), /asset set/);
  const unsafe = structuredClone(release); unsafe.assets[0].browser_download_url = 'https://example.com/archive';
  assert.throws(() => validateReleaseMetadata(unsafe), /Unsafe/);
  const oversized = structuredClone(release); oversized.assets[0].size = 256 * 1024 * 1024 + 1;
  assert.throws(() => validateReleaseMetadata(oversized), /size/);
  const traversal = structuredClone(release); traversal.assets[0].name = '../escape';
  assert.throws(() => validateReleaseMetadata(traversal), /asset set/);
});
