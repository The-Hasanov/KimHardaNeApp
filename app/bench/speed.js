'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const ai = require('../ai');
const { environment } = require('./environment');

const DB = process.env.QUIZ_DB || path.join(__dirname, '..', '..', 'data', 'kimhardane.sqlite');
const SAMPLE = 2048;
const BATCHES = [8, 16, 32, 64, 128];
const QUANTIZED_OPS = ['MatMulInteger', 'DynamicQuantizeLinear', 'QLinearMatMul'];
const TOKENIZER_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];
const DTYPE_FILE = { q8: 'model_quantized.onnx', fp16: 'model_fp16.onnx', fp32: 'model.onnx' };

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const megabytes = bytes => Math.round(bytes / 1048576);

function sampleTexts() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const passages = db.prepare(`SELECT text, answer FROM questions WHERE trim(coalesce(text, '') || coalesce(answer, '')) != ''
    ORDER BY (rowid * 2654435761) % 4294967296 LIMIT ${SAMPLE}`).all().map(r => `${r.text ?? ''}\n${r.answer ?? ''}`);
  const { targets } = JSON.parse(fs.readFileSync(path.join(__dirname, 'queries.json'), 'utf8'));
  const queries = targets.flatMap(t => [t.recall, t.paraphrase]);
  const answers = db.prepare(`SELECT answer FROM questions WHERE length(answer) BETWEEN 3 AND 40
    ORDER BY (rowid * 2654435761) % 4294967296 LIMIT 80`).all().map(r => r.answer);
  return { passages, queries: [...queries, ...answers] };
}

function quantizationOf(file) {
  const bytes = fs.readFileSync(file);
  const ops = Object.fromEntries(QUANTIZED_OPS.map(op => [op, bytes.indexOf(op) >= 0]));
  return { file: path.basename(file), megabytes: megabytes(bytes.length), int8: Object.values(ops).some(Boolean), ops };
}

async function measure(model, device, dtype) {
  const spec = ai.MODELS[model];
  const { passages, queries } = sampleTexts();
  const startedAt = performance.now();
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = path.join(__dirname, '..', 'models');
  env.remotePathTemplate = `{model}/resolve/${spec.revision}/`;
  const loadedFiles = new Set();
  const fe = await pipeline('feature-extraction', model, { dtype, device, progress_callback: p => p.file && loadedFiles.add(p.file) });
  const run = (texts, kind) => fe(texts.map(t => spec[kind] + t), { pooling: spec.pooling ?? 'mean', normalize: true });
  await run([queries[0]], 'query');
  const coldMs = performance.now() - startedAt;
  const rssAfterLoad = process.memoryUsage().rss;

  for (const q of queries.slice(0, 5)) await run([q], 'query');
  const latencies = [];
  for (const q of queries) {
    const t = performance.now();
    await run([q], 'query');
    latencies.push(performance.now() - t);
  }
  latencies.sort((a, b) => a - b);

  const throughput = async (texts, batch) => {
    const t = performance.now();
    for (let k = 0; k < texts.length; k += batch) await run(texts.slice(k, k + batch), 'passage');
    return Math.round(texts.length / ((performance.now() - t) / 1000));
  };
  const byLength = [...passages].sort((a, b) => a.length - b.length);
  const sorted = {};
  for (const batch of BATCHES) sorted[batch] = await throughput(byLength, batch);
  const unsorted32 = await throughput(passages, 32);

  const dir = path.join(env.cacheDir, ...model.split('/'));
  const downloaded = [...TOKENIZER_FILES, `onnx/${DTYPE_FILE[dtype]}`];
  return {
    model, device, dtype, coldMs: Math.round(coldMs),
    queryP50: +percentile(latencies, 0.5).toFixed(1), queryP95: +percentile(latencies, 0.95).toFixed(1), queries: latencies.length,
    sorted, unsorted32, passages: passages.length,
    rssAfterLoadMb: megabytes(rssAfterLoad), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    downloadMb: megabytes(downloaded.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0)),
    loadedFiles: [...loadedFiles], quantization: quantizationOf(path.join(dir, 'onnx', DTYPE_FILE[dtype])),
  };
}

function report(results, environmentLines) {
  const lines = [...environmentLines, `${SAMPLE} passages sampled from ${path.basename(DB)}, ${results[0]?.queries} single queries; rows/s sorted by length per batch size`, ''];
  lines.push(`${'model'.padEnd(30)} ${'device'.padEnd(10)} cold ms  q p50  q p95  ${BATCHES.map(b => `b${b}`.padStart(5)).join(' ')}  unsorted32  rss MB  peak MB  download MB  int8`);
  for (const r of results) {
    lines.push(`${r.model.padEnd(30)} ${`${r.device}/${r.dtype}`.padEnd(10)} ${String(r.coldMs).padStart(7)}  ${String(r.queryP50).padStart(5)}  ${String(r.queryP95).padStart(5)}  ${BATCHES.map(b => String(r.sorted[b]).padStart(5)).join(' ')}  ${String(r.unsorted32).padStart(10)}  ${String(r.rssAfterLoadMb).padStart(6)}  ${String(r.peakRssMb).padStart(7)}  ${String(r.downloadMb).padStart(11)}  ${r.quantization?.int8 ? 'yes' : 'no'}`);
  }
  lines.push('', ...results.map(r => `${r.model} ${r.device}/${r.dtype}: loaded ${r.loadedFiles.join(', ')}; ${JSON.stringify(r.quantization)}`));
  return lines.join('\n');
}

if (require.main === module) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === 'child') {
    measure(...rest).then(r => process.stdout.write(`\n${JSON.stringify(r)}\n`), e => { console.error(e); process.exit(1); });
  } else {
    (async () => {
      const [device = 'cpu', dtype = 'q8', ...models] = [first, ...rest].filter(Boolean);
      const measured = models.length ? models : Object.keys(ai.MODELS);
      const environmentLines = await environment(measured);
      const results = measured.map(model => {
        const out = execFileSync(process.execPath, [__filename, 'child', model, device, dtype], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] });
        const result = JSON.parse(out.trim().split('\n').at(-1));
        console.log(`${model}: done`);
        return result;
      });
      const text = report(results, environmentLines);
      console.log(text);
      fs.writeFileSync(path.join(__dirname, `speed-${device}-${dtype}.txt`), `${text}\n`);
    })();
  }
}

module.exports = { measure, report };
