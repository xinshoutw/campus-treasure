"use strict";

/* 校園尋寶前端。單頁：登入 / 掃描 / 題目 / 結果 四個狀態共用同一份相機串流。 */

const $ = (id) => document.getElementById(id);

const el = {
  bar: $("bar"), scores: $("scores"), progress: $("progress"),
  stage: $("stage"), title: $("stage-title"), hint: $("stage-hint"),
  scanner: $("scanner"), video: $("video"), camSwitch: $("cam-switch"), camLabel: $("cam-label"),
  scanToggle: $("scan-toggle"),
  form: $("entry-form"), input: $("entry-input"), submit: $("entry-submit"),
  qPanel: $("panel-question"), qMeta: $("q-meta"), qContent: $("q-content"),
  qFigure: $("q-figure"), qImage: $("q-image"), qChoices: $("q-choices"),
  qSubmit: $("q-submit"), qBack: $("q-back"),
  rPanel: $("panel-result"), rTitle: $("r-title"),
  rDetail: $("r-detail"), rNext: $("r-next"),
  toast: $("toast"), canvas: $("frame"),
};

const ID_RE = /^[A-Z]{5}$/;
const SCAN_INTERVAL = 100;   // ms，約 10fps
const SCAN_MAX_EDGE = 640;   // 解碼前先降採樣，避免主執行緒卡頓
const POLL_INTERVAL = 5000;
const RESCAN_MISSES = 8;     // 同一組代碼要離開鏡頭這麼多幀才會再次觸發
const TOAST_MS = 3200;
const KEY_TOKEN = "treasure.token";
const KEY_CAMERA = "treasure.camera";
const CHOICE_KEYS = "ABCDEFGHIJ";

const ctx = el.canvas.getContext("2d", { willReadFrequently: true });

let token = null;
let team = null;
let mode = "login";          // login | scan | question | result
let question = null;
let choice = null;
let busy = false;

let stream = null;
let cameras = [];
let cameraIndex = 0;
let rafId = 0;
let lastFrame = 0;
let lastCode = "";
let misses = 0;
let pollId = 0;
let toastId = 0;

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 無痕模式 */ } },
  drop(key) { try { localStorage.removeItem(key); } catch { /* 無痕模式 */ } },
};

// ---------------------------------------------------------------- API

