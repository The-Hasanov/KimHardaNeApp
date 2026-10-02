'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { Store, passage } = require('./store');

const MODELS = {
  'Xenova/multilingual-e5-small': { dim: 384, query: 'query: ', passage: 'passage: ', pooling: 'mean', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78' },
  'Xenova/multilingual-e5-base': { dim: 768, query: 'query: ', passage: 'passage: ', pooling: 'mean', revision: '1ec9243030a27d1a115d5c340572074c125b58b2' },
  'Xenova/bge-m3': { dim: 1024, query: '', passage: '', pooling: 'cls', revision: '4de13258303883538bd53b696b452bf8099f0858' },
  'onnx-community/gte-multilingual-base': { dim: 768, query: '', passage: '', pooling: 'cls', revision: '2edbf5e672aab465f9ed4c154a8b61791c082c69' },
};
const MODEL = 'Xenova/bge-m3';
const DTYPE = 'q8';
const BATCH = 16;
const PASSAGE_FORMAT = 'text, newline, answer';
const LEGACY_VECTORS = {
  model: 'Xenova/bge-m3',
  spaceId: JSON.stringify({ model: 'Xenova/bge-m3', revision: '4de13258303883538bd53b696b452bf8099f0858', dtype: 'q8', dim: 1024, query: '', passage: '', pooling: 'cls', normalize: true, passageFormat: PASSAGE_FORMAT }),
  modelFile: 'onnx/model_quantized.onnx',
  modelSha256: '0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d',
};
const DEFAULT_DB = process.env.QUIZ_DB || path.join(__dirname, '..', 'data', 'kimhardane.sqlite');

const where = { modelsDir: path.join(__dirname, 'models'), remoteHost: null };
const configure = opts => Object.assign(where, opts);

const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const modelDir = (model = MODEL) => path.join(where.modelsDir, ...model.split('/'));
const isDownloaded = (model = MODEL) => MODEL_FILES.every(file => fs.existsSync(path.join(modelDir(model), file)));
const deleteModel = (model = MODEL) => fs.rmSync(modelDir(model), { recursive: true, force: true });
function modelBytes(model = MODEL) {
  const sizeOf = dir => fs.readdirSync(dir, { withFileTypes: true })
    .reduce((sum, entry) => sum + (entry.isDirectory() ? sizeOf(path.join(dir, entry.name)) : fs.statSync(path.join(dir, entry.name)).size), 0);
  return fs.existsSync(modelDir(model)) ? sizeOf(modelDir(model)) : 0;
}

function embeddingSpace(model = MODEL) {
  const { dim, query, passage: passagePrefix, pooling, revision } = MODELS[model];
  const id = JSON.stringify({ model, revision, dtype: DTYPE, dim, query, passage: passagePrefix, pooling, normalize: true, passageFormat: PASSAGE_FORMAT });
  return { model, dim, id };
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function legacyModelFor(space) {
  if (space.id !== LEGACY_VECTORS.spaceId) return null;
  const file = path.join(modelDir(space.model), LEGACY_VECTORS.modelFile);
  return fs.existsSync(file) && (await sha256Of(file)) === LEGACY_VECTORS.modelSha256 ? LEGACY_VECTORS.model : null;
}

let worker = null;
let nextRequestId = 0;
const pending = new Map();
const downloadListeners = new Set();
const unexpectedStopListeners = new Set();
const onUnexpectedStop = listener => unexpectedStopListeners.add(listener);

function failPending(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}

function startWorker() {
  const started = new Worker(path.join(__dirname, 'aiWorker.js'));
  started.on('message', ({ id, result, error, download }) => {
    if (download) return downloadListeners.forEach(listener => listener(download));
    const request = pending.get(id);
    pending.delete(id);
    if (!pending.size) started.unref();
    if (error) request?.reject(new Error(error));
    else request?.resolve(result);
  });
  const stoppedUnexpectedly = error => {
    if (worker !== started) return;
    worker = null;
    failPending(error);
    unexpectedStopListeners.forEach(listener => listener(error));
  };
  started.on('error', error => stoppedUnexpectedly(new Error(`The AI model stopped: ${error.message}`)));
  started.on('exit', code => stoppedUnexpectedly(new Error(`The AI model stopped (exit code ${code})`)));
  return started;
}

function request(type, args = {}) {
  worker ??= startWorker();
  const id = nextRequestId++;
  worker.ref();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...args });
  });
}

const modelOptions = model => ({ model, spec: MODELS[model], dtype: DTYPE, modelsDir: where.modelsDir, remoteHost: where.remoteHost });

async function load(model = MODEL, { signal, onDownload } = {}) {
  signal?.throwIfAborted();
  const listener = download => download.model === model && onDownload?.(download);
  downloadListeners.add(listener);
  const stopOnAbort = () => stop();
  signal?.addEventListener('abort', stopOnAbort);
  try {
    await request('load', modelOptions(model));
    signal?.throwIfAborted();
  } finally {
    downloadListeners.delete(listener);
    signal?.removeEventListener('abort', stopOnAbort);
  }
}

async function stop() {
  const stopping = worker;
  if (!stopping) return;
  await Promise.race([request('unload'), new Promise(resolve => setTimeout(resolve, 2000))]).catch(() => {});
  if (worker === stopping) worker = null;
  failPending(new Error('AI search was turned off'));
  await stopping.terminate();
}

const isRunning = () => !!worker;

let urgentWork = 0;
const waitingForUrgentWork = new Set();
async function beforeIndexing(work) {
  urgentWork++;
  try {
    return await work();
  } finally {
    if (!--urgentWork) {
      waitingForUrgentWork.forEach(resume => resume());
      waitingForUrgentWork.clear();
    }
  }
}
const urgentWorkDone = () => (urgentWork ? new Promise(resume => waitingForUrgentWork.add(resume)) : null);

async function embed(texts, kind, model = MODEL) {
  const { data, dim } = await request('embed', { texts, kind, ...modelOptions(model) });
  return Array.from({ length: texts.length }, (_, k) => data.slice(k * dim, (k + 1) * dim));
}

const embedQuery = async (q, model = MODEL) => (await embed([q], 'query', model))[0];

const nearest = (store, qvec, allowed, limit) =>
  request('nearest', { vecs: store.vecs, has: store.has, dim: store.dim, qvec, allowed, limit });

async function embedRows(store, rows, onBatch = () => {}, batchSize = BATCH) {
  const byLength = [...rows].sort((a, b) => passage(a).length - passage(b).length);
  for (let k = 0; k < byLength.length; k += batchSize) {
    const batch = byLength.slice(k, k + batchSize);
    await urgentWorkDone();
    store.putVectors(batch, await embed(batch.map(passage), 'passage'));
    onBatch(Math.min(k + batchSize, byLength.length), byLength.length);
  }
}

module.exports = {
  MODEL, MODELS, DTYPE, BATCH, LEGACY_VECTORS, configure, embeddingSpace, legacyModelFor, isDownloaded, deleteModel, modelBytes,
  load, stop, isRunning, onUnexpectedStop, beforeIndexing, embed, embedQuery, nearest, embedRows,
};

if (require.main === module) {
  (async () => {
    const store = new Store(process.argv[2] || DEFAULT_DB);
    store.loadVectors(embeddingSpace());
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
    await stop();
  })().catch(e => { console.error(e); process.exit(1); });
}
