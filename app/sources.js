'use strict';
const fs = require('node:fs');
const path = require('node:path');
const scraper = require('./scraper');
const { OWN_PACKAGE_ID, OWN_IMAGE_PREFIX } = require('./store');

const THREE_SUAL_TABLES = ['runs', 'list_pages', 'list_sightings', 'package_list', 'packages', 'tournaments', 'phases', 'themes', 'authors', 'errors'];
const SITE_QUESTIONS = `package_id <> ${OWN_PACKAGE_ID}`;

const threeSual = {
  id: '3sual',
  name: '3sual.az',
  website: 'https://3sual.az',
  description: 'Azerbaijani quiz questions with their handouts: Nə? Harada? Nə zaman?, Brain-ring, Xəmsə, Fərdi oyun and more.',
  installTime: 'about an hour',
  refreshModes: ['quick', 'full'],

  status(db, roots) {
    const one = sql => db.prepare(sql).get();
    const lastRun = one('SELECT status, started_at FROM runs ORDER BY id DESC LIMIT 1');
    const hasFinished = !!one("SELECT 1 AS x FROM runs WHERE status = 'finished' LIMIT 1");
    const questions = one(`SELECT COUNT(*) AS n FROM questions WHERE ${SITE_QUESTIONS}`).n;
    const edited = one(`SELECT COUNT(*) AS n FROM questions WHERE ${SITE_QUESTIONS} AND edited_at IS NOT NULL`).n;
    const referenced = db.prepare(`SELECT DISTINCT url FROM (SELECT rekvizit_url AS url FROM questions WHERE ${SITE_QUESTIONS}
      UNION SELECT source_media_url FROM questions WHERE ${SITE_QUESTIONS}) WHERE url IS NOT NULL`).all().length;
    const saved = db.prepare(`SELECT i.path FROM images i WHERE i.status = 'ok' AND i.url IN (SELECT rekvizit_url FROM questions WHERE ${SITE_QUESTIONS}
      UNION SELECT source_media_url FROM questions WHERE ${SITE_QUESTIONS})`).all()
      .filter(({ path: rel }) => roots.some(root => fs.existsSync(path.join(root, rel)))).length;
    const checkedAt = one(`SELECT MAX(d) AS d FROM (SELECT MAX(finished_at) AS d FROM runs WHERE status = 'finished'
      UNION ALL SELECT MAX(fetched_at) FROM packages WHERE status != 'failed')`).d;
    const state = hasFinished ? 'installed' : questions || lastRun ? 'unfinished' : 'available';
    return { state, questions, edited, pictures: { referenced, saved }, checkedAt };
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

  remove(db, roots) {
    const pictures = db.prepare(`SELECT path FROM images WHERE path IS NOT NULL AND url NOT LIKE '${OWN_IMAGE_PREFIX}%'`).all();
    db.exec('BEGIN');
    try {
      db.exec(`DELETE FROM embeddings WHERE uid IN (SELECT uid FROM questions WHERE ${SITE_QUESTIONS})`);
      db.exec(`DELETE FROM questions WHERE ${SITE_QUESTIONS}`);
      db.exec(`DELETE FROM images WHERE url NOT LIKE '${OWN_IMAGE_PREFIX}%'`);
      for (const table of THREE_SUAL_TABLES) db.exec(`DELETE FROM ${table}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const { path: rel } of pictures) fs.rmSync(path.join(roots[0], rel), { force: true });
    db.exec('VACUUM');
  },
};

const DATA_SOURCES = [threeSual];
const dataSourceById = id => {
  const source = DATA_SOURCES.find(candidate => candidate.id === id);
  if (!source) throw new Error(`Unknown data source ${id}`);
  return source;
};
const describe = (source, db, roots) => ({
  id: source.id, name: source.name, website: source.website, description: source.description,
  installTime: source.installTime, refreshModes: source.refreshModes, ...source.status(db, roots),
});

module.exports = { DATA_SOURCES, dataSourceById, describe };
