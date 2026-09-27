'use strict';
const { app, BrowserWindow, ipcMain, nativeTheme, screen, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./store');
const { installData } = require('./data');
const ai = require('./ai');
const scraper = require('./scraper');
const { judgeAnswer } = require('./judge');
const { openParty } = require('./party');
const { findSamsungTvs, openInTvBrowser } = require('./samsungTv');

const WHAT_WHERE_WHEN_GAME_ID = 1;
const USER_DATA_BEFORE_RENAME = path.join(app.getPath('appData'), '3sual Editor');
if (!app.commandLine.hasSwitch('user-data-dir') && fs.existsSync(USER_DATA_BEFORE_RENAME)) app.setPath('userData', USER_DATA_BEFORE_RENAME);
let store;
let imageRoots;
let refreshing = null;
let aiStatus = { state: 'off' };
let aiJob = null;
let party = null;
let partyDisplay = null;
let dataUpdate = null;

function openStore() {
  if (!app.isPackaged) {
    const file = process.env.QUIZ_DB || path.join(__dirname, '..', 'data', '3sual.sqlite');
    imageRoots = [path.dirname(path.resolve(file))];
    if (process.env.QUIZ_MODELS) ai.configure({ modelsDir: process.env.QUIZ_MODELS });
    return new Store(file, { imagesRoot: imageRoots });
  }
  const res = process.resourcesPath;
  ai.configure({ modelsDir: path.join(app.getPath('userData'), 'models') });
  const r = installData({ bundled: path.join(res, 'data', '3sual.sqlite'), dir: path.join(app.getPath('userData'), 'data'), version: app.getVersion() });
  if (r.replaced && r.from) dataUpdate = { from: r.from, carried: r.carried, newer: r.newer };
  imageRoots = [path.dirname(r.db), path.join(res, 'data')];
  return new Store(r.db, { imagesRoot: imageRoots });
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
const AI_BUSY_STATES = ['downloading', 'loading', 'indexing', 'ready', 'stopping'];

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
    if (!store.vecs) store.loadVectors(ai.MODEL, ai.MODELS[ai.MODEL].dim);
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

function turnOnAi(win) {
  if (AI_BUSY_STATES.includes(aiStatus.state)) return;
  const controller = new AbortController();
  aiJob = { controller, finished: prepareAi(win, controller.signal) };
}

async function turnOffAi(win) {
  setAiStatus(win, { state: 'stopping' });
  aiJob?.controller.abort();
  await aiJob?.finished;
  aiJob = null;
  await ai.unload();
  ai.deleteModel();
  store.dropVectors();
  setAiStatus(win, { state: 'off' });
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

const dataDate = () => {
  try {
    return store.db.prepare(`SELECT MAX(d) AS d FROM (SELECT MAX(finished_at) AS d FROM runs WHERE status = 'finished'
      UNION ALL SELECT MAX(fetched_at) FROM packages WHERE status != 'failed')`).get().d;
  } catch {
    return null;
  }
};

async function refresh(win, mode, signal) {
  const progress = p => win.webContents.send('refresh', p);
  const count = sql => store.db.prepare(sql).get().n;
  const db = scraper.prepareDb(store.db);
  const before = { rows: count('SELECT COUNT(*) AS n FROM questions'), packages: count("SELECT COUNT(*) AS n FROM packages WHERE status != 'failed'") };
  const last = db.prepare('SELECT status, started_at FROM runs ORDER BY id DESC LIMIT 1').get();
  const resume = !!last && last.status !== 'finished' && Date.now() - Date.parse(last.started_at) < 864e5;
  const client = new scraper.Client({ signal });
  let crawled, images = null, error = null;
  try {
    crawled = await scraper.crawl(db, { client, refresh: mode === 'full', newRun: !resume, audit: 'counts', progress });
    if (crawled.status === 'finished') images = await scraper.downloadImages(db, client, imageRoots, { progress });
  } catch (e) {
    if (!(e instanceof scraper.Interrupted)) error = e.message;
  }
  progress({ stage: 'index' });
  await new Promise(r => setTimeout(r, 50));
  store.reload();
  const stale = store.staleRows();
  if (stale.length && !signal.aborted && isAiReady()) {
    try {
      await ai.embedRows(store, stale, (done, total) => {
        progress({ stage: 'embed', done, total });
        if (signal.aborted || !isAiReady()) throw new scraper.Interrupted();
      });
    } catch (e) {
      if (!(e instanceof scraper.Interrupted)) error ??= e.message;
    }
  }
  const report = crawled?.report;
  return { mode, cancelled: signal.aborted, error, complete: !!report?.complete && !!images?.complete,
    rows: store.rows.length, newRows: store.rows.length - before.rows,
    newPackages: count("SELECT COUNT(*) AS n FROM packages WHERE status != 'failed'") - before.packages,
    images: images?.fetched_this_run ?? 0, failures: (report?.errors ?? 0) + (images?.failed ?? 0),
    vectors: store.vectorCount, dataDate: dataDate() };
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
  win.loadFile('renderer/index.html');

  const ready = new Promise(resolve => setTimeout(resolve, 100)).then(() => {
    store = openStore();
    store.buildIndex();
    if (readSettings().aiSearch) turnOnAi(win);
  });
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => { await ready; return fn(...args); });

  handle('info', () => ({ version: app.getVersion(), rows: store.rows.length, games: store.games(), dataUpdate, dataDate: dataDate() }));
  handle('ai-status', () => aiStatus);
  handle('set-ai-search', async isOn => {
    writeSettings({ aiSearch: isOn });
    await (isOn ? turnOnAi(win) : turnOffAi(win));
    return aiStatus;
  });
  handle('search', async opts => {
    const useAi = opts.q?.trim() && opts.mode !== 'keyword' && isAiReady();
    return store.search(opts, useAi ? await ai.embedQuery(opts.q) : null);
  });
  handle('get', uid => store.get(uid));
  handle('game-questions', count => store.randomPlayableQuestions(WHAT_WHERE_WHEN_GAME_ID, count, party ? [...party.game.shownUids] : []));
  handle('lists', () => store.allLists());
  handle('create-list', name => store.createList(name));
  handle('rename-list', (listId, name) => store.renameList(listId, name));
  handle('delete-list', listId => store.deleteList(listId));
  handle('add-to-list', (listId, uid) => store.addToList(listId, uid));
  handle('remove-from-list', (listId, uid) => store.removeFromList(listId, uid));
  handle('reorder-list', (listId, uidsInOrder) => store.reorderList(listId, uidsInOrder));
  handle('list-questions', listId => store.listQuestions(listId));
  handle('list-ids-containing', uid => store.listIdsContaining(uid));
  handle('start-play-game', settings => store.startPlayGame(settings));
  handle('submit-play-answer', async (gameId, { position, uid, givenAnswer, secondsUsed }) => {
    if (!isAiReady()) throw new Error('AI search is not ready');
    const judged = await judgeAnswer(store.get(uid), givenAnswer, texts => ai.embed(texts, 'query'));
    return store.savePlayAnswer(gameId, { position, uid, givenAnswer, secondsUsed, ...judged });
  });
  handle('set-play-answer-correct', (gameId, position, isCorrect) => store.setPlayAnswerCorrect(gameId, position, isCorrect));
  handle('finish-play-game', gameId => store.finishPlayGame(gameId));
  handle('delete-play-game', gameId => store.deletePlayGame(gameId));
  handle('play-games', () => store.playGames());
  handle('play-game-answers', gameId => store.playGameAnswers(gameId));
  const judgeWithAi = (question, given) => judgeAnswer(question, given, texts => ai.embed(texts, 'query'));
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
  handle('party-open', async () => {
    if (!isAiReady()) throw new Error('AI search is not ready');
    await closeParty();
    party = await openParty({ judge: judgeWithAi, onChange: sendPartyState });
    openPartyDisplay(win, party.game.port);
    return party.game.hostView();
  });
  handle('party-start-round', withParty((game, { uids, ...rules }) => game.startRound({ questions: uids.map(uid => store.get(uid)).filter(Boolean), ...rules })));
  handle('party-skip-wait', withParty(game => game.skipWait()));
  handle('party-pause', withParty(game => game.pause()));
  handle('party-resume', withParty(game => game.resume()));
  handle('party-set-screen', withParty((game, screen) => game.setScreen(screen)));
  handle('party-close-answers', withParty(game => game.closeAnswers()));
  handle('party-next', withParty(game => game.next()));
  handle('party-finish-round', withParty(game => game.finish()));
  handle('party-set-correct', withParty((game, playerId, position, isCorrect) => game.setCorrect(playerId, position, isCorrect)));
  handle('party-kick', withParty((game, playerId) => game.kick(playerId)));
  handle('party-back-to-lobby', withParty((game, keepScores) => game.backToLobby({ keepScores })));
  handle('party-close', closeParty);
  handle('party-state', () => party?.game.hostView() ?? null);
  handle('party-open-display', () => party && openPartyDisplay(win, party.game.port));
  handle('party-cast-miracast', () => shell.openExternal('ms-settings-connectabledevices:devicediscovery'));
  handle('party-extend-display', extendDesktopToWirelessDisplay);
  handle('party-set-night-mode', withParty((game, isNightMode) => game.setNightMode(isNightMode)));
  handle('party-find-tvs', () => findSamsungTvs());
  handle('party-cast-samsung', async address => {
    if (!party) throw new Error('No party is open');
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
  handle('save', async (uid, fields) => {
    const row = store.save(uid, fields);
    if (row && isAiReady()) await ai.embedRows(store, [row]);
    return { changed: !!row, question: store.get(uid) };
  });
  handle('refresh', async mode => {
    if (refreshing) return { error: 'A refresh is already running' };
    refreshing = new AbortController();
    try {
      return await refresh(win, mode, refreshing.signal);
    } finally {
      refreshing = null;
    }
  });
  ipcMain.handle('cancel-refresh', () => refreshing?.abort());
  ipcMain.handle('install-update', () => autoUpdater.quitAndInstall(false, true));
  checkForUpdates(win);
});

app.on('will-quit', () => {
  refreshing?.abort();
  aiJob?.controller.abort();
  party?.close();
  store?.db.close();
});
app.on('window-all-closed', () => app.quit());
