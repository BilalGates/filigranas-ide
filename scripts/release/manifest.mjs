import fs from 'node:fs';
import path from 'node:path';
const info = JSON.parse(fs.readFileSync('release-info.json'));
const root = process.argv[2];
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const platforms = {};
for (const file of walk(root).filter(p => p.endsWith('.sig'))) {
  const artifact = file.slice(0, -4);
  if (!fs.existsSync(artifact)) throw Error('Missing signed artifact');
  const platform = file.includes('aarch64-apple-darwin') ? 'darwin-aarch64' : file.includes('x86_64-apple-darwin') ? 'darwin-x86_64' : file.includes('x86_64-pc-windows-msvc') ? 'windows-x86_64' : null;
  if (!platform || platforms[platform]) throw Error('Unknown or duplicate platform');
  platforms[platform] = { signature: fs.readFileSync(file, 'utf8').trim(), url: `https://github.com/BilalGates/filigranas-ide/releases/download/v${info.version}/${path.basename(artifact)}` };
}
if (Object.keys(platforms).length !== 3) throw Error('Incomplete release');
fs.writeFileSync('latest.json', JSON.stringify({ version: info.version, notes: fs.readFileSync('release-notes.md', 'utf8'), pub_date: new Date().toISOString(), platforms }, null, 2));
