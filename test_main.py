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

os.environ["MEMBER_KEY"] = "member-one;member-two"
os.environ["LEADER_KEY"] = "leader-one;leader-two"
os.environ["RESET_TOKEN"] = "token-reset"
os.environ["RANDOM_CHOICES"] = "0"
os.environ["SHOW_SCORES_IN_MENU"] = "1"

import main  # noqa: E402

# questions.yaml 裡長這樣（image_url 是 _check_question 產出的，不是輸入欄位）
LEADER = {"X-Token": "leader-one"}
MEMBER = {"X-Token": "member-one", "X-Device": "d0"}


def device(headers, name):
    return {**headers, "X-Device": name}


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
    main.MEMBER_TOKENS = ["member-one", "member-two"]
    main.LEADER_TOKENS = ["leader-one", "leader-two"]
    main.RESET_TOKEN = "token-reset"
    main.QUESTIONS = {"TESTQ": {**QUESTION, "image_url": None}}
    main.DATA_FILE = Path(tempfile.mkdtemp()) / "data.json"
    main._data = {"teams": {}}
    main._live = {}
    main._seen = {}
    main.RANDOM_CHOICES = False
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
    for method, path in (
        ("get", "/api/state"), ("post", "/api/scan"),
        ("post", "/api/vote"), ("post", "/api/submit"), ("post", "/api/close"),
    ):
        assert getattr(client, method)(path).status_code == 401, path
    assert client.post("/api/login", json={"token": "wrong"}).status_code == 401


def test_roles_cannot_use_each_others_endpoints():
    client = setup()
    leader, member = LEADER, MEMBER
    assert client.post("/api/scan", json={"id": "TESTQ"}, headers=member).status_code == 403
    assert client.post("/api/submit", headers=member).status_code == 403
    assert client.post("/api/close", headers=member).status_code == 403
    client.post("/api/scan", json={"id": "TESTQ"}, headers=leader)
    assert client.post("/api/vote", json={"choice": "對"}, headers=leader).status_code == 403


def test_answer_is_not_leaked_while_voting():
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    for who in (LEADER, MEMBER):
        state = client.get("/api/state", headers=who).get_json()
        assert state["phase"] == "voting"
        assert "answer" not in state["question"], who   # answered 是進度，不是正解
        assert "result" not in state, who


def test_members_never_see_the_tally():
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d1"))
    state = client.get("/api/state", headers=device(MEMBER, "d1")).get_json()
    assert "counts" not in state, "隊員不可以看到各選項票數"
    assert state["my_choice"] == "對"
    assert state["voted"] == 1
    assert client.get("/api/state", headers=LEADER).get_json()["counts"]["對"] == 1


def test_choice_order_is_stable_across_polls():
    """選項在開局時洗一次就固定，不能每次輪詢都重排。"""
    client = setup()
    main.RANDOM_CHOICES = True
    main.QUESTIONS["TESTQ"]["choices"] = list("ABCDEFGH")
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    orders = {
        tuple(client.get("/api/state", headers=who).get_json()["question"]["choices"])
        for who in (LEADER, MEMBER, device(MEMBER, "d2"))
        for _ in range(5)
    }
    assert len(orders) == 1, f"選項順序在輪詢之間跳動了：{orders}"


def test_last_vote_wins_and_counts_are_live():
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d1"))
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d2"))
    client.post("/api/vote", json={"choice": "錯"}, headers=device(MEMBER, "d1"))
    counts = client.get("/api/state", headers=LEADER).get_json()["counts"]
    assert counts == {"對": 1, "錯": 1}, counts


def test_submit_needs_votes_and_sends_the_top_one():
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    assert client.post("/api/submit", json={"choice": "對"}, headers=LEADER).status_code == 409, "零票不可以送出"

    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d1"))
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d2"))
    client.post("/api/vote", json={"choice": "錯"}, headers=device(MEMBER, "d3"))
    body = client.post("/api/submit", json={"choice": "對"}, headers=LEADER).get_json()
    assert body["phase"] == "revealed"
    assert body["result"]["choice"] == "對"
    assert body["result"]["correct"] is True
    assert body["result"]["votes"] == {"對": 2, "錯": 1}
    assert main._score(1) == 2


