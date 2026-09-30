# KimHardaNeApp: how the app works

An Electron app for hosting any kind of quiz and keeping a question bank. It ships without questions: the bank is
your own questions plus the data sources you install in *Settings → Data sources* (for now 3sual.az, built by
the scraper). In development the database is `data/kimhardane.sqlite`, created empty when missing. It needs Node 22+
and works offline once the model and images are downloaded.

```bash
cd app
npm install
npm run embed    # optional: downloads bge-m3 (~570 MB) to app/models and embeds all questions (~30 min on CPU)
npm start        # builds the UI and opens the app (Electron fetches its binary on first start); install a data source in Settings
                 # QUIZ_DB=path overrides the database, QUIZ_MODELS=dir the model folder
npm test         # offline tests for the scraper, data sources, search, ranking, edits and local images
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
- **Questions from data sources**: every question carries `source_id` (the data source that brought it, `own` for
  your own questions) and belongs to one of that source's games (`game_id`, `game_name`). The picker used in Search,
  the Game tab and each party round lists every installed source with its games as checkboxes, plus *My questions*;
  a whole source is checked at once, or single games inside it. With everything checked the pick is *All
  questions*, which also takes in sources installed later. A round saved in a template keeps its picks
  (`source:game` keys); when none of its sources is installed any more, the round is marked and cannot start.
- **Game** tab: a helper for any quiz host. It picks 10 random
  standalone questions from the chosen sources and games (New set picks again) and runs a timer per question, 60 seconds by
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
  there are several). The lobby shows a QR code of that address and the **party name** (default *Quiz night*,
  remembered for the next party), which the TV, every phone and their page titles show; players scan it, type a name and join in the
  browser (`party/player.html`, no app needed, same Wi-Fi). The players' TV screen is one page,
  `party/tv.html` at `http://<address>:<port>/tv`, plain ES5 and CSS so that the 2017 Samsung TV browser
  (Chrome 47) runs it, fed by `/tv/events`, which never carries the answer before the reveal (the TV only ever
  gets what it shows). It follows the host's night mode. Opening a party also opens it in the **TV window**, a
  normal window placed on a second screen if there is one: drag it where you want and press F11 for full
  screen (Esc leaves it; *TV → Show TV window* brings it back if closed). *TV → Show on Samsung TV…* finds
  Samsung Smart TVs on the network (SSDP, `samsungTv.js`; only devices with a local network address are asked, and their
  answers are size-limited) and opens the TV page in the TV's own web browser
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
  to look at the answers longer. Each question and its images appear on every phone with a countdown and, at the bottom where
  thumbs are, a chat-style answer bar (answer box and round send button) with the reactions above it and the answer's
  status and a small *Done* chip (the Skip vote, held for a second) under it. When the time is up (or *Close answers now*),
  AI search checks every answer as in Play mode (with AI search off the host marks each one, and phones show
  *The host is checking* until then); phones then show their verdict, the answer and the
  leaderboard, and the host sees every answer and can overrule it. In Party mode the host plans the **rounds** before opening the party: each round has its own questions (random from the picked sources and games, with a count,
  or a list), timers, answer showing, autoplay and point system, and rounds can be added, duplicated, removed and changed
  until they are played (between rounds too). The party cannot open, and a round cannot start, while a planned round does
  not fit its point system or its list is gone; the round shows why in red. *Save as template* keeps the plan as a **game
  template** (`game_templates` table, carried through updates; saving with an existing name replaces it), and *Use a
  template* or *Game → Templates → Use* loads one. Templates point to their point systems, so editing a point system changes
  every template that uses it, and a point system a template uses cannot be deleted. Each round uses a **point system**,
  picked in the round settings and kept under *Game → Point systems* (`point_systems` table, carried through updates;
  a *Classic* one, correct +1, is made on first use). A point system has either *fixed points* (correct, wrong and no
  answer, negative for a penalty) or a *point pool* (values such as 10, 20 and 30, each with its own wrong and no-answer
  points and an optional number of uses per round): phones show the values as buttons above the answer bar, with the uses
  left, and a question without a pick plays for the lowest free value. A round cannot start when it has more questions
  than a limited pool has picks. Extras can be switched on together: a *streak bonus* from the nth correct answer in a
  row (the same bonus each time, or growing by the bonus), *all or nothing* (a player scores for the round only with no
  wrong answer, and with no blank one unless *No answer counts as wrong* is off), an *all correct bonus* for any point
  system (extra points at the end of a round for players with every answer right, shown on the phone at the last
  answer; with all or nothing and *No answer counts as wrong* off, a blank answer does not lose it), and *risk* (fixed points only): a *Risk it* switch on the phone uses the risked correct and wrong
  points, up to an optional number of risks per round; a risked question left blank is not used up. The host sees each
  player's pick or risk next to the answer, phones see their points with the streak bonus after the reveal, and the
  scoring rules sit in `scoring.js`. *Show the answers: At the end of
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
someone else has, and *Leave the game* removes the player and their score, as if the host had removed them. **Profiles**: the first time a name joins, the host app saves a
profile for it (`party_profiles` table, carried through updates) with the player's preferences (*Show reactions*, and *Sound*:
a chime and a buzz when a question starts). In *Settings* a player can set, change or remove a 4-digit **PIN** (stored as a
salted scrypt hash). A name with a PIN asks for it on joining, or when another player renames to it; five wrong tries lock
that name for a minute. Typing the right PIN for a name that is already in the game moves that player to the new device with
their score, and the old phone goes back to the name screen. A name without a PIN is accepted as before, and a known name
loads its profile. The host's *Game* tab has *Play*, *Profiles* and *Leaderboard* sections: *Profiles* lists every profile
with its PIN state, rounds and last game, and can *Clear PIN* (for a player who forgot it) or delete a profile, optionally
with its all-time results. While a
question runs, a phone that switches to another tab or app, or loses the connection, gets a warning sign on the
host's screen only, with how many times, and a short toast there names the player as it happens (one toast per
player and question, updated with the count); the count starts again at each question. *Message* in the party header sends a clue or
an announcement (up to 300 characters) to every phone, never to the TV; players cannot reply. It shows at the top of each
phone, which vibrates where it can, until the player closes it, the host clears or replaces it, or the next question starts. Phones have a small *Skip* button that must be held for a second (a ring fills while holding; a quick tap only shows "Hold to skip", so it is not pressed by accident) while the next question's number, a question or an answer is
shown: when every online player has held it (hold again to take it back), the game moves on, unless the host has
paused, and never while the host checks answers (between questions when the answers show at the end of the round, or
while an answer is still *not sure*): phones then show that the host is checking, and only the host moves on. Phones
and the host see how many tapped, and the count starts again at each step. Every finished round adds
each player's points, correct, wrong and unanswered questions (counted from the question they joined at) to the
**all-time leaderboard** (in the party lobby and the Game tab's *Leaderboard*), kept per name in the `party_results` table and carried through
updates; it ranks by total points, then by the faster average time, and *Reset* there deletes them (results saved before
points were kept count one point per correct answer). Each answer keeps its time: seconds from the question's start to the last change of the
answer, pauses left out (sending the same answer again keeps the first time). The host sees it next to every answer,
phones see their own after the reveal, and every leaderboard (host, TV, phones, all-time) shows each player's average
time of correct answers; players with the same score are ranked by it, the faster first. When a round ends, the TV and the host show
a podium of the top three with *Congratulations, <winner>!* (shared first places name everyone), confetti and, on the TV,
a short fanfare; each phone congratulates its player by place: a trophy and confetti for first, silver and bronze
medals for second and third, and the place and winner for everyone else. Confetti is left out when the device asks
for reduced motion. **Reactions**: players send one of eight emojis (👏 😂 😮 🤔 🔥 ❤️ 😢 🎉) from a tray,
always shown in the lobby and on the results, and opened with the smile button in the top bar during a round; while a
question runs they sit in a row just above the answer bar; one a
second and ten a minute per player (the tray shows how many are left). The host app queues every reaction and shows it as a small toast
with the player's name in the TV's bottom-right corner (five at a time, about 4 s each) and on the other players' phones
(two at a time, about 3 s each), in the order sent; one that waits too long (15 s for the TV, 8 s for phones) is dropped, and it shows next to the player's name in the
host's player lists for a few seconds when it reaches the TV. *Show reactions* in the phone's Settings hides them and the tray for that player (saved in the
player's profile); *Reactions* in
the party header turns them off and on for everyone. Windows
  Firewall asks once whether KimHardaNeApp may accept connections on private networks; allow it.
- **Lists**: *Add to list* in the editor puts the open question into one or more of your lists, or creates a
  new list with it. The **Lists** tab shows each list in order: move questions up or down, open one in the
  editor, remove it, rename or delete the list. *Start game* plays the list in the Game tab, in list order;
  the Game tab's *Questions* picker switches between a list and random questions. Lists live in the
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
  empty editor; a question needs its text and answer. Once saved, it can get a handout and an answer medium: a
  picture (PNG, JPEG, GIF, WebP), a video (MP4, WebM) or an audio file (MP3, M4A, WAV, OGG), up to 300 MB, copied to
  `images/own/` next to the database and kept through updates. Videos and audio play with controls in the editor, in the
  Game and Play tabs, on the host's party screen, on the TV (they start by themselves) and on phones (tap to play); the
  party server streams them in byte ranges so phones and iPhones can seek. They are stored in the same `questions` table (`source_id` `own`), so search, lists,
  games and parties treat them like any other question, and *My questions* in the source picker finds them in search too.
  Like edits, they survive refreshes and version updates, and `npm run dist` leaves them out of the installer.
  Only your own questions can be deleted.
- **Import and export**: *Export* on the *Custom* tab saves all your own questions, and *Export* on a list saves that list
  with its questions in order, to a `.quzip` file, a ZIP archive under its own name (`transfer.js`, written and read by `zip.js`): `questions.json` with every
  text field and the sources, and a `media/` folder with the pictures, videos and audio stored on this computer (media
  only known by a web link stay links). Import also reads `.zip` copies of it and the older `.json` exports. Import treats every file as untrusted: archives over 2 GB,
  more than 5,000 questions, media over 300 MB or files that unpack to more than they declare (ZIP bombs) are refused;
  archive entries are unpacked one at a time only when a question uses them and are never written under their own names
  (media is stored as `images/own/<sha256>.<ext>`, with the extension taken from an allowed type); only text is taken
  for text fields, capped at 20,000 characters; media links must be `http(s)`; and question text is always shown as
  text, never as HTML. The party server sends media with `nosniff` and a sandboxing content policy. *Import* on the *Custom* tab adds the file's
  questions to your own, skipping ones you already have (same text and answer, ignoring case, diacritics and spacing)
  and question bank questions already in this computer's bank. *Import* on the *Lists* tab (the icon next to *New list*)
  creates a new list from the file, named after it (with a number if the name is taken): question bank questions found
  here are used as they are, your own questions already here are reused, and every other question, custom or from a
  question bank this computer lacks, is added to your own questions first. A message sums up what was added.
- **Images** are shown from `data/images/` when `scraper.js images` has fetched them, otherwise from the site.
- **Data sources** (in Settings, the gear icon top right, on the *Data sources* tab) lists the question banks the
  app can download from. `app/sources.js` keeps them in `DATA_SOURCES`. Each source has an `id` (its questions'
  `source_id`), a name, website, description and install time, a `kind` (`scraper` for a site crawled on this
  computer; later `download` for a ready dataset file) and a `price` (`null` for free; paid datasets from the store
  set it), its own `tables`, and two functions: `progress` (whether a download started or finished, when it was last
  checked) and `download` (install or refresh). Counting questions, edits and saved pictures and deleting a source
  work the same for every source, by `source_id`: deleting keeps pictures other sources still use. A new scraper or
  a sold dataset is added as one more entry; the page, the progress bar and the IPC calls (`data-sources`,
  `update-data-source`, `stop-data-source`, `delete-data-source`) work for every source. A source's `uid`s start
  with its own prefix so they never clash. One source downloads at a time.
  Each source shows as a card: *Not installed* with **Install**, *Not finished* (a stopped install) with
  **Continue install**, or *Installed* with **Refresh** (Quick or Full) and **Delete**. While it downloads, the
  card and the status line show the stage and progress, with **Stop download**; the app stays usable. A search
  with no questions at all offers *Open data sources* and *Write a question*.
  **3sual.az** runs the scraper inside the app. Installing is a first quick refresh on an empty database: every
  package, then every picture (about an hour). *Quick* (~2 min) lists every package, fetches the ones not stored
  yet and runs the author check. *Full* (~20 min) also refetches every stored package, which picks up upstream
  edits. Both then download new pictures, rebuild the index and embed new or changed questions. Edited questions
  are never overwritten. Stopping saves progress; the next download continues from there. **Delete** asks first,
  saying how many questions and edits go, then removes the source's questions, their AI vectors, pictures and the
  scraper's tables. Your own questions and their media, lists, games, profiles, point systems, templates and the
  leaderboard stay. Lists keep their places for deleted questions and show them again after a reinstall.
  Every download goes over `https` only (redirects away from it are refused) and has a size limit (64 MB of data per API
  answer, 25 MB per picture). Pictures are fetched only from the question bank's own image address
  (`https://api.3sual.az/images/`): links that your own or imported questions carry are shown as links, never downloaded
  in the background. A downloaded picture is kept only when its bytes really are a JPEG, PNG, GIF, WebP, BMP or SVG
  image, and it is stored under a hashed name with an extension from that list. Pictures not saved yet are shown
  from the site; the card counts them. The installed app keeps the database and pictures in
  `%APPDATA%\KimHardaNeApp\data` (`kimhardane.sqlite`, `images/`).
- **Cost:** about 6 s to open. A search takes about 110 ms (0.5 s for the first one while the model warms
  up). Memory use is about 1 GB with AI search on (index, 280 MB of vectors and the model), much less with it off.

## Installer, versions and updates

```bash
cd app
npm run dist                                          # dist/KimHardaNeApp Setup <version>.exe
UPDATE_URL=https://your.host/3sual/ npm run dist      # same, plus in-app auto-update from that folder
npm run dist:mac                                      # dist/KimHardaNeApp-<version>-arm64.dmg, Apple silicon only
```

The installer ships no questions and no pictures: users install data sources from Settings. Turning on AI search
downloads the model. The version comes from `app/package.json` and is shown in the title bar and status line.

To keep the installer small, all of it lossless:
- The AI model (587 MB) and the AI vectors (280 MB) are not shipped. Users who want AI search turn it on in
  Settings and the app builds them.
- The app code is packed into `app.asar`; the native modules (ONNX runtime, sharp) stay unpacked.
- Only production dependencies ship: no devDependencies, source maps, type declarations or unused
  Transformers.js builds, and only the `en-US` Chromium locale.
- The UI is minified and tree-shaken by Vite, and the installer uses maximum compression.

**To release a new version:**
1. Bump `"version"` in `app/package.json`.
2. Run `UPDATE_URL=… npm run dist`.
3. Upload `KimHardaNeApp Setup <version>.exe`, its `.blockmap` and `latest.yml` to `UPDATE_URL`. Keep the
   older `.blockmap` files there too. The host must support HTTP range requests, as GitHub Releases, S3 and
   nginx all do. Updates then download only the changed blocks, which was 19% in a test with changed data.
   Without range support, the full installer is downloaded.

**What users see:**
1. At start, an installed app with a feed downloads the new version in the background. It then offers
   *Restart to update*. Quitting the app also installs the update.
2. Updates never touch the questions: the database (`kimhardane.sqlite`), the pictures and the AI model live in the
   user data folder. Data from versions before data sources is not carried over; install the data sources again.
3. The installer is unsigned, so Windows SmartScreen warns on first install. A code-signing certificate
   (`CSC_LINK`, `CSC_KEY_PASSWORD`) removes the warning.

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
