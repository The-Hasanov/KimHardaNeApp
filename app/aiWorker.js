'use strict';
const { parentPort } = require('node:worker_threads');
const { topMatches } = require('./store');

const pipes = new Map();

function load({ model, spec, dtype, modelsDir, remoteHost }) {
  if (!pipes.has(model)) {
    const loading = import('@huggingface/transformers').then(({ pipeline, env }) => {
      env.cacheDir = modelsDir;
      if (remoteHost) env.remoteHost = remoteHost;
      env.remotePathTemplate = `{model}/resolve/${spec.revision}/`;
      const reportTotal = progress => progress.status === 'progress_total' && parentPort.postMessage({ download: { ...progress, model } });
      return pipeline('feature-extraction', model, { dtype, progress_callback: reportTotal });
    });
    loading.catch(() => pipes.get(model) === loading && pipes.delete(model));
    pipes.set(model, loading);
  }
  return pipes.get(model);
}

async function embed({ texts, kind, ...options }) {
  const extract = await load(options);
  const out = await extract(texts.map(text => options.spec[kind] + text), { pooling: options.spec.pooling, normalize: true });
  return { data: out.data, dim: out.dims[1] };
}

async function unload() {
  const loading = [...pipes.values()];
  pipes.clear();
  await Promise.all(loading.map(pipe => pipe.then(extract => extract.dispose(), () => {})));
}

const HANDLERS = {
  load: async options => { await load(options); },
  embed,
  nearest: ({ vecs, has, dim, qvec, allowed, limit }) => topMatches(vecs, has, dim, qvec, allowed, limit),
  unload,
};

let queue = Promise.resolve();
parentPort.on('message', ({ id, type, ...args }) => {
  queue = queue.then(() => HANDLERS[type](args))
    .then(result => parentPort.postMessage({ id, result }), e => parentPort.postMessage({ id, error: e.message }));
});