def test_submit_refuses_a_choice_that_is_no_longer_winning():
    """隊輔的票數最多過期 1 秒。按鈕上寫什麼就送什麼，對不上就擋下來重看。"""
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d1"))
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d2"))
    client.post("/api/vote", json={"choice": "錯"}, headers=device(MEMBER, "d3"))
    # 隊輔螢幕上此刻是「送出『對』」

    for d in ("d1", "d2"):                       # 按下去之前有人改票，「錯」變成最高票
        client.post("/api/vote", json={"choice": "錯"}, headers=device(MEMBER, d))

    stale = client.post("/api/submit", json={"choice": "對"}, headers=LEADER)
    assert stale.status_code == 409, "按鈕寫『對』就不可以記成『錯』"
    assert main._data["teams"].get("1", {}) == {}, "被擋下來不可以留下紀錄"

    ok = client.post("/api/submit", json={"choice": "錯"}, headers=LEADER).get_json()
    assert ok["result"]["choice"] == "錯"


def test_submit_keeps_the_leaders_tie_pick():
    """平手時隊輔明確點了一個，之後票數變動也不可以把它換掉。"""
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d1"))
    client.post("/api/vote", json={"choice": "錯"}, headers=device(MEMBER, "d2"))
    # 平手，隊輔點了「錯」

    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d2"))  # 「對」獨走
    stale = client.post("/api/submit", json={"choice": "錯"}, headers=LEADER)
    assert stale.status_code == 409, "隊輔指定的選項不可以被無聲換掉"
    assert main._score(1) == 0


def test_a_tie_needs_the_leader_to_pick():
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d1"))
    client.post("/api/vote", json={"choice": "錯"}, headers=device(MEMBER, "d2"))

    assert client.get("/api/state", headers=LEADER).get_json()["tie"] == ["對", "錯"]
    assert client.post("/api/submit", headers=LEADER).status_code == 409, "平手不可以自動送"
    assert client.post("/api/submit", json={"choice": "沒這個"}, headers=LEADER).status_code == 409
    body = client.post("/api/submit", json={"choice": "錯"}, headers=LEADER).get_json()
    assert body["result"]["choice"] == "錯"
    assert body["result"]["correct"] is False


def test_close_discards_votes_without_recording():
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d1"))
    body = client.post("/api/close", headers=LEADER).get_json()
    assert body["phase"] == "idle"
    assert main._data["teams"].get("1", {}) == {}, "取消不可以留下作答紀錄"
    assert client.get("/api/state", headers=MEMBER).get_json()["phase"] == "idle"


def test_rescanning_an_answered_question_is_read_only():
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d1"))
    client.post("/api/submit", json={"choice": "對"}, headers=LEADER)
    client.post("/api/close", headers=LEADER)

    body = client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER).get_json()
    assert body["phase"] == "revealed"
    assert body["result"]["votes"] == {"對": 1}
    assert client.post("/api/vote", json={"choice": "錯"}, headers=device(MEMBER, "d1")).status_code == 409
    assert main._score(1) == 2, "重掃不可以改變分數"


def test_voting_outside_a_round_is_rejected():
    client = setup()
    assert client.post("/api/vote", json={"choice": "對"}, headers=MEMBER).status_code == 409
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    assert client.post("/api/vote", json={"choice": "不是選項"}, headers=MEMBER).status_code == 400


def test_scan_rejects_unknown_question():
    client = setup()
    assert client.post("/api/scan", json={"id": "NOPE1"}, headers=LEADER).status_code == 404
    assert client.get("/api/state", headers=LEADER).get_json()["phase"] == "idle"


def test_online_count_only_counts_recent_members():
    client = setup()
    client.get("/api/state", headers=device(MEMBER, "d1"))
    client.get("/api/state", headers=device(MEMBER, "d2"))
    client.get("/api/state", headers=LEADER)
    assert client.get("/api/state", headers=LEADER).get_json()["online"] == 2, "隊輔不算在線隊員"

    main._seen["1"]["d1"] -= main.ONLINE_TIMEOUT + 1
    assert client.get("/api/state", headers=LEADER).get_json()["online"] == 1


def test_startup_guard_blocks_requests():
    client = setup()
    main._started = False
    try:
        assert client.get("/").status_code == 503
    finally:
        main._started = True


