import { deflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const nativeLocales = ['en','zh-CN','zh-TW','ja','ko','fr','de','es','pt-BR','ru','vi'];
const sharedNativeKeys = ['common.loading','common.retry','common.cancel'];
const privacyKeys = {
  NSCameraUsageDescription: 'mobile.native.cameraUsageDescription',
  NSLocalNetworkUsageDescription: 'mobile.native.localNetworkUsageDescription',
};
const iosLocale = locale => ({'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant'}[locale] ?? locale);
const strictVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export async function syncResources(root = new URL('../../../', import.meta.url)) {
  const read = async path => readFile(new URL(path, root), 'utf8');
  const mobile = 'apps/mobile/';
  const shared = mobile + 'plugins/remote/shared/';
  const target = mobile + 'plugins/remote/ios/Sources/VelaRemotePlugin/Bootstrap/';
  const {version: serverVersion} = JSON.parse(await read('src-tauri/tauri.conf.json'));
  const {version: rootVersion} = JSON.parse(await read('package.json'));
  const cargo = (await read('src-tauri/Cargo.toml')).match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
  const cargoVersions = [...cargo.matchAll(/^version\s*=\s*"([^"]+)"\s*$/gm)];
  if (!strictVersion.test(serverVersion) || rootVersion !== serverVersion || cargoVersions.length !== 1 || cargoVersions[0][1] !== serverVersion) {
    throw new Error('Server versions in tauri.conf.json, package.json and Cargo.toml must match and use x.y.z');
  }
  const {version} = JSON.parse(await read(mobile + 'package.json'));
  if (!strictVersion.test(version)) throw new Error('Mobile app version must use x.y.z');
  const originalBootstrap = await read(shared + 'bootstrap.py');
  const definitions = [...originalBootstrap.matchAll(/^VERSION\s*=.*$/gm)];
  if (definitions.length !== 1 || !/^VERSION\s*=\s*["']\d+\.\d+\.\d+["']\s*$/.test(definitions[0][0])) {
    throw new Error('bootstrap.py must contain exactly one top-level VERSION string');
  }
  const bootstrap = originalBootstrap.replace(definitions[0][0], `VERSION = "${serverVersion}"`);
  const runtime = JSON.parse(await read(shared + 'runtime.json'));
  runtime.version = serverVersion;
  const pending = new Map();
  pending.set(shared + 'bootstrap.py', bootstrap);
  pending.set(shared + 'runtime.json', JSON.stringify(runtime, null, 2) + '\n');
  pending.set(shared + 'bootstrap-code.txt', `import base64,zlib;exec(zlib.decompress(base64.b64decode('${deflateSync(Buffer.from(bootstrap)).toString('base64')}')))`);

  // Every string-valued mobile key travels to native plugins from the shared dictionaries.
  const nativeText = {};
  for (const locale of nativeLocales) {
    const {default: dictionary} = await import(new URL('src/i18n/locales/' + locale + '.ts', root).href);
    const keys = [...sharedNativeKeys, ...Object.keys(dictionary).filter(key => key.startsWith('mobile.') && typeof dictionary[key] === 'string')];
    nativeText[locale] = Object.fromEntries(keys.map(key => [key, dictionary[key]]));
    const strings = Object.entries(privacyKeys).map(([name, key]) => {
      const value = nativeText[locale][key];
      if (typeof value !== 'string' || !value) throw new Error(`Missing ${locale} ${key}`);
      return `${JSON.stringify(name)} = ${JSON.stringify(value)};`;
    });
    pending.set(mobile + `ios/App/App/${iosLocale(locale)}.lproj/InfoPlist.strings`, strings.join('\n') + '\n');
  }
  pending.set(shared + 'native-text.json', JSON.stringify(nativeText));
  let plist = await read(mobile + 'ios/App/App/Info.plist');
  for (const [name, key] of Object.entries(privacyKeys)) {
    const escaped = nativeText.en[key].replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const pattern = new RegExp(`(<key>${name}</key>\\s*<string>)[^<]*(</string>)`, 'g');
    if ([...plist.matchAll(pattern)].length !== 1) throw new Error(`Info.plist must declare ${name} exactly once`);
    plist = plist.replace(pattern, (_, start, end) => start + escaped + end);
  }
  pending.set(mobile + 'ios/App/App/Info.plist', plist);
  for (const file of ['bootstrap.py','bootstrap-code.txt','discover.json','runtime.json','login.js','notifications.js','page-readiness.js','native-text.json']) {
    pending.set(target + file, pending.get(shared + file) ?? await read(shared + file));
  }
  // The mobile package version stays independent of the remote server version.
  for (const [path, pattern, replacement] of [
    ['ios/App/App.xcodeproj/project.pbxproj', /MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`],
    ['android/app/build.gradle', /versionName "[^"]+"/g, `versionName "${version}"`],
  ]) pending.set(mobile + path, (await read(mobile + path)).replace(pattern, replacement));

  // Finish all validation and reads before creating or changing any generated resource.
  for (const [path, text] of pending) {
    const file = new URL(path, root);
    if (await readFile(file, 'utf8').catch(() => null) === text) continue;
    await mkdir(new URL('.', file), {recursive: true});
    await writeFile(file, text);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await syncResources();
