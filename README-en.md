<div align="center">

<h1>Campus Treasure Hunt</h1>

<img width="820" src=".github/assets/hero.webp" alt="Leader screen while waiting for a question, with the six-team score bar on top" />

<br>
<br>

[![Python](https://img.shields.io/badge/Python-3.14-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org)
[![Flask](https://img.shields.io/badge/Flask-3-000000?style=for-the-badge&logo=flask&logoColor=white)](https://flask.palletsprojects.com)

[繁體中文](README.md) | **English**

</div>

## Overview

Front and back end for the NTUST campus treasure hunt. Questions are printed as QR codes
and taped around campus. Each team has one leader; members vote on their own phones and
the leader decides what gets submitted.

```
Leader scans a question QR ─▶ the question appears on every phone in the team
                              members pick a choice (changeable, last one counts)
                              only the leader sees the tally and the voter count
Leader hits submit         ─▶ the top choice is submitted, tally and answer go public
Leader hits next           ─▶ the whole team goes back to waiting
```

### Rules

- The leader can discard a question at any time: all votes are thrown away, nothing is recorded
- On a tie, submit is locked until the leader picks one. With zero votes it stays locked too
- One submission per team per question. Rescanning an answered question shows a read-only result
- The leader does not vote

<br/>

## Getting started

### Requirements

- Python 3.14 or newer
- [uv](https://docs.astral.sh/uv/)
- Node (only for the frontend tests)

### Run it

```bash
git clone https://github.com/xinshoutw/campus-treasure.git
cd campus-treasure

uv sync
uv run main.py
```

Startup does three things, and refuses to start if any of them fails, so a broken question
set never makes it to the event:

1. Validates `.env` (6 leader keys, 6 member keys, all 12 distinct)
2. Validates `questions.yaml` (id format and uniqueness, `answer` must be one of `choices`, 2-10 choices, positive `points`, no misspelled keys)
3. Downloads every remote `image` into `static/cache/`, so the frontend only ever loads local files

nginx reverse-proxies to `HOST:PORT` (`192.168.10.101:20001` by default). TLS is your job.

> [!IMPORTANT]
> **The camera only works over HTTPS or on localhost.** Hitting
> `http://192.168.10.101:20001` straight from a phone gets you no camera. Everyone has to
> go through your `https://treasure.ntust.org`.

<br/>

## Configuration

`.env`:

| Key | What it does |
|---|---|
| `MEMBER_KEY` | **Member** tokens, `;` separated. **Position is the team number** (formerly `TEAM_KEY`) |
| `LEADER_KEY` | **Leader** tokens, same order, same count |
| `RANDOM_CHOICES` | Shuffle the choice order when a question opens |
| `SHOW_SCORES_IN_MENU` | Show the per-team score bar at the top |
| `RESET_TOKEN` | Token for wiping the event. **Leave it empty and `/reset` is disabled entirely** |
| `HOST` / `PORT` | Listen address |
| `SITE_URL` | Base URL `make_qr.py` bakes into the login QR codes |

The `questions.yaml` fields are documented at the top of that file.

<br/>

## Generating QR codes

```bash
uv run make_qr.py          # one PNG per QR
uv run make_qr.py --pdf    # multi-page A4 PDF, 2x4 per page, with cut lines
```

Output lands in `qr/`:

| File | Purpose | Printed label |
|---|---|---|
| `leader_1.png` … `leader_6.png` | **Leader** login | `LEADER n` |
| `member_1.png` … `member_6.png` | **Member** login | `TEAM n` |
| `ABCDE.png` … | Questions, encoding the five-letter code; only leaders can scan them | the code itself |
| `qrcodes.pdf` | `--pdf` output. The QR codes are vector, so printing large stays crisp | — |

> [!WARNING]
> **Do not let the leader stack get mixed into the member stack.** Whoever holds a leader QR
> can submit on behalf of the whole team. Leader tokens are not device-limited, which is
> deliberate: when the leader's phone dies, a deputy scans the same sheet and takes over.

Always use `segno.make_qr()`, **never `segno.make()`**. Given payloads as short as five
characters the latter picks a Micro QR (`M2-M`, a single finder pattern), and jsQR does not
support Micro QR, so the printed code is completely unscannable.

Labels on the PDF are deliberately ASCII-only (`TEAM 1`, `ABCDE`) so no CJK font has to be
embedded. For which sticker belongs to which question, read the mapping the script prints.

<br/>

## Tests

```bash
uv run test_main.py    # backend
node test_web.cjs      # frontend (boots its own server)
```

Neither uses a test framework, just `assert`, and neither touches `.env` or the real
`data.json`.

- `test_main.py` — question validation, roles and permissions, voting and re-voting, ties
  and zero votes, discarding, rescanning an answered question, two leaders submitting at
  once, online-count timeout, `/reset` backup
- `test_web.cjs` — the real `static/app.js` running inside a minimal DOM stub in Node,
  against a server that actually boots. Each simulated phone is its own vm context, so
  "one leader plus three members" really is four clients talking to each other

<br/>

## Stack

| Piece | Choice |
|---|---|
| Backend | Flask 3 and waitress, single process, 8 threads |
| Frontend | Plain JS. No framework, no build step |
| State | Open rounds live in memory; submitted answers go to `data.json` |
| QR decoding | Vendored jsQR, no CDN |
| QR generation | segno and fpdf2 |
| Packaging | uv |

### Layout

```
main.py                config and question validation, state machine, API, data.json I/O
make_qr.py             login and question QR codes (PNG or A4 PDF)
questions.yaml         question bank, fields documented at the top
templates/index.html   single page, all four screens toggled with hidden
static/app.js          the whole frontend: login, camera, polling, voting, submitting
static/style.css       design tokens and layout
static/jsQR.js         vendored QR decoder, minified
static/cache/          question images downloaded at startup (gitignored)
qr/                    make_qr.py output (gitignored)
test_main.py           backend tests
test_web.cjs           frontend end-to-end tests
data.json              answer log, created at runtime (gitignored)
```

<br/>

## Design notes

- Single process (waitress, 8 threads). **Do not run multiple workers**: the in-memory state
  splits and scores overwrite each other. Starting without going through `main.py`'s
  `__main__` (say, `gunicorn main:app`) makes every request return 503 rather than quietly
  flushing empty state over `data.json`.
- The frontend polls `/api/state` every **300ms**; the server decides everything on screen.
  No SSE or WebSocket: each long-lived connection pins a waitress thread, and 40 devices is
  far past 8. Measured (6 teams x 12 questions all answered, score bar on, choice shuffling
  on): 42 devices at 42 req/s gave p50 1.2ms / p99 37ms, 96 devices at 95 req/s gave p50
  1.6ms. What 300ms costs is member mobile data, roughly 3MB per device per hour
  (272 B per gzipped response).
- **Do not turn on the Cloudflare proxy.** Measured, it moves time-to-first-byte from 17ms
  to 1.2s, and every single poll of the event pays that. Hitting the origin directly, nginx
  terminates TLS itself.
- The submit check and the write happen inside one `threading.Lock`, so when two leader
  phones hit submit together only the first one counts.
- Choice order is shuffled **once when the round opens** and then fixed (`RANDOM_CHOICES`).
  Reshuffling on every poll would rearrange the choices under the user's finger every second.
- Anyone who has voted counts as present. Voting and then locking the phone is normal, and a
  locked phone stops polling, so going by heartbeats alone the leader sees "3 voted, 0 online".
- The leader's camera is on only while waiting for a question and shuts off once the round
  opens, giving the screen over to the tally. For members it is off permanently after login.
- QR decoding uses the vendored `static/jsQR.js`, so every device takes the same path. It is
  minified (58KB to 46KB gzipped). To change versions or patch it, get the original source
  back and re-run:

  ```bash
  bun build static/jsQR.js --no-bundle --minify --outfile=tmp.js && mv tmp.js static/jsQR.js
  ```

  `--no-bundle` is required: without it the bundler eats the UMD wrapper and `window.jsQR`
  disappears.

<br/>

## During the event

- **Changing questions**: edit `questions.yaml` and restart. Login state lives in the
  browser's localStorage, so a restart logs nobody out.
- **A restart interrupts open rounds**: unsubmitted votes only exist in memory, so after a
  restart the team is back at "waiting for a question" and the leader rescans to continue.
  Submitted answers and scores survive intact. So pick a moment when no team is mid-vote.
- **Scores** are computed from the answer log in `data.json` on the fly with no cache, so
  editing `points` shows up immediately for every team.
- **Backups**: every answer rewrites `data.json` in full, then fsync, then atomic rename.
  Copying the file gives you a complete snapshot.

### Wiping the event

```bash
curl -X POST https://treasure.ntust.org/reset -H "X-Reset-Token: $RESET_TOKEN"
```

Clears every team's score and answer log. **Before clearing, `data.json` is renamed to
`data.<timestamp>.json`**, so a misfire is recoverable: rename the backup back to
`data.json` and restart.

- `POST` only. `GET` returns 405, which keeps browser prefetch, chat-app link previews and
  crawlers from tripping it
- With no `RESET_TOKEN` set it returns 404; the endpoint simply does not exist
- If `RESET_TOKEN` matches any team's token, startup refuses to run

<br/>

## Pre-event manual checklist

Run this on a real phone against the real HTTPS address:

- [ ] iPhone Safari: scan the login QR, get in
- [ ] Android Chrome: scan the login QR, get in
- [ ] Scan the login QR with the built-in camera app (opens the browser with `?token=`): get in, and the token is stripped from the address bar
- [ ] Cycle "switch camera" to find the lens that focuses up close; it stays selected after a reload
- [ ] Scan a question QR, answer correctly, score goes up, the top bar updates
- [ ] Answer wrong, the correct answer is shown, 0 points
- [ ] Rescan the same question: "a teammate already answered this", score unchanged
- [ ] Two phones on the same team submit different answers at once: only one counts
- [ ] Deny camera permission: typing the five-letter code by hand still works
- [ ] Look at the screen outdoors at noon and confirm it is readable

<br/>

## Contributing

Before opening a PR:

1. `uv run test_main.py` and `node test_web.cjs` both pass
2. Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
3. Branches named `feat/your-feature` or `fix/your-fix`
4. No emoji

Dependency updates arrive as one Dependabot PR every Monday, see
[`.github/dependabot.yml`](.github/dependabot.yml).

<br/>

## Disclaimer

This project is not officially affiliated with National Taiwan University of Science and Technology.
