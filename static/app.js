"use strict";

/* 校園尋寶前端。
 *
 * 畫面完全由伺服器的 /api/state 決定：每秒拉一次，拿到什麼就畫什麼。
 * 前端自己只留三個東西 —— token、device id、平手時隊輔點的那個選項。
 *
 * 角色：
 *   leader  掃題目開局、看各選項票數、決定送出。相機只在等待時開著。
 *   member  只掃一次登入 QR，之後相機永久關閉，等隊輔開題目再投票。
 */

const $ = (id) => document.getElementById(id);

const el = {
  bar: $("bar"), scores: $("scores"), progress: $("progress"),
  stage: $("stage"), title: $("stage-title"), hint: $("stage-hint"),
  scanner: $("scanner"), video: $("video"), camSwitch: $("cam-switch"), camLabel: $("cam-label"),
  scanToggle: $("scan-toggle"),
  form: $("entry-form"), input: $("entry-input"), submit: $("entry-submit"),
  wait: $("panel-wait"), waitTitle: $("wait-title"),
  qPanel: $("panel-question"), qMeta: $("q-meta"), qContent: $("q-content"),
  qFigure: $("q-figure"), qImage: $("q-image"), qChoices: $("q-choices"),
  qTally: $("q-tally"), qSubmit: $("q-submit"), qCancel: $("q-cancel"),
  rPanel: $("panel-result"), rTitle: $("r-title"),
  rDetail: $("r-detail"), rVotes: $("r-votes"), rNext: $("r-next"),
  toast: $("toast"), canvas: $("frame"),
};

const ID_RE = /^[A-Z]{5}$/;
const SCAN_INTERVAL = 100;   // ms，約 10fps
const SCAN_MAX_EDGE = 640;   // 解碼前先降採樣，避免主執行緒卡頓
const RESCAN_MISSES = 8;     // 同一組代碼要離開鏡頭這麼多幀才會再次觸發
const POLL_INTERVAL = 1000;
const REQUEST_TIMEOUT = 6000;   // ms。行動網路上請求可能永遠不回來，不能讓它卡死整支手機
const TOAST_MS = 3200;
const KEY_TOKEN = "treasure.token";
const KEY_DEVICE = "treasure.device";
const KEY_CAMERA = "treasure.camera";
const CHOICE_KEYS = "ABCDEFGHIJ";

const ctx = el.canvas.getContext("2d", { willReadFrequently: true });

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 無痕模式 */ } },
  drop(key) { try { localStorage.removeItem(key); } catch { /* 無痕模式 */ } },
};

let token = store.get(KEY_TOKEN);
let device = store.get(KEY_DEVICE);
if (!device) {
  device = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now().toString(36));
  store.set(KEY_DEVICE, device);
}

let state = null;
let pick = null;             // 平手時隊輔點的選項，只活在這台手機上
let rendered = "";           // 目前畫面的身分，變了才重建 DOM
let tallied = "";            // 票數的指紋，變了就取消隊輔已點的選項
let busy = false;
let polling = false;         // 同時只允許一次輪詢在飛
let pendingVote = null;      // 上一票還在飛時又點的那個選項
let shownWinner = null;      // 送出鈕上寫的那個選項，就是會送出去的那個

let stream = null;
let cameras = [];
let cameraIndex = 0;
let cameraGranted = false;   // 成功開過一次，之後每局自動接回來
let cameraOpening = false;
let rafId = 0;
let lastFrame = 0;
let lastCode = "";
let misses = 0;
let pollId = 0;
let toastId = 0;

const role = () => state?.role;
const phase = () => state?.phase ?? "idle";

// ---------------------------------------------------------------- API

