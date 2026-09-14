#!/usr/bin/env python3
"""Campus treasure hunt, Flask backend.

Runs as a single process (waitress, multi-threaded). All state lives in memory;
every answer rewrites data.json in full inside the lock and swaps it in
atomically, so a restart never loses points.
"""

import functools
import json
import os
import random
import re
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter
from hashlib import sha1
from pathlib import Path

import yaml
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from waitress import serve

BASE = Path(__file__).parent
DATA_FILE = BASE / "data.json"
QUESTIONS_FILE = BASE / "questions.yaml"
CACHE_DIR = BASE / "static" / "cache"

ID_RE = re.compile(r"^[A-Z]{5}$")
MIN_CHOICES, MAX_CHOICES = 2, 10
QUESTION_KEYS = {"id", "content", "answer", "choices", "image", "points"}
FETCH_UA = "Mozilla/5.0 (compatible; treasure-hunt/1.0)"
FETCH_TIMEOUT = 20
ONLINE_TIMEOUT = 30   # Seconds. Too short and glancing at a message marks a member offline.


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

def _die(errors, header):
    print(f"\n[錯誤] {header}\n", file=sys.stderr)
    for err in errors:
        print(f"  {err}", file=sys.stderr)
    print(f"\n共 {len(errors)} 個錯誤，未啟動。\n", file=sys.stderr)
    raise SystemExit(1)


def _flag(name, default=True):
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _token_list(name):
    return [t.strip() for t in os.getenv(name, "").split(";") if t.strip()]


def load_config():
    """Two rows of tokens, position is the team number: LEADER_KEY, then MEMBER_KEY.

    All 12 must be distinct. A token that is both a leader and a member resolves
    to whichever list matches first, so behaviour depends on list order, and
    nobody is going to debug that on the day of the event.
    """
    load_dotenv(BASE / ".env")
    members = _token_list("MEMBER_KEY")
    leaders = _token_list("LEADER_KEY")
    reset_token = os.getenv("RESET_TOKEN", "").strip()
    errors = []

    if os.getenv("TEAM_KEY"):
        errors.append("TEAM_KEY 已改名 MEMBER_KEY（隊員），另外要加一排 LEADER_KEY（隊輔）")
    if not members:
        errors.append(".env 缺少 MEMBER_KEY（格式：MEMBER_KEY=第1隊隊員;第2隊隊員;…）")
    if not leaders:
        errors.append(".env 缺少 LEADER_KEY（格式：LEADER_KEY=第1隊隊輔;第2隊隊輔;…）")
    if members and leaders and len(members) != len(leaders):
        errors.append(
            f"MEMBER_KEY 有 {len(members)} 把、LEADER_KEY 有 {len(leaders)} 把，"
            "數量必須一致（順序即隊號）"
        )

    everyone = members + leaders
    if len(set(everyone)) != len(everyone):
        errors.append("MEMBER_KEY 與 LEADER_KEY 裡有重複的 token，角色與隊號會混在一起")
    if reset_token and reset_token in everyone:
        errors.append("RESET_TOKEN 與某一把隊伍 token 相同，那隊隨手一掃就會清空全場")

    if errors:
        _die(errors, ".env 設定錯誤")
    return members, leaders, reset_token, _flag("RANDOM_CHOICES"), _flag("SHOW_SCORES_IN_MENU")


# --------------------------------------------------------------------------
# Question bank: validated strictly at startup, any error refuses to boot
# --------------------------------------------------------------------------

