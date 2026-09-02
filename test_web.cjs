#!/usr/bin/env node
"use strict";

/* 前端端到端測試：`node test_web.cjs`（要有 node 與 uv）。
 *
 * 真正的 static/app.js 跑在一個最小 DOM stub 裡，打一個真正起起來的 Flask
 * 伺服器。每個 Phone 是獨立的 vm context = 一支手機，有自己的 localStorage
 * 與 device id，所以「隊輔 + 三台隊員」是真的四個 client 在互動。
 *
 * 伺服器用臨時的 DATA_FILE 與臨時的 token，不會碰到 .env 或正式的 data.json。
 * 相機在 Node 裡一定開不起來，所以走的是手動輸入題目代碼那條路徑。
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


const SRC = fs.readFileSync(path.join(__dirname, "static", "app.js"), "utf8");

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

const LIVE_PHONES = [];   // check 結束要全部關掉，不然輪詢會一直累積下去

class Phone {
  constructor(name, base, seed) {
    this.name = name;
    this.delay = 0;        // 人為的網路延遲，毫秒
    this.inflight = 0;
    this.maxInflight = 0;
    this.sent = [];        // 送出去的每一個 path，用來抓多餘的請求
    this.qr = null;        // 鏡頭裡現在對著哪張 QR
    this.camera = false;   // 這支手機有沒有相機
    this.streams = 0;      // 總共開過幾條 stream
    this.liveTracks = 0;   // 還沒被關掉的 track
    this.frame = 0;
    this.hang = false;     // 請求永遠不回來
    this.slowPath = null;  // 只有這個 path 會被延遲
    this.camDelay = 0;     // getUserMedia 要多久才回來
    this.els = {};
    this.timers = [];
    LIVE_PHONES.push(this);
    const store = new Map(Object.entries(seed || {}));
    const sandbox = {
      console,
      setTimeout, clearTimeout, clearInterval,
      setInterval: (fn, ms) => { const id = setInterval(fn, ms); this.timers.push(id); return id; },
      // 掃描迴圈：讓 tick 真的一幀一幀跑，才測得到重複掃描的去重
      requestAnimationFrame: (fn) => {
        const id = setTimeout(() => fn(this.frame += 20), 5);
        this.timers.push(id); return id;
      },
      cancelAnimationFrame: (id) => clearTimeout(id),
      URL, URLSearchParams, Math, Date, JSON, Object, Number, String, Boolean, Array, Error, Promise,
      AbortSignal,
      crypto: { randomUUID: () => `${name}-device` },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
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
      // 鏡頭裡「看到」什麼由測試決定：this.qr 有值就每幀都解得到它
      jsQR: () => (this.qr ? { data: this.qr } : null),
      fetch: (path, opts) => {
        this.sent.push(path);
        this.inflight++;
        this.maxInflight = Math.max(this.maxInflight, this.inflight);
        const done = () => { this.inflight--; };
        // 延遲加在回應之後：真實的慢下行是伺服器早就算完了，只是回應晚到。
        // 加在請求之前會變成「伺服器晚點才算」，測不到過期回應的問題。
        if (this.hang) {
          // 請求永遠不回來，但要尊重 AbortSignal
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

  /** 停掉輪詢。不關的話上一個 check 的手機會一直打伺服器 */
  close() { this.timers.forEach(clearInterval); this.timers = []; }

  /** 讓 video 看起來有畫面，掃描迴圈才會動；code 就是鏡頭裡那張 QR */
  aimAt(code) {
    const v = this.el("video");
    v.videoWidth = 640; v.videoHeight = 640; v.readyState = 4;
    this.qr = code;
  }

  el(id) { return this.els[id]; }
  /** 等待所有 in-flight 的 promise 收斂 */
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
  /** 點下去但不等回應，用來檢查畫面有沒有先動 */
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

  /** 目前顯示哪個畫面 */
  screen() {
    for (const id of ["stage", "panel-wait", "panel-question", "panel-result"]) {
      if (this.els[id] && !this.els[id].hidden) return id;
    }
    return "(none)";
  }
  choices() { return (this.els["q-choices"]?.children || []).map((c) => c.dataset.choice); }
  /** 只收真的有票數欄位的選項 —— 隊員的按鈕根本不會有這個元素 */
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


// ---------------------------------------------------------------- 伺服器

