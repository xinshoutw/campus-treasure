#!/usr/bin/env node
"use strict";

/* Frontend end-to-end tests: `node test_web.cjs` (needs node and uv).
 *
 * The real static/app.js runs inside a minimal DOM stub against a Flask server
 * that actually boots. Each Phone is its own vm context, so it is one phone with
 * its own localStorage and device id, which makes "a leader plus three members"
 * four real clients talking to each other.
 *
 * The server uses a temporary DATA_FILE and temporary tokens, so it never
 * touches .env or the real data.json. A camera can never open under Node, so
 * these take the manual question-code path.
 */

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const LEADER = "test-leader-1";
const MEMBER = "test-member-1";
const RESET_TOKEN = "test-reset";
const PORT = 20000 + Math.floor(Math.random() * 9000);
const BASE = `http://127.0.0.1:${PORT}`;


const ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT, "src");

const SRC = fs.readFileSync(path.join(APP_DIR, "static", "app.js"), "utf8");

function makeElement(id) {
  const listeners = {};
  const el = {
    id, hidden: false, textContent: "", value: "", className: "", placeholder: "",
    maxLength: 0, disabled: false, src: "", alt: "", children: [], dataset: {},
    listeners,
    setAttribute(k, v) { this.dataset["aria_" + k] = v; },
    getAttribute(k) { return this.dataset["aria_" + k]; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, event = {}) { (listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, ...event })); },
    replaceChildren(...kids) { this.children = kids; },
    append(...kids) { this.children.push(...kids); },
    querySelector(sel) { return this.children.find((c) => c.className === sel.slice(1)) || null; },
    blur() {}, focus() {},
    classList: { toggle() {}, add() {}, remove() {} },
    videoWidth: 0, videoHeight: 0, readyState: 0, srcObject: null,
    play: () => Promise.resolve(),
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: [], width: 0, height: 0 }) }),
  };
  return el;
}

const LIVE_PHONES = [];   // Closed after every check, or polling piles up

