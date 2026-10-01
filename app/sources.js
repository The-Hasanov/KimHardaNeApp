'use strict';
const fs = require('node:fs');
const path = require('node:path');
const scraper = require('./scraper');
const { OWN_IMAGE_PREFIX } = require('./store');

const threeSual = {
  id: scraper.SOURCE_ID,
  name: '3sual.az',
  kind: 'scraper',
  price: null,
  website: 'https://3sual.az',
  description: 'Azerbaijani quiz questions from several game formats, with their handouts.',
  installTime: 'about an hour',
  refreshModes: ['quick', 'full'],
  tables: ['runs', 'list_pages', 'list_sightings', 'package_list', 'packages', 'tournaments', 'phases', 'themes', 'authors', 'errors'],

  progress(db) {
    const hasRun = !!db.prepare('SELECT 1 AS x FROM runs LIMIT 1').get();
    const hasFinished = !!db.prepare("SELECT 1 AS x FROM runs WHERE status = 'finished' LIMIT 1").get();
    const checkedAt = db.prepare(`SELECT MAX(d) AS d FROM (SELECT MAX(finished_at) AS d FROM runs WHERE status = 'finished'
      UNION ALL SELECT MAX(fetched_at) FROM packages WHERE status != 'failed')`).get().d;
    return { hasStarted: hasRun, isComplete: hasFinished, checkedAt };
  },

  async download(db, { mode, signal, roots, progress }) {
    const lastRun = db.prepare('SELECT status, started_at FROM runs ORDER BY id DESC LIMIT 1').get();
    const resume = !!lastRun && lastRun.status !== 'finished' && Date.now() - Date.parse(lastRun.started_at) < 864e5;
    const client = new scraper.Client({ signal });
    let crawled = null, images = null, error = null;
    try {
      crawled = await scraper.crawl(db, { client, refresh: mode === 'full', newRun: !resume, audit: 'counts', progress });
      if (crawled.status === 'finished') images = await scraper.downloadImages(db, client, roots, { progress });
    } catch (e) {
      if (!(e instanceof scraper.Interrupted)) error = e.message;
    }
    return { error, complete: !!crawled?.report?.complete && !!images?.complete,
      images: images?.fetched_this_run ?? 0, failures: (crawled?.report?.errors ?? 0) + (images?.failed ?? 0) };
  },
};

const DATA_SOURCES = [threeSual];

function dataSourceById(id) {
  const source = DATA_SOURCES.find(candidate => candidate.id === id);
  if (!source) throw new Error(`Unknown data source ${id}`);
  return source;
}

const MEDIA_OF = sourceId => `SELECT rekvizit_url AS url FROM questions WHERE source_id = '${sourceId}' AND rekvizit_url IS NOT NULL
  UNION SELECT source_media_url FROM questions WHERE source_id = '${sourceId}' AND source_media_url IS NOT NULL`;

function questionStats(db, roots, sourceId) {
  const counts = db.prepare(`SELECT COUNT(*) AS questions, COUNT(edited_at) AS edited FROM questions WHERE source_id = ?`).get(sourceId);
  const referenced = db.prepare(`SELECT COUNT(*) AS n FROM (${MEDIA_OF(sourceId)})`).get().n;
  const saved = db.prepare(`SELECT path FROM images WHERE status = 'ok' AND url IN (${MEDIA_OF(sourceId)})`).all()
    .filter(({ path: rel }) => roots.some(root => fs.existsSync(path.join(root, rel)))).length;
  return { questions: counts.questions, edited: counts.edited, pictures: { referenced, saved } };
}

function describe(source, db, roots) {
  const stats = questionStats(db, roots, source.id);
  const { hasStarted, isComplete, checkedAt } = source.progress(db);
  const state = isComplete ? 'installed' : stats.questions || hasStarted ? 'unfinished' : 'available';
  const { progress, download, tables, ...info } = source;
  return { ...info, state, checkedAt, ...stats };
}

function removeDataSource(source, db, roots) {
  const unshared = `url IN (${MEDIA_OF(source.id)}) AND url NOT LIKE '${OWN_IMAGE_PREFIX}%'
    AND url NOT IN (SELECT rekvizit_url FROM questions WHERE source_id <> '${source.id}' AND rekvizit_url IS NOT NULL
      UNION SELECT source_media_url FROM questions WHERE source_id <> '${source.id}' AND source_media_url IS NOT NULL)`;
  const pictures = db.prepare(`SELECT path FROM images WHERE path IS NOT NULL AND ${unshared}`).all();
  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM images WHERE ${unshared}`);
    db.prepare('DELETE FROM embeddings WHERE uid IN (SELECT uid FROM questions WHERE source_id = ?)').run(source.id);
    db.prepare('DELETE FROM questions WHERE source_id = ?').run(source.id);
    for (const table of source.tables) db.exec(`DELETE FROM ${table}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const { path: rel } of pictures) fs.rmSync(path.join(roots[0], rel), { force: true });
  db.exec('VACUUM');
}

module.exports = { DATA_SOURCES, dataSourceById, describe, removeDataSource };
