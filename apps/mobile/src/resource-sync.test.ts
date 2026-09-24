import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
// @ts-expect-error The build script is a native Node module.
import { syncResources } from '../scripts/sync-resources.mjs';

async function fixture(run: (root: URL, write: (name: string, text: string) => Promise<void>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'vela-resource-sync-'));
  const root = pathToFileURL(directory + '/');
  const write = async (name: string, text: string) => { const file = new URL(name, root); await mkdir(new URL('.', file), {recursive: true}); await writeFile(file, text); };
  try {
    for (const name of ['package.json', 'src-tauri/tauri.conf.json']) await write(name, '{"version":"0.2.2"}');
    await write('src-tauri/Cargo.toml', '[package]\nname = "fixture"\nversion = "0.2.2"\n\n[dependencies]\nother = "1"\n');
    await write('apps/mobile/package.json', '{"version":"0.1.0"}');
    await write('apps/mobile/plugins/remote/shared/bootstrap.py', 'VERSION = "0.1.108"\nprint(VERSION)\n');
    await write('apps/mobile/plugins/remote/shared/runtime.json', '{"version":"0.1.108","protocolVersion":1,"minimumPort":10000}');
    for (const name of ['discover.json', 'login.js', 'notifications.js', 'page-readiness.js']) await write('apps/mobile/plugins/remote/shared/' + name, 'fixture\n');
    await write('apps/mobile/ios/App/App/Info.plist', '<key>NSCameraUsageDescription</key><string>old</string>\n<key>NSLocalNetworkUsageDescription</key><string>old</string>\n');
    await write('apps/mobile/ios/App/App.xcodeproj/project.pbxproj', 'MARKETING_VERSION = 0.1.0;');
    await write('apps/mobile/android/app/build.gradle', 'versionName "0.1.0"');
    for (const locale of ['en','zh-CN','zh-TW','ja','ko','fr','de','es','pt-BR','ru','vi']) {
      await write('src/i18n/locales/' + locale + '.ts', 'export default {"mobile.native.cameraUsageDescription":"camera", "mobile.native.localNetworkUsageDescription":"network"}');
    }
    await run(root, write);
  } finally { await rm(directory, {recursive: true, force: true}); }
}
async function snapshot(root: URL, path = ''): Promise<Record<string, string>> {
  let files: Record<string, string> = {};
  for (const entry of await readdir(new URL(path || '.', root), {withFileTypes: true})) {
    const name = path + entry.name;
    if (entry.isDirectory()) files = {...files, ...await snapshot(root, name + '/')};
    else files[name] = (await readFile(new URL(name, root))).toString('base64');
  }
  return files;
}

test('resource synchronization is byte-idempotent and keeps server and mobile versions independent', async () => {
  await fixture(async root => {
    await syncResources(root);
    const first = await snapshot(root);
    const sourcePath = 'apps/mobile/plugins/remote/shared/bootstrap.py';
    const source = await readFile(new URL(sourcePath, root));
    const time = (await stat(new URL(sourcePath, root))).mtimeMs;
    assert.match(source.toString(), /^VERSION = "0.2.2"$/m);
    const runtime = JSON.parse(await readFile(new URL('apps/mobile/plugins/remote/shared/runtime.json', root), 'utf8'));
    assert.deepEqual(runtime, {version: '0.2.2', protocolVersion: 1, minimumPort: 10000});
    const code = await readFile(new URL('apps/mobile/plugins/remote/shared/bootstrap-code.txt', root), 'utf8');
    const encoded = code.match(/b64decode\('([^']+)'\)/)?.[1];
    assert.ok(encoded); assert.deepEqual(inflateSync(Buffer.from(encoded, 'base64')), source);
    for (const file of ['bootstrap.py', 'bootstrap-code.txt', 'runtime.json', 'native-text.json']) {
      assert.deepEqual(await readFile(new URL('apps/mobile/plugins/remote/ios/Sources/VelaRemotePlugin/Bootstrap/' + file, root)), await readFile(new URL('apps/mobile/plugins/remote/shared/' + file, root)));
    }
    assert.equal(await readFile(new URL('apps/mobile/android/app/build.gradle', root), 'utf8'), 'versionName "0.1.0"');
    await syncResources(root);
    assert.deepEqual(await snapshot(root), first);
    assert.equal((await stat(new URL(sourcePath, root))).mtimeMs, time);
  });
});

for (const [name, path, content] of [
  ['missing VERSION', 'apps/mobile/plugins/remote/shared/bootstrap.py', 'print("missing")\n'],
  ['duplicate VERSION', 'apps/mobile/plugins/remote/shared/bootstrap.py', 'VERSION = "0.1.0"\nVERSION = "0.1.1"\n'],
  ['root version mismatch', 'package.json', '{"version":"0.2.3"}'],
  ['Cargo version mismatch', 'src-tauri/Cargo.toml', '[package]\nversion = "0.2.3"\n'],
  ['invalid server version', 'src-tauri/tauri.conf.json', '{"version":"0.2.2-beta"}'],
  ['invalid mobile version', 'apps/mobile/package.json', '{"version":"1.2"}'],
] as const) test(`${name} fails before any resource is written`, async () => {
  await fixture(async (root, write) => {
    await write(path, content);
    const before = await snapshot(root);
    await assert.rejects(syncResources(root));
    assert.deepEqual(await snapshot(root), before);
  });
});
