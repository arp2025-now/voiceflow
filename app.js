/* VoiceFlow — voice recording + live transcription
 * Two engines:
 *   1. browser  → Web Speech API (instant, free, real-time interim results)
 *   2. whisper  → records audio with MediaRecorder, sends to OpenAI Whisper for high accuracy
 * Everything runs client-side; the optional OpenAI key is stored only in localStorage.
 */

const $ = (id) => document.getElementById(id);

const el = {
  transcript: $("transcript"),
  interim: $("interim"),
  recordBtn: $("recordBtn"),
  statusDot: $("statusDot"),
  statusText: $("statusText"),
  timer: $("timer"),
  wordCount: $("wordCount"),
  langSelect: $("langSelect"),
  engineSelect: $("engineSelect"),
  copyBtn: $("copyBtn"),
  downloadBtn: $("downloadBtn"),
  cleanBtn: $("cleanBtn"),
  clearTextBtn: $("clearTextBtn"),
  newBtn: $("newBtn"),
  historyList: $("historyList"),
  historyEmpty: $("historyEmpty"),
  clearHistoryBtn: $("clearHistoryBtn"),
  autoCopyToggle: $("autoCopyToggle"),
  settingsBtn: $("settingsBtn"),
  settingsModal: $("settingsModal"),
  apiKeyInput: $("apiKeyInput"),
  saveKeyBtn: $("saveKeyBtn"),
  closeModalBtn: $("closeModalBtn"),
  visualizer: $("visualizer"),
  toast: $("toast"),
};

const LS_HISTORY = "voiceflow.history";
const LS_KEY = "voiceflow.apikey";

let recording = false;
let recognition = null;            // Web Speech API instance
let mediaRecorder = null;          // for Whisper engine
let recordedChunks = [];
let audioStream = null;            // mic stream (shared by visualizer)
let audioCtx, analyser, vizRAF;
let timerInterval, startedAt = 0;
let spacePushToTalk = false;

/* ---------------- Helpers ---------------- */

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add("hidden"), 2600);
}

function setStatus(state, text) {
  el.statusDot.className = "status-dot " + state;
  el.statusText.textContent = text;
}

function updateWordCount() {
  const text = el.transcript.innerText.trim();
  const words = text ? text.split(/\s+/).length : 0;
  el.wordCount.textContent = `${words} מילים`;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function startTimer() {
  startedAt = Date.now();
  el.timer.textContent = "00:00";
  timerInterval = setInterval(() => {
    el.timer.textContent = fmtTime(Date.now() - startedAt);
  }, 250);
}
function stopTimer() { clearInterval(timerInterval); }

/* Light text cleanup: collapse spaces, capitalize sentences (latin),
   ensure space after punctuation. Keeps it conservative so nothing is lost. */
function polishText(text) {
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/\s+([,.!?;:])/g, "$1").replace(/([,.!?;:])(?=\S)/g, "$1 ");
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
  return t.trim();
}

/* ---------------- Visualizer ---------------- */

function startVisualizer(stream) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);

  const canvas = el.visualizer;
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    vizRAF = requestAnimationFrame(draw);
    canvas.width = canvas.clientWidth;
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bars = 48;
    const step = Math.floor(data.length / bars);
    const bw = canvas.width / bars;
    for (let i = 0; i < bars; i++) {
      const v = data[i * step] / 255;
      const h = Math.max(3, v * canvas.height);
      const x = i * bw;
      const grad = ctx.createLinearGradient(0, canvas.height, 0, 0);
      grad.addColorStop(0, "#7c5cff");
      grad.addColorStop(1, "#a78bff");
      ctx.fillStyle = grad;
      ctx.fillRect(x + bw * 0.2, (canvas.height - h) / 2, bw * 0.6, h);
    }
  }
  draw();
}

