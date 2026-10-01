# The 3sual.az scraper

`app/scraper.js` collects every publicly accessible quiz question on
[3sual.az](https://3sual.az/) through its public JSON API. It stores the raw
package documents and normalized question records in SQLite and exports JSONL.
It has no dependencies beyond Node, runs one request at a time, and can resume
after an interruption. The desktop app in `app/` runs the same scraper as its 3sual.az data source (*Settings → Data sources*).

## Install

Requires Node 22.5+ (built-in `node:sqlite` and `fetch`). Tested on Node 26.

```bash
cd app
node scraper.js   # prints the usage line; options are listed below
```

## Usage

```bash
cd app

# small test: first 5 listed packages
node scraper.js crawl --db ../sample/sample.sqlite --limit-packages 5

# full collection (~20 min at the default 1 s delay); prints a JSON report to stdout
node scraper.js crawl --db ../data/3sual.sqlite > report.json

# interrupted (Ctrl+C)? run the same command again: finished list pages and stored packages are skipped
node scraper.js crawl --db ../data/3sual.sqlite

# start over with a fresh listing (stored packages are still skipped unless --refresh)
node scraper.js crawl --db ../data/3sual.sqlite --new-run
node scraper.js crawl --db ../data/3sual.sqlite --new-run --refresh   # also refetch every package

# question images (handouts, theme media) for offline use: ~35 min at 1 s/request, resumable
node scraper.js images --db ../data/3sual.sqlite       # files go to images/ next to the database

# export
node scraper.js export --db ../data/3sual.sqlite --out questions.jsonl
node scraper.js export --db ../data/3sual.sqlite --out questions_raw.jsonl --include-raw

# tests (offline; the parser tests need saved API responses in app/fixtures, which are not published)
npm test
```

The Node scraper replaced an earlier Python one and writes the same schema and records. Re-parsing all
926 stored packages gave identical question, phase and theme rows (68,565 / 3,014 / 8,402), and live
fetches match the stored rows and image hashes.

| Option | Default | Meaning |
|---|---|---|
| `--delay` | `1.0` | Seconds between requests. Requests are always sequential. |
| `--retries` / `--timeout` | `5` / `30` | Retries on timeouts, connection errors, 429 and 5xx. Backoff is 2, 4, 8, 16, 32 s plus jitter, capped at 120 s. `Retry-After` is honoured. |
| `--limit-packages N` | – | Only the first N listed packages. Turns the author audit off. |
| `--list-passes` | `2` | Traverse the listing again if unique IDs fall short of the reported `count`. |
| `--audit-authors` | `auto` | `counts`: diff author listings only where per-author counts disagree. `full`: diff every author listing (~1,500 requests). `auto`: `counts` on full crawls, `off` with a limit. |
| `--refresh` | off | Refetch packages that are already stored (once per run, so a resumed refresh continues where it stopped). Rows edited in the app are kept. |
| `--new-run` | off | Do not resume the last unfinished run. |

**Exit status:** `0` when the run is complete. `1` when anything is missing, meaning a failed or partial
package, a listing error, coverage below `count`, or an error-severity parse problem. `130` when
interrupted. Progress is logged to stderr. The final report goes to stdout and is also stored in
`runs.report_json`.

## Endpoints used

All requests are `GET https://api-v2.3sual.az/api/…` with no authentication.

| Endpoint | Used for | Observed shape |
|---|---|---|
| `packages/forhome?page=N&games=1,2,3,4,5,6,7&word=` | Package listing (15 per page) | `{count, packages:[{id, name, game, organization:{name, logo}, date}]}`. A page past the end returns `packages: []`. |
| `packages/foruse?id=ID` | Package detail | `{package:{id, name, isReady, played, added, updated, information, game:{id, name, with_Theme}, editors[], tags[], phases[]}, tournament:{id, name, isLeague, continuation_ID, continuation, organizations[], organizers[]}, user, copies[], viewtype}`. An unknown ID returns **HTTP 204** with an empty body. |
| `info/stats` | Reference counts | `{packages, tournaments, authors, organizations, games, nhn, br, xamsa, theme}` |
| `authors?page=N&perpage=100&detailed=true&search=` | Audit: per-author counts | `{count, authors:[{id, fullname, questions, themes, editors, other, user}]}` |
| `authors/questions?id=A&page=N&perpage=100` | Audit: an author's questions | `{id, fullname, count, results:[{id(package), name, game, isReady, questions[], themes:null}]}`. `count` counts questions. Entries have **no `authors` field**. |
| `authors/themes?id=A&page=N&perpage=100` | Audit: an author's themes | Same shape with `themes[]` |

Game IDs: 1 Nə? Harada? Nə zaman?, 2 Xəmsə, 3 Fərdi Oyun, 4 Breyn Rinq, 5 Erudit-kvartet,
6 OSİP, 7 Quiz. Media paths resolve under `https://api-v2.3sual.az/images/`.

Not used: `questions/search` (a keyword search that needs `limit` and `keywords`, so it can't
enumerate), `packages/forcont?id=` (tournament series view), and the logged-in `editor/*`,
`users/*` and `auth/*` routes.

### Package detail structure

```
package.phases[]                      phase: {id, name, information, questions|null, themes|null, subs|null}
  .subs[]                             sub-phase, same shape, recursive (walked to any depth)
  .questions[]                        question-style games (NHN, Breyn Rinq, OSİP):
      {comment, notebefore, considered, isTranslated, isRekvizitForAll, sources[], authors[], values[]}
      values[]: {id, text, answer, rekvizit: null | {text: bool, rekvizit: str}}
      1 value = normal question; 2/3/4 = duplet / blits / kvadriplet sharing parent comment and sources
  .themes[]                           theme-style games (Xəmsə, Fərdi Oyun, Erudit-kvartet, Quiz):
      {id, raund, name, information, authors[], sources[], values[]}
      values[]: {id, text, answer, comment, rekvizit: null | "path", source_media: null | "path", sources[]}
```

Question-level objects have **no ID of their own**. A value's `id` is the stable key. Parent
questions are grouped under `group_key = "q:<first value id>"`, and themes under `"t:<theme id>"`.
Text fields may contain the site's line-break marker `/-/`. It is preserved as-is.

## SQLite schema

| Table | Key | Contents |
|---|---|---|
| `runs` | `id` | One row per crawl: status (`running`/`interrupted`/`finished`), args, site stats, final report |
| `list_pages` | `(run_id, pass, page)` | Listing pages already fetched, used to resume a run |
| `list_sightings` | `(run_id, pass, page, package_id)` | Every package seen on every page, used for duplicate and shift detection |
| `package_list` | `package_id` | Listing metadata. `source` is `list` or `author_listing` |
| `packages` | `id` | `status` (`ok`/`empty`/`partial`/`failed`), error, metadata, `n_values`, **`raw_json`** (the full `foruse` document), attempts |
| `tournaments` | `id` | Tournament metadata plus raw JSON |
| `phases` | `(package_id, phase_id)` | `parent_phase_id`, `depth`, position, name, information |
| `themes` | `(package_id, theme_id)` | Phase, round (`raund`), name, information, authors, sources |
| `questions` | `(package_id, kind, value_id)`, `uid` unique | One row per question value (columns below) |
| `authors` | `id` | Per-author counts reported by the site (audit) |
| `embeddings` | `uid` | Created by the desktop app: `hash` (model + embedded text) and `vec` (1,024 float32). A hash mismatch means the vector is stale |
| `images` | `url` | `status` (`ok`/`failed`), `path` (relative to the database folder, `images/<ab>/<sha1(url)>.<ext>`), bytes, content type, SHA-256, error |
| `lists` | `id` | Created by the desktop app: the user's question lists (`name`, `created_at`). Kept when the 3sual.az data source is deleted |
| `list_questions` | `(list_id, uid)` | Questions of each list, ordered by `position`, with `added_at` |
| `play_games` | `id` | Created by the desktop app: one row per Play-mode game (title, list, timing, question count, start and finish). Kept when the data source is deleted |
| `play_answers` | `(game_id, position)` | The player's answer to each question, the AI verdict and similarity, the final `is_correct` and whether the player decided it |
| `errors` | `id` | `stage` (`list`/`fetch`/`parse`/`audit`/`stats`), `severity` (`error`/`warning`), package ID, JSON path, message, raw snippet |

Reruns are idempotent. Each package is replaced atomically: its phases, themes, question rows
and parse errors are deleted and rewritten in one transaction. The same value ID in two
packages (for example, a package reused by another tournament) gives two rows with different
`uid`s. The report counts these.

## JSONL export (`questions.jsonl`)

One JSON object per question value, ordered by package and play order:

| Field | Notes |
|---|---|
| `uid` | `"<package_id>:<kind>:<value_id>"` (stable) |
| `value_id`, `kind` | API value ID. `kind` is `question` (from `phases[].questions`) or `theme` (from `themes[].values`) |
| `origin` | `package`, or `author_listing` when only the author audit revealed the value |
| `ordinal`, `position`, `group_key`, `group_size`, `group_index` | Order in the package, index of the question/theme in its phase, grouping of multi-part questions |
| `package_id`, `package_name`, `package_played`, `package_is_ready` | Package context. `package_is_ready` is false for unlisted packages found by the audit. |
| `tournament_id`, `tournament_name`, `tournament_continuation` | Tournament context |
| `game_id`, `game_name` | Game |
| `phase_id`, `phase_name`, `subphase_id`, `subphase_name`, `phase_path` | Top phase, deepest sub-phase, full path `[{id, name}, …]` |
| `theme_id`, `theme_name`, `theme_round`, `theme_information` | Theme-style games only |
| `text`, `answer` | Question text and answer |
| `comment` | The value's own comment (themes), or the parent question's comment |
| `accepted_answers` | Parent `considered` field (accepted answer variants) |
| `note_before` | Parent `notebefore` (host note) |
| `rekvizit_text`, `rekvizit_url` | Handout: text, or an image URL under `/images/` |
| `rekvizit_path`, `source_media_path` | Downloaded copy of the image, relative to the database folder, when `images` has run |
| `source_media_url` | Theme value `source_media` image URL |
| `sources` | Value sources merged with parent sources, de-duplicated |
| `authors` | `[{id, user, fullname}]` from the question or theme |
| `is_translated`, `is_rekvizit_for_all` | Parent flags. With `is_rekvizit_for_all`, the first value's handout applies to the whole group. |
| `edited_at` | When the question was last edited in the desktop app, else null |
| `raw_value`, `raw_parent` | Only with `--include-raw`: the untouched value and its parent without `values` |

## Completeness checks

- **Listing.** Pages are walked until an empty page appears past `ceil(count / page_size)`.
  `count` is re-read on every page, so growth mid-run extends the walk. Empty pages before the
  end are logged as warnings. IDs seen on more than one page (items shifting while paging) are
  counted as `duplicate_sightings`. If unique IDs fall short of `count`, the listing is walked
  again (`--list-passes`).
- **Details.** Every listed package must end as `ok` or `empty`. A `failed` package (HTTP error,
  204, invalid JSON, or a document whose `package.id` differs from the requested ID) or a
  `partial` one (at least one record could not be normalized) makes the run incomplete. The next
  run retries it.
- **Malformed records.** A phase, theme or value with no integer `id`, a question with no values,
  a non-list container, or a duplicate value ID with different content is written to `errors`
  with the package ID and JSON path. The rest of the package is still stored, and the raw
  document is always kept.
- **Author audit.** Per-author `questions`/`themes` counts from `authors` are compared with the
  distinct question groups and themes credited to each author in the database. For every
  mismatch, that author's listing is fetched and diffed by value ID. Packages it references that
  were never collected are fetched through `packages/foruse`. Values still missing after that are
  stored with `origin = "author_listing"`.

## Access restrictions and known gaps

- No login is used. Nothing behind `auth`, `users`, `editor` or `Authorization` headers is
  requested.
- Some listed packages return phases with empty `questions` arrays (174, 175 and 3980). The API exposes no questions for them. They are
  stored as `status = empty` and listed in the report under `packages.empty_ids`.
- `info/stats.packages` (917) differs slightly from the listing `count` (919). The listing count
  is the completeness target. Both are reported.
- Package IDs are sparse (up to about 4,000 for about 919 packages). IDs that appear neither in
  the listing nor in any author listing are **not** probed, because the scraper does not
  enumerate IDs.

The results of the full run are in [Full-run results](#full-run-results).

## Full-run results

Run of 2026-09-26: `crawl` exit 0, report `complete: true`, 1,092 requests, about 18.5 minutes.

| Check | Result |
|---|---|
| Listing | 919 unique packages, matching `count` 919. 1 pass, 0 duplicate sightings, 0 empty pages. |
| Package details | 923 `ok`, 3 `empty` (174, 175, 3980), 0 `failed`, 0 `partial` |
| Question rows | 68,565: 26,856 question values and 41,709 theme values. 68,436 distinct value IDs. |
| Cross-package duplicates | 129 values appear in two packages: package pairs 40/221 (60 values) and 96/230 (69 values) |
| Errors / warnings | 0 errors. 22 warnings, all identical duplicates inside author-listing responses. |
| vs `info/stats` | Breyn Rinq groups 2,202 = `br` 2,202. NHN 23,436 + OSİP 236 (listed packages) = `nhn` 23,672. Theme count 8,366 = `theme` 8,284 + `xamsa` 82. |
| Author audit | 506 authors. 37 of about 1,012 counts disagreed, and those listings were diffed. |
| Found by the audit | **7 packages absent from the listing**: 7, 95, 450, 627, 1646, 2856, 3955. That is 357 values, all with `isReady: false`. |
| After the audit | 6 authors are still off by exactly 1. Each is explained by the same entry appearing twice in that author's own listing, so no values are missing. |

The 7 unlisted packages are publicly reachable: they are linked from the public author pages and
served by `packages/foruse` without authentication. They are included with
`package_list.source = 'author_listing'`, `packages.is_ready = 0`, and `package_is_ready: false`
in the JSONL. Filter on that field to keep only packages the site lists.
