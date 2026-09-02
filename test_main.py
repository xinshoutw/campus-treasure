#!/usr/bin/env python3
"""最小回歸測試：`uv run test_main.py`。

只用 assert，不吃測試框架。涵蓋的是壞掉會讓活動當天出事的東西：題庫驗證、
同隊併發只算一筆、圖片快取的副檔名白名單、端點權限。

環境變數在 import main 之前就設好，load_dotenv 不會覆蓋既有的值，所以這支
測試不依賴 .env，也不會碰到正式的 data.json。
"""

import http.server
import os
import socketserver
import tempfile
import threading
from pathlib import Path

os.environ["TEAM_KEY"] = "token-team-one;token-team-two"
os.environ["RESET_TOKEN"] = "token-reset"
os.environ["RANDOM_CHOICES"] = "0"
os.environ["SHOW_SCORES_IN_MENU"] = "1"

import main  # noqa: E402

# questions.yaml 裡長這樣（image_url 是 _check_question 產出的，不是輸入欄位）
QUESTION = {
    "id": "TESTQ",
    "content": "測試題",
    "answer": "對",
    "choices": ["對", "錯"],
    "points": 2,
    "image": None,
}


def setup():
    """把全域狀態換成測試用的，尤其是 DATA_FILE，別碰到正式資料。"""
    main.TOKENS = ["token-team-one", "token-team-two"]
    main.RESET_TOKEN = "token-reset"
    main.QUESTIONS = {"TESTQ": {**QUESTION, "image_url": None}}
    main.DATA_FILE = Path(tempfile.mkdtemp()) / "data.json"
    main._data = {"teams": {}}
    main._started = True
    return main.app.test_client()


# ---------------------------------------------------------------- 題庫驗證

def test_valid_question_passes():
    errors, parsed = main._check_question(1, dict(QUESTION), {})
    assert errors == [], errors
    assert parsed["id"] == "TESTQ"
    assert parsed["points"] == 2


def test_question_validation_rejects_bad_input():
    cases = {
        "id 不是五碼": {**QUESTION, "id": "abc"},
        "answer 不在 choices": {**QUESTION, "answer": "沒有這個"},
        "choices 只有一個": {**QUESTION, "choices": ["對"]},
        "choices 重複": {**QUESTION, "choices": ["對", "對"]},
        "points 是零": {**QUESTION, "points": 0},
        "points 是 True": {**QUESTION, "points": True},
        "欄位打錯字": {**QUESTION, "poitns": 3},
        "image 不是網址": {**QUESTION, "image": "not-a-url"},
        "content 空白": {**QUESTION, "content": "   "},
    }
    for name, item in cases.items():
        errors, parsed = main._check_question(1, item, {})
        assert errors, f"{name} 應該要被擋下來"
        assert parsed is None, name


def test_duplicate_id_is_reported():
    errors, _ = main._check_question(2, dict(QUESTION), {"TESTQ": 1})
    assert any("重複" in e for e in errors), errors


# ---------------------------------------------------------------- 圖片快取

def test_image_extension_is_whitelisted():
    """副檔名不能由遠端的 Content-Type 決定，否則會生出離譜的檔名。"""
    served = {
        "/png": ("image/png", b"\x89PNG\r\n\x1a\n"),
        "/traversal": ("image/../../evil.py", b"pwned"),
        "/html": ("text/html", b"<html>"),
        "/huge": ("image/png", b"x" * (main.MAX_IMAGE_BYTES + 1)),
    }

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            ctype, body = served[self.path]
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    cache = Path(tempfile.mkdtemp())
    original, main.CACHE_DIR = main.CACHE_DIR, cache
    try:
        path, _ = main._fetch_image(f"{base}/png")
        assert path.suffix == ".png", path
        assert path.parent == cache, path

        for bad in ("/traversal", "/html", "/huge"):
            try:
                main._fetch_image(f"{base}{bad}")
            except ValueError:
                pass
            else:
                raise AssertionError(f"{bad} 應該要被拒絕")
        assert sorted(p.name for p in cache.iterdir()) == [path.name]
    finally:
        main.CACHE_DIR = original
        server.shutdown()


# ---------------------------------------------------------------- 端點

def test_endpoints_require_a_token():
    client = setup()
    assert client.get("/api/state").status_code == 401
    assert client.get("/api/question/TESTQ").status_code == 401
    assert client.post("/api/answer", json={"id": "TESTQ", "choice": "對"}).status_code == 401
    assert client.post("/api/login", json={"token": "wrong"}).status_code == 401


def test_answer_is_not_leaked_before_answering():
    client = setup()
    payload = client.get("/api/question/TESTQ", headers={"X-Token": "token-team-one"}).get_json()
    assert payload["answered"] is False
    assert "answer" not in payload, "未作答時不可以回傳正解"
    assert sorted(payload["choices"]) == ["對", "錯"]


def test_wrong_choice_is_rejected():
    client = setup()
    response = client.post(
        "/api/answer",
        json={"id": "TESTQ", "choice": "不是選項"},
        headers={"X-Token": "token-team-one"},
    )
    assert response.status_code == 400


def test_startup_guard_blocks_requests():
    client = setup()
    main._started = False
    try:
        assert client.get("/").status_code == 503
    finally:
        main._started = True


# ---------------------------------------------------------------- 併發

def test_only_the_first_answer_counts():
    """同隊兩台手機同時送出不同答案，只有第一筆算數，分數不會加兩次。"""
    setup()
    header = {"X-Token": "token-team-one"}
    results = []
    barrier = threading.Barrier(2)

    def submit(choice):
        # 每條執行緒要自己的 test_client，Flask 的不是 thread-safe
        client = main.app.test_client()
        barrier.wait()
        results.append(
            client.post("/api/answer", json={"id": "TESTQ", "choice": choice}, headers=header).get_json()
        )

    threads = [threading.Thread(target=submit, args=(c,)) for c in ("對", "錯")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(main._data["teams"]["1"]) == 1, main._data
    assert sum(1 for r in results if r["already"]) == 1, "應該剛好一筆是重複的"
    stored = main._data["teams"]["1"]["TESTQ"]["choice"]
    assert all(r["choice"] == stored for r in results), "兩邊看到的答案要一致"
    assert main._score(1) == (2 if stored == "對" else 0)


def test_reset_clears_scores_and_keeps_a_backup():
    client = setup()
    client.post("/api/answer", json={"id": "TESTQ", "choice": "對"}, headers={"X-Token": "token-team-one"})
    assert main._score(1) == 2

    assert client.post("/reset").status_code == 401
    assert client.post("/reset", headers={"X-Reset-Token": "nope"}).status_code == 401

    body = client.post("/reset", headers={"X-Reset-Token": "token-reset"}).get_json()
    assert body["cleared"] == 1
    assert main._score(1) == 0
    assert (main.DATA_FILE.parent / body["backup"]).exists(), "清空前要留備份"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"  PASS  {test.__name__}")
        except Exception as exc:
            failed += 1
            print(f"  FAIL  {test.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
