'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const workerThreads = require('node:worker_threads');

const startedWorkers = [];
workerThreads.Worker = class extends workerThreads.Worker {
  constructor(...args) {
    super(...args);
    startedWorkers.push(this);
  }
};
const ai = require('./ai');

const SMALL_MODEL = 'Xenova/multilingual-e5-small';
const localModelDir = path.join(__dirname, 'models', ...SMALL_MODEL.split('/'));
const hasSmallModel = fs.existsSync(path.join(localModelDir, 'onnx', 'model_quantized.onnx'));

async function modelServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const [, file] = decodeURIComponent(req.url).match(/\/resolve\/[^/]+\/(.+)$/) ?? [];
    const local = file && path.join(localModelDir, file);
    if (!local || !fs.existsSync(local)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': fs.statSync(local).size });
    fs.createReadStream(local).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

function useEmptyModelsDir(remoteHost) {
  const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimhardane-models-'));
  ai.configure({ modelsDir, remoteHost });
  return modelsDir;
}

test('downloading a model reports its progress and an aborted start downloads nothing', { skip: !hasSmallModel && 'needs app/models/Xenova/multilingual-e5-small' }, async () => {
  const server = await modelServer();
  try {
    useEmptyModelsDir(server.url);
    const aborted = AbortSignal.abort();
    await assert.rejects(ai.load(SMALL_MODEL, { signal: aborted }), { name: 'AbortError' });
    assert.deepEqual(server.requests, []);
    const progress = [];
    await ai.load(SMALL_MODEL, { onDownload: ({ loaded, total }) => progress.push({ loaded, total }) });
    assert.ok(progress.length > 0);
    assert.ok(progress.at(-1).total > 100e6);
    assert.equal(progress.at(-1).loaded, progress.at(-1).total);
    assert.ok(server.requests.some(url => url.includes(`/resolve/${ai.MODELS[SMALL_MODEL].revision}/onnx/model_quantized.onnx`)));
  } finally {
    await ai.stop();
    server.close();
  }
});

test('turning the model off while it embeds lets the batch finish, then a new request starts a fresh worker', { skip: !hasSmallModel && 'needs app/models/Xenova/multilingual-e5-small' }, async () => {
  ai.configure({ modelsDir: path.join(__dirname, 'models'), remoteHost: null });
  const texts = Array.from({ length: 32 }, (_, i) => `Azərbaycanın paytaxtı Bakı şəhəridir ${i} `.repeat(8));
  const embedding = ai.embed(texts, 'passage', SMALL_MODEL);
  await new Promise(resolve => setTimeout(resolve, 50));
  await ai.stop();
  const outcome = await embedding.then(vectors => vectors.length, e => e.message);
  assert.ok(outcome === 32 || /turned off/.test(outcome), String(outcome));
  assert.equal(ai.isRunning(), false);
  const [vector] = await ai.embed(['Bakı'], 'query', SMALL_MODEL);
  assert.equal(vector.length, ai.MODELS[SMALL_MODEL].dim);
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-3);
  await ai.stop();
});

test('legacy vectors are adopted only for the pinned BGE-M3 preprocessing and model file', async () => {
  useEmptyModelsDir(null);
  assert.equal(ai.embeddingSpace(ai.MODEL).id, ai.LEGACY_VECTORS.spaceId);
  assert.equal(await ai.legacyModelFor(ai.embeddingSpace('Xenova/multilingual-e5-small')), null);
  assert.equal(await ai.legacyModelFor(ai.embeddingSpace(ai.MODEL)), null);
  const modelsDir = useEmptyModelsDir(null);
  const file = path.join(modelsDir, ...ai.MODEL.split('/'), ai.LEGACY_VECTORS.modelFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not the pinned model');
  assert.equal(await ai.legacyModelFor(ai.embeddingSpace(ai.MODEL)), null);
});

test('every model is pinned to a revision and states its pooling', () => {
  for (const [model, spec] of Object.entries(ai.MODELS)) {
    assert.match(spec.revision, /^[0-9a-f]{40}$/, model);
    assert.ok(['cls', 'mean'].includes(spec.pooling), model);
  }
  assert.notEqual(ai.embeddingSpace(ai.MODEL).id, ai.embeddingSpace('onnx-community/gte-multilingual-base').id);
});

test('a worker that dies fails its requests, tells the app, and the next request starts a new one', { skip: !hasSmallModel && 'needs app/models/Xenova/multilingual-e5-small' }, async () => {
  ai.configure({ modelsDir: path.join(__dirname, 'models'), remoteHost: null });
  const stops = [];
  ai.onUnexpectedStop(error => stops.push(error.message));
  await ai.embed(['Bakı'], 'query', SMALL_MODEL);
  const embedding = ai.embed(Array.from({ length: 64 }, (_, i) => `uzun mətn ${i} `.repeat(40)), 'passage', SMALL_MODEL);
  await startedWorkers.at(-1).terminate();
  await assert.rejects(embedding, /The AI model stopped/);
  assert.equal(stops.length, 1);
  assert.equal(ai.isRunning(), false);
  assert.equal((await ai.embed(['Gəncə'], 'query', SMALL_MODEL))[0].length, ai.MODELS[SMALL_MODEL].dim);
  await ai.stop();
  assert.equal(stops.length, 1);
});
