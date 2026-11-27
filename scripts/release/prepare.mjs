import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const channel = process.env.CHANNEL;
const sequence = Number(process.env.GITHUB_RUN_NUMBER);
if (!['stable', 'development'].includes(channel) || !Number.isSafeInteger(sequence) || sequence < 1) throw Error('Invalid release inputs');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const version = `0.2.${sequence}${channel === 'development' ? '-dev.0' : ''}`;
const pkg = JSON.parse(fs.readFileSync('package.json'));
pkg.version = version;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json'));
if (process.env.FILIGRANAS_UPDATER_PUBLIC_KEY && config.plugins?.updater?.pubkey !== process.env.FILIGRANAS_UPDATER_PUBLIC_KEY.trim()) {
  throw Error('The configured updater public key differs from the release verification key');
}
config.version = version;
config.bundle.createUpdaterArtifacts = true;
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(config, null, 2) + '\n');
for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/(name = "filigranas"\nversion = ")[^"]+/, `$1${version}`));
}
fs.writeFileSync('release-info.json', JSON.stringify({ version, channel, sha }, null, 2));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nsha=${sha}\n`);