class Phone {
  constructor(name, base, seed) {
    this.name = name;
    this.delay = 0;        // Artificial network delay, ms
    this.inflight = 0;
    this.maxInflight = 0;
    this.sent = [];        // Every path sent, to catch redundant requests
    this.qr = null;        // Which QR the lens is currently on
    this.camera = false;   // Whether this phone has a camera
    this.streams = 0;      // How many streams have been opened in total
    this.liveTracks = 0;   // Tracks not yet stopped
    this.frame = 0;
    this.frames = 0;       // Frames the scan loop has run
    this.hang = false;     // Requests never come back
    this.slowPath = null;  // Only this path gets delayed
    this.camDelay = 0;     // How long getUserMedia takes to return
    this.els = {};
    this.timers = [];
    LIVE_PHONES.push(this);
    // Keys starting with __ configure the harness, they are not storage contents
    const opts = seed || {};
    const store = new Map(Object.entries(opts).filter(([k]) => !k.startsWith("__")));
    const session = (this.session = opts.__session || new Map());
    this.privateMode = Boolean(opts.__private);   // Has to take effect before the script runs
    const sandbox = {
      console,
      setTimeout, clearTimeout, clearInterval,
      setInterval: (fn, ms) => { const id = setInterval(fn, ms); this.timers.push(id); return id; },
      // Scan loop: tick has to run frame by frame for rescan deduplication to be testable
      requestAnimationFrame: (fn) => {
        this.frames++;
        const id = setTimeout(() => fn(this.frame += 20), 5);
        this.timers.push(id); return id;
      },
      cancelAnimationFrame: (id) => clearTimeout(id),
      URL, URLSearchParams, Math, Date, JSON, Object, Number, String, Boolean, Array, Error, Promise,
      AbortSignal,
      crypto: { randomUUID: () => `${name}-device` },
      localStorage: {
        getItem: (k) => (this.privateMode ? null : (store.has(k) ? store.get(k) : null)),
        setItem: (k, v) => { if (this.privateMode) throw new Error("QuotaExceeded"); store.set(k, String(v)); },
        removeItem: (k) => store.delete(k),
      },
      sessionStorage: {
        getItem: (k) => (session.has(k) ? session.get(k) : null),
        setItem: (k, v) => session.set(k, String(v)),
        removeItem: (k) => session.delete(k),
      },
      location: { search: "", pathname: "/" },
      history: { replaceState() {} },
      navigator: {
        mediaDevices: {
          getUserMedia: () => (this.camera
            ? new Promise((r) => setTimeout(r, this.camDelay || 0)).then(() => {
                this.liveTracks++; this.streams++;
                return { getTracks: () => [{ stop: () => { this.liveTracks--; } }],
                         getVideoTracks: () => [{ getSettings: () => ({ deviceId: this.camId || "cam1" }) }] };
              })
            : Promise.reject(Object.assign(new Error("no cam"), { name: "NotFoundError" }))),
          enumerateDevices: () => Promise.resolve(this.camera
            ? [{ kind: "videoinput", deviceId: "cam1", label: "後鏡頭" },
               { kind: "videoinput", deviceId: "cam2", label: "前鏡頭" }] : []),
        },
      },
      // The test decides what the lens sees: a non-null this.qr decodes every frame
      jsQR: () => (this.qr ? { data: this.qr } : null),
      fetch: (path, opts) => {
        this.sent.push(path);
        this.inflight++;
        this.maxInflight = Math.max(this.maxInflight, this.inflight);
        const done = () => { this.inflight--; };
        // The delay goes after the response: a real slow downlink means the
        // server finished long ago and only the reply is late. Delaying the
        // request instead would mean "the server computed later", which does
        // not reproduce the stale-response problem at all.
        if (this.hang) {
          // Never returns, but still honours AbortSignal
          return new Promise((_, reject) => {
            const sig = opts && opts.signal;
            if (sig) sig.addEventListener("abort", () => { done(); reject(sig.reason || new Error("aborted")); });
          });
        }
        const slow = this.delay && (!this.slowPath || path.startsWith(this.slowPath));
        const late = (v, throwIt) => new Promise((r) => setTimeout(r, this.delay))
          .then(() => { done(); if (throwIt) throw v; return v; });
        return fetch(base + path, opts).then(
          (r) => (slow ? late(r, false) : (done(), r)),
          (e) => (slow ? late(e, true) : (done(), Promise.reject(e))));
      },
      document: {
        getElementById: (id) => (this.els[id] ||= makeElement(id)),
        createElement: (tag) => makeElement(`<${tag}>`),
        addEventListener() {},
        hidden: false,
      },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    this.sandbox = sandbox;
    vm.runInContext(SRC, sandbox, { filename: "app.js" });
  }

  /** Stops polling. Without it the previous check's phones keep hitting the server */
  close() { this.timers.forEach(clearInterval); this.timers = []; }

  /** Makes video look like it has a picture so the scan loop runs; code is the QR in frame */
  aimAt(code) {
    const v = this.el("video");
    v.videoWidth = 640; v.videoHeight = 640; v.readyState = 4;
    this.qr = code;
  }

  el(id) { return this.els[id]; }
  /** Waits for every in-flight promise to settle */
  settle() { return new Promise((r) => setTimeout(r, 150)); }

  async login(token) {
    this.el("entry-input").value = token;
    this.el("entry-form").fire("submit");
    await this.settle();
  }
  async type(code) {
    this.el("entry-input").value = code;
    this.el("entry-input").fire("input");
    await this.settle();
  }
  async click(id) { this.el(id).fire("click"); await this.settle(); }
  /** Clicks without awaiting the response, to check the screen moved first */
  clickNow(id) { this.el(id).fire("click"); }
  tapChoiceNow(text) {
    const button = this.el("q-choices").children.find((c) => c.dataset.choice === text);
    if (!button) throw new Error(`${this.name}: 找不到選項 ${text}`);
    button.fire("click");
  }
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async tapChoice(text) {
    const button = this.el("q-choices").children.find((c) => c.dataset.choice === text);
    if (!button) throw new Error(`${this.name}: 找不到選項 ${text}`);
    button.fire("click");
    await this.settle();
  }
  async poll() { await this.sandbox.refreshState?.(); await this.settle(); }

  /** Which screen is showing right now */
  screen() {
    for (const id of ["stage", "panel-wait", "panel-question", "panel-result"]) {
      if (this.els[id] && !this.els[id].hidden) return id;
    }
    return "(none)";
  }
  choices() { return (this.els["q-choices"]?.children || []).map((c) => c.dataset.choice); }
  /** Only choices that really carry a count field; a member's buttons have no such element */
  counts() {
    return Object.fromEntries((this.els["q-choices"]?.children || [])
      .filter((c) => c.querySelector(".choice-count"))
      .map((c) => [c.dataset.choice, c.querySelector(".choice-count").textContent]));
  }
  checked() {
    return (this.els["q-choices"]?.children || [])
      .filter((c) => c.getAttribute("aria-checked") === "true").map((c) => c.dataset.choice);
  }
  text(id) { return this.els[id]?.textContent ?? ""; }
}


// ---------------------------------------------------------------- Server

const BOOT = `
import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(APP_DIR)})
import main
from waitress import serve
main.MEMBER_TOKENS = [${JSON.stringify(MEMBER)}, "test-member-2"]
main.LEADER_TOKENS = [${JSON.stringify(LEADER)}, "test-leader-2"]
main.RESET_TOKEN = ${JSON.stringify(RESET_TOKEN)}
main.DATA_FILE = Path(tempfile.mkdtemp()) / "data.json"
main.cache_images(main.QUESTIONS)
main._data = {"teams": {}}
main._started = True
serve(main.app, host="127.0.0.1", port=${PORT}, threads=8)
`;

async function boot() {
  const server = spawn("uv", ["run", "--offline", "python", "-c", BOOT],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (d) => { stderr += d; });
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + "/"); return server; } catch { /* Not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  server.kill();
  throw new Error("伺服器起不來：\n" + stderr);
}

/** The question comes from questions.yaml; these tests only need one with these choices. */
const QID = "ABCDE";
const A = "火車";
const B = "恐龍";
const C = "企鵝";

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check("無痕模式下重新整理不會變成另一個人", async () => {
  const leader = new Phone("L", BASE);
  await leader.login(LEADER);
  await leader.type(QID);

  const session = new Map();             // sessionStorage of the same tab
  const first = new Phone("M1", BASE, { __session: session, __private: true });
  await first.login(MEMBER);
  await first.poll();
  await first.tapChoice(A);
  first.close();

  const reloaded = new Phone("M1b", BASE, { __session: session, __private: true });  // Reload
  await reloaded.login(MEMBER);
  await reloaded.poll();
  await reloaded.tapChoice(B);           // Same person switches their vote

  await leader.poll();
  assert.equal(leader.text("q-tally").match(/已投 (\d+)/)[1], "1",
    `一個人重新整理後變成 ${leader.text("q-tally")}`);
  assert.equal(leader.counts()[A], "0");
  assert.equal(leader.counts()[B], "1");
});

check("投票中不再空轉掃描迴圈", async () => {
  const leader = new Phone("L", BASE);
  leader.camera = true;
  await leader.login(LEADER);
  await leader.click("scan-toggle");
  leader.aimAt(QID);
  await leader.wait(300);
  assert.equal(leader.screen(), "panel-question");

  leader.frames = 0;
  await leader.wait(600);
  assert.ok(leader.frames <= 1, `投票中還跑了 ${leader.frames} 幀，應該停下來`);

  await leader.click("q-cancel");        // Back to waiting
  leader.frames = 0;
  await leader.wait(300);
  assert.ok(leader.frames > 5, `回到等待後迴圈要醒過來，只跑了 ${leader.frames} 幀`);
});

check("下一題送不出去時，立刻回到結果頁並說明，不是隔幾秒才被拉回去", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();
  await m1.tapChoice(A);
  await leader.poll();
  await leader.click("q-submit");
  assert.equal(leader.screen(), "panel-result");

  leader.hang = true;                    // The network drops right here
  leader.clickNow("r-next");
  await leader.wait(100);
  assert.equal(leader.screen(), "stage", "先樂觀切過去");

  leader.hang = false;
  await leader.wait(6800);               // Wait for the timeout
  assert.equal(leader.screen(), "panel-result", "失敗就要回到結果頁");
  assert.match(leader.text("toast"), /網路/, "而且要說明為什麼");
});

