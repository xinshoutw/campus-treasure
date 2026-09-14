"use strict";

/* Campus treasure hunt frontend.
 *
 * The server's /api/state decides everything on screen: poll it, draw whatever
 * comes back. The client keeps only three things of its own: the token, the
 * device id, and the choice the leader picked to break a tie.
 *
 * Roles:
 *   leader  scans to open a round, sees the tally, decides what to submit.
 *           The camera runs only while waiting.
 *   member  scans the login QR once, after which the camera is off for good,
 *           then votes when the leader opens a question.
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
const SCAN_INTERVAL = 100;   // ms, about 10fps
const SCAN_MAX_EDGE = 640;   // Downsample before decoding, to keep the main thread smooth
const RESCAN_MISSES = 8;     // Frames the same code must be out of frame before it fires again
// 300ms: measured, the server takes ~3ms, 42 devices add up to 140 req/s, and
// at 96 devices running 95 req/s p50 is still 1.6ms. The real cost is member
// mobile data, roughly 3MB per device per hour. The polling flag skips a tick
// when a response runs slower than the interval, so requests never stack up.
const POLL_INTERVAL = 300;
const REQUEST_TIMEOUT = 6000;   // ms. On mobile a request may never return, and it must not wedge the phone
const TOAST_MS = 3200;
const KEY_TOKEN = "treasure.token";
const KEY_DEVICE = "treasure.device";
const KEY_CAMERA = "treasure.camera";
const CHOICE_KEYS = "ABCDEFGHIJ";

const ctx = el.canvas.getContext("2d", { willReadFrequently: true });

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
// In private mode localStorage can be entirely unwritable. Losing the device id
// turns one person reloading into a second device and their vote gets counted
// twice, so fall back to sessionStorage, which survives a reload in the same tab.
const backends = [
  () => localStorage,
  () => sessionStorage,
];

const store = {
  get(key) {
    for (const at of backends) {
      try {
        const value = at().getItem(key);
        if (value !== null) return value;
      } catch { /* This backend is unusable, try the next one */ }
    }
    return null;
  },
  set(key, value) {
    for (const at of backends) {
      try { at().setItem(key, value); return true; } catch { /* Try the next one */ }
    }
    return false;
  },
  drop(key) {
    for (const at of backends) {
      try { at().removeItem(key); } catch { /* No such backend, never mind */ }
    }
  },
};

let token = store.get(KEY_TOKEN);
let device = store.get(KEY_DEVICE);
if (!device) {
  device = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now().toString(36));
  store.set(KEY_DEVICE, device);
}

let state = null;
let pick = null;             // The leader's tiebreak choice, local to this phone
let rendered = "";           // Identity of what is on screen; a change rebuilds the DOM
let appliedVersion = -1;     // Server version already drawn, used to drop stale responses
let tallied = "";            // Fingerprint of the tally; a change clears the leader's pick
let busy = false;
let polling = false;         // Only one poll in flight at a time
let pendingVote = null;      // A choice tapped while the previous vote was still in flight
let shownWinner = null;      // The choice written on the submit button, and the one submitted

