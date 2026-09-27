'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Store, passage } = require('./store');

const MODELS = {
  'Xenova/multilingual-e5-small': { dim: 384, query: 'query: ', passage: 'passage: ' },
  'Xenova/multilingual-e5-base': { dim: 768, query: 'query: ', passage: 'passage: ' },
  'Xenova/bge-m3': { dim: 1024, query: '', passage: '', pooling: 'cls' },
};
const MODEL = 'Xenova/bge-m3';
const BATCH = 32;
const DEFAULT_DB = process.env.QUIZ_DB || path.join(__dirname, '..', 'data', '3sual.sqlite');

const pipes = new Map();
const where = { modelsDir: path.join(__dirname, 'models') };
const configure = opts => Object.assign(where, opts);

const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const modelDir = (model = MODEL) => path.join(where.modelsDir, ...model.split('/'));
const isDownloaded = (model = MODEL) => MODEL_FILES.every(file => fs.existsSync(path.join(modelDir(model), file)));
const deleteModel = (model = MODEL) => fs.rmSync(modelDir(model), { recursive: true, force: true });

function load(model = MODEL, { signal, onDownload } = {}) {
  if (!pipes.has(model)) {
    const loading = import('@huggingface/transformers').then(({ pipeline, env }) => {
      env.cacheDir = where.modelsDir;
      env.fetch = (url, init) => fetch(url, { ...init, signal });
      const reportTotal = progress => progress.status === 'progress_total' && onDownload?.(progress);
      return pipeline('feature-extraction', model, { dtype: 'q8', progress_callback: reportTotal });
    });
    loading.catch(() => pipes.get(model) === loading && pipes.delete(model));
    pipes.set(model, loading);
  }
  return pipes.get(model);
}

async function unload(model = MODEL) {
  const loading = pipes.get(model);
  pipes.delete(model);
  await loading?.then(pipe => pipe.dispose(), () => {});
}

async function embed(texts, kind, model = MODEL) {
  const spec = MODELS[model];
  const fe = await load(model);
  const out = await fe(texts.map(t => spec[kind] + t), { pooling: spec.pooling ?? 'mean', normalize: true });
  const [n, dim] = out.dims;
  return Array.from({ length: n }, (_, k) => out.data.slice(k * dim, (k + 1) * dim));
}

const embedQuery = async (q, model = MODEL) => (await embed([q], 'query', model))[0];

async function embedRows(store, rows, onBatch = () => {}) {
  for (let k = 0; k < rows.length; k += BATCH) {
    const batch = rows.slice(k, k + BATCH);
    store.putVectors(batch, await embed(batch.map(passage), 'passage'));
    onBatch(Math.min(k + BATCH, rows.length), rows.length);
  }
}

module.exports = { MODEL, MODELS, BATCH, configure, isDownloaded, deleteModel, load, unload, embed, embedQuery, embedRows };

if (require.main === module) {
  (async () => {
    const store = new Store(process.argv[2] || DEFAULT_DB);
    store.loadVectors(MODEL, MODELS[MODEL].dim);
    const todo = store.staleRows();
    console.log(`${store.vectorCount} vectors current, ${todo.length} to embed with ${MODEL}`);
    const t0 = Date.now();
    await embedRows(store, todo, (done, total) => {
      if (done % 3200 === 0 || done === total) {
        const s = (Date.now() - t0) / 1000;
        console.log(`${done}/${total}  ${Math.round(done / s)}/s  eta ${Math.round((total - done) / (done / s))}s`);
      }
    });
    console.log(`done: ${store.vectorCount}/${store.rows.length} vectors`);
  })().catch(e => { console.error(e); process.exit(1); });
}
