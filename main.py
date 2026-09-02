#!/usr/bin/env python3
"""校園尋寶 — Flask 後端。

單 process 執行（waitress，多執行緒）。所有狀態放在記憶體，每次作答
在鎖內整份寫回 data.json 並原子換檔，重啟不掉分。
"""

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


# --------------------------------------------------------------------------
# 設定
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


def load_config():
    load_dotenv(BASE / ".env")
    tokens = [t.strip() for t in os.getenv("TEAM_KEY", "").split(";") if t.strip()]
    reset_token = os.getenv("RESET_TOKEN", "").strip()
    errors = []
    if not tokens:
        errors.append(".env 缺少 TEAM_KEY（格式：TEAM_KEY=第1隊;第2隊;…）")
    if len(set(tokens)) != len(tokens):
        errors.append("TEAM_KEY 裡有重複的 token，隊伍會互相竄改分數")
    if reset_token and reset_token in tokens:
        errors.append("RESET_TOKEN 與某一隊的 token 相同，那隊隨手一掃就會清空全場")
    if errors:
        _die(errors, ".env 設定錯誤")
    return tokens, reset_token, _flag("RANDOM_CHOICES"), _flag("SHOW_SCORES_IN_MENU")


# --------------------------------------------------------------------------
# 題庫：啟動時嚴格驗證，有錯就不啟動
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
# 圖片快取：啟動時把遠端圖抓下來，活動當天不依賴外部圖床
# --------------------------------------------------------------------------

# 副檔名一律查表決定。曾經是「拿 Content-Type 的後半段當副檔名」，但那個字串
# 完全由遠端圖床控制，回一個 image/../../x 就會生出離譜的檔名讓啟動整個掛掉。
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
        except Exception as exc:  # 下載失敗一律視為致命：破圖的題目沒有意義
            errors.append(f"{question['id']}: 下載失敗 {question['image']}\n      {exc}")
            print(f"  {question['id']} → 失敗：{exc}")
            continue
        question["image_url"] = f"/static/cache/{path.name}"
        print(f"  {question['id']} → static/cache/{path.name}{'（已快取）' if cached else ''}")
    if errors:
        _die(errors, "題目圖片下載失敗")


# --------------------------------------------------------------------------
# 儲存：記憶體為主，每次作答在鎖內整份寫回 + 原子換檔
# --------------------------------------------------------------------------