function stopVisualizer() {
  cancelAnimationFrame(vizRAF);
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  const canvas = el.visualizer;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/* ---------------- Recording control ---------------- */

async function startRecording() {
  if (recording) return;
  const engine = el.engineSelect.value;

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("לא ניתן לגשת למיקרופון. אנא אשרו הרשאה.");
    return;
  }

  recording = true;
  el.recordBtn.classList.add("recording");
  el.interim.textContent = "";
  startTimer();
  startVisualizer(audioStream);
  setStatus("recording", "מקליט… דברו עכשיו");

  if (engine === "whisper") startWhisper();
  else startBrowserRecognition();
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
  el.recordBtn.classList.remove("recording");
  stopTimer();
  stopVisualizer();

  if (recognition) { try { recognition.stop(); } catch (_) {} }
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();

  if (audioStream) { audioStream.getTracks().forEach((t) => t.stop()); audioStream = null; }

  if (el.engineSelect.value === "browser") {
    setStatus("done", "הסתיים");
    finalizeTranscript();
  }
}

function finalizeTranscript() {
  el.interim.textContent = "";
  const text = el.transcript.innerText.trim();
  if (text) {
    saveToHistory(text);
    if (el.autoCopyToggle.checked) autoCopy(text);
  }
}

/* Copy the finished transcript so it can be pasted straight into Claude,
   Gmail, or any other field with Ctrl/Cmd+V. */
async function autoCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("הטקסט הועתק — הדביקו עם Ctrl+V ✓");
  } catch (_) {
    // Clipboard can fail without focus/permission; copy button stays available.
  }
}

/* ---------------- Engine 1: Web Speech API ---------------- */

function startBrowserRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast("הדפדפן לא תומך בתמלול מובנה. נסו Chrome או עברו ל-Whisper.");
    stopRecording();
    return;
  }
  recognition = new SR();
  recognition.lang = el.langSelect.value;
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        const sep = el.transcript.innerText && !/\s$/.test(el.transcript.innerText) ? " " : "";
        el.transcript.innerText += sep + res[0].transcript.trim();
        updateWordCount();
      } else {
        interim += res[0].transcript;
      }
    }
    el.interim.textContent = interim ? " " + interim : "";
    autoScroll();
  };

  recognition.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed") toast("הרשאת מיקרופון נדחתה.");
    else toast("שגיאת תמלול: " + e.error);
  };

  // Auto-restart while the user is still recording (the API stops periodically)
  recognition.onend = () => {
    if (recording) { try { recognition.start(); } catch (_) {} }
  };

  recognition.start();
}

/* ---------------- Engine 2: OpenAI Whisper ---------------- */

function startWhisper() {
  const key = localStorage.getItem(LS_KEY);
  if (!key) {
    toast("יש להזין מפתח OpenAI API בהגדרות.");
    openModal();
    stopRecording();
    return;
  }
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(audioStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => transcribeWithWhisper(key);
  mediaRecorder.start();
}

async function transcribeWithWhisper(key) {
  setStatus("processing", "מתמלל עם Whisper…");
  const blob = new Blob(recordedChunks, { type: "audio/webm" });
  const form = new FormData();
  form.append("file", blob, "audio.webm");
  form.append("model", "whisper-1");
  const lang = el.langSelect.value.split("-")[0];
  if (lang) form.append("language", lang);

  try {
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      body: form,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(resp.status + " " + err);
    }
    const data = await resp.json();
    const sep = el.transcript.innerText && !/\s$/.test(el.transcript.innerText) ? " " : "";
    el.transcript.innerText += sep + (data.text || "").trim();
    updateWordCount();
    autoScroll();
    setStatus("done", "הסתיים");
    finalizeTranscript();
  } catch (e) {
    setStatus("idle", "מוכן להקלטה");
    toast("שגיאת Whisper — בדקו את המפתח. " + e.message.slice(0, 80));
  }
}

function autoScroll() {
  const w = el.transcript.parentElement;
  w.scrollTop = w.scrollHeight;
}

/* ---------------- History (localStorage) ---------------- */

function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY)) || []; }
  catch { return []; }
}