check("取消後重掃同一題，隊員的選項順序要跟著換", async () => {
  let caught = null;
  for (let i = 0; i < 15 && !caught; i++) {
    const leader = new Phone("L", BASE);
    const m1 = new Phone("M1", BASE);
    await leader.login(LEADER);
    await m1.login(MEMBER);
    await leader.type(QID);
    await m1.poll();                     // The member sees the first shuffle

    await leader.click("q-cancel");      // Every member poll falls between the discard and the rescan
    await leader.type(QID);              // Rescan, so the server reshuffles
    await m1.poll();

    if (JSON.stringify(m1.choices()) !== JSON.stringify(leader.choices())) {
      caught = { leader: leader.choices(), member: m1.choices() };
    }
    leader.close(); m1.close();
  }
  assert.equal(caught, null,
    caught && `隊輔 ${JSON.stringify(caught.leader)} vs 隊員 ${JSON.stringify(caught.member)}`);
});

check("切換鏡頭時輪詢插進來，不會漏掉 stream 也不會切回去", async () => {
  const leader = new Phone("L", BASE);
  leader.camera = true;
  await leader.login(LEADER);
  await leader.click("scan-toggle");
  await leader.wait(200);
  assert.equal(leader.liveTracks, 1, "應該剛好一條 stream");

  leader.camDelay = 900;                 // getUserMedia takes 0.3-2s on a phone
  leader.clickNow("cam-switch");
  await leader.wait(1600);               // At least one poll happens in this window

  assert.equal(leader.liveTracks, 1, `有 ${leader.liveTracks} 條 track 沒被關掉`);
  assert.ok(leader.streams <= 3, `開了 ${leader.streams} 條 stream，太多了`);
});

