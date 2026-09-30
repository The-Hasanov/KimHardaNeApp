'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { OWN_SOURCE_ID, MEDIA_TYPES, fold } = require('./store');
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
const LIMITS = {
  archiveBytes: 2 * 1024 * 1024 * 1024, manifestBytes: 32 * 1024 * 1024, mediaBytes: 300 * 1024 * 1024,
  questions: 5000, fieldLength: 20000, sources: 50, sourceLength: 2000, urlLength: 2000, listNameLength: 80,
};
const WEB_LINK = /^https?:\/\/[^\s]+$/i;

const textOf = (value, maxLength = LIMITS.fieldLength) => (typeof value === 'string' ? value.slice(0, maxLength) : null);
const webLinkOf = value => (typeof value === 'string' && value.length <= LIMITS.urlLength && WEB_LINK.test(value) ? value : null);

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
    const isOwn = question.source_id === OWN_SOURCE_ID;
    const entry = {
      ...(!isOwn && { uid: question.uid, sourceId: question.source_id, packageName: question.package_name, tournamentName: question.tournament_name }),
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

const notOurs = () => new Error('This is not a KimHardaNeApp questions file');

function parseManifest(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw notOurs();
  }
  if (data?.format !== FORMAT || !Array.isArray(data.questions)) throw notOurs();
  if (!(Number(data.version) <= VERSION)) throw new Error('This file comes from a newer KimHardaNeApp. Update the app to import it.');
  if (data.questions.length > LIMITS.questions) throw new Error(`A file can hold at most ${LIMITS.questions} questions`);
  const listName = typeof data.list?.name === 'string' ? data.list.name.replace(/\s+/g, ' ').trim().slice(0, LIMITS.listNameLength) : null;
  return { questions: data.questions.filter(question => question && typeof question === 'object' && !Array.isArray(question)), list: listName ? { name: listName } : null };
}

function mediaFrom(bytes, type) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.mediaBytes || !EXTENSION_OF_TYPE[type]) return null;
  return { bytes, type };
}

const linkMedia = entry => {
  const url = webLinkOf(entry?.url);
  return url ? { url } : null;
};

function legacyMedia(picture) {
  if (typeof picture?.data === 'string') return mediaFrom(Buffer.from(picture.data, 'base64'), picture.type);
  return linkMedia(picture);
}

function readArchive(buffer) {
  if (buffer.length > LIMITS.archiveBytes) throw new Error('This file is too large to import');
  if (isZip(buffer)) {
    const files = readZip(buffer, { maxEntryBytes: LIMITS.mediaBytes, maxTotalBytes: LIMITS.archiveBytes });
    const manifest = files.get(MANIFEST);
    if (!manifest || manifest.size > LIMITS.manifestBytes) throw notOurs();
    const data = parseManifest(manifest.read().toString('utf8'));
    const media = entry => {
      const file = typeof entry?.file === 'string' && files.get(entry.file);
      if (!file) return linkMedia(entry);
      return file.size <= LIMITS.mediaBytes && EXTENSION_OF_TYPE[entry.type] ? mediaFrom(file.read(), entry.type) : null;
    };
    return { data, mediaOf: (question, index) => media(question[MEDIA[index].name]) };
  }
  if (buffer.length > LIMITS.manifestBytes * 4) throw notOurs();
  const data = parseManifest(buffer.toString('utf8'));
  return { data, mediaOf: (question, index) => legacyMedia(question[MEDIA[index].legacyName]) };
}

function readArchiveFile(file) {
  if (fs.statSync(file).size > LIMITS.archiveBytes) throw new Error('This file is too large to import');
  return readArchive(fs.readFileSync(file));
}

function ownQuestionsByKey(store) {
  return new Map(store.rows.filter(row => row.source_id === OWN_SOURCE_ID).map(row => [questionKey(row), row.uid]));
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
  const fields = Object.fromEntries(TEXT_FIELDS.map(field => [field, textOf(question[field])]));
  const sources = Array.isArray(question.sources) ? question.sources : [];
  fields.sources = sources.slice(0, LIMITS.sources).map(source => textOf(source, LIMITS.sourceLength)).filter(Boolean).map(source => source.replace(/\s+/g, ' ')).join('\n');
  const { uid } = store.createQuestion(fields);
  addMedia(store, uid, question, mediaOf);
  return uid;
}

const isImportable = question => typeof question.text === 'string' && typeof question.answer === 'string' && sameText(question.text) && sameText(question.answer);

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
    const datasetQuestion = question.origin === 'dataset' && typeof question.uid === 'string' ? store.get(question.uid) : null;
    if (datasetQuestion && datasetQuestion.source_id !== OWN_SOURCE_ID) {
      summary.fromDataset += 1;
      if (useDataset) uids.push(datasetQuestion.uid);
      continue;
    }
    const existing = ownByKey.get(questionKey({ text: textOf(question.text), answer: textOf(question.answer) }));
    if (existing) {
      summary.alreadyYours += 1;
      uids.push(existing);
      continue;
    }
    const uid = createOwnQuestion(store, question, mediaOf);
    ownByKey.set(questionKey({ text: textOf(question.text), answer: textOf(question.answer) }), uid);
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
  const base = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.listNameLength) || 'Imported list';
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`.toLowerCase())) return `${base} (${n})`;
}

function importList(store, archive, { fileName = null } = {}) {
  const { uids, createdUids, summary } = resolveQuestions(store, archive, { useDataset: true });
  const listId = store.createList(freeListName(store, archive.data.list?.name ?? fileName));
  for (const uid of [...new Set(uids)]) store.addToList(listId, uid);
  return { listId, createdUids, summary: { ...summary, total: new Set(uids).size } };
}

module.exports = { FORMAT, MANIFEST, LIMITS, exportArchive, readArchive, readArchiveFile, importOwnQuestions, importList };