def _check_question(index, item, seen):
    where = f"[{index}]"
    if not isinstance(item, dict):
        return [f"{where} 這一項不是物件，請檢查縮排"], None

    qid = item.get("id")
    label = f"{where} {qid}" if isinstance(qid, str) else where
    errors = []

    unknown = set(item) - QUESTION_KEYS
    if unknown:
        errors.append(f"{label}: 不認識的欄位 {sorted(unknown)}，是不是打錯字？")

    if not isinstance(qid, str) or not ID_RE.match(qid):
        errors.append(f"{label}: id 必須是 5 碼大寫英文字母，目前是 {qid!r}")
    elif qid in seen:
        errors.append(f"{label}: id 重複（與第 {seen[qid]} 題撞號）")

    content = item.get("content")
    if not isinstance(content, str) or not content.strip():
        errors.append(f"{label}: content 不可為空")

    raw_choices = item.get("choices")
    if not isinstance(raw_choices, list):
        errors.append(f"{label}: choices 必須是陣列，請檢查縮排")
        choices = []
    else:
        choices = [str(c).strip() for c in raw_choices]
        if not (MIN_CHOICES <= len(choices) <= MAX_CHOICES):
            errors.append(
                f"{label}: choices 數量必須介於 {MIN_CHOICES}-{MAX_CHOICES}，目前 {len(choices)}"
            )
        if any(not c for c in choices):
            errors.append(f"{label}: choices 裡有空白選項")
        if len(set(choices)) != len(choices):
            errors.append(f"{label}: choices 有重複選項")

    answer = item.get("answer")
    if answer is None:
        errors.append(f"{label}: 缺少 answer")
    else:
        answer = str(answer).strip()
        if choices and answer not in choices:
            errors.append(
                f"{label}: answer {answer!r} 不在 choices 裡\n"
                f"      choices = {choices}"
            )

    points = item.get("points", 1)
    if isinstance(points, bool) or not isinstance(points, (int, float)) or points <= 0:
        errors.append(f"{label}: points 必須是正數，目前是 {points!r}")

    image = item.get("image")
    if image is not None and (
        not isinstance(image, str) or not image.startswith(("http://", "https://"))
    ):
        errors.append(f"{label}: image 必須是 http(s) 網址，目前是 {image!r}")

    if errors:
        return errors, None
    return [], {
        "id": qid,
        "content": content.strip(),
        "answer": answer,
        "choices": choices,
        "points": points,
        "image": image,
        "image_url": None,
    }


def load_questions():
    try:
        raw = yaml.safe_load(QUESTIONS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        _die([f"找不到 {QUESTIONS_FILE.name}"], "題庫讀取失敗")
    except yaml.YAMLError as exc:
        _die([str(exc).replace("\n", "\n  ")], "questions.yaml 語法錯誤")

    items = (raw or {}).get("questions")
    if not isinstance(items, list) or not items:
        _die(["questions.yaml 需要一個非空的 questions 陣列"], "題庫格式錯誤")

    errors, seen, questions = [], {}, {}
    for index, item in enumerate(items, 1):
        item_errors, question = _check_question(index, item, seen)
        errors.extend(item_errors)
        if question:
            seen[question["id"]] = index
            questions[question["id"]] = question
    if errors:
        _die(errors, "questions.yaml 驗證失敗")
    return questions


# --------------------------------------------------------------------------
# Image cache: pull remote images at startup so the event needs no image host
# --------------------------------------------------------------------------

# Extensions always come from this table. This used to take the second half of
# Content-Type verbatim, but that string is fully controlled by the remote host:
# image/../../x would produce an absurd filename and take the whole startup down.
_CONTENT_TYPE_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
}
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def _fetch_image(url):
    stem = sha1(url.encode()).hexdigest()[:12]
    for existing in CACHE_DIR.glob(stem + ".*"):
        return existing, True

    req = urllib.request.Request(url, headers={"User-Agent": FETCH_UA})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
        ext = _CONTENT_TYPE_EXT.get(ctype)
        if not ext:
            raise ValueError(f"不支援的圖片格式（Content-Type: {ctype or '未提供'}）")
        body = resp.read(MAX_IMAGE_BYTES + 1)
        if len(body) > MAX_IMAGE_BYTES:
            raise ValueError(f"圖片超過 {MAX_IMAGE_BYTES // 1024 // 1024} MB")

    path = CACHE_DIR / f"{stem}{ext}"
    path.write_bytes(body)
    return path, False


def cache_images(questions):
    todo = [q for q in questions.values() if q["image"]]
    if not todo:
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    print(f"準備 {len(todo)} 張題目圖片…")

    errors = []
    for question in todo:
        try:
            path, cached = _fetch_image(question["image"])
        except Exception as exc:  # A failed download is fatal: a broken image is a broken question
            errors.append(f"{question['id']}: 下載失敗 {question['image']}\n      {exc}")
            print(f"  {question['id']} → 失敗：{exc}")
            continue
        question["image_url"] = f"/static/cache/{path.name}"
        print(f"  {question['id']} → static/cache/{path.name}{'（已快取）' if cached else ''}")
    if errors:
        _die(errors, "題目圖片下載失敗")


# --------------------------------------------------------------------------
# Storage: memory first, every answer rewrites in full inside the lock, then
# an atomic rename
# --------------------------------------------------------------------------

