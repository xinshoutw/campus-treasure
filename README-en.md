<div align="center">

<h1>Campus Treasure Hunt</h1>

[![Python](https://img.shields.io/badge/Python-3.14-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org)
[![Flask](https://img.shields.io/badge/Flask-3-000000?style=for-the-badge&logo=flask&logoColor=white)](https://flask.palletsprojects.com)
[![License](https://img.shields.io/github/license/xinshoutw/campus-treasure?style=for-the-badge)](LICENSE)

[繁體中文](README.md) | **English**

</div>

## Overview

<img align="right" width="420" alt="Leader screen while waiting for a question, with the six-team score bar on top" src=".github/assets/hero.webp" />

Front and back end for the NTUST CSIE campus treasure hunt. Find the QR codes hidden around campus and solve the puzzles together with your leader and teammates

### Rules

- The leader is a neutral referee: they scan questions, can end a round, and on a tie talk it through with the members to reach a final consensus
- One submission per team per question
- Only members can vote

<br clear="right"/>

## Getting Started

### Requirements

- Python 3.14 or newer
- [uv](https://docs.astral.sh/uv/)
- Node (only for the frontend tests)

### Run It

```bash
git clone https://github.com/xinshoutw/campus-treasure.git
cd campus-treasure

uv sync
uv run src/main.py
```

1. Validates `.env` (token uniqueness)
2. Validates `questions.yaml` (id format and uniqueness, `answer` must be one of `choices`, 2-10 choices, positive `points`, correct field names)
3. Caches the remote images in `image` into `static/cache/`

<br/>

## Configuration

`.env`:

| Key | Description |
|---|---|
| `MEMBER_KEY` | **Member** tokens, `;` separated, same count as `LEADER_KEY` |
| `LEADER_KEY` | **Leader** tokens, `;` separated, same count as `MEMBER_KEY` |
| `RANDOM_CHOICES` | Whether to randomize choice order |
| `SHOW_SCORES_IN_MENU` | Whether to show every team's score publicly |
| `RESET_TOKEN` | Resets the game. **Leave empty to disable** |
| `HOST` / `PORT` | Listen address |
| `SITE_URL` | Domain `make_qr.py` uses for the login QR codes |

The `questions.yaml` fields are documented at the top of that file.

<br/>

## Generating QR Codes

```bash
uv run src/make_qr.py      # one PNG per QR
uv run src/make_qr.py --pdf # multi-page A4 PDF, 2x4 per page, with cut lines
```

Output lands in `qr/`:

| File | Purpose | Printed label |
|---|---|---|
| `leader_1.png` … `leader_6.png` | **Leader** login | `LEADER n` |
| `member_1.png` … `member_6.png` | **Member** login | `TEAM n` |
| `ABCDE.png` … | Hunt questions, five-letter code | ABCDE |
| `qrcodes.pdf` | `--pdf` output, vector | — |

<br/>

## Tests

```bash
uv run tests/test_main.py    # backend
node tests/test_web.cjs      # frontend
```

<br/>

## Stack

| Piece | Choice |
|---|---|
| Backend | Flask 3 and waitress, single process, 8 threads |
| Frontend | Plain JS |
| State | Open rounds in memory; submitted results in `data.json` |
| QR decoding | vendored jsQR |
| QR generation | segno and fpdf2 |
| Packaging | uv |

### Layout

```
src/main.py                config and question validation, state machine, API, data.json I/O
src/make_qr.py             login and question QR codes (PNG or A4 PDF)
src/templates/index.html   single page, all four screens toggled with hidden
src/static/app.js          frontend: login, camera, polling, voting, submitting
src/static/style.css       design tokens and layout
src/static/jsQR.js         vendored QR decoder, minified
src/static/cache/          question images downloaded at startup (gitignored)
tests/test_main.py         backend tests
tests/test_web.cjs         frontend end-to-end tests
questions.yaml             question bank, fields documented at the top
qr/                        make_qr.py output (gitignored)
data.json                  answer log, created at runtime (gitignored)
```

<br/>

## Resetting The Game

```bash
curl -X POST https://treasure.ntust.org/reset -H "X-Reset-Token: $RESET_TOKEN"
```

Backs `data.json` up in the same directory, then clears every team's score and answer log

<br/>

## Contributing

Before opening a PR:

1. `uv run tests/test_main.py` and `node tests/test_web.cjs` pass
2. Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
3. Branches named `feat/your-feature` or `fix/your-fix`
4. No emoji

<br/>

## License

Copyright (C) 2026 xinshoutw

This project is licensed under the **GNU Affero General Public License v3.0 or later**. Full terms in [LICENSE](LICENSE)

<br/>

## Disclaimer

This project is not officially affiliated with National Taiwan University of Science and Technology.
