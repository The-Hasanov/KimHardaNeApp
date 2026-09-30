'use strict';
const updateUrl = process.env.UPDATE_URL;
if (updateUrl && !/^https:\/\//i.test(updateUrl)) throw new Error('UPDATE_URL must start with https:// so updates cannot be swapped on the way');
// A platform-level `files` list drops the exclusions below, so pick the other OS's onnxruntime binaries here.
const otherOs = process.argv.includes('--mac') ? 'win32' : 'darwin';

module.exports = {
  appId: 'az.kimhardaneapp',
  productName: 'KimHardaNeApp',
  directories: { output: 'dist' },
  files: [
    '**/*',
    '!{bench,bundle,dist,fixtures,models,ui}/**',
    '!{vite.config.mjs,components.json,jsconfig.json}',
    '!**/*.test.js',
    '!build-data.js',
    '!electron-builder.config.js',
    '!**/*.{map,d.ts,d.mts,d.cts}',
    '!node_modules/@huggingface/transformers/dist/!(transformers.node.mjs)',
    '!node_modules/onnxruntime-web/**',
    `!node_modules/onnxruntime-node/bin/napi-v6/{${otherOs},linux}/**`,
    '!node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/**',
  ],
  asarUnpack: ['node_modules/onnxruntime-node/**', 'node_modules/sharp/**', 'node_modules/@img/**'],
  electronLanguages: ['en-US'],
  compression: 'maximum',
  extraResources: [
    { from: 'bundle/3sual.sqlite', to: 'data/3sual.sqlite' },
    { from: 'bundle/images', to: 'data/images' },
  ],
  win: { icon: 'icon.png', target: [{ target: 'nsis', arch: ['x64'] }] },
  // ponytail: arm64 only (onnxruntime-node ships no darwin/x64 binary); no auto-update on Mac yet
  // Signs with the Developer ID certificate in the Keychain and notarizes with the notarytool profile in APPLE_KEYCHAIN_PROFILE.
  mac: { icon: 'icon.png', category: 'public.app-category.education', notarize: true, signIgnore: ['/Contents/Resources/data/'], target: [{ target: 'dmg', arch: ['arm64'] }] },
  nsis: { oneClick: true, perMachine: false },
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
};