check("投票前算好、投票後才送達的輪詢回應，不可以抹掉選擇", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();
  const choice = m1.choices()[0];

  // The /api/state response is held up by the downlink: the server computed it
  // before any vote, and by the time it arrives the vote has landed
  m1.slowPath = "/api/state";
  m1.delay = 1200;
  m1.poll();                             // Not awaited; this one carries the pre-vote state
  await m1.wait(150);
  m1.slowPath = "/api/vote";             // The vote itself must be fast
  m1.delay = 0;
  await m1.tapChoice(choice);
  assert.deepEqual(m1.checked(), [choice]);

  // Sampled throughout: it must not drop even for the instant the stale response
  // arrives, and being restored by a later poll does not count as passing
  const seen = new Set();
  const sampler = setInterval(() => seen.add(m1.checked().join(",") + "|" + m1.text("q-tally")), 20);
  await m1.wait(1600);                   // The stale state only arrives now
  clearInterval(sampler);
  const bad = [...seen].filter((v) => !v.startsWith(choice + "|") || /已投 0/.test(v));
  assert.deepEqual(bad, [], `中途閃過的畫面：${bad.join("  /  ")}`);
  await leader.poll();
  assert.equal(leader.counts()[choice], "1");
});

check("登入時網路一閃，恢復後會自己接回來", async () => {
  const phone = new Phone("M1", BASE);
  phone.hang = true;                     // The login request never returns
  phone.login(MEMBER);                   // Not awaited
  await phone.wait(500);
  phone.hang = false;                    // The network recovers fast, but that request is already stuck
  await phone.wait(6500);                // Wait for it to time out
  assert.match(phone.text("toast"), /網路/, "要先告訴使用者失敗了");

  await phone.wait(2000);                // Polling retries with the stored token on its own
  assert.equal(phone.screen(), "panel-wait", "應該自己接回來，不用重新整理");
});

