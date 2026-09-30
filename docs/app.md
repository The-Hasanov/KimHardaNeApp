# KimHardaNeApp: how the app works

An Electron app for hosting quiz games and keeping a question bank. The bank is `data/3sual.sqlite`, built
by the scraper from 3sual.az, plus your own questions. It needs Node 22+ and works offline once the model and
images are downloaded.

```bash
cd app
node scraper.js images --db ../data/3sual.sqlite   # optional: handout images for offline use (~35 min)
npm install
npm run embed    # optional: downloads bge-m3 (~570 MB) to app/models and embeds all questions (~30 min on CPU)
npm start        # builds the UI and opens the app (Electron fetches its binary on first start)
                 # QUIZ_DB=path overrides the database, QUIZ_MODELS=dir the model folder
npm test         # offline tests for the scraper, search, ranking, edits, data updates and local images
```

- **Interface**: React with [shadcn/ui](https://ui.shadcn.com) components and Tailwind, in `ui/`. Vite bundles it
  into `renderer/`, which Electron loads from disk; `npm start` and `npm run dist` build it, `npm run ui` rebuilds
  only the UI. Shortcuts: Ctrl+K search, ↑/↓ move through results, Ctrl+S save. Matched words are highlighted,
  the split between results and editor is resizable, and the theme follows the system light/dark setting.
  *Hide answers* (above the results) blurs the answers in the list for self-testing, and in the editor hides
  the answer, accepted answers, comment, sources and answer picture until you click *Show answer* (or a hidden
  field). Clicking an author's name in the editor filters the results to that author's questions. *With image*
  lists only questions that have a handout image.
  New shadcn components: `npx shadcn add <name>` (see `components.json`).
- **Game** tab: a helper for the host of *Nə? Harada? Nə zaman?* (What? Where? When?). It picks 10 random
  standalone questions of that game (New set picks again) and runs a timer per question, 60 seconds by
  default, with a tone at 10 seconds left and at the end. When time is up it moves to the next question.
  The host can end the game at any time; the answers of the questions whose timer was started are then
  revealed one by one. Keys: Space starts/pauses the timer (or reveals the next answer), → next question.
  *Seconds between questions* (0 = off) shows the next question's number full screen for that many seconds
  before each question, starting with question 1; Space or → skips the wait. *Auto-start next question* starts
  each question's timer as soon as the question appears.
  Scoring stays with the host. *Night mode* (the switch in Settings, or the moon button top right in the Game tab) toggles the dark and
  light themes for the whole app, the TV and the phones; the choice is remembered, and until it is made the app follows Windows.
- **Play mode** (Game tab, *Host* / *Play* switch): answer the questions yourself. With AI search off, every
  answer is left for you to mark *Correct* or *Wrong*.
  Each question's timer starts when it appears; type the answer and press Enter, or let the time run out.
  The answer is checked at once (`judge.js`): first as text against the answer and the accepted answers,
  ignoring case, diacritics, punctuation and small typos in each word (a swap of two letters is one typo),
  "a" for "ə", "sh"/"ch" for "ş"/"ç", joining words ("və", "ilə") and the order of a list's parts; otherwise by meaning with the AI model,
  *correct* at 86% similarity or more, *not sure* from 60%, *wrong* below. Crediting notes such as
  "Yalnız dəqiq cavablar" are not treated as answers, and exact-only or very short answers skip the AI check.
  You can overrule every verdict with *Correct* / *Wrong*. The score and every answer are saved; *Your results*
  in the Play setup lists past games, where verdicts can still be changed or a game deleted.
- **Party mode** (Game tab, *Party*): players join from any phone, tablet or computer with a web browser (below, *phones* means any of
  them). *Open party* starts a small web server
  (`party.js`, Node's `http`, port 8765 or a free one) on this computer's local network address, which the app
  finds itself (private IPv4, real adapters before virtual ones such as Hyper-V or VPNs; a picker appears when
  there are several). The lobby shows a QR code of that address; players scan it, type a name and join in the
  browser (`party/player.html`, no app needed, same Wi-Fi). The players' TV screen is one page,
  `party/tv.html` at `http://<address>:<port>/tv`, plain ES5 and CSS so that the 2017 Samsung TV browser
  (Chrome 47) runs it, fed by `/tv/events`, which never carries the answer before the reveal (the TV only ever
  gets what it shows). It follows the host's night mode. Opening a party also opens it in the **TV window**, a
  normal window placed on a second screen if there is one: drag it where you want and press F11 for full
  screen (Esc leaves it; *TV → Show TV window* brings it back if closed). *TV → Show on Samsung TV…* finds
  Samsung Smart TVs on the network (SSDP, `samsungTv.js`) and opens the TV page in the TV's own web browser
  through Samsung's remote-control channel (`wss://<tv>:8002`, the TV may ask once to allow KimHardaNeApp);
  press OK on the remote for full screen. Nothing is installed on the TV. *TV → Cast with Miracast…* opens the
  Windows Cast panel (Win+K) on computers with Miracast-capable Wi-Fi: pick the TV, then *Extend to TV*
  (`DisplaySwitch /extend`; Duplicate would show the host's answers) and the TV window moves to the new display
  by itself. The TV shows the join code, each question with its images and countdown, the answer with every
  player's result, and the leaderboard. The app window stays the host's
  console: the question with its answer (only the host sees it) before and while it runs, every player's answer
  as it comes in, and every control. The host can already mark answers correct or wrong while the question runs; the call
  also applies to the same answer (as `judge.js` compares text) from any other player the host has not marked directly, before
  and after the check, and a player who changes the answer loses the mark (sending the same answer again keeps it). *Game / Leaderboard / Join code* in the header picks what the TV shows; a choice other
  than *Game* holds until the next question starts. *Pause* (Space during a question) freezes the countdown on
  every screen and phone. The TV counts the last 10 seconds of each question in big numbers with a beep per
  second and a tone when time is up; sounds play only from the TV page (after *Show on Samsung TV* the TV window
  on the computer goes silent). *Autoplay* in the round settings moves on to the next question once the answer
  has been shown for *Seconds on the answer*; the host can still press *Next question* early or *Pause* (Space)
  to look at the answers longer. Each question and its images appear on every phone with an answer box and a
  countdown. When the time is up (or *Close answers now*),
  AI search checks every answer as in Play mode (with AI search off the host marks each one, and phones show
  *The host is checking* until then); phones then show their verdict, the answer and the
  leaderboard, and the host sees every answer and can overrule it. The host sets the points for a correct
  answer and for a wrong one (for example −1; a blank answer always scores 0). *Show the answers: At the end of
  the round* keeps every answer and score hidden from phones and the TV; it needs seconds between questions, and
  during them the host checks the previous question's answers. After the last question the host checks its answers,
  presses *Show the answers* and steps through them with *Next answer*, and the scores grow as they are revealed. After the last question the
  round's leaderboard appears: *Next round* keeps the scores and *New game* resets them; either way players
  stay connected and the host picks the next questions in the lobby. Random questions never repeat one already
  shown while the party is open (lists play as chosen). Players can only join and send answers:
  every host control stays in the app, phones never receive an answer before the reveal, names and answers are
  length-limited, and the host can remove a player at any time, online or not (a green dot marks who is online):
their answers and score leave the party, and their phone asks for a name again, so it is not a ban. A phone that
loses the connection keeps its place and reconnects by itself, even after minutes or a page reload; only a removed
player or a closed party has to join again. The phone's *Settings* (tap the name, or the button in the lobby) change the name, never to a name
someone else has, and *Leave the game* removes the player and their score, as if the host had removed them. While a
question runs, a phone that switches to another tab or app, or loses the connection, gets a warning sign on the
host's screen only, with how many times, and a short toast there names the player as it happens (one toast per
player and question, updated with the count); the count starts again at each question. *Message* in the party header sends a clue or
an announcement (up to 300 characters) to every phone, never to the TV; players cannot reply. It shows at the top of each
phone, which vibrates where it can, until the player closes it, the host clears or replaces it, or the next question starts. Phones have a small *Skip* button while the next question's number, a question or an answer is
shown: when every online player has tapped it (tap again to take it back), the game moves on, unless the host has
paused, and never while the host checks answers (between questions when the answers show at the end of the round, or
while an answer is still *not sure*): phones then show that the host is checking, and only the host moves on. Phones
and the host see how many tapped, and the count starts again at each step. Every finished round adds
each player's correct, wrong and unanswered questions (counted from the question they joined at) to the
**all-time leaderboard** in the party lobby, kept per name in the `party_results` table and carried through
updates; *Reset* there deletes them. Each answer keeps its time: seconds from the question's start to the last change of the
answer, pauses left out (sending the same answer again keeps the first time). The host sees it next to every answer,
phones see their own after the reveal, and every leaderboard (host, TV, phones, all-time) shows each player's average
time of correct answers; players with the same score are ranked by it, the faster first. When a round ends, the TV and the host show
a podium of the top three with *Congratulations, <winner>!* (shared first places name everyone), confetti and, on the TV,
a short fanfare; each phone congratulates its player by place: a trophy and confetti for first, silver and bronze
medals for second and third, and the place and winner for everyone else. Confetti is left out when the device asks
for reduced motion. **Reactions**: players send one of eight emojis (👏 😂 😮 🤔 🔥 ❤️ 😢 🎉) from a tray,
always shown in the lobby and on the results, and opened with the smile button in the top bar during a round (under
the *Send answer* button while a question runs); one a
second and ten a minute per player (the tray shows how many are left). The host app queues every reaction and shows it as a small toast
with the player's name in the TV's bottom-right corner (five at a time, about 4 s each) and on the other players' phones
(two at a time, about 3 s each), in the order sent; one that waits too long (15 s for the TV, 8 s for phones) is dropped, and it shows next to the player's name in the
host's player lists for a few seconds when it reaches the TV. *Show reactions* in the phone's Settings hides them and the tray for that player (remembered
on the device); *Reactions* in
the party header turns them off and on for everyone. Windows
  Firewall asks once whether KimHardaNeApp may accept connections on private networks; allow it.
- **Lists**: *Add to list* in the editor puts the open question into one or more of your lists, or creates a
  new list with it. The **Lists** tab shows each list in order: move questions up or down, open one in the
  editor, remove it, rename or delete the list. *Start game* plays the list in the Game tab, in list order;
  the Game tab's *Questions* picker switches between a list and 10 random questions. Lists live in the
  `lists` and `list_questions` tables of your database and survive version updates.
- **Keyword search** uses [MiniSearch](https://github.com/lucaong/minisearch) with BM25 over the question,
  answer, comment, accepted answers and theme name. By default every query word must match, as a prefix,
  with small typos allowed. It ignores case and diacritics, so `baki` finds `Bakı` and `Bakının`.
- **AI search** uses [Transformers.js](https://github.com/huggingface/transformers.js) to run the Hugging Face
  model `Xenova/bge-m3` locally on the CPU, with no API key. The question text plus answer is embedded once into
  the `embeddings` table (`uid`, `hash`, `vec`, 1,024 floats). The query is embedded on the fly, and results
  are ranked by cosine similarity. AI search is off until it is turned on in **Settings** (gear icon, top right):
  the app then downloads the model from Hugging Face (587 MB) and builds the AI index on the computer (about
  30 min for 68,000 questions here, longer on slower CPUs), with progress in Settings and the status line.
  Search and editing keep working meanwhile, and an interrupted build resumes on the next start. Turning it off
  deletes the model and the vectors (about 900 MB). The choice is kept in `settings.json` in the user data
  folder, and the installed app keeps the model in `%APPDATA%\KimHardaNeApp\models`.
- **Hybrid** (the default) fuses the two rankings with reciprocal rank fusion (`k = 10`, AI weight 0.5). Each
  result shows its `kw` (BM25) and `ai` (cosine) scores. The game and edited-only filters apply to every mode.
- **Editing** covers the question, answer, accepted answers, comment, host note, handout text and sources.
  Saving writes only the fields that changed. It sets `questions.edited_at` and re-embeds the question.
  `crawl --refresh` keeps edited rows. The site's original values are still in `packages.raw_json`, and
  the export includes `edited_at`.
- **Your own questions**: the *Custom* tab lists them next to the editor, and *New question* there opens an
  empty editor; a question needs its text and answer. Once saved, it can get a handout picture and an answer
  picture (PNG, JPEG, GIF or WebP), copied to `images/own/` next to the database and kept through updates. They are stored in the same `questions` table (`package_id` 0, `origin` `own`), so search, lists,
  games and parties treat them like any other question, and *My questions* in the game filter finds them in search too.
  Like edits, they survive refreshes and version updates, and `npm run dist` leaves them out of the installer.
  Only your own questions can be deleted.
- **Import and export**: *Export* on the *Custom* tab saves all your own questions, and *Export* on a list saves that list
  with its questions in order, to a `.json` file (`transfer.js`) that carries every text field, the sources and the
  pictures (embedded when they are on this computer, as links otherwise). *Import* on the *Custom* tab adds the file's
  questions to your own, skipping ones you already have (same text and answer, ignoring case, diacritics and spacing)
  and question bank questions already in this computer's bank. *Import* on the *Lists* tab (the icon next to *New list*)
  creates a new list from the file, named after it (with a number if the name is taken): question bank questions found
  here are used as they are, your own questions already here are reused, and every other question, custom or from a
  question bank this computer lacks, is added to your own questions first. A message sums up what was added.
- **Images** are shown from `data/images/` when `scraper.js images` has fetched them, otherwise from the site.
- **Refresh data** (header button) runs the scraper inside the app and brings the open database up to date.
  *Quick* (~2 min) lists every package, fetches the ones not stored yet and runs the author check. *Full*
  (~20 min) also refetches every stored package, which picks up upstream edits. Both then download new
  images, rebuild the index and embed new or changed questions. Search and editing keep working meanwhile, and
  edited questions are never overwritten. *Stop refresh* saves progress, and the next refresh within a day
  resumes it. The status line shows when the data was last checked. The installed app saves new images
  next to its database in `%APPDATA%\KimHardaNeApp\data\images`.
- **Cost:** about 6 s to open. A search takes about 110 ms (0.5 s for the first one while the model warms
  up). Memory use is about 1 GB with AI search on (index, 280 MB of vectors and the model), much less with it off.

## Installer, versions and updates

```bash
cd app
npm run dist                                          # dist/KimHardaNeApp Setup <version>.exe (~365 MB)
UPDATE_URL=https://your.host/3sual/ npm run dist      # same, plus in-app auto-update from that folder
npm run dist:mac                                      # dist/KimHardaNeApp-<version>-arm64.dmg, Apple silicon only
```

`npm run dist` snapshots `data/3sual.sqlite` with `VACUUM INTO`, without the AI vectors and lists. It refuses
to build if any image is missing. The installer bundles the database and the images, so the installed app works
offline; only turning on AI search downloads the model. The version comes from `app/package.json` and is
shown in the title bar and status line.

To keep the installer small, all of it lossless:
- The AI model (587 MB) and the AI vectors (280 MB) are not shipped. Users who want AI search turn it on in
  Settings and the app builds them.
- PNGs ship as lossless WebP when that decodes to exactly the same pixels, about 40% smaller. PNGs with
  colour-profile, gamma, animation or orientation chunks, and all JPEGs and GIFs, ship unchanged.
  The copies are cached in `app/bundle/images`; `data/images` keeps the originals.
- The app code is packed into `app.asar`; the native modules (ONNX runtime, sharp) stay unpacked.
- Only production dependencies ship: no devDependencies, source maps, type declarations or unused
  Transformers.js builds, and only the `en-US` Chromium locale.
- The UI is minified and tree-shaken by Vite, and the installer uses maximum compression.

**To release a new version:**
1. Refresh the data: `node scraper.js crawl`, then `images` (both with `--db ../data/3sual.sqlite`).
2. Bump `"version"` in `app/package.json`.
3. Run `UPDATE_URL=… npm run dist`.
4. Upload `KimHardaNeApp Setup <version>.exe`, its `.blockmap` and `latest.yml` to `UPDATE_URL`. Keep the
   older `.blockmap` files there too. The host must support HTTP range requests, as GitHub Releases, S3 and
   nginx all do. Updates then download only the changed blocks, which was 19% in a test with changed data.
   Without range support, the full installer is downloaded.

**What users see:**
1. At start, an installed app with a feed downloads the new version in the background. It then offers
   *Restart to update*. Quitting the app also installs the update.
2. On the first start of a new version, the bundled database replaces the working copy in
   `%APPDATA%\KimHardaNeApp\data`. Questions the user edited are carried over and win over upstream changes.
   The AI vectors the user built are carried over too; those of changed questions are rebuilt in the background. Packages the user refreshed after the new version's data was
   collected keep their newer copy, so an update never rolls data back. The replaced database stays as `3sual.previous.sqlite`, and the
   status line reports the update.
3. Images live in the install folder, so the installer replaces them. The AI model stays in the user data folder.
4. The installer is unsigned, so Windows SmartScreen warns on first install. A code-signing certificate
   (`CSC_LINK`, `CSC_KEY_PASSWORD`) removes the warning.

Tested end to end on Windows 11 with a local feed:
1. Installed 1.0.0 and edited a question.
2. Published 1.0.1 with changed data.
3. 1.0.0 found the update, downloaded it, and installed it on *Restart to update*.
4. 1.0.1 started with the new data, kept the edit and made a backup.

## Search benchmark (`app/bench.js`)

`npm run bench` scores 300 queries against known answers. The first 60 are target questions drawn with a
fixed seed, stratified by game. Each target gets four queries:
- **recall**: a few remembered words.
- **paraphrase**: the idea in other words, written by hand in `bench/queries.json`.
- **ascii**: the recall query typed without Azerbaijani letters.
- **typo**: the recall query with two adjacent letters swapped.

The last 60 queries are **answer** lookups: the query is an answer, and every question with that answer counts.
A copy of the same question in another package counts as a hit. The metric is MRR@10: 100 means the right
question is always first, 50 means second on average.

Settings are chosen on the dev half of the targets and reported on the held-out test half (30 targets, so
±5 points is noise). Candidate vectors are cached in `bench/cache/` via `node bench.js embed <model> [ta|tac]`.
The full log is in `bench/results.txt`.

| Test half, MRR@10 % | recall | paraphrase | ascii | typo | answer | macro | top-1 | top-10 |
|---|---|---|---|---|---|---|---|---|
| First release: e5-small hybrid, k=60, weight 1 | 97 | 15 | 94 | 75 | 75 | 71 | 67 | 79 |
| Keyword only, best (any word may match) | 98 | 19 | 98 | 92 | 94 | 80 | 77 | 86 |
| AI only: e5-small / e5-base / bge-m3 | 71 / 74 / 88 | 15 / 19 / **47** | 56 / 47 / 68 | 55 / 59 / 85 | 42 / 36 / 76 | 48 / 47 / 73 | | |
| e5-small with the comment embedded, best hybrid | 97 | 23 | 97 | 92 | 91 | 80 | 75 | 87 |
| **Shipped: bge-m3 hybrid, all words, k=10, weight 0.5** | **100** | **47** | 97 | 88 | 89 | **84** | **79** | **92** |

Findings:
- The e5 models barely understand Azerbaijani paraphrases, and embedding the comment did not help.
- bge-m3 triples paraphrase recall. It costs 1,024-dim vectors, and embedding takes 30 min instead of 4.
- With a weak AI model, letting any word match is the best keyword setting. With bge-m3, requiring every
  word is better, because the AI half catches what exact matching misses.
- Remaining misses are mostly paraphrases that need outside knowledge, such as "reggae star" for Bob Marley.