async function api(path, options = {}) {
  const headers = { "X-Device": device };
  if (token) headers["X-Token"] = token;
  if (options.body) headers["Content-Type"] = "application/json";

  let res;
  try {
    // 沒有逾時的話，一個卡住的請求會讓 busy 永遠是 true：輪詢停掉、
    // 每個按鈕都沒反應，直到作業系統的 TCP timeout（數十秒）才解開
    res = await fetch(path, { ...options, headers, signal: AbortSignal.timeout?.(REQUEST_TIMEOUT) });
  } catch {
    throw new Error("網路不穩，沒送出去，再試一次");
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

const post = (path, body) =>
  api(path, { method: "POST", body: JSON.stringify(body || {}) });

/** 先照使用者的動作把畫面改掉，再送出去讓伺服器確認。
 *
 * 送不出去也不會卡住錯的畫面：act 的 catch 會提示，而且下一次輪詢（1 秒內）
 * 就會用伺服器的狀態蓋回來。 */
function optimistic(patch) {
  apply({ ...state, ...patch });
}

const IDLE_PATCH = { phase: "idle", question: undefined, counts: undefined, tie: undefined,
                     voted: undefined, result: undefined };

/** 包住一次使用者動作：期間停掉輪詢與掃描，結束後把回傳的 state 畫上去。 */
async function act(run) {
  if (busy) return;
  busy = true;
  try {
    apply(await run());
  } catch (err) {
    if (err.status === 401) logout();
    else toast(err.message);
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- 畫面

function toast(message) {
  clearTimeout(toastId);
  if (!message) { el.toast.hidden = true; return; }
  el.toast.textContent = message;
  el.toast.hidden = false;
  toastId = setTimeout(() => { el.toast.hidden = true; }, TOAST_MS);
}

function renderBar(next) {
  el.bar.hidden = false;
  el.scores.hidden = !next.show_scores;
  if (next.show_scores) {
    el.scores.replaceChildren(...next.scores.map((value, i) => {
      const li = document.createElement("li");
      if (i + 1 === next.team) li.className = "me";
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
  el.progress.textContent = `解題數 ${next.answered}/${next.total} · 共 ${fmt(next.score)} 分`;
}

/** 伺服器說什麼就畫什麼。fresh 表示題目或階段換了，要重建 DOM。 */
function apply(next) {
  state = next;
  renderBar(next);

  const key = `${next.role}:${next.phase}:${next.question?.id ?? ""}`;
  const fresh = key !== rendered;
  rendered = key;
  if (fresh) pick = null;

  // 票數一有異動就取消隊輔已點的選項：平手的組合可能已經換人，留著會讓
  // 送出鈕指著一個根本不在平手名單裡的答案
  const tally = JSON.stringify(next.counts ?? null);
  if (tally !== tallied) { tallied = tally; pick = null; }

  el.stage.hidden = !(next.phase === "idle" && next.role === "leader");
  el.wait.hidden = !(next.phase === "idle" && next.role === "member");
  el.qPanel.hidden = next.phase !== "voting";
  el.rPanel.hidden = next.phase !== "revealed";

  if (next.phase === "idle") renderIdle(next);
  else if (next.phase === "voting") renderVoting(next, fresh);
  else renderResult(next, fresh);

  setCamera(next.phase === "idle" && next.role === "leader");
}

function renderIdle(next) {
  if (next.role === "member") {
    el.waitTitle.textContent = `第 ${next.team} 隊 · 等待題目中`;
    return;
  }
  el.title.textContent = `第 ${next.team} 隊`;
  el.hint.textContent = `掃描題目 QR-Code · 隊員在線 ${next.online} 人`;
  el.input.className = "field code";
  el.input.placeholder = "ABCDE";
  el.input.maxLength = 5;
  el.input.setAttribute("autocapitalize", "characters");
  el.submit.textContent = "開始";
  el.scanToggle.textContent = "開啟相機";
}

function renderLogin() {
  el.bar.hidden = true;
  el.stage.hidden = false;
  el.wait.hidden = el.qPanel.hidden = el.rPanel.hidden = true;
  el.title.textContent = "校園尋寶";
  el.hint.textContent = "掃描隊伍 QR-Code 登入";
  el.input.className = "field";
  el.input.placeholder = "輸入登入 Token";
  el.input.maxLength = 64;
  el.input.setAttribute("autocapitalize", "off");
  el.input.value = "";
  el.submit.textContent = "登入";
  el.scanToggle.textContent = "掃描 QR-Code 登入";
  setCamera(true);
}

// ---------------------------------------------------------------- 投票中

function renderVoting(next, fresh) {
  const q = next.question;
  const leader = next.role === "leader";

  if (fresh) {
    // 隊員看不到題目代碼：貼紙是隊輔在掃的，代碼對隊員沒有用途
    el.qMeta.textContent = leader ? `${q.id} · ${fmt(q.points)} 分` : `${fmt(q.points)} 分`;
    el.qContent.textContent = q.content;
    el.qFigure.hidden = !q.image;
    if (q.image) {
      el.qImage.src = q.image;
      el.qImage.alt = q.content;
    }
    el.qChoices.replaceChildren(...q.choices.map((text, i) => buildChoice(text, i, leader)));
    el.qSubmit.hidden = !leader;
    el.qCancel.hidden = !leader;
    el.qCancel.disabled = false;
  }

  const tie = next.tie ?? [];
  for (const button of el.qChoices.children) {
    const text = button.dataset.choice;
    const chosen = leader ? pick === text : next.my_choice === text;
    button.setAttribute("aria-checked", String(chosen));
    if (leader) {
      // 隊輔平常不能點選項，只有平手時才用來指定送哪一個
      button.disabled = !tie.includes(text);
      button.classList.toggle("tiebreak", tie.includes(text));   // 平手時才看得出來能點
      button.querySelector(".choice-count").textContent = next.counts[text] ?? 0;
    }
  }

  el.qTally.textContent = `已投 ${next.voted}/${next.online} 人`;
  if (leader) updateSubmit(next, tie);
}

function buildChoice(text, index, leader) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "choice";
  button.dataset.key = CHOICE_KEYS[index];
  button.dataset.choice = text;
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", "false");

  const label = document.createElement("span");
  label.className = "choice-text";
  label.textContent = text;
  button.append(label);

  if (leader) {
    const count = document.createElement("span");
    count.className = "choice-count";
    count.textContent = "0";
    button.append(count);
  }
  button.addEventListener("click", () => onChoice(text, leader));
  return button;
}

function updateSubmit(next, tie) {
  if (!next.voted) {
    shownWinner = null;
    el.qSubmit.textContent = "還沒有人投票";
    el.qSubmit.disabled = true;
  } else if (tie.length > 1 && !tie.includes(pick)) {
    shownWinner = null;
    el.qSubmit.textContent = `${tie.join(" · ")} 同票，點一個要送的`;
    el.qSubmit.disabled = true;
  } else {
    shownWinner = tie.length > 1 ? pick : topChoice(next);
    el.qSubmit.textContent = `送出「${shownWinner}」`;
    el.qSubmit.disabled = false;
  }
}

function topChoice(next) {
  return Object.keys(next.counts).reduce((best, key) =>
    next.counts[key] > next.counts[best] ? key : best);
}

function onChoice(text, leader) {
  if (leader) {
    if (!(state.tie ?? []).includes(text)) return;
    pick = text;
    renderVoting(state, false);
    return;
  }
  // 先反白再送：不要讓使用者為了一趟網路來回而懷疑自己沒點到
  optimistic({ my_choice: text, voted: state.voted + (state.my_choice ? 0 : 1) });
  castVote(text);
}

// ---------------------------------------------------------------- 結果

/** 送出這一票。上一票還在飛的話記住最後一次，等它回來再補送。
 *
 * 直接丟掉會讓「最後一次點的算數」在有 RTT 的網路上變成假的：使用者看到自己
 * 改了，伺服器卻收到第一次那票，畫面過幾百毫秒又無聲倒回去。 */
function castVote(text) {
  if (busy) { pendingVote = text; return; }
  sendVote(text);
}

async function sendVote(text) {
  busy = true;
  try {
    const next = await post("/api/vote", { choice: text });
    if (pendingVote === null) apply(next);   // 期間又點了，別把舊的畫回去
  } catch (err) {
    if (err.status === 401) logout();
    else toast(err.message);
  } finally {
    busy = false;
  }
  const queued = pendingVote;
  pendingVote = null;
  if (queued !== null && queued !== text) sendVote(queued);
}


function renderResult(next, fresh) {
  if (!fresh) return;
  const result = next.result;
  el.rPanel.classList.toggle("correct", result.correct);
  el.rPanel.classList.toggle("wrong", !result.correct);
  el.rTitle.textContent = result.correct ? "答對了！" : "答錯了";

  const rows = [["送出的答案", result.choice]];
  if (!result.correct) rows.push(["正解", result.answer]);
  rows.push(["本題得分", `${fmt(result.earned)} 分`]);
  el.rDetail.replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    return [dt, dd];
  }));

  const votes = Object.entries(result.votes ?? {}).sort((a, b) => b[1] - a[1]);
  el.rVotes.replaceChildren(...votes.map(([text, count]) => {
    const li = document.createElement("li");
    if (text === result.answer) li.className = "right";
    const name = document.createElement("span");
    name.textContent = text;
    const bar = document.createElement("span");
    bar.className = "bars";
    bar.textContent = `${count} 票`;
    li.append(name, bar);
    return li;
  }));

  el.rNext.hidden = next.role !== "leader";
  el.rNext.disabled = false;
}

// ---------------------------------------------------------------- 相機

function setCamera(on) {
  if (on) {
    // 上一局結束時相機被關掉了，權限拿過就直接接回來，不用隊輔每題手動按一次
    if (!stream && cameraGranted) { openCamera(); return; }
    el.scanner.hidden = !stream;
    el.scanToggle.hidden = Boolean(stream);
    el.camSwitch.hidden = cameras.length < 2;
    resumeScanning();
  } else if (stream) {
    stopCamera();
    el.scanner.hidden = true;
    el.scanToggle.hidden = false;
  }
}

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

  cameraGranted = true;
  el.video.srcObject = stream;
  await el.video.play().catch(() => { /* iOS 偶爾拒絕自動播放 */ });
  await refreshCameraList();
  setCamera(true);
}

function stopCamera() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  // 這裡不能清 lastCode。相機每一局都會關掉再開，清掉的話按「下一題」時
  // 鏡頭若還對著剛才那張貼紙，會立刻再掃一次、把全隊彈回結果頁。
  // 解除封鎖只由 RESCAN_MISSES 負責，也就是貼紙真的離開鏡頭。
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
  // 等待時每秒輪詢一次都會叫到這裡，相機還在開的時候不能再開一次
  if (cameraOpening) return;
  cameraOpening = true;
  startCamera(store.get(KEY_CAMERA))
    .catch((err) => toast(cameraMessage(err)))
    .finally(() => { cameraOpening = false; });
}

function cameraMessage(err) {
  if (err?.name === "NotAllowedError") return "相機權限被拒絕，可以直接輸入代碼";
  if (err?.name === "NotFoundError") return "找不到相機，可以直接輸入代碼";
  return "相機開不起來，可以直接輸入代碼";
}

// ---------------------------------------------------------------- 掃描

function scanning() {
  return Boolean(stream) && (!state || (state.phase === "idle" && state.role === "leader"));
}

function resumeScanning() {
  if (!stream) return;
  el.video.play().catch(() => { /* 面板切換後 iOS 可能暫停 */ });
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function tick(now) {
  rafId = requestAnimationFrame(tick);
  if (busy || !scanning()) return;
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
  if (!token) { login(parseToken(text)); return; }
  const id = text.toUpperCase();
  if (!ID_RE.test(id)) { toast("這不是題目 QR-Code"); return; }
  act(() => post("/api/scan", { id }));
}

function parseToken(text) {
  try {
    const found = new URL(text).searchParams.get("token");
    if (found) return found.trim();
  } catch { /* 不是網址，就當成 token 本身 */ }
  return text.trim();
}

// ---------------------------------------------------------------- 登入

async function login(value) {
  if (!value || busy) return;
  busy = true;
  try {
    const next = await api("/api/login", { method: "POST", body: JSON.stringify({ token: value }) });
    token = value;
    store.set(KEY_TOKEN, value);
    apply(next);
    startPolling();
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
  state = null;
  rendered = "";
  store.drop(KEY_TOKEN);
  renderLogin();
  toast("登入失效，請重新登入");
}

// ---------------------------------------------------------------- 輪詢

function startPolling() {
  clearInterval(pollId);
  pollId = setInterval(refreshState, POLL_INTERVAL);
}

async function refreshState() {
  if (!token || busy || polling || document.hidden) return;
  polling = true;
  try {
    const next = await api("/api/state");
    // 這趟飛的時候使用者動了手，那份狀態比較新，別用舊的蓋掉
    if (!busy) apply(next);
  } catch (err) {
    if (err.status === 401) logout();
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------- 綁定

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = el.input.value.trim();
  if (!value) return;
  el.input.blur();
  el.input.value = "";
  if (!token) login(parseToken(value));
  else if (ID_RE.test(value.toUpperCase())) act(() => post("/api/scan", { id: value.toUpperCase() }));
  else toast("題目代碼是五碼大寫英文字母");
});

el.input.addEventListener("input", () => {
  if (!token) return;
  const cleaned = el.input.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
  if (cleaned !== el.input.value) el.input.value = cleaned;
  if (cleaned.length === 5) {
    el.input.blur();
    el.input.value = "";
    act(() => post("/api/scan", { id: cleaned }));
  }
});

el.scanToggle.addEventListener("click", openCamera);
el.camSwitch.addEventListener("click", cycleCamera);
el.qSubmit.addEventListener("click", () => {
  if (busy) return;
  el.qSubmit.disabled = true;   // 送出可能被伺服器擋（票數變了），所以只給按下去的回饋
  // 送出的一定是按鈕上寫的那個。伺服器會重算並比對，對不上就擋下來
  act(() => post("/api/submit", { choice: shownWinner }));
});

// 取消與下一題在伺服器端一定成功，直接切畫面不用等
const goIdle = () => { if (!busy) { optimistic(IDLE_PATCH); act(() => post("/api/close")); } };
el.qCancel.addEventListener("click", goIdle);
el.rNext.addEventListener("click", goIdle);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  resumeScanning();
  refreshState();
});

// ---------------------------------------------------------------- 啟動

renderLogin();

const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  history.replaceState(null, "", location.pathname);  // 別把 token 留在網址列
  login(urlToken.trim());
} else if (token) {
  login(token);
}
