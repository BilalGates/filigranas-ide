import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const scripts = resolve('scripts/release');
test('versionado de CI sincroniza manifiestos sin modificar main y distingue canales', () => {
  const dir = mkdtempSync(join(tmpdir(), 'filigranas-release-'));
  try {
    mkdirSync(join(dir, 'src-tauri'));
    writeFileSync(join(dir, 'package.json'), '{"version":"0.1.0"}');
    writeFileSync(join(dir, 'src-tauri/tauri.conf.json'), '{"version":"0.1.0","bundle":{}}');
    for (const file of ['Cargo.toml', 'Cargo.lock']) writeFileSync(join(dir, 'src-tauri', file), 'name = "filigranas"\nversion = "0.1.0"\n');
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: dir });
    for (const channel of ['development', 'stable']) {
      execFileSync(process.execPath, [join(scripts, 'prepare.mjs')], { cwd: dir, env: { ...process.env, CHANNEL: channel, GITHUB_RUN_NUMBER: '12', GITHUB_OUTPUT: '' } });
      const expected = channel === 'stable' ? '0.2.12' : '0.2.12-dev.0';
      assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, expected);
      assert.equal(JSON.parse(readFileSync(join(dir, 'src-tauri/tauri.conf.json'), 'utf8')).version, expected);
      assert.ok(readFileSync(join(dir, 'src-tauri/Cargo.lock'), 'utf8').includes(`version = "${expected}"`));
    }
    assert.throws(() => execFileSync(process.execPath, [join(scripts, 'prepare.mjs')], {
      cwd: dir, stdio: 'pipe', env: { ...process.env, CHANNEL: 'development', GITHUB_RUN_NUMBER: '13', GITHUB_OUTPUT: '', FILIGRANAS_UPDATER_PUBLIC_KEY: 'incorrect-key' },
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manifiesto rechaza una matriz incompleta y enlaza cada arquitectura a su paquete firmado', () => {
  const dir = mkdtempSync(join(tmpdir(), 'filigranas-manifest-'));
  try {
    writeFileSync(join(dir, 'release-info.json'), '{"version":"0.2.12","channel":"stable","sha":"fixture"}');
    writeFileSync(join(dir, 'release-notes.md'), 'Notas de prueba');
    mkdirSync(join(dir, 'assets'));
    assert.throws(() => execFileSync(process.execPath, [join(scripts, 'manifest.mjs'), 'assets'], { cwd: dir, stdio: 'pipe' }));
    for (const target of ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc']) {
      const base = join(dir, 'assets', target);
      mkdirSync(base);
      writeFileSync(join(base, target + '.tar.gz'), 'fixture');
      writeFileSync(join(base, target + '.tar.gz.sig'), 'fixture-signature');
    }
    execFileSync(process.execPath, [join(scripts, 'manifest.mjs'), 'assets'], { cwd: dir });
    const manifest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
    assert.equal(Object.keys(manifest.platforms).length, 3);
    assert.match(manifest.platforms['darwin-aarch64'].url, /releases\/download\/v0.2.12\/aarch64-apple-darwin/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