_lock = threading.Lock()
_data = {"teams": {}}

# The open round, memory only: a restart drops it and the leader rescans.
# Submitted answers live in _data, so points still survive a restart.
_live = {}   # team number (str) -> {"phase", "qid", "choices", "votes": {device: choice}}
_seen = {}   # team number (str) -> {device: monotonic timestamp}


# Incremented whenever state actually changes. The frontend uses it to drop
# stale responses, the ones the server computed long ago that a slow downlink
# only just delivered, which would wipe a member's fresh vote off the screen.
# _seen updates do not count, or every poll would bump it and nothing would
# ever look stale.
_version = 0


def _bump():
    """Caller must hold _lock."""
    global _version
    _version += 1


def _blank_round():
    return {"phase": "idle", "qid": None, "choices": [], "votes": {}}


def load_data():
    if not DATA_FILE.exists():
        return {"teams": {}}
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        _die(
            [f"{DATA_FILE.name} 讀不了：{exc}", "先備份再刪掉它，就會從零開始"],
            "data.json 損毀",
        )
    data.setdefault("teams", {})
    return data


def _backup_data():
    """Caller must hold _lock. Moves data.json aside to a timestamped backup and
    returns its name.
    """
    if not DATA_FILE.exists():
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = DATA_FILE.with_name(f"data.{stamp}.json")
    collision = 0
    while backup.exists():
        collision += 1
        backup = DATA_FILE.with_name(f"data.{stamp}-{collision}.json")
    os.replace(DATA_FILE, backup)
    return backup.name