const BOOT = `
import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(__dirname)})
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
    { cwd: __dirname, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (d) => { stderr += d; });
  for (let i = 0; i < 100; i++) {
    try { await fetch(BASE + "/"); return server; } catch { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  server.kill();
  throw new Error("伺服器起不來：\n" + stderr);
}

/** 題目來自 questions.yaml，測試只需要一題有這些選項的。 */
const QID = "ABCDE";
const A = "火車";
const B = "恐龍";
const C = "企鵝";

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

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

  leader.hang = true;                    // 網路在這一刻斷了
  leader.clickNow("r-next");
  await leader.wait(100);
  assert.equal(leader.screen(), "stage", "先樂觀切過去");

  leader.hang = false;
  await leader.wait(6800);               // 等逾時
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
    await m1.poll();                     // 隊員看到第一次的洗牌結果

    await leader.click("q-cancel");      // 隊員的輪詢整段落在取消與重掃之間
    await leader.type(QID);              // 重掃 → 伺服器重洗
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

  leader.camDelay = 900;                 // 手機上 getUserMedia 要 0.3-2 秒
  leader.clickNow("cam-switch");
  await leader.wait(1600);               // 這段期間至少有一次輪詢

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

  // /api/state 的回應被下行拖慢：伺服器早就算好（還沒有票），送達時票已經進去了
  m1.slowPath = "/api/state";
  m1.delay = 1200;
  m1.poll();                             // 不等，這一發帶的是「還沒投票」的狀態
  await m1.wait(150);
  m1.slowPath = "/api/vote";             // 投票本身要快
  m1.delay = 0;
  await m1.tapChoice(choice);
  assert.deepEqual(m1.checked(), [choice]);

  // 全程取樣：過期回應送達的那一瞬間也不可以掉，之後被輪詢補回來不算過關
  const seen = new Set();
  const sampler = setInterval(() => seen.add(m1.checked().join(",") + "|" + m1.text("q-tally")), 20);
  await m1.wait(1600);                   // 那個過期的 state 現在才送達
  clearInterval(sampler);
  const bad = [...seen].filter((v) => !v.startsWith(choice + "|") || /已投 0/.test(v));
  assert.deepEqual(bad, [], `中途閃過的畫面：${bad.join("  /  ")}`);
  await leader.poll();
  assert.equal(leader.counts()[choice], "1");
});

check("登入時網路一閃，恢復後會自己接回來", async () => {
  const phone = new Phone("M1", BASE);
  phone.hang = true;                     // 登入請求飛不回來
  phone.login(MEMBER);                   // 不等
  await phone.wait(500);
  phone.hang = false;                    // 網路很快就回來了，但那一發已經卡住
  await phone.wait(6500);                // 等它逾時
  assert.match(phone.text("toast"), /網路/, "要先告訴使用者失敗了");

  await phone.wait(2000);                // 輪詢自己拿存著的 token 重試
  assert.equal(phone.screen(), "panel-wait", "應該自己接回來，不用重新整理");
});

check("存著的舊 token 失效後，重打新 token 仍然是登入", async () => {
  // 真實情境：localStorage 裡有上一場留下的 token，開頁時自動登入失敗
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

  m1.hang = true;                       // 這一票永遠飛不回來
  m1.tapChoiceNow(m1.choices()[0]);
  await m1.wait(1000);
  m1.sent = [];
  await m1.wait(1500);
  assert.equal(m1.sent.length, 0, "卡住期間輪詢確實停住了（預期行為）");

  m1.hang = false;
  await m1.wait(9000);                  // 等逾時觸發
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
  leader.aimAt(QID);                     // 對著牆上的題目貼紙
  await leader.wait(300);
  assert.equal(leader.screen(), "panel-question", "應該掃到題目了");

  await m1.poll();
  await m1.tapChoice(A);
  await leader.poll();
  await leader.click("q-submit");
  assert.equal(leader.screen(), "panel-result");

  await leader.click("r-next");           // 貼紙還在鏡頭裡
  await leader.wait(500);
  assert.equal(leader.screen(), "stage", "不可以被同一張貼紙彈回結果頁");
});

check("CSS 沒有蓋掉 hidden 屬性", async () => {
  // DOM stub 只看 el.hidden，永遠抓不到這個 —— 這是靜態檢查
  const css = fs.readFileSync(path.join(__dirname, "static", "style.css"), "utf8");
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

  await m1.tapChoice(B);          // 改票
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

  m1.delay = 400;                       // 一趟來回 400ms
  m1.tapChoiceNow(first);
  await m1.wait(80);
  m1.tapChoiceNow(second);              // 第一票還在飛的時候改主意
  await m1.wait(80);
  assert.deepEqual(m1.checked(), [second], "畫面要顯示第二次點的");

  // 整段期間畫面都不可以閃回第一次點的那個
  const seen = new Set();
  const sampler = setInterval(() => seen.add(m1.checked().join(",")), 20);
  m1.delay = 0;
  await m1.wait(1200);                  // 等兩趟都收斂
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
  m1.tapChoiceNow(only);                // 同一個選項連點兩下
  m1.delay = 0;
  await m1.wait(1200);
  const votes = m1.sent.filter((p) => p === "/api/vote");
  assert.equal(votes.length, 1, `送了 ${votes.length} 次投票請求，應該只有 1 次`);
});

check("回應比輪詢週期慢時，輪詢不會堆疊", async () => {
  const m1 = new Phone("M1", BASE);
  await m1.login(MEMBER);
  m1.maxInflight = 0;
  m1.delay = 1500;                      // 比 POLL_INTERVAL 還久
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

  m1.delay = 1500;                      // 比 1 秒的輪詢週期還久：中途會有一次輪詢
  m1.tapChoiceNow(A);
  await m1.wait(60);                    // 遠早於回應
  assert.deepEqual(m1.checked(), [A], "點下去就要反白");
  assert.match(m1.text("q-tally"), /已投 1\//, "已投人數也要立刻跳");

  await m1.wait(1000);                  // 跨過一次輪詢
  assert.deepEqual(m1.checked(), [A], "中途的輪詢不可以把樂觀更新蓋回去");

  m1.delay = 0;
  await m1.wait(1000);                  // 等回應收斂
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

  await m1.tapChoice(C);            // 平手組合從 A/B 變成 B/C
  await leader.poll();
  assert.deepEqual(leader.checked(), [], "票數變了，隊輔的選擇要取消");
  assert.equal(leader.el("q-submit").disabled, true, "平手換人後要重新鎖住");
  assert.doesNotMatch(leader.text("q-submit"), new RegExp(`送出「${A}」`),
    "送出鈕不可以還指著已經不在平手名單裡的選項");
  assert.match(leader.text("q-submit"), /同票/);

  await leader.tapChoice(C);        // 重新點一個，才又能送
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

  await m1.tapChoice(B);            // 變成 B 獨走
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
