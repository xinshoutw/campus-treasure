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
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: [], width: 0, height: 0 }) }),
  };
  return el;
}

class Phone {
  constructor(name, base) {
    this.name = name;
    this.els = {};
    const store = new Map();
    const sandbox = {
      console,
      setTimeout, clearTimeout, setInterval, clearInterval,
      requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
      URL, URLSearchParams, Math, Date, JSON, Object, Number, String, Boolean, Array, Error, Promise,
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
          getUserMedia: () => Promise.reject(Object.assign(new Error("no cam"), { name: "NotFoundError" })),
          enumerateDevices: () => Promise.resolve([]),
        },
      },
      jsQR: () => null,
      fetch: (path, opts) => fetch(base + path, opts),
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

  el(id) { return this.els[id]; }
  /** 等待所有 in-flight 的 promise 收斂 */
  settle() { return new Promise((r) => setTimeout(r, 60)); }

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
