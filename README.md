<img src="app/icon.png" alt="" width="96" align="right">

# KimHardaNeApp

A Windows desktop app for Azerbaijani quiz questions from [3sual.az](https://3sual.az/): search about 68,000
questions offline, edit them, build lists, and host *Nə? Harada? Nə zaman?* games with a TV and players'
phones.

![Search](docs/screenshots/search.png)

## Features

- **Search** by keyword, by meaning (a local AI model, no API key) or both. It ignores case and diacritics,
  so `baki` finds `Bakı`, and it forgives small typos.
- **Edit** questions, answers, comments and sources, or **add your own questions** (*New question*). Your
  edits and questions survive data refreshes and app updates.
- **Lists** of questions, played in the order you choose.
- **Game** helper for the host: 10 random questions with a timer, or play them yourself with the AI
  checking your answers.
- **Party mode**: players join from their phones with a QR code, and the TV shows the questions, a countdown
  with sound, the answer and the leaderboard. Works with a TV window, Miracast, or the web browser of a
  Samsung Smart TV.
- **Offline**: the installer bundles every question and image. Night mode included.

## Party mode

| Host (the app) | TV | Phone |
|---|---|---|
| ![Host console](docs/screenshots/party-host.png) | ![TV question](docs/screenshots/tv-question.png) | ![Phone question](docs/screenshots/phone-question.png) |
| ![Host reveal](docs/screenshots/party-reveal.png) | ![TV reveal](docs/screenshots/tv-reveal.png) | ![Phone reveal](docs/screenshots/phone-reveal.png) |

1. Open **Settings** and turn on AI search (it checks the answers).
2. In the **Game** tab pick **Party**, then **Open party**. The TV window opens with the join code.
3. Put the TV window on the TV: drag it there and press F11, or use **TV → Show on Samsung TV…** or
   **TV → Cast with Miracast…**.
4. Players scan the QR code on the same Wi-Fi and type a name.
5. Pick the questions and start the round. Turn on **Autoplay** to move on by itself.

The app window stays the host's console: only the host sees the answer before the reveal, and phones and
the TV never receive it early.

## More screenshots

| | |
|---|---|
| ![TV lobby](docs/screenshots/tv-lobby.png) | ![Game setup](docs/screenshots/game-setup.png) |
| ![Lists](docs/screenshots/lists.png) | ![Settings](docs/screenshots/settings.png) |
| ![Night mode](docs/screenshots/search-dark.png) | |

## Install

Download `KimHardaNeApp Setup <version>.exe` from
[Releases](https://github.com/The-Hasanov/KimHardaNeApp/releases) and run it. The installer is not
code-signed, so Windows SmartScreen warns on the first install: choose **More info → Run anyway**.

Windows Firewall asks once whether KimHardaNeApp may accept connections on private networks. Allow it, or
phones cannot join a party.

## Build from source

The question database is not in this repository. The scraper builds it from the public 3sual.az API
(about 20 minutes, one request per second).

```bash
cd app
npm install
node scraper.js crawl --db ../data/3sual.sqlite
node scraper.js images --db ../data/3sual.sqlite   # optional, for offline images (~35 min)
npm start
```

Requires Node 22.5+. Other commands:

```bash
npm test          # offline tests
npm run dist      # Windows installer in app/dist
```

## Documentation

- [How the app works](docs/app.md): search, editing, game and party modes, the installer and updates, and
  the search benchmark.
- [The scraper](docs/scraper.md): options, API endpoints, the SQLite schema, the JSONL export and the
  completeness checks.

## Credits

The questions belong to their authors and to [3sual.az](https://3sual.az/). The scraper reads only
public data, one request at a time.

## License

The code is under the [MIT License](LICENSE). The questions are not: they belong to their authors and 3sual.az.
