'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { OWN_PACKAGE_ID, MEDIA_TYPES, fold } = require('./store');
const { createZip, readZip, isZip } = require('./zip');

const FORMAT = 'kimhardaneapp-questions';
const VERSION = 2;
const MANIFEST = 'questions.json';
const TEXT_FIELDS = ['text', 'answer', 'accepted_answers', 'comment', 'note_before', 'rekvizit_text'];
const MEDIA = [
  { column: 'rekvizit_url', src: 'rekvizit_src', name: 'handoutMedia', legacyName: 'handoutPicture' },
  { column: 'source_media_url', src: 'source_media_src', name: 'answerMedia', legacyName: 'answerPicture' },
];
const EXTENSION_OF_TYPE = Object.fromEntries(Object.entries(MEDIA_TYPES).reverse().map(([extension, type]) => [type, extension]));
const ALREADY_COMPRESSED = /^(image\/(png|jpeg|gif|webp)|video\/|audio\/(mpeg|mp4|ogg))/;

const sameText = text => fold(String(text ?? '')).replace(/\s+/g, ' ').trim();
const questionKey = question => `${sameText(question.text)}\n${sameText(question.answer)}`;

function mediaFile(src) {
  if (!src?.startsWith('file:')) return null;
  const file = fileURLToPath(src);
  const extension = path.extname(file).toLowerCase();
  return MEDIA_TYPES[extension] && fs.existsSync(file) ? { file, extension, type: MEDIA_TYPES[extension] } : null;
}

function exportArchive(questions, { list = null } = {}) {
  const mediaEntries = new Map();
  const exported = questions.map(question => {
    const isOwn = question.package_id === OWN_PACKAGE_ID;
    const entry = {
      ...(!isOwn && { uid: question.uid, packageName: question.package_name, tournamentName: question.tournament_name }),
      origin: isOwn ? 'own' : 'dataset',
      ...Object.fromEntries(TEXT_FIELDS.map(field => [field, question[field] ?? null])),
      sources: question.sources ?? [],
    };
    for (const { src, name } of MEDIA) {
      const local = mediaFile(question[src]);
      if (local) {
        const bytes = fs.readFileSync(local.file);
        const archiveName = `media/${crypto.createHash('sha256').update(bytes).digest('hex')}${local.extension}`;
        mediaEntries.set(archiveName, { name: archiveName, data: bytes, compress: !ALREADY_COMPRESSED.test(local.type) });
        entry[name] = { file: archiveName, type: local.type };
      } else if (question[src]) {
        entry[name] = { url: question[src] };
      }
    }
    return entry;
  });
  const manifest = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), ...(list && { list: { name: list.name } }), questions: exported };
  const archive = createZip([{ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...mediaEntries.values()]);
  return { archive, count: exported.length, mediaCount: mediaEntries.size };
}

function checkManifest(data) {
  if (data?.format !== FORMAT || !Array.isArray(data.questions)) throw new Error('This is not a KimHardaNeApp questions file');
  if (data.version > VERSION) throw new Error('This file comes from a newer KimHardaNeApp. Update the app to import it.');
  return data;
}

function legacyMedia(picture) {
  if (picture?.data) return { bytes: Buffer.from(picture.data, 'base64'), type: picture.type };
  return picture?.url ? { url: picture.url } : null;
}

function readArchive(buffer) {
  if (isZip(buffer)) {
    const files = readZip(buffer);
    if (!files.has(MANIFEST)) throw new Error('This is not a KimHardaNeApp questions file');
    const data = checkManifest(JSON.parse(files.get(MANIFEST).toString('utf8')));
    const media = entry => (entry?.file && files.has(entry.file) ? { bytes: files.get(entry.file), type: entry.type } : entry?.url ? { url: entry.url } : null);
    return { data, mediaOf: (question, index) => media(question[MEDIA[index].name]) };
  }
  let data;
  try {
    data = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('This is not a KimHardaNeApp questions file');
  }
  checkManifest(data);
  return { data, mediaOf: (question, index) => legacyMedia(question[MEDIA[index].legacyName]) };
}

function ownQuestionsByKey(store) {
  return new Map(store.rows.filter(row => row.package_id === OWN_PACKAGE_ID).map(row => [questionKey(row), row.uid]));
}

function addMedia(store, uid, question, mediaOf) {
  MEDIA.forEach(({ column }, index) => {
    const media = mediaOf(question, index);
    const extension = EXTENSION_OF_TYPE[media?.type];
    try {
      if (media?.bytes && extension) store.setOwnImageBytes(uid, column, { bytes: media.bytes, extension });
      else if (media?.url) store.setOwnImageBytes(uid, column, { remoteUrl: media.url });
    } catch {}
  });
}

function createOwnQuestion(store, question, mediaOf) {
  const fields = Object.fromEntries(TEXT_FIELDS.map(field => [field, question[field] ?? null]));
  fields.sources = (Array.isArray(question.sources) ? question.sources : []).join('\n');
  const { uid } = store.createQuestion(fields);
  addMedia(store, uid, question, mediaOf);
  return uid;
}

const isImportable = question => sameText(question?.text) && sameText(question?.answer);

function resolveQuestions(store, { data, mediaOf }, { useDataset }) {
  const ownByKey = ownQuestionsByKey(store);
  const summary = { fromDataset: 0, alreadyYours: 0, added: 0, invalid: 0 };
  const uids = [];
  const createdUids = [];
  for (const question of data.questions) {
    if (!isImportable(question)) {
      summary.invalid += 1;
      continue;
    }
    const datasetQuestion = question.origin === 'dataset' && question.uid ? store.get(question.uid) : null;
    if (datasetQuestion && datasetQuestion.package_id !== OWN_PACKAGE_ID) {
      summary.fromDataset += 1;
      if (useDataset) uids.push(datasetQuestion.uid);
      continue;
    }
    const existing = ownByKey.get(questionKey(question));
    if (existing) {
      summary.alreadyYours += 1;
      uids.push(existing);
      continue;
    }
    const uid = createOwnQuestion(store, question, mediaOf);
    ownByKey.set(questionKey(question), uid);
    summary.added += 1;
    uids.push(uid);
    createdUids.push(uid);
  }
  return { uids, createdUids, summary };
}

function importOwnQuestions(store, archive) {
  const { createdUids, summary } = resolveQuestions(store, archive, { useDataset: false });
  return { createdUids, summary };
}

function freeListName(store, name) {
  const taken = new Set(store.allLists().map(list => list.name.toLowerCase()));
  const base = String(name ?? '').trim() || 'Imported list';
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`.toLowerCase())) return `${base} (${n})`;
}

function importList(store, archive, { fileName = null } = {}) {
  const { uids, createdUids, summary } = resolveQuestions(store, archive, { useDataset: true });
  const listId = store.createList(freeListName(store, archive.data.list?.name ?? fileName));
  for (const uid of [...new Set(uids)]) store.addToList(listId, uid);
  return { listId, createdUids, summary: { ...summary, total: new Set(uids).size } };
}

module.exports = { FORMAT, MANIFEST, exportArchive, readArchive, importOwnQuestions, importList };
