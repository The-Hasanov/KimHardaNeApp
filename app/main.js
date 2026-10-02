'use strict';
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Store, OWN_SOURCE_ID, POOL, semanticHitsOf } = require('./store');
const { prepareLibrary } = require('./data');
const { DATA_SOURCES, dataSourceById, describe, removeDataSource } = require('./sources');
const ai = require('./ai');
const { judgeAnswer } = require('./judge');
const { openParty } = require('./party');
const { PlayerProfiles } = require('./profiles');
const { CLASSIC_POINT_SYSTEM, normalizePointSystem, summaryOf } = require('./scoring');
const { normalizeTemplate } = require('./templates');
const { normalizeShowPage } = require('./showPages');
const transfer = require('./transfer');
const { findSamsungTvs, openInTvBrowser, isLocalNetworkAddress } = require('./samsungTv');

const USER_DATA_BEFORE_RENAME = path.join(app.getPath('appData'), '3sual Editor');
if (!app.commandLine.hasSwitch('user-data-dir') && fs.existsSync(USER_DATA_BEFORE_RENAME)) app.setPath('userData', USER_DATA_BEFORE_RENAME);
let store;
let imageRoots;
let dataSourceJob = null;
let aiStatus = { state: 'off' };
let aiJob = null;
let party = null;
let partyDisplay = null;

function openStore() {
  const file = prepareLibrary(app.isPackaged ? path.join(app.getPath('userData'), 'data', 'kimhardane.sqlite')
    : process.env.QUIZ_DB || path.join(__dirname, '..', 'data', 'kimhardane.sqlite'));
  if (app.isPackaged) ai.configure({ modelsDir: path.join(app.getPath('userData'), 'models') });
  else if (process.env.QUIZ_MODELS) ai.configure({ modelsDir: process.env.QUIZ_MODELS });
  imageRoots = [path.dirname(path.resolve(file))];
  return new Store(file, { imagesRoot: imageRoots });
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
const writeSettings = changes => fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...changes }));

const isAiReady = () => aiStatus.state === 'ready';
const AI_BUSY_STATES = ['downloading', 'loading', 'indexing', 'ready', 'stopping', 'removing'];
const VECTOR_BYTES = ai.MODELS[ai.MODEL].dim * 4;
const aiOffStatus = () => ({ state: 'off', storedBytes: ai.modelBytes() + store.storedVectorCount() * VECTOR_BYTES });

function setAiStatus(win, status) {
  aiStatus = status;
  win.webContents.send('ai', status);
}

async function prepareAi(win, signal) {
  const report = status => !signal.aborted && setAiStatus(win, status);
  try {
    const needsDownload = !ai.isDownloaded();
    if (needsDownload) ai.deleteModel();
    report(needsDownload ? { state: 'downloading', loaded: 0, total: 0 } : { state: 'loading' });
    await ai.load(ai.MODEL, { signal, onDownload: ({ loaded, total }) => needsDownload && report({ state: 'downloading', loaded, total }) });
    if (!store.vecs) await loadAiVectors();
    const stale = store.staleRows();
    const startedAt = Date.now();
    if (stale.length) report({ state: 'indexing', done: 0, total: stale.length });
    await ai.embedRows(store, stale, (done, total) => {
      signal.throwIfAborted();
      const secondsLeft = Math.round(((Date.now() - startedAt) / done) * (total - done) / 1000);
      report({ state: 'indexing', done, total, secondsLeft });
    });
    report({ state: 'ready', vectors: store.vectorCount });
  } catch (e) {
    report({ state: 'error', message: e.message });
  }
}

async function loadAiVectors() {
  const space = ai.embeddingSpace();
  store.loadVectors(space);
  if (!store.legacyVectorCount(ai.LEGACY_VECTORS.model)) return;
  const legacyModel = await ai.legacyModelFor(space);
  if (legacyModel) store.loadVectors({ ...space, legacyModel });
}

