'use strict';
const updateUrl = process.env.UPDATE_URL;

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
    '!node_modules/onnxruntime-node/bin/napi-v6/{darwin,linux}/**',
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
  nsis: { oneClick: true, perMachine: false },
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
};
