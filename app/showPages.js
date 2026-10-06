'use strict';
const { whole } = require('./templates');

const MAX_BLOCKS = 12;
const MAX_TITLE_LENGTH = 80;
const MAX_TEXT_LENGTH = 2000;
const DEFAULT_SECONDS = 10;
const OWN_MEDIA = { image: /^own-image:[0-9a-f]{64}\.(png|jpe?g|gif|webp)$/, video: /^own-image:[0-9a-f]{64}\.(mp4|m4v|webm)$/ };

function normalizeBlock(block) {
  if (OWN_MEDIA[block?.type]) return OWN_MEDIA[block.type].test(block.image ?? '') ? { type: block.type, image: block.image, isFullscreen: !!block.isFullscreen, ...(block.type === 'video' && { isLooping: !!block.isLooping }) } : null;
  const text = String(block?.text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT_LENGTH);
  return text ? { type: 'text', text, isLarge: !!block.isLarge } : null;
}

function normalizeShowPage({ id = null, title, blocks, seconds, canPlayersSkip = true } = {}) {
  const cleanTitle = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  const cleanBlocks = (Array.isArray(blocks) ? blocks : []).map(normalizeBlock).filter(Boolean).slice(0, MAX_BLOCKS);
  if (!cleanTitle && !cleanBlocks.length) throw new Error('Give the show page a title, a text, a picture or a video');
  return { id: Number.isInteger(id) && id > 0 ? id : null, title: cleanTitle, blocks: cleanBlocks, seconds: whole(seconds, 3, 600, DEFAULT_SECONDS), canPlayersSkip: canPlayersSkip !== false };
}

module.exports = { normalizeShowPage };
