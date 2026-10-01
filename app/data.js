'use strict';
const fs = require('node:fs');
const path = require('node:path');
const scraper = require('./scraper');

function prepareLibrary(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  scraper.connect(file).close();
  return file;
}

module.exports = { prepareLibrary };