def test_only_the_first_submit_counts():
    """兩台隊輔同時按送出，只有第一筆算數。"""
    setup()
    main.app.test_client().post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    for i, choice in enumerate(("對", "對", "錯", "錯")):
        main.app.test_client().post("/api/vote", json={"choice": choice}, headers=device(MEMBER, f"d{i}"))

    results = []
    barrier = threading.Barrier(2)

    def submit(pick):
        client = main.app.test_client()   # Flask 的 test_client 不是 thread-safe
        barrier.wait()
        results.append(client.post("/api/submit", json={"choice": pick}, headers=LEADER).get_json())

    threads = [threading.Thread(target=submit, args=(c,)) for c in ("對", "錯")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(main._data["teams"]["1"]) == 1, main._data
    stored = main._data["teams"]["1"]["TESTQ"]["choice"]
    assert all(r["result"]["choice"] == stored for r in results), "兩台看到的答案要一致"
    assert main._score(1) == (2 if stored == "對" else 0)


def test_a_second_submit_never_overwrites_the_record():
    """白箱：就算局的狀態被弄回投票中，已記錄的答案也不能被改掉。

    正常流程走不到這裡（phase 會先擋下），但守的是計分，不能只靠上游。
    """
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    client.post("/api/vote", json={"choice": "錯"}, headers=device(MEMBER, "d1"))
    client.post("/api/submit", json={"choice": "錯"}, headers=LEADER)
    assert main._score(1) == 0

    live = main._live["1"]
    live["phase"] = "voting"
    live["votes"] = {"d1": "對"}
    client.post("/api/submit", json={"choice": "對"}, headers=LEADER)

    assert main._data["teams"]["1"]["TESTQ"]["choice"] == "錯", "已記錄的答案被覆寫了"
    assert main._score(1) == 0


def test_reset_clears_scores_and_live_rounds():
    client = setup()
    client.post("/api/scan", json={"id": "TESTQ"}, headers=LEADER)
    client.post("/api/vote", json={"choice": "對"}, headers=device(MEMBER, "d1"))
    client.post("/api/submit", json={"choice": "對"}, headers=LEADER)
    assert main._score(1) == 2

    assert client.post("/reset").status_code == 401
    assert client.post("/reset", headers={"X-Reset-Token": "nope"}).status_code == 401

    body = client.post("/reset", headers={"X-Reset-Token": "token-reset"}).get_json()
    assert body["cleared"] == 1
    assert main._score(1) == 0
    assert main._live == {} and main._seen == {}, "重置也要清掉進行中的局"
    assert (main.DATA_FILE.parent / body["backup"]).exists(), "清空前要留備份"


def test_config_rejects_bad_token_sets():
    """啟動時就要擋下來的 .env 錯誤。"""
    cases = {
        "少了 LEADER_KEY": {"MEMBER_KEY": "a;b", "LEADER_KEY": ""},
        "少了 MEMBER_KEY": {"MEMBER_KEY": "", "LEADER_KEY": "a;b"},
        "數量不一致": {"MEMBER_KEY": "a;b;c", "LEADER_KEY": "d;e"},
        "隊員間重複": {"MEMBER_KEY": "a;a", "LEADER_KEY": "c;d"},
        "隊輔撞到隊員": {"MEMBER_KEY": "a;b", "LEADER_KEY": "b;c"},
        "撞到 RESET_TOKEN": {"MEMBER_KEY": "a;b", "LEADER_KEY": "c;token-reset"},
        "還留著舊的 TEAM_KEY": {"MEMBER_KEY": "a;b", "LEADER_KEY": "c;d", "TEAM_KEY": "old"},
    }
    for name, env in cases.items():
        saved = {k: os.environ.get(k) for k in ("MEMBER_KEY", "LEADER_KEY", "TEAM_KEY")}
        try:
            for key in saved:
                os.environ.pop(key, None)
            os.environ.update({k: v for k, v in env.items() if v})
            try:
                main.load_config()
            except SystemExit:
                pass
            else:
                raise AssertionError(f"{name} 應該要讓啟動失敗")
        finally:
            for key, value in saved.items():
                os.environ.pop(key, None)
                if value is not None:
                    os.environ[key] = value


def test_role_is_resolved_from_token():
    setup()
    assert main._identify_token("leader-two") == (2, "leader")
    assert main._identify_token("member-one") == (1, "member")
    assert main._identify_token("nope") == (None, None)
    assert main._identify_token("") == (None, None)


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