function turnOnAi(win) {
  if (AI_BUSY_STATES.includes(aiStatus.state)) return;
  const controller = new AbortController();
  aiJob = { controller, finished: prepareAi(win, controller.signal) };
}

async function stopAi() {
  aiJob?.controller.abort();
  await aiJob?.finished;
  aiJob = null;
  await ai.stop();
  store.unloadVectors();
}

async function turnOffAi(win) {
  if (['off', 'stopping', 'removing'].includes(aiStatus.state)) return;
  setAiStatus(win, { state: 'stopping' });
  await stopAi();
  setAiStatus(win, aiOffStatus());
}

async function removeAiFiles(win) {
  if (aiStatus.state !== 'off') throw new Error('Turn off AI search before removing its files');
  setAiStatus(win, { state: 'removing' });
  try {
    await ai.stop();
    ai.deleteModel();
    store.dropVectors();
  } finally {
    setAiStatus(win, aiOffStatus());
  }
}

function watchAiWorker(win) {
  ai.onUnexpectedStop(error => {
    if (!['loading', 'indexing', 'ready'].includes(aiStatus.state)) return;
    aiJob?.controller.abort();
    aiJob = null;
    setAiStatus(win, { state: 'error', message: error.message });
  });
}

async function searchWithAi(opts) {
  const qvec = await ai.embedQuery(opts.q);
  for (let attempt = 0; attempt < 3 && isAiReady(); attempt++) {
    const generation = store.generation;
    const found = await ai.nearest(store, qvec, store.allowedRows(opts), POOL);
    if (generation === store.generation && isAiReady()) return store.search(opts, qvec, semanticHitsOf(found));
  }
  return store.search(opts);
}

const APP_ICON = path.join(__dirname, 'icon.png');
const TV_WINDOW_SIZE = { width: 1280, height: 720 };

const centeredOn = display => ({
  x: Math.round(display.workArea.x + (display.workArea.width - TV_WINDOW_SIZE.width) / 2),
  y: Math.round(display.workArea.y + (display.workArea.height - TV_WINDOW_SIZE.height) / 2),
  ...TV_WINDOW_SIZE,
});

function openPartyDisplay(mainWindow, port) {
  if (partyDisplay && !partyDisplay.isDestroyed()) return partyDisplay.focus();
  const mainDisplayId = screen.getDisplayMatching(mainWindow.getBounds()).id;
  const television = screen.getAllDisplays().find(display => display.id !== mainDisplayId);
  partyDisplay = new BrowserWindow({
    title: 'KimHardaNeApp · TV screen', icon: APP_ICON, backgroundColor: '#0a0a0a',
    ...(television ? centeredOn(television) : TV_WINDOW_SIZE),
  });
  partyDisplay.removeMenu();
  partyDisplay.on('page-title-updated', e => e.preventDefault());
  partyDisplay.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') partyDisplay.setFullScreen(!partyDisplay.isFullScreen());
    else if (input.key === 'Escape') partyDisplay.setFullScreen(false);
  });
  partyDisplay.on('closed', () => { partyDisplay = null; });
  partyDisplay.loadURL(`http://127.0.0.1:${port}/tv`);
}

const closePartyDisplay = () => partyDisplay?.destroy();

function movePartyDisplayTo(display) {
  if (!partyDisplay || partyDisplay.isDestroyed()) return;
  partyDisplay.setFullScreen(false);
  partyDisplay.setBounds(centeredOn(display));
}

const extendDesktopToWirelessDisplay = () => new Promise((resolve, reject) => {
  const displaySwitch = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'DisplaySwitch.exe');
  execFile(displaySwitch, ['/extend'], error => (error ? reject(error) : resolve()));
});