let stream = null;
let cameras = [];
let cameraIndex = 0;
let cameraGranted = false;   // Opened once successfully, so later rounds reconnect on their own
let cameraOpening = false;
let cameraGen = 0;           // Sequence per open, so a late stream knows to drop itself
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
    // Without a timeout, one stuck request leaves busy true forever: polling
    // stops and every button goes dead until the OS TCP timeout, tens of seconds
    res = await fetch(path, { ...options, headers, signal: AbortSignal.timeout?.(REQUEST_TIMEOUT) });
  } catch {
    throw new Error("網路不穩，沒送出去，再試一次");
  }
  let data = {};
  try { data = await res.json(); } catch { /* Not a JSON response */ }
  if (!res.ok) {
    const err = new Error(data.error || `伺服器錯誤（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const post = (path, body) =>
  api(path, { method: "POST", body: JSON.stringify(body || {}) });

/** Paints the user's action first, then sends it for the server to confirm.
 *
 * A failed send never leaves a wrong screen behind: act's catch shows a toast,
 * and the next poll overwrites it with server state within a fraction of a second. */
function optimistic(patch) {
  apply({ ...state, ...patch });
}

const IDLE_PATCH = { phase: "idle", question: undefined, counts: undefined, tie: undefined,
                     voted: undefined, result: undefined };

/** Wraps one user action: pauses polling and scanning, then paints the state it returns. */
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

// ---------------------------------------------------------------- Rendering

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

/** Draws whatever the server says. fresh means the question or phase changed and
 *  the DOM has to be rebuilt. */
function apply(next) {
  // A slow downlink delivers a response computed before the vote after the vote
  // landed, and painting it would wipe the fresh vote off the screen. Anything
  // older than what is already drawn gets dropped.
  if (next.v !== undefined) {
    if (next.v < appliedVersion) return;
    appliedVersion = next.v;
  }
  state = next;
  renderBar(next);

  // Choice order belongs in the key too: rescanning the same question after a
  // discard reshuffles it server-side, and keyed on the question id alone a
  // member whose polls all fell between the two would never rebuild the buttons
  // and would end up with a different order from everyone else
  const key = `${next.role}:${next.phase}:${next.question?.id ?? ""}`
    + `:${(next.question?.choices ?? []).join("\u0000")}`;
  const fresh = key !== rendered;
  rendered = key;
  if (fresh) pick = null;

  // Any change in the tally clears the leader's pick: the tie may now be between
  // different choices, and keeping it would point submit at an answer that is no
  // longer tied at all
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

// ---------------------------------------------------------------- Voting

function renderVoting(next, fresh) {
  const q = next.question;
  const leader = next.role === "leader";

  if (fresh) {
    // Members do not see the question code: the leader scans the sticker and the
    // code is of no use to them
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
      // The leader cannot normally tap a choice, only to settle a tie
      button.disabled = !tie.includes(text);
      button.classList.toggle("tiebreak", tie.includes(text));   // Only a tie makes them look tappable
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
  // Highlight first, then send: nobody should doubt their own tap for a round trip
  optimistic({ my_choice: text, voted: state.voted + (state.my_choice ? 0 : 1) });
  castVote(text);
}

// ---------------------------------------------------------------- Result

/** Sends this vote. If the previous one is still in flight, remember the latest
 *  and send it once that returns.
 *
 * Dropping it instead would make "the last tap wins" a lie over any real RTT:
 * the user sees their change, the server keeps the first vote, and a few hundred
 * milliseconds later the screen silently rolls back. */
function castVote(text) {
  if (busy) { pendingVote = text; return; }
  sendVote(text);
}

async function sendVote(text) {
  busy = true;
  try {
    const next = await post("/api/vote", { choice: text });
    if (pendingVote === null) apply(next);   // Tapped again meanwhile, do not repaint the old one
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

// ---------------------------------------------------------------- Camera

function setCamera(on) {
  if (on) {
    // The camera was shut off when the last round ended. Once permission is
    // granted, reconnect automatically instead of a tap per question
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
  const gen = ++cameraGen;
  stopCamera();
  const attempts = [];
  if (preferredId) attempts.push({ video: { deviceId: { exact: preferredId } } });
  attempts.push({ video: { facingMode: { ideal: "environment" } } });
  attempts.push({ video: true });

  let opened = null;
  let lastError = null;
  for (const constraints of attempts) {
    try {
      opened = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!opened) throw lastError || new Error("no camera");

  // getUserMedia takes 0.3-2s on a phone. If a newer open started meanwhile,
  // nobody wants this stream: leaving it be keeps the track alive, the camera
  // indicator lit for the whole event, and the older stream painting over the view
  if (gen !== cameraGen) {
    opened.getTracks().forEach((t) => t.stop());
    return;
  }

  stream = opened;
  cameraGranted = true;
  el.video.srcObject = stream;
  await el.video.play().catch(() => { /* iOS occasionally refuses autoplay */ });
  await refreshCameraList();
  setCamera(true);
}

function stopCamera() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  // lastCode must not be cleared here. The camera closes and reopens every round,
  // and clearing it would mean that pressing next with the lens still on the same
  // sticker instantly rescans it and throws the team back to the result screen.
  // Only RESCAN_MISSES unblocks it, which means the sticker really left frame.
}

async function refreshCameraList() {
  // Both deviceId and label are only readable after camera permission is granted
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
  if (cameras.length < 2 || cameraOpening) return;
  const next = cameras[(cameraIndex + 1) % cameras.length].deviceId;
  cameraOpening = true;   // Without this lock, a poll while waiting opens a second stream and switches back
  try {
    await startCamera(next);
  } catch {
    toast("這顆鏡頭開不起來");
  } finally {
    cameraOpening = false;
  }
}

function openCamera() {
  // Every poll while waiting calls in here, so do not open again mid-open
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

// ---------------------------------------------------------------- Scanning

function scanning() {
  return Boolean(stream) && (!state || (state.phase === "idle" && state.role === "leader"));
}

function resumeScanning() {
  if (!stream) return;
  el.video.play().catch(() => { /* iOS may pause after a panel switch */ });
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
    // Only several consecutive frames without a QR count as the sticker leaving
    // frame, which unblocks a rescan
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
  } catch { /* Not a URL, treat it as the token itself */ }
  return text.trim();
}

// ---------------------------------------------------------------- Login

async function login(value) {
  if (!value || busy) return;
  busy = true;
  // Store it first: when a network blip fails the login, polling needs something
  // to retry with. A genuinely invalid token gets dropped by the 401 below
  store.set(KEY_TOKEN, value);
  try {
    const next = await api("/api/login", { method: "POST", body: JSON.stringify({ token: value }) });
    token = value;
    apply(next);
  } catch (err) {
    // Leaving the token set would make later typing in the field go to /api/scan
    // as a question code, and this phone could never log in again without a reload
    token = null;
    if (err.status === 401) store.drop(KEY_TOKEN);   // Expired, stop retrying it
    toast(err.message);
    renderLogin();
  } finally {
    busy = false;
  }
}

function logout() {
  token = null;
  state = null;
  rendered = "";
  store.drop(KEY_TOKEN);
  renderLogin();
  toast("登入失效，請重新登入");
}

// ---------------------------------------------------------------- Polling

function startPolling() {
  clearInterval(pollId);
  pollId = setInterval(refreshState, POLL_INTERVAL);
}

async function refreshState() {
  if (busy || polling || document.hidden) return;
  if (!token) {
    // Recovers by itself after a login failed on a network blip, with no reload
    const saved = store.get(KEY_TOKEN);
    if (saved) login(saved);
    return;
  }
  polling = true;
  try {
    const next = await api("/api/state");
    // The user acted while this was in flight; that state is newer, do not overwrite it
    if (!busy) apply(next);
  } catch (err) {
    if (err.status === 401) logout();
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------- Bindings

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
  el.qSubmit.disabled = true;   // The server may reject this if the tally moved, so only acknowledge the press
  // What gets submitted is always what the button says. The server recomputes and
  // compares, and rejects a mismatch
  act(() => post("/api/submit", { choice: shownWinner, id: state.question.id }));
});

/** Discard or next: switch the screen without waiting. If the send really fails,
 *  switch straight back and say so. Leaving a false "that's over" screen up would
 *  have the leader believe they moved on while the team is still stuck. */
async function closeRound() {
  if (busy) return;
  const before = state;
  optimistic(IDLE_PATCH);
  busy = true;
  try {
    apply(await post("/api/close"));
  } catch (err) {
    if (err.status === 401) { logout(); return; }
    apply(before);
    toast(err.message);
  } finally {
    busy = false;
  }
}

el.qCancel.addEventListener("click", closeRound);
el.rNext.addEventListener("click", closeRound);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  resumeScanning();
  refreshState();
});

// ---------------------------------------------------------------- Startup

renderLogin();
startPolling();          // Runs from the start, so a failed login can retry itself

const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  history.replaceState(null, "", location.pathname);  // Do not leave the token in the address bar
  login(urlToken.trim());
} else if (token) {
  login(token);
}