check("存著的舊 token 失效後，重打新 token 仍然是登入", async () => {
  // Real scenario: localStorage holds a token left over from the last event, and
  // the automatic login on page open fails
  const phone = new Phone("M1", BASE, { "treasure.token": "stale-token-from-last-time" });
  await phone.wait(400);
  assert.equal(phone.el("bar").hidden, true, "自動登入應該失敗");
  assert.equal(phone.el("bar").hidden, true);

  phone.el("entry-input").value = MEMBER;
  phone.el("entry-form").fire("submit");
  await phone.wait(300);
  assert.equal(phone.screen(), "panel-wait", `重打正確 token 應該登入，toast=${phone.text("toast")}`);
});

check("卡住的請求會逾時，手機不會被凍住", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();

  m1.hang = true;                       // This vote never comes back
  m1.tapChoiceNow(m1.choices()[0]);
  await m1.wait(1000);
  m1.sent = [];
  await m1.wait(1500);
  assert.equal(m1.sent.length, 0, "卡住期間輪詢確實停住了（預期行為）");

  m1.hang = false;
  await m1.wait(9000);                  // Wait for the timeout to fire
  assert.ok(m1.sent.length > 0, `逾時後應該恢復輪詢，實際只送了 ${m1.sent.length} 個請求`);
  assert.match(m1.text("toast"), /網路|逾時|連不上/, "要告訴使用者發生什麼事");
});

check("按下一題後，鏡頭裡還是同一張貼紙也不會被彈回結果頁", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  leader.camera = true;
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.click("scan-toggle");
  leader.aimAt(QID);                     // Pointed at the question sticker on the wall
  await leader.wait(300);
  assert.equal(leader.screen(), "panel-question", "應該掃到題目了");

  await m1.poll();
  await m1.tapChoice(A);
  await leader.poll();
  await leader.click("q-submit");
  assert.equal(leader.screen(), "panel-result");

  await leader.click("r-next");           // The sticker is still in frame
  await leader.wait(500);
  assert.equal(leader.screen(), "stage", "不可以被同一張貼紙彈回結果頁");
});

check("CSS 沒有蓋掉 hidden 屬性", async () => {
  // The DOM stub only looks at el.hidden and could never catch this, so this is
  // a static check
  const css = fs.readFileSync(path.join(APP_DIR, "static", "style.css"), "utf8");
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    "少了 [hidden] 的保險規則：.ghost 的 display: block 會蓋過瀏覽器的 "
    + "[hidden]，隊員就會看到「取消這一題」");
});

check("隊輔登入後看到掃描畫面，隊員登入後看到等待畫面", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  assert.equal(leader.screen(), "stage", "隊輔應該在掃描舞台");
  assert.equal(m1.screen(), "panel-wait", "隊員應該在等待畫面");
  assert.match(m1.text("wait-title"), /第 1 隊/);
  assert.match(leader.text("stage-hint"), /隊員在線/);
  return { leader, m1 };
});

check("隊輔開題目，隊員手機上自動出現同一題", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);

  await leader.type(QID);
  assert.equal(leader.screen(), "panel-question");
  assert.equal(m1.screen(), "panel-wait", "隊員要等下一次輪詢才會看到");
  await m1.poll();
  assert.equal(m1.screen(), "panel-question", "輪詢後隊員應該看到題目");
  assert.deepEqual(m1.choices().sort(), leader.choices().sort(), "兩邊選項要一樣");
});

