/* VoiceFlow — voice recording + live transcription */

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
let recognition = null;
let mediaRecorder = null;
let recordedChunks = [];
let audioStream = null;
let audioCtx, analyser, vizRAF;
let timerInterval, startedAt = 0;

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
  el.wordCount.textContent = words + " מילים";
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function startTimer() {
  startedAt = Date.now();
  el.timer.textContent = "00:00";
  timerInterval = setInterval(() => {
    el.timer.textContent = fmtTime(Date.now() - startedAt);
  }, 250);
}
function stopTimer() { clearInterval(timerInterval); }

function polishText(text) {
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/\s+([,.!?;:])/g, "$1").replace(/([,.!?;:])(?=\S)/g, "$1 ");
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
  return t.trim();
}

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
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

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
  if (engine === "whisper") {
    setStatus("recording", "🔴 מקליט עם Whisper — דברו, הטקסט יופיע אחרי עצירה");
    startWhisper();
  } else {
    setStatus("recording", "מקליט… דברו עכשיו");
    startBrowserRecognition();
  }
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
  // For browser engine: finalizeTranscript is called from recognition.onend
  // after the API delivers all final results
}

function finalizeTranscript() {
  el.interim.textContent = "";
  const text = el.transcript.innerText.trim();
  if (text) {
    saveToHistory(text);
    if (el.autoCopyToggle.checked) autoCopy(text);
  }
}

async function autoCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("הטקסט הועתק — הדביקו עם Ctrl+V");
  } catch (_) {}
}

function startBrowserRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast("הדפדפן לא תומך בתמלול מובנה. נסו Chrome.");
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
    const w = el.transcript.parentElement;
    w.scrollTop = w.scrollHeight;
  };
  recognition.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed") toast("הרשאת מיקרופון נדחתה.");
    else toast("שגיאת תמלול: " + e.error);
  };
  recognition.onend = () => {
    if (recording) {
      try { recognition.start(); } catch (_) {}
    } else {
      setStatus("done", "הסתיים");
      finalizeTranscript();
    }
  };
  recognition.start();
}

function startWhisper() {
  const key = localStorage.getItem(LS_KEY);
  if (!key) { toast("יש להזין מפתח OpenAI API בהגדרות."); openModal(); stopRecording(); return; }
  recordedChunks = [];

  // Boost mic volume before recording to reduce Whisper hallucinations
  const recCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = recCtx.createMediaStreamSource(audioStream);
  const gain = recCtx.createGain();
  gain.gain.value = 1.4;
  const dest = recCtx.createMediaStreamDestination();
  src.connect(gain);
  gain.connect(dest);

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm")
    ? "audio/webm"
    : "";
  const opts = mimeType ? { mimeType, audioBitsPerSecond: 128000 } : { audioBitsPerSecond: 128000 };
  mediaRecorder = new MediaRecorder(dest.stream, opts);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    recCtx.close();
    const duration = Date.now() - startedAt;
    if (duration < 1500) {
      toast("ההקלטה קצרה מדי — דברו לפחות שנייה-שתיים");
      return;
    }
    transcribeWithWhisper(key);
  };
  mediaRecorder.start(500);
}

async function transcribeWithWhisper(key) {
  setStatus("processing", "⏳ שולח ל-Whisper, רגע…");
  toast("שולח ל-Whisper — ממתינה לתוצאה…");
  const blob = new Blob(recordedChunks, { type: "audio/webm" });
  const form = new FormData();
  form.append("file", blob, "audio.webm");
  form.append("model", "whisper-1");
  form.append("temperature", "0");
  const lang = el.langSelect.value.split("-")[0];
  if (lang) form.append("language", lang);
  const prompts = {
    "he": "שלום. זהו תמלול דיבור בעברית.",
    "en": "Hello. This is a speech transcription in English.",
    "ar": "مرحبا. هذا نص كلام باللغة العربية.",
  };
  const prompt = prompts[lang] || prompts["he"];
  form.append("prompt", prompt);
  try {
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: "Bearer " + key }, body: form,
    });
    if (!resp.ok) throw new Error(resp.status + " " + await resp.text());
    const data = await resp.json();
    const sep = el.transcript.innerText && !/\s$/.test(el.transcript.innerText) ? " " : "";
    el.transcript.innerText += sep + (data.text || "").trim();
    updateWordCount();
    setStatus("done", "הסתיים");
    finalizeTranscript();
  } catch (e) {
    setStatus("idle", "מוכן להקלטה");
    console.error("Whisper error:", e);
    toast("שגיאת Whisper: " + e.message.slice(0, 120));
  }
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY)) || []; } catch { return []; }
}

function saveToHistory(text) {
  const history = getHistory();
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
    const date = new Date(item.date).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    li.innerHTML = "<div class=\"hi-text\">" + escapeHtml(item.text) + "</div><div class=\"hi-meta\"><span>" + date + "</span><button class=\"hi-del\" title=\"מחק\">🗑</button></div>";
    li.querySelector(".hi-text").addEventListener("click", () => {
      el.transcript.innerText = item.text;
      updateWordCount();
      toast("התמלול נטען");
    });
    li.querySelector(".hi-del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const h = getHistory().filter((x) => x.id !== item.id);
      localStorage.setItem(LS_HISTORY, JSON.stringify(h));
      renderHistory();
    });
    el.historyList.appendChild(li);
  });
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function openModal() {
  el.apiKeyInput.value = localStorage.getItem(LS_KEY) || "";
  el.settingsModal.classList.remove("hidden");
}
function closeModal() { el.settingsModal.classList.add("hidden"); }

/* Wiring */
el.recordBtn.addEventListener("click", () => recording ? stopRecording() : startRecording());

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
  a.download = "transcript-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".txt";
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

/* Space = toggle start/stop (when not typing in transcript) */
document.addEventListener("keydown", (e) => {
  const modalClosed = el.settingsModal.classList.contains("hidden");
  if (e.code === "Space" && document.activeElement !== el.transcript && modalClosed && !e.repeat) {
    e.preventDefault();
    recording ? stopRecording() : startRecording();
  }
});

renderHistory();
updateWordCount();
setStatus("idle", "מוכן להקלטה");

/* Auto-open settings if Whisper is selected but no key saved yet */
if (el.engineSelect.value === "whisper" && !localStorage.getItem(LS_KEY)) {
  openModal();
}
