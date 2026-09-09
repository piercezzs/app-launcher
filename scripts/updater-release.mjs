import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const platforms = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'];
// Keep published artifacts within the native updater download limit.
const maximumSize = 256 * 1024 * 1024;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
export function versionParts(version) {
  assert(typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), 'Expected a stable major.minor.patch version');
  return version.split('.').map(BigInt);
}
export function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
export function fileNames(version) {
  versionParts(version);
  const prefix = `Hatch_${version}_`;
  return {
    'darwin-aarch64': `${prefix}aarch64.app.tar.gz`,
    'darwin-x86_64': `${prefix}x64.app.tar.gz`,
    'windows-x86_64': `${prefix}x64-setup.exe`,
  };
}
function decode(value) {
  assert(typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'Invalid base64 signature/key');
  const bytes = Buffer.from(value, 'base64');
  assert(bytes.toString('base64') === value, 'Noncanonical base64 signature/key');
  return bytes;
}
export function verifyMinisign(data, signature, publicKey) {
  const keyLines = decode(publicKey.trim()).toString('utf8').trimEnd().split(/\r?\n/);
  const lines = decode(signature.trim()).toString('utf8').trimEnd().split(/\r?\n/);
  assert(keyLines.length === 2 && keyLines[0].startsWith('untrusted comment: '), 'Invalid public key envelope');
  assert(lines.length === 4 && lines[0].startsWith('untrusted comment: ') && lines[2].startsWith('trusted comment: '), 'Invalid signature envelope');
  const key = decode(keyLines[1]); const packet = decode(lines[1]); const globalSignature = decode(lines[3]);
  assert(key.length === 42 && key.subarray(0, 2).toString() === 'Ed', 'Invalid Ed25519 public key');
  assert(packet.length === 74 && ['Ed', 'ED'].includes(packet.subarray(0, 2).toString()), 'Invalid minisign packet');
  assert(packet.subarray(2, 10).equals(key.subarray(2, 10)), 'Signature key ID mismatch');
  assert(globalSignature.length === 64, 'Invalid trusted comment signature');
  const nativeKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const payload = packet.subarray(0, 2).toString() === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  assert(verifySignature(null, payload, nativeKey, packet.subarray(10)), 'Update archive signature verification failed');
  assert(verifySignature(null, Buffer.concat([packet.subarray(10), Buffer.from(lines[2].slice('trusted comment: '.length))]), nativeKey, globalSignature), 'Trusted comment signature verification failed');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function bytesAt(directory, name) {
  assert(/^[A-Za-z0-9_.-]+$/.test(name) && basename(name) === name, 'Unsafe asset filename');
  const path = join(directory, name); const info = statSync(path);
  assert(info.isFile() && info.size > 0 && info.size <= maximumSize, `Invalid asset size: ${name}`);
  assert(!name.endsWith('.sig') || info.size <= 8192, `Oversized signature: ${name}`);
  return readFileSync(path);
}
export function createManifest(directory, repository, version, commit, publicKey, notes = '') {
  versionParts(version);
  assert(repository === 'piercezzs/hatch', 'Unexpected repository');
  assert(/^[a-f0-9]{40}$/.test(commit), 'Expected full source commit');
  const names = fileNames(version);
  const expected = [...Object.values(names).flatMap(name => [name, `${name}.sig`]), `Hatch_${version}_aarch64.dmg`, `Hatch_${version}_x64.dmg`, 'LICENSE', 'THIRD_PARTY_NOTICES.txt'].sort();
  const actual = readdirSync(directory).filter(name => !['latest.json', 'SHA256SUMS'].includes(name)).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'Incomplete or unexpected release assets');
  const assets = Object.fromEntries(expected.map(name => { const bytes = bytesAt(directory, name); return [name, { size: bytes.length, sha256: sha256(bytes) }]; }));
  const entries = Object.fromEntries(platforms.map(platform => {
    const name = names[platform]; const signature = bytesAt(directory, `${name}.sig`).toString('utf8').trim();
    verifyMinisign(bytesAt(directory, name), signature, publicKey);
    return [platform, { signature, url: `https://github.com/${repository}/releases/download/v${version}/${name}` }];
  }));
  return { version, notes, platforms: entries, hatch: { repository, tag: `v${version}`, commit, assets } };
}
export function verifyManifest(directory, manifest, publicKey) {
  assert(manifest && manifest.hatch, 'Missing release provenance');
  const expected = createManifest(directory, manifest.hatch.repository, manifest.version, manifest.hatch.commit, publicKey, manifest.notes);
  assert(JSON.stringify(manifest) === JSON.stringify(expected), 'Manifest does not match verified assets');
  const listed = [...Object.keys(expected.hatch.assets), 'latest.json'].sort();
  const sums = listed.map(name => `${sha256(bytesAt(directory, name))}  ${name}\n`).join('');
  assert(readFileSync(join(directory, 'SHA256SUMS'), 'utf8') === sums, 'Release checksum list mismatch');
  return expected;
}
export function advanceChannel(previous, next) {
  if (!previous) return next;
  const order = compareVersions(next.version, previous.version);
  assert(order >= 0, 'Refusing channel downgrade');
  assert(order !== 0 || JSON.stringify(previous) === JSON.stringify(next), 'Refusing changed assets for an existing channel version');
  return next;
}
function recursiveFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? recursiveFiles(join(directory, entry.name)) : [join(directory, entry.name)]);
}
function collect(source, destination, target, version) {
  const platform = { 'aarch64-apple-darwin': 'darwin-aarch64', 'x86_64-apple-darwin': 'darwin-x86_64', 'x86_64-pc-windows-msvc': 'windows-x86_64' }[target];
  assert(platform, 'Unsupported build target');
  const files = recursiveFiles(source); const archive = fileNames(version)[platform];
  const select = suffix => { const matches = files.filter(path => path.endsWith(suffix)); assert(matches.length === 1, `Expected exactly one ${suffix} artifact`); return matches[0]; };
  mkdirSync(destination, { recursive: true });
  const original = select(platform.startsWith('darwin') ? 'Hatch.app.tar.gz' : archive);
  copyFileSync(original, join(destination, archive));
  copyFileSync(`${original}.sig`, join(destination, `${archive}.sig`));
  if (platform.startsWith('darwin')) {
    const dmg = `Hatch_${version}_${platform.endsWith('aarch64') ? 'aarch64' : 'x64'}.dmg`;
    copyFileSync(select(dmg), join(destination, dmg));
  }
}
export function validateReleaseMetadata(release) {
  assert(release.draft === false && release.published_at && release.prerelease === false, 'Release must be published and must not be a prerelease');
  assert(typeof release.tag_name === 'string' && release.tag_name.startsWith('v'), 'Invalid release tag');
  const version = release.tag_name.slice(1);
  const names = fileNames(version);
  const expected = [...Object.values(names).flatMap(name => [name, `${name}.sig`]), `Hatch_${version}_aarch64.dmg`, `Hatch_${version}_x64.dmg`, 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'latest.json', 'SHA256SUMS'].sort();
  assert(Array.isArray(release.assets) && JSON.stringify(release.assets.map(asset => asset.name).sort()) === JSON.stringify(expected), 'Published release asset set mismatch');
  for (const asset of release.assets) {
    assert(asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= maximumSize, 'Invalid published asset size/state');
    assert(!asset.name.endsWith('.sig') || asset.size <= 8192, 'Oversized published signature');
    assert(asset.browser_download_url === `https://github.com/piercezzs/hatch/releases/download/${release.tag_name}/${asset.name}`, 'Unsafe published asset URL');
  }
  return release;
}
function main([command, ...args]) {
  if (command === 'collect') { collect(...args); return; }
  if (command === 'metadata') { validateReleaseMetadata(JSON.parse(readFileSync(args[0], 'utf8'))); return; }
  const config = JSON.parse(readFileSync(new URL('../apps/hatch/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const publicKey = config.plugins.updater.pubkey;
  if (command === 'manifest') {
    const [directory, repository, tag, commit] = args;
    assert(tag?.startsWith('v'), 'Missing release tag');
    const manifest = createManifest(directory, repository, tag.slice(1), commit, publicKey, `Hatch ${tag}. Release notes: https://github.com/${repository}/releases/tag/${tag}`);
    writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const names = [...Object.keys(manifest.hatch.assets), 'latest.json'].sort();
    writeFileSync(join(directory, 'SHA256SUMS'), names.map(name => `${sha256(bytesAt(directory, name))}  ${name}\n`).join(''));
    verifyManifest(directory, manifest, publicKey); return;
  }
  if (command === 'verify') {
    const [directory, metadataPath] = args;
    const manifest = verifyManifest(directory, JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8')), publicKey);
    const release = validateReleaseMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')));
    assert(release.draft === false && release.published_at && release.tag_name === manifest.hatch.tag, 'Release is draft, unpublished or has a mismatched version');
    const actual = release.assets.map(asset => asset.name).sort();
    const expected = [...Object.keys(manifest.hatch.assets), 'latest.json', 'SHA256SUMS'].sort();
    assert(JSON.stringify(actual) === JSON.stringify(expected), 'Published release asset set mismatch');
    for (const asset of release.assets) {
      assert(asset.state === 'uploaded' && asset.size === bytesAt(directory, asset.name).length, 'Published release asset size/state mismatch');
      assert(asset.browser_download_url === `https://github.com/piercezzs/hatch/releases/download/${release.tag_name}/${asset.name}`, 'Unsafe published asset URL');
    }
    console.log(manifest.hatch.commit); return;
  }
  if (command === 'channel') {
    const [source, destination] = args;
    const next = JSON.parse(readFileSync(source, 'utf8'));
    const previous = existsSync(destination) ? JSON.parse(readFileSync(destination, 'utf8')) : null;
    advanceChannel(previous, next); writeFileSync(destination, `${JSON.stringify(next, null, 2)}\n`); return;
  }
  throw new Error('Expected collect, manifest, verify or channel');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