def _flush():
    """Caller must hold _lock."""
    tmp = DATA_FILE.with_name(DATA_FILE.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(_data, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, DATA_FILE)


def _score(team):
    """Computed from the answer log on the fly, no redundant stored field.
    Caller must hold _lock.
    """
    answers = _data["teams"].get(str(team), {})
    return sum(
        QUESTIONS[qid]["points"]
        for qid, rec in answers.items()
        if rec["correct"] and qid in QUESTIONS
    )


def _round(team):
    """Caller must hold _lock."""
    return _live.setdefault(str(team), _blank_round())


def _online(team):
    """Caller must hold _lock. Also drops timed-out devices, or the count only grows.

    Anyone who has voted counts as present. Voting and then locking the phone is
    normal, and a locked phone stops polling, so going by _seen alone the leader
    would see "3 voted, 0 online" with the votes right there and the people
    standing next to them.
    """
    now = time.monotonic()
    seen = _seen.setdefault(str(team), {})
    for device, last in list(seen.items()):
        if now - last >= ONLINE_TIMEOUT:
            del seen[device]
    live = _live.get(str(team))
    return len(set(seen) | set(live["votes"] if live else ()))


def _tally(live):
    """Caller must hold _lock. Returns (counts per choice, the leading choices).

    Winners follow the order of live["choices"], so a tie list looks identical
    to everyone.
    """
    counts = Counter(live["votes"].values())
    top = max(counts.values(), default=0)
    winners = [c for c in live["choices"] if counts.get(c, 0) == top] if top else []
    return counts, winners


def _state(team, role, device=None):
    """Caller must hold _lock. What a member receives never includes the tally
    or the correct answer.
    """
    answers = _data["teams"].get(str(team), {})
    live = _round(team)
    state = {
        "team": team,
        "role": role,
        "phase": live["phase"],
        "teams": len(MEMBER_TOKENS),
        "show_scores": SHOW_SCORES,
        "scores": [_score(i) for i in range(1, len(MEMBER_TOKENS) + 1)] if SHOW_SCORES else [],
        "score": _score(team),
        "answered": sum(1 for qid in answers if qid in QUESTIONS),
        "total": len(QUESTIONS),
        "online": _online(team),   # The leader wants to know everyone is there before scanning
        "v": _version,
    }
    if live["phase"] == "idle":
        return state

    question = QUESTIONS[live["qid"]]
    state["question"] = {
        "id": question["id"],
        "content": question["content"],
        "image": question["image_url"],
        "points": question["points"],
    }

    if live["phase"] == "voting":
        # Choice order was shuffled once when the round opened; reshuffling on
        # every poll would make the choices impossible to tap
        state["question"]["choices"] = live["choices"]
        state["voted"] = len(live["votes"])
        if role == "member":
            state["my_choice"] = live["votes"].get(device)
        else:
            counts, winners = _tally(live)
            state["counts"] = {c: counts.get(c, 0) for c in live["choices"]}
            state["tie"] = winners if len(winners) > 1 else []
        return state

    record = answers.get(live["qid"], {})
    state["result"] = {
        "choice": record.get("choice"),
        "correct": record.get("correct", False),
        "answer": question["answer"],
        "earned": question["points"] if record.get("correct") else 0,
        "votes": record.get("votes", {}),   # Older records lack this field, hand back an empty one
    }
    return state


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

app = Flask(__name__)

# Loading data.json and caching question images both happen in __main__ (see the
# bottom of the file), so importing this module from make_qr.py does not drag in
# downloads or need network access. The cost is that running it some other way,
# say `gunicorn main:app`, would get an empty _data and the first answer would
# overwrite the existing data.json. Better to refuse to serve at all than to
# silently wipe the whole event's scores.
_started = False


@app.before_request
def _require_startup():
    if not _started:
        return jsonify(error="伺服器未以 `uv run main.py` 啟動"), 503


def _token_matches(supplied, known):
    # Compare bytes: compare_digest raises TypeError on a str holding non-ASCII
    return secrets.compare_digest(supplied.encode("utf-8"), known.encode("utf-8"))


def _identify_token(token):
    """Returns (team number, role), or (None, None). Role is "leader" or "member"."""
    if not token:
        return None, None
    for role, known_tokens in (("leader", LEADER_TOKENS), ("member", MEMBER_TOKENS)):
        for number, known in enumerate(known_tokens, 1):
            if _token_matches(token, known):
                return number, role
    return None, None


def _current():
    return _identify_token(request.headers.get("X-Token", "").strip())


def _device():
    return request.headers.get("X-Device", "").strip()


def _role_required(role=None):
    """Keeps the logged-in and right-role checks outside the view, which only
    ever receives (team, role).
    """
    def wrap(view):
        @functools.wraps(view)
        def inner(*args, **kwargs):
            team, actual = _current()
            if not team:
                return jsonify(error="請重新登入"), 401
            if role and actual != role:
                return jsonify(error="這個操作不屬於你的角色"), 403
            return view(team, actual, *args, **kwargs)
        return inner
    return wrap


def _touch(team, role, device):
    """Caller must hold _lock. Only members count towards the online tally."""
    if role == "member" and device:
        _seen.setdefault(str(team), {})[device] = time.monotonic()


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/login")
def api_login():
    token = str((request.get_json(silent=True) or {}).get("token", "")).strip()
    team, role = _identify_token(token)
    if not team:
        return jsonify(error="登入 Token 無效"), 401
    device = _device()
    with _lock:
        _touch(team, role, device)
        return jsonify(_state(team, role, device))


@app.get("/api/state")
@_role_required()
def api_state(team, role):
    device = _device()
    with _lock:
        _touch(team, role, device)
        return jsonify(_state(team, role, device))


@app.post("/api/scan")
@_role_required("leader")
def api_scan(team, role):
    """Opens a round. Scanning an already answered question opens a read-only
    result instead of starting over.
    """
    qid = str((request.get_json(silent=True) or {}).get("id", "")).strip().upper()
    question = QUESTIONS.get(qid)
    if not question:
        return jsonify(error="找不到這個題目代碼"), 404
    with _lock:
        live = _round(team)
        # Leader tokens are not device-limited, so a second phone may scan
        # midway through someone else's round. Overwriting would silently throw
        # away votes already cast; discarding has to be deliberate.
        if live["phase"] == "voting" and live["votes"]:
            return jsonify(error="這一題已經有人投票了，要換題請先按取消"), 409

        answered = qid in _data["teams"].get(str(team), {})
        choices = list(question["choices"])
        if RANDOM_CHOICES and not answered:
            random.shuffle(choices)
        _live[str(team)] = {
            "phase": "revealed" if answered else "voting",
            "qid": qid,
            "choices": choices,
            "votes": {},
        }
        _bump()
        return jsonify(_state(team, role))


@app.post("/api/vote")
@_role_required("member")
def api_vote(team, role):
    """Records what this device picked. Nothing is submitted; the last tap wins."""
    device = _device()
    if not device:
        return jsonify(error="缺少裝置識別，請重新整理"), 400
    choice = str((request.get_json(silent=True) or {}).get("choice", "")).strip()
    with _lock:
        live = _round(team)
        if live["phase"] != "voting":
            return jsonify(error="現在不是投票時間"), 409
        if choice not in live["choices"]:
            return jsonify(error="不是這題的選項"), 400
        live["votes"][device] = choice
        _bump()
        _touch(team, role, device)
        return jsonify(_state(team, role, device))


@app.post("/api/submit")
@_role_required("leader")
def api_submit(team, role):
    """Submits the choice the leader's button was showing.

    The choice in the body is what the leader's screen said. Their tally can be
    up to one poll interval stale, so it is recomputed and compared at submit
    time: a mismatch is rejected and they press again against fresh numbers.
    If the server picked one itself, the button could read "submit 'right'" and
    record "wrong", and nobody would ever notice.
    """
    body = request.get_json(silent=True) or {}
    pick = str(body.get("choice", "")).strip()
    for_qid = str(body.get("id", "")).strip().upper()
    with _lock:
        live = _round(team)
        # Another leader phone may have already submitted, closed, and opened a
        # new question. Without this check, this phone's stale submit would land
        # on the new question and settle it on one incidental vote.
        if for_qid and live["qid"] and for_qid != live["qid"]:
            return jsonify(error="題目已經換了，請看新的題目"), 409
        if live["phase"] == "revealed":
            return jsonify(_state(team, role))          # Another leader already submitted
        if live["phase"] != "voting":
            return jsonify(error="現在沒有進行中的投票"), 409

        counts, winners = _tally(live)
        if not winners:
            return jsonify(error="還沒有人投票"), 409
        if pick not in winners:
            if len(winners) > 1:
                return jsonify(error="票數平手，請點一個要送出的選項"), 409
            return jsonify(error=f"票數變了，現在最高票是「{winners[0]}」，請再確認"), 409
        chosen = pick

        qid = live["qid"]
        question = QUESTIONS[qid]
        answers = _data["teams"].setdefault(str(team), {})
        if qid not in answers:
            # Check and write are both inside the lock, so when two leaders
            # submit at once only the first one counts
            answers[qid] = {
                "choice": chosen,
                "correct": chosen == question["answer"],
                "at": time.time(),
                "votes": {c: counts[c] for c in live["choices"] if counts.get(c)},
            }
            _flush()
        live["phase"] = "revealed"
        live["votes"] = {}
        _bump()
        return jsonify(_state(team, role))


@app.post("/api/close")
@_role_required("leader")
def api_close(team, role):
    """Back to waiting. Pressed mid-vote this discards the round: every vote is
    thrown away and nothing is recorded.
    """
    with _lock:
        _live[str(team)] = _blank_round()
        _bump()
        return jsonify(_state(team, role))


@app.post("/reset")
def api_reset():
    """Clears every team's score and answer log. data.json is backed up first."""
    if not RESET_TOKEN:
        return jsonify(error="未設定 RESET_TOKEN，此端點停用"), 404
    supplied = request.headers.get("X-Reset-Token", "").strip()
    if not supplied or not _token_matches(supplied, RESET_TOKEN):
        return jsonify(error="Reset Token 無效"), 401

    with _lock:
        cleared = sum(len(answers) for answers in _data["teams"].values())
        backup = _backup_data()
        _data["teams"] = {}
        _live.clear()
        _seen.clear()
        _bump()
        _flush()
    print(f"[重置] 清空 {cleared} 筆作答紀錄" + (f"，已備份為 {backup}" if backup else ""))
    return jsonify(ok=True, cleared=cleared, backup=backup)


# --------------------------------------------------------------------------

MEMBER_TOKENS, LEADER_TOKENS, RESET_TOKEN, RANDOM_CHOICES, SHOW_SCORES = load_config()
QUESTIONS = load_questions()

if __name__ == "__main__":
    cache_images(QUESTIONS)
    _data = load_data()
    _started = True
    host = os.getenv("HOST", "192.168.10.101")
    port = int(os.getenv("PORT", "20001"))
    print(
        f"\n已載入 {len(QUESTIONS)} 題 · {len(MEMBER_TOKENS)} 隊 · "
        f"洗牌 {'開' if RANDOM_CHOICES else '關'} · "
        f"分數列 {'開' if SHOW_SCORES else '關'} · "
        f"/reset {'開' if RESET_TOKEN else '關'}"
    )
    print(f"  http://{host}:{port}\n")
    serve(app, host=host, port=port, threads=8)
