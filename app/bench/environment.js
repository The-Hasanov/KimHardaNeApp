'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ai = require('../ai');

const versionOf = pkg => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')).version;
const fileSha1 = file => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

async function busyCpuPercent() {
  const totals = () => os.cpus().reduce((sum, cpu) => {
    const all = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return { all: sum.all + all, idle: sum.idle + cpu.times.idle };
  }, { all: 0, idle: 0 });
  const before = totals();
  await new Promise(resolve => setTimeout(resolve, 1000));
  const after = totals();
  return Math.round(100 * (1 - (after.idle - before.idle) / (after.all - before.all)));
}

async function environment(models) {
  const cpus = os.cpus();
  return [
    `machine: ${cpus[0].model.trim()}, ${cpus.length} logical CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM; ${os.version()} ${os.release()} ${os.arch()}; CPU busy before the run: ${await busyCpuPercent()}%`,
    `runtime: Node ${process.versions.node}, onnxruntime-node ${versionOf('onnxruntime-node')}, @huggingface/transformers ${versionOf('@huggingface/transformers')}, execution provider cpu, precision ${ai.DTYPE}`,
    ...models.map(model => {
      const { revision, pooling, query, passage } = ai.MODELS[model];
      return `model: ${model} @ ${revision}, ${pooling} pooling, normalized, prefixes query "${query}" passage "${passage}"`;
    }),
  ];
}

module.exports = { environment, fileSha1 };