function checkForUpdates(win) {
  if (!app.isPackaged) return;
  const send = (state, extra = {}) => win.webContents.send('update', { state, ...extra });
  autoUpdater.on('update-available', i => send('downloading', { version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', p => send('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => send('ready', { version: i.version }));
  autoUpdater.on('error', e => console.error('update:', e.message));
  autoUpdater.checkForUpdates().catch(() => {});
}

const dataSources = () => DATA_SOURCES.map(source => describe(source, store.db, imageRoots));
const sourceNameOf = id => (id === OWN_SOURCE_ID ? 'My questions' : DATA_SOURCES.find(source => source.id === id)?.name ?? id);
function questionSources() {
  const bySource = new Map();
  for (const { sourceId, key, name, n } of store.games()) {
    if (!bySource.has(sourceId)) bySource.set(sourceId, { id: sourceId, name: sourceNameOf(sourceId), games: [] });
    bySource.get(sourceId).games.push({ key, name, n });
  }
  return [...bySource.values()];
}

async function updateDataSource(win, source, mode, signal) {
  const progress = p => win.webContents.send('data-source-progress', { sourceId: source.id, ...p });
  const count = () => store.db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
  const before = count();
  const result = await source.download(store.db, { mode, signal, roots: imageRoots, progress });
  progress({ stage: 'index' });
  await new Promise(r => setTimeout(r, 50));
  store.reload();
  const stale = store.staleRows();
  if (stale.length && !signal.aborted && isAiReady()) {
    try {
      await ai.embedRows(store, stale, (done, total) => {
        progress({ stage: 'embed', done, total });
        if (signal.aborted || !isAiReady()) throw new Error('stopped');
      });
    } catch (e) {
      if (!signal.aborted && isAiReady()) result.error ??= e.message;
    }
  }
  return { ...result, cancelled: signal.aborted, newRows: count() - before };
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400, height: 900, title: `KimHardaNeApp ${app.getVersion()}`, icon: APP_ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.removeMenu();
  win.on('page-title-updated', e => e.preventDefault());
  win.on('close', closePartyDisplay);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile('renderer/index.html');

  const ready = new Promise(resolve => setTimeout(resolve, 100)).then(() => {
    store = openStore();
    store.buildIndex();
    aiStatus = aiOffStatus();
    watchAiWorker(win);
    if (readSettings().aiSearch) turnOnAi(win);
  });
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => { await ready; return fn(...args); });

  handle('info', () => ({ version: app.getVersion(), rows: store.rows.length, ownCount: store.rows.filter(row => row.source_id === OWN_SOURCE_ID).length, questionSources: questionSources() }));
  handle('ai-status', () => aiStatus);
  handle('set-ai-search', async isOn => {
    writeSettings({ aiSearch: isOn });
    await (isOn ? turnOnAi(win) : turnOffAi(win));
    return aiStatus;
  });
  handle('remove-ai-files', async () => {
    await removeAiFiles(win);
    return aiStatus;
  });
  handle('search', async opts => {
    if (!opts.q?.trim() || opts.mode === 'keyword' || !isAiReady()) return store.search(opts);
    return ai.beforeIndexing(() => searchWithAi(opts)).catch(() => store.search(opts));
  });
  handle('get', uid => store.get(uid));
  handle('game-questions', (games, count) => store.randomPlayableQuestions(games, count, party ? [...party.game.shownUids] : []));
  handle('lists', () => store.allLists());
  handle('create-list', name => store.createList(name));
  handle('rename-list', (listId, name) => store.renameList(listId, name));
  handle('delete-list', listId => store.deleteList(listId));
  handle('add-to-list', (listId, uid) => store.addToList(listId, uid));
  handle('remove-from-list', (listId, uid) => store.removeFromList(listId, uid));
  handle('reorder-list', (listId, uidsInOrder) => store.reorderList(listId, uidsInOrder));
  handle('list-questions', listId => store.listQuestions(listId));
  handle('list-ids-containing', uid => store.listIdsContaining(uid));
  const judgeNow = (question, given) => judgeAnswer(question, given, isAiReady() ? texts => ai.beforeIndexing(() => ai.embed(texts, 'query')) : null)
    .catch(() => judgeAnswer(question, given, null));
  handle('start-play-game', settings => store.startPlayGame(settings));
  handle('submit-play-answer', async (gameId, { position, uid, givenAnswer, secondsUsed }) => {
    const judged = await judgeNow(store.get(uid), givenAnswer);
    return store.savePlayAnswer(gameId, { position, uid, givenAnswer, secondsUsed, ...judged });
  });
  handle('set-play-answer-correct', (gameId, position, isCorrect) => store.setPlayAnswerCorrect(gameId, position, isCorrect));
  handle('finish-play-game', gameId => store.finishPlayGame(gameId));
  handle('delete-play-game', gameId => store.deletePlayGame(gameId));
  handle('play-games', () => store.playGames());
  handle('play-game-answers', gameId => store.playGameAnswers(gameId));
  const closeParty = async () => {
    closePartyDisplay();
    await party?.close();
    party = null;
  };
  const sendPartyState = state => win.webContents.send('party', state);
  const withParty = action => (...args) => {
    if (!party) throw new Error('No party is open');
    action(party.game, ...args);
    return party.game.hostView();
  };
  const playerProfiles = new PlayerProfiles({ get: key => store.partyProfile(key), save: profile => store.savePartyProfile(profile) });
  handle('party-open', async title => {
    await closeParty();
    party = await openParty({ judge: judgeNow, title, profiles: playerProfiles, onChange: sendPartyState, onReaction: reaction => win.webContents.send('party-reaction', reaction), onRoundFinished: results => {
      store.addPartyResults(results);
      win.webContents.send('party-results', store.partyResults());
    } });
    openPartyDisplay(win, party.game.port);
    return party.game.hostView();
  });
  handle('party-start-round', withParty((game, { uids, pointSystemId, showPageIds = [], showPageIdsAfter = [], ...rules }) => {
    const showPages = store.showPages();
    const pagesOf = ids => ids.map(id => showPages.find(page => page.id === id)).filter(Boolean);
    game.startRound({
      questions: uids.map(uid => store.get(uid)).filter(Boolean), ...rules, pointSystem: store.pointSystems().find(system => system.id === pointSystemId),
      showPages: pagesOf(showPageIds), showPagesAfter: pagesOf(showPageIdsAfter),
    });
  }));
  handle('party-skip-wait', withParty(game => game.skipWait()));
  handle('party-pause', withParty(game => game.pause()));
  handle('party-resume', withParty(game => game.resume()));
  handle('party-set-screen', withParty((game, screen) => game.setScreen(screen)));
  handle('party-close-answers', withParty(game => game.closeAnswers()));
  handle('party-next', withParty(game => game.next()));
  handle('party-finish-round', withParty(game => game.finish()));
  handle('party-adjust', withParty((game, playerId, position, points) => game.adjust(playerId, position, points)));
  handle('party-unban', withParty((game, playerId, position) => game.unban(playerId, position)));
  handle('party-set-correct', withParty((game, playerId, position, isCorrect) => game.setCorrect(playerId, position, isCorrect)));
  handle('party-kick', withParty((game, playerId) => game.kick(playerId)));
  handle('party-announce', withParty((game, text) => game.announce(text)));
  handle('party-set-reactions-on', withParty((game, areOn) => game.setReactionsOn(areOn)));
  handle('party-back-to-lobby', withParty((game, keepScores) => game.backToLobby({ keepScores })));
  handle('party-close', closeParty);
  handle('party-results', () => store.partyResults());
  handle('reset-party-results', () => {
    store.resetPartyResults();
    return store.partyResults();
  });
  const pointSystemsWithSummary = () => {
    if (!store.pointSystems().length) store.savePointSystem(normalizePointSystem(CLASSIC_POINT_SYSTEM));
    return store.pointSystems().map(system => ({ ...system, ...normalizePointSystem(system), summary: summaryOf(normalizePointSystem(system)), usedBy: store.templatesUsingPointSystem(system.id) }));
  };
  handle('point-systems', pointSystemsWithSummary);
  handle('new-point-system', () => ({ ...normalizePointSystem(CLASSIC_POINT_SYSTEM), name: '' }));
  handle('save-point-system', system => {
    const id = store.savePointSystem({ id: system.id ?? null, ...normalizePointSystem(system) });
    return { id, pointSystems: pointSystemsWithSummary() };
  });
  handle('delete-point-system', id => {
    if (store.pointSystems().length <= 1) throw new Error('Keep at least one point system');
    const usedBy = store.templatesUsingPointSystem(id);
    if (usedBy.length) throw new Error(`It is used by ${usedBy.length === 1 ? 'the template' : 'the templates'} ${usedBy.map(name => `“${name}”`).join(', ')}. Change those rounds first.`);
    store.deletePointSystem(id);
    return pointSystemsWithSummary();
  });
  handle('game-templates', () => store.gameTemplates());
  handle('save-game-template', template => {
    const id = store.saveGameTemplate(normalizeTemplate(template));
    return { id, templates: store.gameTemplates() };
  });
  handle('delete-game-template', id => {
    store.deleteGameTemplate(id);
    return store.gameTemplates();
  });
  const showPagesWithUse = () => store.showPages().map(page => ({ ...page, usedBy: store.templatesUsingShowPage(page.id) }));
  handle('show-pages', showPagesWithUse);
  handle('save-show-page', page => {
    const id = store.saveShowPage(normalizeShowPage(page));
    return { id, showPages: showPagesWithUse() };
  });
  handle('delete-show-page', id => {
    const usedBy = store.templatesUsingShowPage(id);
    if (usedBy.length) throw new Error(`It is used by ${usedBy.length === 1 ? 'the template' : 'the templates'} ${usedBy.map(name => `“${name}”`).join(', ')}. Change those rounds first.`);
    store.deleteShowPage(id);
    return showPagesWithUse();
  });
  handle('pick-show-page-image', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add a picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (canceled) return null;
    if (fs.statSync(filePaths[0]).size > 50 * 1024 * 1024) throw new Error('Pick a picture smaller than 50 MB');
    const image = store.saveOwnMedia({ bytes: fs.readFileSync(filePaths[0]), extension: path.extname(filePaths[0]).toLowerCase() });
    return { type: 'image', image, src: store.imageSrc(image) };
  });
  handle('party-profiles', () => store.partyProfiles());
  handle('clear-party-profile-pin', name => {
    store.clearPartyProfilePin(name);
    party?.game.profileChanged(name);
    return store.partyProfiles();
  });
  handle('delete-party-profile', (name, options) => {
    store.deletePartyProfile(name, options);
    party?.game.profileChanged(name);
    if (options?.withResults) win.webContents.send('party-results', store.partyResults());
    return store.partyProfiles();
  });
  handle('party-state', () => party?.game.hostView() ?? null);
  handle('party-open-display', () => party && openPartyDisplay(win, party.game.port));
  handle('party-cast-miracast', () => shell.openExternal('ms-settings-connectabledevices:devicediscovery'));
  handle('party-extend-display', extendDesktopToWirelessDisplay);
  handle('party-set-title', withParty((game, title) => game.setTitle(title)));
  handle('party-set-night-mode', withParty((game, isNightMode) => game.setNightMode(isNightMode)));
  handle('party-find-tvs', () => findSamsungTvs());
  handle('party-cast-samsung', async address => {
    if (!party) throw new Error('No party is open');
    if (!isLocalNetworkAddress(address)) throw new Error('That TV is not on the local network');
    const tvNetwork = address.split('.').slice(0, 3).join('.');
    const joinUrls = party.game.urls.map(({ url }) => url);
    const partyUrl = joinUrls.find(url => url.startsWith(`http://${tvNetwork}.`)) ?? joinUrls[0];
    if (!partyUrl) throw new Error('This computer has no network address the TV can reach');
    await openInTvBrowser(address, `${partyUrl}tv`);
    if (partyDisplay && !partyDisplay.isDestroyed()) partyDisplay.webContents.setAudioMuted(true);
  });
  screen.on('display-added', (_event, display) => movePartyDisplayTo(display));
  handle('create-question', async fields => {
    const row = store.createQuestion(fields);
    if (isAiReady()) await ai.embedRows(store, [row]);
    return store.get(row.uid);
  });
  handle('delete-question', uid => store.deleteQuestion(uid));
  const QUESTION_ARCHIVES = [{ name: 'KimHardaNeApp questions', extensions: ['quzip'] }];

  const fileNameOf = name => String(name).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Questions';
  const embedCreated = async uids => {
    if (uids.length && isAiReady()) await ai.embedRows(store, uids.map(uid => store.rows[store.pos.get(uid)]));
  };
  const saveQuestionsFile = async (name, questions, options) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export questions', defaultPath: path.join(app.getPath('documents'), `${fileNameOf(name)}.quzip`), filters: QUESTION_ARCHIVES,
    });
    if (canceled) return null;
    const { archive, count, mediaCount } = transfer.exportArchive(questions, options);
    fs.writeFileSync(filePath, archive);
    return { file: filePath, count, mediaCount };
  };
  const openQuestionsFile = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Import questions', properties: ['openFile'], filters: QUESTION_ARCHIVES });
    if (canceled) return null;
    return { archive: transfer.readArchiveFile(filePaths[0]), fileName: path.basename(filePaths[0], path.extname(filePaths[0])) };
  };
  const ownQuestions = () => store.rows.filter(row => row.source_id === OWN_SOURCE_ID).map(row => store.get(row.uid));
  handle('export-own-questions', () => saveQuestionsFile('My questions', ownQuestions()));
  handle('import-own-questions', async () => {
    const opened = await openQuestionsFile();
    if (!opened) return null;
    const { createdUids, summary } = transfer.importOwnQuestions(store, opened.archive);
    await embedCreated(createdUids);
    return summary;
  });
  handle('export-list', listId => {
    const list = store.allLists().find(candidate => candidate.id === listId);
    if (!list) throw new Error('This list no longer exists');
    return saveQuestionsFile(list.name, store.listQuestions(listId), { list });
  });
  handle('import-list', async () => {
    const opened = await openQuestionsFile();
    if (!opened) return null;
    const { listId, createdUids, summary } = transfer.importList(store, opened.archive, { fileName: opened.fileName });
    await embedCreated(createdUids);
    return { listId, summary };
  });
  handle('pick-question-image', async (uid, column) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add a picture, video or audio', properties: ['openFile'],
      filters: [{ name: 'Pictures, videos and audio', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'm4v', 'webm', 'mp3', 'm4a', 'wav', 'ogg', 'oga'] }],
    });
    return canceled ? null : store.setOwnImage(uid, column, filePaths[0]);
  });
  handle('remove-question-image', (uid, column) => store.setOwnImage(uid, column, null));
  handle('save', async (uid, fields) => {
    const row = store.save(uid, fields);
    if (row && isAiReady()) await ai.embedRows(store, [row]);
    return { changed: !!row, question: store.get(uid) };
  });
  handle('data-sources', dataSources);
  handle('update-data-source', async (id, mode) => {
    if (dataSourceJob) throw new Error('A data source is already downloading');
    const source = dataSourceById(id);
    dataSourceJob = new AbortController();
    try {
      return { ...(await updateDataSource(win, source, mode, dataSourceJob.signal)), dataSources: dataSources() };
    } finally {
      dataSourceJob = null;
    }
  });
  ipcMain.handle('stop-data-source', () => dataSourceJob?.abort());
  handle('delete-data-source', id => {
    if (dataSourceJob) throw new Error('Wait until the download stops');
    removeDataSource(dataSourceById(id), store.db, imageRoots);
    store.reload();
    return dataSources();
  });
  ipcMain.handle('install-update', () => autoUpdater.quitAndInstall(false, true));
  checkForUpdates(win);
});

app.on('will-quit', () => {
  dataSourceJob?.abort();
  aiJob?.controller.abort();
  ai.stop();
  party?.close();
  store?.db.close();
});
app.on('window-all-closed', () => app.quit());