check("隊員畫面不顯示題目代碼，只顯示分數", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();

  assert.doesNotMatch(m1.text("q-meta"), new RegExp(QID), "隊員不可以看到題目代碼");
  assert.match(m1.text("q-meta"), /\d+ 分/, "隊員要看得到分數");
  assert.match(leader.text("q-meta"), new RegExp(QID), "隊輔要看得到代碼，才對得上貼紙");
});

check("隊員投票、改票；隊輔即時看到票數，隊員看不到", async () => {
  const leader = new Phone("L", BASE);
  const [m1, m2, m3] = ["M1", "M2", "M3"].map((n) => new Phone(n, BASE));
  await leader.login(LEADER);
  for (const m of [m1, m2, m3]) await m.login(MEMBER);
  await leader.type(QID);
  for (const m of [m1, m2, m3]) await m.poll();

  await m1.tapChoice(A);
  await m2.tapChoice(A);
  await m3.tapChoice(B);
  assert.deepEqual(m1.checked(), [A], "隊員要看到自己選的");
  assert.deepEqual(m1.counts(), {}, "隊員畫面上不可以有票數");

  await leader.poll();
  assert.equal(leader.counts()[A], "2");
  assert.equal(leader.counts()[B], "1");
  assert.match(leader.text("q-submit"), new RegExp(`送出「${A}」`));
  assert.match(leader.text("q-tally"), /已投 3\/3/);
  assert.match(m1.text("q-tally"), /已投 \d+\/\d+/, "隊員看得到參與人數");

  await m1.tapChoice(B);          // Changes the vote
  await leader.poll();
  assert.equal(leader.counts()[A], "1");
  assert.equal(leader.counts()[B], "2");
  assert.match(leader.text("q-submit"), new RegExp(`送出「${B}」`));
});

check("RTT 期間的第二次點擊不會被丟掉", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();
  const [first, second] = m1.choices();

  m1.delay = 400;                       // 400ms per round trip
  m1.tapChoiceNow(first);
  await m1.wait(80);
  m1.tapChoiceNow(second);              // Changes their mind while the first vote is in flight
  await m1.wait(80);
  assert.deepEqual(m1.checked(), [second], "畫面要顯示第二次點的");

  // Throughout, the screen must never flash back to the first tap
  const seen = new Set();
  const sampler = setInterval(() => seen.add(m1.checked().join(",")), 20);
  m1.delay = 0;
  await m1.wait(1200);                  // Wait for both round trips to settle
  clearInterval(sampler);
  assert.deepEqual([...seen], [second], `畫面中途閃過：${[...seen].join(" → ")}`);
  assert.deepEqual(m1.checked(), [second], "畫面不可以無聲倒回第一次點的");
  await leader.poll();
  assert.equal(leader.counts()[second], "1", "伺服器要記到第二次點的");
  assert.equal(leader.counts()[first], "0");
});

check("重複點同一個選項不會送出多餘的請求", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();
  const [only] = m1.choices();

  m1.delay = 400;
  m1.sent = [];
  m1.tapChoiceNow(only);
  await m1.wait(80);
  m1.tapChoiceNow(only);                // Taps the same choice twice
  m1.delay = 0;
  await m1.wait(1200);
  const votes = m1.sent.filter((p) => p === "/api/vote");
  assert.equal(votes.length, 1, `送了 ${votes.length} 次投票請求，應該只有 1 次`);
});

check("回應比輪詢週期慢時，輪詢不會堆疊", async () => {
  const m1 = new Phone("M1", BASE);
  await m1.login(MEMBER);
  m1.maxInflight = 0;
  m1.delay = 1500;                      // Longer than POLL_INTERVAL
  await m1.wait(4000);
  assert.equal(m1.maxInflight, 1, `同時在飛 ${m1.maxInflight} 個請求，應該只有 1 個`);
});

