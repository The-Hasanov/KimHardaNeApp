'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { Store, OWN_PACKAGE_ID, OWN_IMAGE_PREFIX } = require('./store');

const src = process.env.QUIZ_DB || path.join(__dirname, '..', 'data', '3sual.sqlite');
const bundle = path.join(__dirname, 'bundle');
const out = path.join(bundle, '3sual.sqlite');

function displayChunks(png) {
  if (png.toString('latin1', 1, 4) !== 'PNG') return true;
  for (let i = 8; i + 12 <= png.length; i += png.readUInt32BE(i) + 12) {
    const type = png.toString('latin1', i + 4, i + 8);
    if (['iCCP', 'cHRM', 'acTL', 'eXIf'].includes(type) || (type === 'gAMA' && png.readUInt32BE(i + 8) !== 45455)) return true;
  }
  return false;
}

async function losslessWebp(png) {
  if (displayChunks(png) || (await sharp(png).metadata()).depth !== 'uchar') return null;
  const webp = await sharp(png).webp({ lossless: true, effort: 6 }).toBuffer();
  const pixels = b => sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [a, b] = await Promise.all([pixels(png), pixels(webp)]);
  const same = a.info.width === b.info.width && a.info.height === b.info.height && a.data.equals(b.data);
  return same && webp.length < png.length ? webp : null;
}

async function bundleImages(dbFile) {
  const db = new DatabaseSync(dbFile);
  const rows = db.prepare("SELECT url, path FROM images WHERE status = 'ok'").all();
  const update = db.prepare("UPDATE images SET path = ?, bytes = ?, content_type = 'image/webp', sha256 = ? WHERE url = ?");
  let before = 0, after = 0;
  db.exec('BEGIN');
  for (const { url, path: rel } of rows) {
    const orig = fs.readFileSync(path.join(path.dirname(src), rel));
    const webpRel = rel.replace(/\.png$/i, '.webp');
    let shipped = [webpRel, rel].find(p => fs.existsSync(path.join(bundle, p)));
    if (!shipped) {
      const webp = webpRel !== rel && await losslessWebp(orig);
      shipped = webp ? webpRel : rel;
      fs.mkdirSync(path.dirname(path.join(bundle, shipped)), { recursive: true });
      fs.writeFileSync(path.join(bundle, shipped), webp || orig);
    }
    const body = fs.readFileSync(path.join(bundle, shipped));
    if (shipped !== rel) update.run(shipped, body.length, crypto.createHash('sha256').update(body).digest('hex'), url);
    before += orig.length;
    after += body.length;
  }
  db.exec('COMMIT');
  db.close();
  console.log(`bundle/images: ${rows.length} images, ${(before / 1e6).toFixed(0)} MB -> ${(after / 1e6).toFixed(0)} MB, pixels unchanged`);
}

async function main() {
  const store = new Store(src);
  const missing = store.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT rekvizit_url u FROM questions WHERE rekvizit_url IS NOT NULL
    UNION SELECT source_media_url FROM questions WHERE source_media_url IS NOT NULL) WHERE u NOT IN (SELECT url FROM images WHERE status = 'ok')`).get().n;
  if (missing) throw new Error(`${missing} images not downloaded: run "node scraper.js images --db ${src}" first`);
  store.db.close();

  fs.mkdirSync(bundle, { recursive: true });
  fs.rmSync(out, { force: true });
  const db = new DatabaseSync(src, { readOnly: true });
  db.prepare('VACUUM INTO ?').run(out);
  db.close();
  const shipped = new DatabaseSync(out);
  shipped.prepare('DELETE FROM questions WHERE package_id = ?').run(OWN_PACKAGE_ID);
  shipped.prepare('DELETE FROM images WHERE url LIKE ?').run(`${OWN_IMAGE_PREFIX}%`);
  shipped.exec('DROP TABLE IF EXISTS embeddings; DROP TABLE IF EXISTS list_questions; DROP TABLE IF EXISTS lists; DROP TABLE IF EXISTS play_answers; DROP TABLE IF EXISTS play_games; DROP TABLE IF EXISTS party_results; VACUUM;');
  shipped.close();
  await bundleImages(out);
  console.log(`bundle/3sual.sqlite: ${store.rows.length} questions, ${(fs.statSync(out).size / 1e6).toFixed(0)} MB`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
