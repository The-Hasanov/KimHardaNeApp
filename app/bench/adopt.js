'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ai = require('../ai');
const { Store, embeddable } = require('../store');

const model = process.argv[2];
const DB = process.env.QUIZ_DB || path.join(__dirname, '..', '..', 'data', '3sual.sqlite');
const base = path.join(__dirname, 'cache', model.replace(/[^\w.-]+/g, '_'));
const meta = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
const store = new Store(DB);
const uids = crypto.createHash('sha1').update(store.rows.map(r => r.uid).join('\n')).digest('hex');
if (meta.uids !== uids || (meta.kind ?? 'ta') !== 'ta') throw new Error('cache does not match this database / passage kind');
store.loadVectors(model, ai.MODELS[model].dim);
const buf = fs.readFileSync(`${base}.f32`);
const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const idx = store.rows.map((r, i) => i).filter(i => embeddable(store.rows[i]));
for (let k = 0; k < idx.length; k += 5000) {
  const part = idx.slice(k, k + 5000);
  store.putVectors(part.map(i => store.rows[i]), part.map(i => vecs.subarray(i * meta.dim, (i + 1) * meta.dim)));
}
console.log(`${model}: ${store.vectorCount}/${store.rows.length} vectors in the database`);