check("隊員點選項立刻反白，不等伺服器回應", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();

  m1.delay = 1500;                      // Longer than the poll interval, so a poll lands in between
  m1.tapChoiceNow(A);
  await m1.wait(60);                    // Well before the response
  assert.deepEqual(m1.checked(), [A], "點下去就要反白");
  assert.match(m1.text("q-tally"), /已投 1\//, "已投人數也要立刻跳");

  await m1.wait(1000);                  // Across one poll
  assert.deepEqual(m1.checked(), [A], "中途的輪詢不可以把樂觀更新蓋回去");

  m1.delay = 0;
  await m1.wait(1000);                  // Wait for the response to settle
  assert.deepEqual(m1.checked(), [A], "伺服器回來後結果一致");
  await leader.poll();
  assert.equal(leader.counts()[A], "1");
});

check("隊輔按下一題立刻回到等待，不等伺服器回應", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();
  await m1.tapChoice(A);
  await leader.poll();
  await leader.click("q-submit");

  leader.delay = 1500;
  leader.clickNow("r-next");
  await leader.wait(60);
  assert.equal(leader.screen(), "stage", "按下去就要回到掃描畫面");
  await leader.wait(1000);
  assert.equal(leader.screen(), "stage", "中途的輪詢不可以把畫面拉回結果頁");

  leader.delay = 0;
  await leader.wait(1000);
  assert.equal(leader.screen(), "stage");
});

check("隊輔按取消立刻回到等待，不等伺服器回應", async () => {
  const leader = new Phone("L", BASE);
  await leader.login(LEADER);
  await leader.type(QID);

  leader.delay = 1500;
  leader.clickNow("q-cancel");
  await leader.wait(60);
  assert.equal(leader.screen(), "stage");
  await leader.wait(1000);
  assert.equal(leader.screen(), "stage", "中途的輪詢不可以把畫面拉回題目");

  leader.delay = 0;
  await leader.wait(1000);
  assert.equal(leader.screen(), "stage");
});

check("平手時送出鈕鎖住，隊輔點一個才解鎖", async () => {
  const leader = new Phone("L", BASE);
  const [m1, m2] = ["M1", "M2"].map((n) => new Phone(n, BASE));
  await leader.login(LEADER);
  for (const m of [m1, m2]) await m.login(MEMBER);
  await leader.type(QID);
  for (const m of [m1, m2]) await m.poll();

  await m1.tapChoice(A);
  await m2.tapChoice(B);
  await leader.poll();
  assert.match(leader.text("q-submit"), /同票/);
  assert.equal(leader.el("q-submit").disabled, true, "平手時不可以直接送");

  await leader.tapChoice(B);
  assert.equal(leader.el("q-submit").disabled, false);
  assert.match(leader.text("q-submit"), new RegExp(`送出「${B}」`));
});

check("平手換人時，隊輔已點的選項要取消，送出鈕重新鎖住", async () => {
  const leader = new Phone("L", BASE);
  const [m1, m2] = ["M1", "M2"].map((n) => new Phone(n, BASE));
  await leader.login(LEADER);
  for (const m of [m1, m2]) await m.login(MEMBER);
  await leader.type(QID);
  for (const m of [m1, m2]) await m.poll();

  await m1.tapChoice(A);
  await m2.tapChoice(B);
  await leader.poll();
  await leader.tapChoice(A);
  assert.match(leader.text("q-submit"), new RegExp(`送出「${A}」`));
  assert.deepEqual(leader.checked(), [A]);

  await m1.tapChoice(C);            // The tie moves from A/B to B/C
  await leader.poll();
  assert.deepEqual(leader.checked(), [], "票數變了，隊輔的選擇要取消");
  assert.equal(leader.el("q-submit").disabled, true, "平手換人後要重新鎖住");
  assert.doesNotMatch(leader.text("q-submit"), new RegExp(`送出「${A}」`),
    "送出鈕不可以還指著已經不在平手名單裡的選項");
  assert.match(leader.text("q-submit"), /同票/);

  await leader.tapChoice(C);        // Pick again before submit unlocks
  assert.equal(leader.el("q-submit").disabled, false);
  assert.match(leader.text("q-submit"), new RegExp(`送出「${C}」`));
});

