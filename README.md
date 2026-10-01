<img src="app/icon.png" alt="" width="96" align="right">

# KimHardaNeApp

A Windows app for hosting any kind of quiz night. Players
answer in the web browser of any phone, tablet or computer, the TV shows the questions, a countdown and the leaderboard, and the host runs the
game from the app. Bring your own questions or install a question bank from *Data sources* in Settings.

![A question on the TV](docs/screenshots/tv-question.png)

## Features

- **Party mode**: players join from any phone, tablet or computer by scanning a QR code or opening
  the address in a browser, with nothing to install. The TV shows each question with
  its pictures, a countdown with sound for the last 10 seconds, the answer with everyone's result, and the
  leaderboard. Typed answers are checked by a local AI model, or marked by the host when AI search is off,
  and the host can overrule any verdict, or mark answers while the question is still running. Players answer
  in a chat-style bar, send reactions that show on the TV and on everyone's screen, skip a wait together, rename
  themselves and reconnect without losing their place. Answer times break ties, the leaderboard (or, if you choose, nothing) shows between rounds, the last round
  ends with a podium for the winners, and
  an all-time leaderboard ranks everyone by total points. The host can send messages to all players and sees who
  leaves the game screen during a question. Questions cannot be selected or copied on the phones or the TV page.
- **Your own quiz show**: name the party and plan its rounds, each with its own questions, timers and point
  system. Put **show pages** (titles, text and pictures, each on screen for its own seconds) before or after any
  round to greet the players, explain the rules or announce a break. Save the whole show as a template and play it again.
- **Point systems**: fixed points for right, wrong and blank answers, or a point pool where players pick 10, 20 or
  30 for each question. Add a streak bonus, all or nothing, a bonus for an all-correct round, or let players
  *Risk it* for more points.
- **Player profiles**: every name keeps its preferences and all-time results. A player can protect their name with
  a 4-digit PIN and move to another phone without losing their score.
- **Any TV**: a TV window on a second screen, Miracast, or the web browser of a Samsung Smart TV.
- **Host controls**: pause, autoplay, answers shown after each question or
  all at the end of the round, several rounds with or without keeping the scores, and no question shown twice
  in one party.
- **Your own questions**: write them on the *Custom* tab, add a picture, video or audio file to the question and to
  the answer, collect them in lists and play a list in order. Import and export your questions or a list as a `.quzip`
  file, media included.
- **Game helper and solo play**: a timer for the host, or play alone and mark your answers yourself or let the
  AI check them.
- **Question banks**: install them from *Data sources* in Settings, then pick which sources and games each search,
  game or round draws from. Search by keyword or by meaning, ignoring case, diacritics and small typos, and edit
  any question. Works offline. Night mode included.

## Party mode

| Host (the app) | TV | Player (any browser) |
|---|---|---|
| ![Host showing a show page](docs/screenshots/party-show-page.png) | ![TV show page](docs/screenshots/tv-show-page.png) | ![Phone show page](docs/screenshots/phone-show-page.png) |
| ![Host console](docs/screenshots/party-host.png) | ![TV question](docs/screenshots/tv-question.png) | ![Phone question](docs/screenshots/phone-question.png) |
| ![Host reveal](docs/screenshots/party-reveal.png) | ![TV reveal](docs/screenshots/tv-reveal.png) | ![Phone reveal](docs/screenshots/phone-reveal.png) |
| ![Host leaderboard between rounds](docs/screenshots/party-between-rounds.png) | ![TV leaderboard between rounds](docs/screenshots/tv-between-rounds.png) | ![Phone leaderboard between rounds](docs/screenshots/phone-between-rounds.png) |
| ![Host final results](docs/screenshots/party-results.png) | ![TV final results](docs/screenshots/tv-results.png) | ![Phone final results](docs/screenshots/phone-results.png) |

1. Optional: open **Settings** and turn on AI search to check the answers automatically. Without it, you mark
   each answer.
2. In the **Game** tab pick **Party**, then **Open party**. The TV window opens with the join code.
3. Put the TV window on the TV: drag it there and press F11, or use **TV → Show on Samsung TV…** or
   **TV → Cast with Miracast…**.