function saveToHistory(text) {
  const history = getHistory();
  // avoid duplicating if last entry is the same text
  if (history[0] && history[0].text === text) return;
  history.unshift({ id: Date.now(), text, date: new Date().toISOString(), lang: el.langSelect.value });
  localStorage.setItem(LS_HISTORY, JSON.stringify(history.slice(0, 100)));
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  el.historyList.innerHTML = "";
  el.historyEmpty.style.display = history.length ? "none" : "block";

  history.forEach((item) => {
    const li = document.createElement("li");
    li.className = "history-item";
    const date = new Date(item.date).toLocaleString("he-IL", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    li.innerHTML = `
      <div class="hi-text">${escapeHtml(item.text)}</div>
      <div class="hi-meta"><span>${date}</span><button class="hi-del" title="מחק">🗑</button></div>`;
    li.querySelector(".hi-text").addEventListener("click", () => {
      el.transcript.innerText = item.text;
      updateWordCount();
      toast("התמלול נטען");
    });
    li.querySelector(".hi-del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteHistory(item.id);
    });
    el.historyList.appendChild(li);
  });
}

function deleteHistory(id) {
  const history = getHistory().filter((h) => h.id !== id);
  localStorage.setItem(LS_HISTORY, JSON.stringify(history));
  renderHistory();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ---------------- Settings modal ---------------- */

function openModal() {
  el.apiKeyInput.value = localStorage.getItem(LS_KEY) || "";
  el.settingsModal.classList.remove("hidden");
}
function closeModal() { el.settingsModal.classList.add("hidden"); }

/* ---------------- Wiring ---------------- */

el.recordBtn.addEventListener("click", () => (recording ? stopRecording() : startRecording()));

el.copyBtn.addEventListener("click", async () => {
  const text = el.transcript.innerText.trim();
  if (!text) return toast("אין טקסט להעתקה");
  await navigator.clipboard.writeText(text);
  toast("הטקסט הועתק ✓");
});

el.downloadBtn.addEventListener("click", () => {
  const text = el.transcript.innerText.trim();
  if (!text) return toast("אין טקסט להורדה");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

el.cleanBtn.addEventListener("click", () => {
  const text = el.transcript.innerText.trim();
  if (!text) return;
  el.transcript.innerText = polishText(text);
  updateWordCount();
  toast("הטקסט שופר ✓");
});

el.clearTextBtn.addEventListener("click", () => {
  if (!el.transcript.innerText.trim()) return toast("אין טקסט למחיקה");
  if (!confirm("למחוק את הטקסט?")) return;
  el.transcript.innerText = "";
  el.interim.textContent = "";
  updateWordCount();
  toast("הטקסט נמחק ✓");
});

el.newBtn.addEventListener("click", () => {
  if (el.transcript.innerText.trim()) saveToHistory(el.transcript.innerText.trim());
  el.transcript.innerText = "";
  el.interim.textContent = "";
  updateWordCount();
  setStatus("idle", "מוכן להקלטה");
  el.timer.textContent = "00:00";
});

el.clearHistoryBtn.addEventListener("click", () => {
  if (!getHistory().length) return;
  if (confirm("למחוק את כל ההיסטוריה?")) {
    localStorage.removeItem(LS_HISTORY);
    renderHistory();
  }
});

el.settingsBtn.addEventListener("click", openModal);
el.closeModalBtn.addEventListener("click", closeModal);
el.saveKeyBtn.addEventListener("click", () => {
  const k = el.apiKeyInput.value.trim();
  if (k) localStorage.setItem(LS_KEY, k);
  else localStorage.removeItem(LS_KEY);
  closeModal();
  toast("ההגדרות נשמרו ✓");
});

el.transcript.addEventListener("input", updateWordCount);

el.engineSelect.addEventListener("change", () => {
  if (el.engineSelect.value === "whisper" && !localStorage.getItem(LS_KEY)) openModal();
});

/* Push-to-talk: hold Space (when not typing in the transcript) */
document.addEventListener("keydown", (e) => {
  const modalClosed = el.settingsModal.classList.contains("hidden");
  if (e.code === "Space" && document.activeElement !== el.transcript && modalClosed) {
    if (!recording && !spacePushToTalk) {
      e.preventDefault();
      spacePushToTalk = true;
      startRecording();
    }
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && spacePushToTalk) {
    spacePushToTalk = false;
    stopRecording();
  }
});

/* Init */
renderHistory();
updateWordCount();
setStatus("idle", "מוכן להקלטה");