async function api(path, options = {}) {
  const headers = {};
  if (token) headers["X-Token"] = token;
  if (options.body) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch {
    throw new Error("連不上伺服器，檢查一下網路");
  }
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON 回應 */ }
  if (!res.ok) {
    const err = new Error(data.error || `伺服器錯誤（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function onApiError(err) {
  if (err.status === 401) logout();
  else toast(err.message);
}

// ---------------------------------------------------------------- 畫面

function toast(message) {
  clearTimeout(toastId);
  if (!message) { el.toast.hidden = true; return; }
  el.toast.textContent = message;
  el.toast.hidden = false;
  toastId = setTimeout(() => { el.toast.hidden = true; }, TOAST_MS);
}

function renderBar(state) {
  el.bar.hidden = false;
  el.scores.hidden = !state.show_scores;
  if (state.show_scores) {
    el.scores.replaceChildren(...state.scores.map((value, i) => {
      const li = document.createElement("li");
      if (i + 1 === team) li.className = "me";
      const no = document.createElement("span");
      no.className = "no";
      no.textContent = i + 1;
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = fmt(value);
      li.append(no, val);
      return li;
    }));
  }
  el.progress.textContent = `解題數 ${state.answered}/${state.total} · 共 ${fmt(state.score)} 分`;
}

function setMode(next) {
  mode = next;
  const onStage = next === "login" || next === "scan";
  el.stage.hidden = !onStage;
  el.qPanel.hidden = next !== "question";
  el.rPanel.hidden = next !== "result";

  if (next === "login") {
    el.title.textContent = "校園尋寶";
    el.hint.textContent = "掃描隊伍 QR-Code 登入";
    el.input.className = "field";
    el.input.placeholder = "輸入登入 Token";
    el.input.maxLength = 64;
    el.input.setAttribute("autocapitalize", "off");
    el.submit.textContent = "登入";
    el.scanToggle.textContent = "掃描 QR-Code 登入";
    el.input.value = "";
  } else if (next === "scan") {
    el.title.textContent = `第 ${team} 隊`;
    el.hint.textContent = "掃描題目 QR-Code";
    el.input.className = "field code";
    el.input.placeholder = "ABCDE";
    el.input.maxLength = 5;
    el.input.setAttribute("autocapitalize", "characters");
    el.submit.textContent = "送出";
    el.scanToggle.textContent = "開啟相機";
    el.input.value = "";
  }

  syncScanner();
  if (onStage) resumeScanning();
}

function syncScanner() {
  const live = Boolean(stream);
  el.scanner.hidden = !live;
  el.scanToggle.hidden = live;
  el.camSwitch.hidden = cameras.length < 2;
}

// ---------------------------------------------------------------- 相機

async function startCamera(preferredId) {
  stopCamera();
  const attempts = [];
  if (preferredId) attempts.push({ video: { deviceId: { exact: preferredId } } });
  attempts.push({ video: { facingMode: { ideal: "environment" } } });
  attempts.push({ video: true });

  let lastError = null;
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!stream) throw lastError || new Error("no camera");

  el.video.srcObject = stream;
  await el.video.play().catch(() => { /* iOS 偶爾拒絕自動播放 */ });
  await refreshCameraList();
  syncScanner();
  resumeScanning();
}

function stopCamera() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

async function refreshCameraList() {
  // deviceId 與 label 都要拿到相機權限之後才讀得到
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  cameras = devices.filter((d) => d.kind === "videoinput" && d.deviceId);

  const active = stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
  const index = cameras.findIndex((c) => c.deviceId === active);
  if (index >= 0) cameraIndex = index;
  if (active) store.set(KEY_CAMERA, active);

  const current = cameras[cameraIndex];
  el.camLabel.textContent = cameras.length
    ? `${current?.label || "鏡頭"}（${cameraIndex + 1}/${cameras.length}）`
    : "";
}

async function cycleCamera() {
  if (cameras.length < 2) return;
  const next = cameras[(cameraIndex + 1) % cameras.length].deviceId;
  try {
    await startCamera(next);
  } catch {
    toast("這顆鏡頭開不起來");
  }
}

function openCamera() {
  startCamera(store.get(KEY_CAMERA)).catch((err) => toast(cameraMessage(err)));
}

function cameraMessage(err) {
  if (err?.name === "NotAllowedError") return "相機權限被拒絕，可以直接輸入代碼";
  if (err?.name === "NotFoundError") return "找不到相機，可以直接輸入代碼";
  return "相機開不起來，可以直接輸入代碼";
}

// ---------------------------------------------------------------- 掃描

function resumeScanning() {
  if (!stream) return;
  el.video.play().catch(() => { /* 面板切換後 iOS 可能暫停 */ });
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function tick(now) {
  rafId = requestAnimationFrame(tick);
  if (busy || (mode !== "login" && mode !== "scan")) return;
  if (now - lastFrame < SCAN_INTERVAL) return;
  lastFrame = now;

  const w = el.video.videoWidth;
  const h = el.video.videoHeight;
  if (!w || !h || el.video.readyState < 2) return;

  const scale = Math.min(1, SCAN_MAX_EDGE / Math.max(w, h));
  el.canvas.width = Math.round(w * scale);
  el.canvas.height = Math.round(h * scale);
  ctx.drawImage(el.video, 0, 0, el.canvas.width, el.canvas.height);

  const frame = ctx.getImageData(0, 0, el.canvas.width, el.canvas.height);
  const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
  if (!found?.data) {
    // 連續數幀都沒看到 QR，才算貼紙離開鏡頭、解除封鎖
    if (++misses >= RESCAN_MISSES) lastCode = "";
    return;
  }
  misses = 0;
  const text = found.data.trim();
  if (text === lastCode) return;
  lastCode = text;
  onScan(text);
}

function onScan(text) {
  if (busy) return;
  if (mode === "login") { login(parseToken(text)); return; }
  const id = text.toUpperCase();
  if (!ID_RE.test(id)) { toast("這不是題目 QR-Code"); return; }
  openQuestion(id);
}

function parseToken(text) {
  try {
    const found = new URL(text).searchParams.get("token");
    if (found) return found.trim();
  } catch { /* 不是網址，就當成 token 本身 */ }
  return text.trim();
}

// ---------------------------------------------------------------- 流程

async function login(value) {
  if (!value || busy) return;
  busy = true;
  try {
    const state = await api("/api/login", { method: "POST", body: JSON.stringify({ token: value }) });
    token = value;
    team = state.team;
    store.set(KEY_TOKEN, value);
    renderBar(state);
    setMode("scan");
    startPolling();
    if (!stream) openCamera();
  } catch (err) {
    // 存著的 token 已經失效就丟掉，否則每次重整都會再失敗一次
    if (err.status === 401) store.drop(KEY_TOKEN);
    toast(err.message);
  } finally {
    busy = false;
  }
}

function logout() {
  clearInterval(pollId);
  token = null;
  team = null;
  store.drop(KEY_TOKEN);
  el.bar.hidden = true;
  setMode("login");
  toast("登入失效，請重新登入");
}

async function openQuestion(id) {
  if (busy) return;
  busy = true;
  try {
    const data = await api(`/api/question/${id}`);
    if (data.answered) { showResult(data, true); return; }
    question = data;
    choice = null;
    renderQuestion(data);
    setMode("question");
  } catch (err) {
    // 不清掉的話，再多打一個字會被 slice 回同一組壞代碼、又送一次
    el.input.value = "";
    onApiError(err);
  } finally {
    busy = false;
  }
}

function renderQuestion(data) {
  el.qMeta.textContent = `${data.id} · ${fmt(data.points)} 分`;
  el.qContent.textContent = data.content;
  el.qFigure.hidden = !data.image;
  if (data.image) {
    el.qImage.src = data.image;
    el.qImage.alt = data.content;
  }
  el.qSubmit.disabled = true;
  el.qChoices.replaceChildren(...data.choices.map((text, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    button.dataset.key = CHOICE_KEYS[i];
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    button.textContent = text;
    button.addEventListener("click", () => selectChoice(button, text));
    return button;
  }));
}

function selectChoice(button, text) {
  choice = text;
  for (const other of el.qChoices.children) {
    other.setAttribute("aria-checked", String(other === button));
  }
  el.qSubmit.disabled = false;
}

async function submitAnswer() {
  if (!question || !choice || busy) return;
  busy = true;
  el.qSubmit.disabled = true;
  try {
    const result = await api("/api/answer", {
      method: "POST",
      body: JSON.stringify({ id: question.id, choice }),
    });
    renderBar(result);
    showResult(result, result.already);
  } catch (err) {
    onApiError(err);
    el.qSubmit.disabled = false;
  } finally {
    busy = false;
  }
}

function showResult(result, already) {
  el.rPanel.classList.toggle("correct", result.correct);
  el.rPanel.classList.toggle("wrong", !result.correct);
  el.rTitle.textContent = already
    ? (result.correct ? "隊友已經答對了" : "隊友已經答過了")
    : (result.correct ? "答對了！" : "答錯了");

  const rows = [["你們選了", result.choice]];
  if (!result.correct) rows.push(["正解", result.answer]);
  rows.push(["本題得分", `${fmt(result.earned)} 分`]);

  el.rDetail.replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    return [dt, dd];
  }));
  setMode("result");
}

// ---------------------------------------------------------------- 輪詢

function startPolling() {
  clearInterval(pollId);
  pollId = setInterval(refreshState, POLL_INTERVAL);
}

async function refreshState() {
  if (!token || busy || document.hidden) return;
  try {
    renderBar(await api("/api/state"));
  } catch (err) {
    if (err.status === 401) logout();
  }
}

// ---------------------------------------------------------------- 綁定

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = el.input.value.trim();
  if (!value) return;
  el.input.blur();
  if (mode === "login") login(parseToken(value));
  else onScan(value);
});

el.input.addEventListener("input", () => {
  if (mode !== "scan") return;
  const cleaned = el.input.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
  if (cleaned !== el.input.value) el.input.value = cleaned;
  if (cleaned.length === 5) { el.input.blur(); openQuestion(cleaned); }
});

el.scanToggle.addEventListener("click", openCamera);
el.camSwitch.addEventListener("click", cycleCamera);
el.qSubmit.addEventListener("click", submitAnswer);
el.qBack.addEventListener("click", () => setMode("scan"));
el.rNext.addEventListener("click", () => setMode("scan"));

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  resumeScanning();
  refreshState();
});

// ---------------------------------------------------------------- 啟動

setMode("login");

const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  history.replaceState(null, "", location.pathname);  // 別把 token 留在網址列
  login(urlToken.trim());
} else {
  const saved = store.get(KEY_TOKEN);
  if (saved) login(saved);
}