4. Players scan the QR code, or type the address into any browser, on the same Wi-Fi and type a name.
5. Plan the rounds, or pick a template, and start the first round. Turn on **Autoplay** to move on by itself.

The app window stays the host's console: only the host sees the answer before the reveal, and phones and
the TV never receive it early.

## Your own quiz show

| | |
|---|---|
| ![Round plan with show pages before and after a round](docs/screenshots/round-plan.png) | ![Show page editor with a live TV preview](docs/screenshots/show-pages.png) |
| ![Point pool editor](docs/screenshots/point-systems.png) | ![Host sees each player's pick](docs/screenshots/party-point-pool.png) |
| ![Phone picks 10, 20 or 30 points](docs/screenshots/phone-point-pool.png) | ![Phone with Risk it on](docs/screenshots/phone-risk.png) |
| ![TV when the leaderboard is off for a round](docs/screenshots/tv-round-over.png) | ![Phone when the leaderboard is off for a round](docs/screenshots/phone-round-over.png) |

## More screenshots

| | |
|---|---|
| ![Search](docs/screenshots/search.png) | ![Custom questions](docs/screenshots/custom.png) |
| ![Lists](docs/screenshots/lists.png) | ![Game setup](docs/screenshots/game-setup.png) |
| ![Party lobby with the party name and round plan](docs/screenshots/party-lobby.png) | ![TV lobby](docs/screenshots/tv-lobby.png) |
| ![Player profiles](docs/screenshots/profiles.png) | ![All-time leaderboard](docs/screenshots/leaderboard.png) |
| ![Data sources](docs/screenshots/data-sources.png) | ![Settings](docs/screenshots/settings.png) |
| ![Night mode](docs/screenshots/search-dark.png) | |

## Install

Download `KimHardaNeApp-Setup-<version>.exe` from
[Releases](https://github.com/The-Hasanov/KimHardaNeApp/releases) and run it. The installer is not
code-signed, so Windows SmartScreen warns on the first install: choose **More info → Run anyway**.
On a Mac with Apple silicon, download `KimHardaNeApp-<version>-arm64.dmg`, drag the app to Applications, and on the
first launch choose **System Settings → Privacy & Security → Open Anyway**.

Version 2 starts with an empty question bank: questions, lists and results from version 1 are not carried over,
and version 1 export files do not import. Install the question banks again from *Settings → Data sources*.

Windows Firewall asks once whether KimHardaNeApp may accept connections on private networks. Allow it, or
phones cannot join a party.

## Question banks

The app ships without questions. *Settings → Data sources* lists the question banks it can download from, each
with *Install*, *Refresh* and *Delete*. For now there is one: about 68,000 Azerbaijani questions from
[3sual.az](https://3sual.az/), collected from its public API by the included scraper (about an hour to install,
one request per second). The questions belong to their authors and to 3sual.az. Your own questions, edits, lists
and party data are kept apart from installs, refreshes, deletes and updates.

## Build from source

The question database is not in this repository. Install 3sual.az from *Settings → Data sources*, or build it
with the scraper (about 20 minutes, one request per second).

```bash
cd app
npm install
node scraper.js crawl --db ../data/kimhardane.sqlite
node scraper.js images --db ../data/kimhardane.sqlite   # optional, for offline images (~35 min)
npm start
```

Requires Node 22.5+. Other commands:

```bash
npm test          # offline tests
npm run dist      # Windows installer in app/dist
npm run dist:mac  # Mac (Apple silicon) disk image in app/dist
node bench/judge.js 1000  # benchmark the answer check
```

## Documentation

- [How the app works](docs/app.md): party and game modes, your own questions, search and editing, the
  installer and updates, and the search benchmark.
- [The scraper](docs/scraper.md): options, API endpoints, the SQLite schema, the JSONL export and the
  completeness checks.

## License

The code is under the [MIT License](LICENSE). The downloaded questions are not: they belong to their authors
and 3sual.az.