_lock = threading.Lock()
_data = {"teams": {}}


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
    """呼叫者必須持有 _lock。把現有 data.json 挪成帶時間戳的備份，回傳檔名。"""
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
    """呼叫者必須持有 _lock。"""
    tmp = DATA_FILE.with_name(DATA_FILE.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(_data, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, DATA_FILE)


def _score(team):
    """分數即時從作答紀錄算出，不存冗餘欄位。呼叫者必須持有 _lock。"""
    answers = _data["teams"].get(str(team), {})
    return sum(
        QUESTIONS[qid]["points"]
        for qid, rec in answers.items()
        if rec["correct"] and qid in QUESTIONS
    )


def _state(team):
    """呼叫者必須持有 _lock。"""
    answers = _data["teams"].get(str(team), {})
    return {
        "teams": len(TOKENS),
        "show_scores": SHOW_SCORES,
        "scores": [_score(i) for i in range(1, len(TOKENS) + 1)] if SHOW_SCORES else [],
        "score": _score(team),
        "answered": sum(1 for qid in answers if qid in QUESTIONS),
        "total": len(QUESTIONS),
    }


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

app = Flask(__name__)

# 載入 data.json 與快取題目圖片都放在 __main__ 裡（見檔尾），這樣 make_qr.py
# 匯入本模組時不會被拖去下載圖片、也不需要網路。代價是 `gunicorn main:app`
# 這類跑法會拿到空的 _data，第一筆作答就把既有的 data.json 整份蓋掉 ——
# 與其安靜地把全場分數清光，不如整個不服務。
_started = False


@app.before_request
def _require_startup():
    if not _started:
        return jsonify(error="伺服器未以 `uv run main.py` 啟動"), 503


def _token_matches(supplied, known):
    # 用 bytes 比對：compare_digest 對含非 ASCII 的 str 會直接丟 TypeError
    return secrets.compare_digest(supplied.encode("utf-8"), known.encode("utf-8"))


def _team_from_token(token):
    if not token:
        return None
    for number, known in enumerate(TOKENS, 1):
        if _token_matches(token, known):
            return number
    return None


def _current_team():
    return _team_from_token(request.headers.get("X-Token", "").strip())


def _question_payload(question, record):
    payload = {
        "id": question["id"],
        "content": question["content"],
        "image": question["image_url"],
        "points": question["points"],
    }
    if record:
        payload.update(
            answered=True,
            choice=record["choice"],
            correct=record["correct"],
            answer=question["answer"],
            earned=question["points"] if record["correct"] else 0,
        )
    else:
        choices = list(question["choices"])
        if RANDOM_CHOICES:
            random.shuffle(choices)
        payload.update(answered=False, choices=choices)
    return payload


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/login")
def api_login():
    token = str((request.get_json(silent=True) or {}).get("token", "")).strip()
    team = _team_from_token(token)
    if not team:
        return jsonify(error="登入 Token 無效"), 401
    with _lock:
        return jsonify(team=team, **_state(team))


@app.get("/api/state")
def api_state():
    team = _current_team()
    if not team:
        return jsonify(error="請重新登入"), 401
    with _lock:
        return jsonify(team=team, **_state(team))


@app.get("/api/question/<qid>")
def api_question(qid):
    team = _current_team()
    if not team:
        return jsonify(error="請重新登入"), 401
    question = QUESTIONS.get(qid.strip().upper())
    if not question:
        return jsonify(error="找不到這個題目代碼"), 404
    with _lock:
        record = _data["teams"].get(str(team), {}).get(question["id"])
    return jsonify(_question_payload(question, record))


@app.post("/api/answer")
def api_answer():
    team = _current_team()
    if not team:
        return jsonify(error="請重新登入"), 401

    body = request.get_json(silent=True) or {}
    question = QUESTIONS.get(str(body.get("id", "")).strip().upper())
    if not question:
        return jsonify(error="找不到這個題目代碼"), 404
    choice = str(body.get("choice", "")).strip()
    if choice not in question["choices"]:
        return jsonify(error="不是這題的選項"), 400

    qid = question["id"]
    with _lock:
        answers = _data["teams"].setdefault(str(team), {})
        record = answers.get(qid)
        already = record is not None
        if not already:
            # 檢查與寫入都在鎖內，所以同隊同時送出時只有第一筆算數
            record = {"choice": choice, "correct": choice == question["answer"], "at": time.time()}
            answers[qid] = record
            _flush()
        return jsonify(
            already=already,
            choice=record["choice"],
            correct=record["correct"],
            answer=question["answer"],
            earned=question["points"] if record["correct"] else 0,
            points=question["points"],
            **_state(team),
        )


@app.post("/reset")
def api_reset():
    """清空所有隊伍的分數與作答紀錄。清掉之前會先把 data.json 備份起來。"""
    if not RESET_TOKEN:
        return jsonify(error="未設定 RESET_TOKEN，此端點停用"), 404
    supplied = request.headers.get("X-Reset-Token", "").strip()
    if not supplied or not _token_matches(supplied, RESET_TOKEN):
        return jsonify(error="Reset Token 無效"), 401

    with _lock:
        cleared = sum(len(answers) for answers in _data["teams"].values())
        backup = _backup_data()
        _data["teams"] = {}
        _flush()
    print(f"[重置] 清空 {cleared} 筆作答紀錄" + (f"，已備份為 {backup}" if backup else ""))
    return jsonify(ok=True, cleared=cleared, backup=backup)


# --------------------------------------------------------------------------

TOKENS, RESET_TOKEN, RANDOM_CHOICES, SHOW_SCORES = load_config()
QUESTIONS = load_questions()

if __name__ == "__main__":
    cache_images(QUESTIONS)
    _data = load_data()
    _started = True
    host = os.getenv("HOST", "192.168.10.101")
    port = int(os.getenv("PORT", "20001"))
    print(
        f"\n已載入 {len(QUESTIONS)} 題 · {len(TOKENS)} 隊 · "
        f"洗牌 {'開' if RANDOM_CHOICES else '關'} · "
        f"分數列 {'開' if SHOW_SCORES else '關'} · "
        f"/reset {'開' if RESET_TOKEN else '關'}"
    )
    print(f"  http://{host}:{port}\n")
    serve(app, host=host, port=port, threads=8)
