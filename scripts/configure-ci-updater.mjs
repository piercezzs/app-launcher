// Build-only credentials. This script never publishes keys or changes repository source remotely.
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyMinisign } from './updater-release.mjs';

const configPath = new URL('../apps/hatch/src-tauri/tauri.conf.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error('This helper requires an isolated GitHub Actions runner');
const run = (args, env = process.env) => {
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', 'hatch', 'exec', 'tauri', 'signer', ...args], { env, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error('Updater signer failed; inspect key/password configuration (output suppressed to protect credentials)');
};
let key = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();
let password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';
const releaseBuild = process.env.GITHUB_REF?.startsWith('refs/tags/');
if (releaseBuild) {
  if (!key || !config.plugins?.updater?.pubkey) throw new Error('Release builds require the production updater public key and TAURI_SIGNING_PRIVATE_KEY secret; test-key fallback is forbidden');
} else {
  const keyPath = join(process.env.RUNNER_TEMP, 'hatch-test-updater.key');
  password = randomBytes(32).toString('hex');
  run(['generate', '--ci', '--password', password, '--write-keys', keyPath]);
  chmodSync(keyPath, 0o600);
  key = readFileSync(keyPath, 'utf8').trim();
  config.plugins ??= {}; config.plugins.updater ??= {};
  config.plugins.updater.pubkey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
}
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) throw new Error('Store the base64 private key contents in the GitHub secret, not a file path');
console.log(`::add-mask::${key}`);
if (password) console.log(`::add-mask::${password}`);
const probe = join(process.env.RUNNER_TEMP, 'hatch-signing-probe');
writeFileSync(probe, 'Hatch updater signing preflight\n');
run(['sign', probe], { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password });
verifyMinisign(readFileSync(probe), readFileSync(`${probe}.sig`, 'utf8').trim(), config.plugins.updater.pubkey);
// Only mutate the disposable build checkout after the key has passed verification.
config.bundle ??= {};
config.bundle.createUpdaterArtifacts = true;
config.plugins.updater.windows = { ...config.plugins.updater.windows, installMode: 'passive' };
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
// Passwords are written through a delimiter to preserve special characters and newlines.
const delimiter = `HATCH_${randomBytes(24).toString('hex')}`;
appendFileSync(process.env.GITHUB_ENV, `TAURI_SIGNING_PRIVATE_KEY=${key}\nTAURI_SIGNING_PRIVATE_KEY_PASSWORD<<${delimiter}\n${password}\n${delimiter}\n`);
console.log(releaseBuild ? 'Production updater signing key verified' : 'Ephemeral CI signing key verified; artifacts cannot update production clients');