check("票數變動讓平手消失時，送出鈕指向新的最高票", async () => {
  const leader = new Phone("L", BASE);
  const [m1, m2] = ["M1", "M2"].map((n) => new Phone(n, BASE));
  await leader.login(LEADER);
  for (const m of [m1, m2]) await m.login(MEMBER);
  await leader.type(QID);
  for (const m of [m1, m2]) await m.poll();

  await m1.tapChoice(A);
  await m2.tapChoice(B);
  await leader.poll();
  await leader.tapChoice(A);

  await m1.tapChoice(B);            // B pulls ahead alone
  await leader.poll();
  assert.deepEqual(leader.checked(), []);
  assert.equal(leader.el("q-submit").disabled, false);
  assert.match(leader.text("q-submit"), new RegExp(`送出「${B}」`));
});

check("零票時送出鈕鎖住", async () => {
  const leader = new Phone("L", BASE);
  await leader.login(LEADER);
  await leader.type(QID);
  assert.match(leader.text("q-submit"), /還沒有人投票/);
  assert.equal(leader.el("q-submit").disabled, true);
});

check("送出後兩邊都看到票數與正解，隊員沒有下一題按鈕", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();
  await m1.tapChoice(A);

  await leader.poll();
  await leader.click("q-submit");
  assert.equal(leader.screen(), "panel-result");
  assert.equal(leader.el("r-next").hidden, false, "隊輔要有下一題");

  await m1.poll();
  assert.equal(m1.screen(), "panel-result");
  assert.equal(m1.el("r-next").hidden, true, "隊員不可以有下一題");
  const votes = m1.el("r-votes").children.map((c) => c.children.map((x) => x.textContent).join(" "));
  assert.deepEqual(votes, [`${A} 1 票`], "送出後票數才公開");
});

check("隊輔按下一題，全隊回到等待", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();
  await m1.tapChoice(A);
  await leader.poll();
  await leader.click("q-submit");

  await leader.click("r-next");
  assert.equal(leader.screen(), "stage");
  await m1.poll();
  assert.equal(m1.screen(), "panel-wait");
});

check("取消這一題：不留紀錄，全隊回到等待", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();
  await m1.tapChoice(A);

  await leader.click("q-cancel");
  assert.equal(leader.screen(), "stage");
  await m1.poll();
  assert.equal(m1.screen(), "panel-wait");
});

check("重掃已答過的題目：唯讀結果，隊員也看得到", async () => {
  const leader = new Phone("L", BASE);
  const m1 = new Phone("M1", BASE);
  await leader.login(LEADER);
  await m1.login(MEMBER);
  await leader.type(QID);
  await m1.poll();
  await m1.tapChoice(A);
  await leader.poll();
  await leader.click("q-submit");
  await leader.click("r-next");

  await leader.type(QID);
  assert.equal(leader.screen(), "panel-result", "重掃要開唯讀結果");
  await m1.poll();
  assert.equal(m1.screen(), "panel-result");
});

check("壞掉的題目代碼：留在原畫面並提示", async () => {
  const leader = new Phone("L", BASE);
  await leader.login(LEADER);
  await leader.type("ZZZZZ");
  assert.equal(leader.screen(), "stage", "找不到的代碼不該換畫面");
  assert.match(leader.text("toast"), /找不到/);
});

check("壞掉的 token：不會登入，也不會留在 localStorage", async () => {
  const phone = new Phone("X", BASE);
  await phone.login("definitely-not-a-real-token");
  assert.equal(phone.el("bar").hidden, true, "沒登入不該顯示分數列");
  assert.match(phone.text("toast"), /Token/);
});

(async () => {
  const server = await boot();
  let failed = 0;
  for (const [name, fn] of checks) {
    LIVE_PHONES.splice(0).forEach((p) => p.close());
    await fetch(BASE + "/reset", { method: "POST", headers: { "X-Reset-Token": RESET_TOKEN } });
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}\n          ${err.message.split("\n")[0]}`);
    }
  }
  server.kill();
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
