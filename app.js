/* 100 Mexicanos Dijeron — cliente (frontend estático, sin frameworks).
 *
 * REGLA DE ORO: el cliente NUNCA calcula puntos ni transiciones.
 * Solo muestra el estado autoritativo que envía el servidor ({type:"state"})
 * y envía las acciones del jugador por WebSocket. El servidor decide todo.
 *
 * Protocolo (SPEC.md §4):
 *   cliente -> servidor: join, faceoff-answer, guess, steal-answer,
 *     fastmoney-answer, fastmoney-pass, next, rematch, use-wildcard
 *   servidor -> cliente: {type:"state", state} | {type:"error", message}
 *
 * Dinero Rápido (versión corregida): SOLO juega el ganador del juego.
 * 5 preguntas en 20 s en total. 100 puntos o más = carta comodín para la
 * siguiente partida. El perdedor lo ve como espectador.
 */

"use strict";

/* ------------------------------------------------------------------ */
/* Constantes ajustables                                               */
/* ------------------------------------------------------------------ */

// Efecto del comodín. Opciones: "forgive-strike" (perdona una cruz) o
// "reveal-answer" (revela gratis una respuesta del tablero).
// El efecto real lo aplica el servidor; aquí solo cambia el texto del botón.
// Para cambiarlo, edita SOLO esta línea (y el mismo valor en el Worker).
var WILDCARD_EFFECT = "forgive-strike";

var WILDCARD_EFFECT_LABEL = {
  "forgive-strike": "perdona una cruz",
  "reveal-answer": "revela una respuesta del tablero"
};

var WILDCARD_THRESHOLD = 100; // puntos de Dinero Rápido para ganar comodín
var FACEOFF_SECONDS = 20;
var GUESS_SECONDS = 20;
var FASTMONEY_SECONDS = 20;

var LS_NAME = "100mxd-name";
var LS_RECENT = "100mxd-recent-questions"; // IDs usados en las últimas 3 partidas
var LS_WILDCARD_NOTE = "100mxd-wildcards"; // solo informativo, el servidor manda

/* ------------------------------------------------------------------ */
/* Estado local (nada de esto es autoridad: todo viene del servidor)   */
/* ------------------------------------------------------------------ */

var ws = null;
var myName = "";
var myId = null;          // "p1" | "p2" — se infiere del estado (ver identifyMe)
var roomCode = "";
var currentState = null;
var connected = false;
var demoMode = false;
var demoIndex = 0;
var seenQuestionIds = []; // para la rotación de preguntas (SPEC §2)
var savedGameRecorded = false;

var timerInterval = null;
var localDeadline = null; // respaldo cuando el estado no trae fecha límite
var timerKey = "";
var timeoutSentForKey = "";
var wildcardUsedForState = ""; // evita doble envío de use-wildcard por estado
var diceAnimKey = "";
var diceAnimTimer = null;
var confettiDoneForKey = "";
var toastTimer = null;

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function apiBase() {
  var u = (window.GAME_API_URL || "").trim();
  return u ? u.replace(/\/+$/, "") : "";
}

function wsBase() {
  var base = apiBase();
  if (!base) return "";
  if (/^wss?:\/\//i.test(base)) return base;
  return base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
}

function playerById(state, id) {
  if (!state || !state.players) return null;
  for (var i = 0; i < state.players.length; i++) {
    if (state.players[i].id === id) return state.players[i];
  }
  return null;
}

function me(state) { return myId ? playerById(state, myId) : null; }
function opponent(state) {
  if (!state || !state.players) return null;
  for (var i = 0; i < state.players.length; i++) {
    if (state.players[i].id !== myId) return state.players[i];
  }
  return null;
}

function myWildcards(state) {
  var p = me(state);
  return p && typeof p.wildcards === "number" ? p.wildcards : 0;
}

function otherPlayerName(state, id) {
  var p = playerById(state, id);
  return p ? p.name : "Rival";
}

/* Mi identidad: el servidor puede mandar state.myId; si no, se infiere por
 * el nombre (en una sala de 2 los nombres distinguen a los jugadores). */
function identifyMe(state) {
  if (!state) return;
  if (state.myId) { myId = state.myId; return; }
  if (state.you) { myId = state.you; return; }
  if (!myId && myName && state.players) {
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].name === myName) { myId = state.players[i].id; return; }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Toasts / buzzer visual                                              */
/* ------------------------------------------------------------------ */

function toast(msg, kind) {
  var el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast" + (kind === "error" ? " error" : "");
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 4500);
}

function buzzer(msg) {
  toast(msg, "error");
  var stage = $("stage");
  if (stage) {
    stage.style.animation = "none";
    void stage.offsetWidth; // reinicia la animación
    stage.style.animation = "shake .4s";
    setTimeout(function () { stage.style.animation = ""; }, 450);
  }
}

/* ------------------------------------------------------------------ */
/* Confeti                                                             */
/* ------------------------------------------------------------------ */

var CONFETTI_COLORS = ["#ffd700", "#e63329", "#2ee06f", "#ff9ff3", "#4da6ff", "#ffffff", "#ff8c42"];

function spawnConfetti(n) {
  var box = $("confetti");
  if (!box) return;
  box.innerHTML = "";
  var count = n || 90;
  for (var i = 0; i < count; i++) {
    var piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = (Math.random() * 100) + "vw";
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.animationDuration = (2.2 + Math.random() * 1.8) + "s";
    piece.style.animationDelay = (Math.random() * 0.7) + "s";
    piece.style.transform = "rotate(" + Math.floor(Math.random() * 360) + "deg)";
    if (Math.random() < 0.4) piece.style.borderRadius = "50%";
    box.appendChild(piece);
  }
  setTimeout(function () { box.innerHTML = ""; }, 5200);
}

/* ------------------------------------------------------------------ */
/* Sonido (Web Audio API): música 8-bit de fondo + efectos             */
/*                                                                     */
/* Todo se genera con osciladores (sin archivos de audio), así el      */
/* juego sigue siendo 100% estático. El contexto de audio solo se      */
/* crea tras un gesto del usuario (política de autoplay del navegador) */
/* y la música arranca con el primer toque. Hay botón de silencio 🔊.  */
/* ------------------------------------------------------------------ */

var LS_MUTED = "100mxd-muted";
var audioCtx = null;
var musicGainNode = null;
var sfxGainNode = null;
var soundMuted = false;
try { soundMuted = localStorage.getItem(LS_MUTED) === "1"; } catch (e) {}
var musicTimer = null;
var musicStep = 0;

/* Melodía 8-bit en loop (16 pasos de corchea, ~132 BPM, progresión
 * C–G–Am–F). Notas en Hz; 0 = silencio. */
var MUSIC_BPM = 132;
var MUSIC_MELODY = [
  523.25, 659.25, 783.99, 659.25,  // C5 E5 G5 E5
  880.00, 783.99, 659.25, 587.33,  // A5 G5 E5 D5
  523.25, 659.25, 783.99, 659.25,  // C5 E5 G5 E5
  587.33, 523.25, 587.33, 659.25   // D5 C5 D5 E5
];
var MUSIC_BASS = [
  130.81, 0, 0, 0,  // C3
  98.00, 0, 0, 0,   // G2
  110.00, 0, 0, 0,  // A2
  87.31, 0, 0, 0    // F2
];

function ensureAudio() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    return true;
  }
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audioCtx = new AC();
    musicGainNode = audioCtx.createGain();
    musicGainNode.gain.value = 0.065; // música de fondo, que se escuche sin tapar los efectos
    musicGainNode.connect(audioCtx.destination);
    sfxGainNode = audioCtx.createGain();
    sfxGainNode.gain.value = 0.5;
    sfxGainNode.connect(audioCtx.destination);
    return true;
  } catch (e) { return false; }
}

/* Tono simple con envolvente. Si el audio no está corriendo o está
 * silenciado, no hace nada (evita acumular notas en pausa). */
function playTone(freq, startOffset, dur, type, vol, dest) {
  if (!audioCtx || audioCtx.state !== "running" || soundMuted) return;
  var t0 = audioCtx.currentTime + (startOffset || 0);
  var osc = audioCtx.createOscillator();
  var g = audioCtx.createGain();
  osc.type = type || "square";
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol || 0.5, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g);
  g.connect(dest || sfxGainNode);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function musicTick() {
  if (!audioCtx || audioCtx.state !== "running" || soundMuted) return;
  var stepDur = 60 / MUSIC_BPM / 2; // corchea
  var mel = MUSIC_MELODY[musicStep % MUSIC_MELODY.length];
  var bass = MUSIC_BASS[musicStep % MUSIC_BASS.length];
  if (mel) playTone(mel, 0, stepDur * 0.9, "square", 0.35, musicGainNode);
  if (bass) playTone(bass, 0, stepDur * 1.8, "triangle", 0.6, musicGainNode);
  musicStep++;
}

function startMusic() {
  if (musicTimer || soundMuted) return;
  if (!ensureAudio()) return;
  var stepDur = 60 / MUSIC_BPM / 2;
  musicTimer = setInterval(musicTick, stepDur * 1000);
}

function stopMusic() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
}

/* Desbloquea el audio tras un gesto del usuario y arranca la música. */
function unlockAudio() {
  if (!ensureAudio()) return;
  startMusic();
}

function setMuted(m) {
  soundMuted = !!m;
  try { localStorage.setItem(LS_MUTED, soundMuted ? "1" : "0"); } catch (e) {}
  if (soundMuted) stopMusic(); else startMusic();
  var btn = $("soundBtn");
  if (btn) {
    btn.textContent = soundMuted ? "🔇" : "🔊";
    btn.title = soundMuted ? "Sonido apagado (tocar para encender)" : "Sonido encendido (tocar para apagar)";
  }
}

/* --- Efectos de sonido --- */
function sfxCorrect() { // acierto en el tablero: ding ascendente
  playTone(659.25, 0, 0.12, "square", 0.5);
  playTone(880.00, 0.1, 0.2, "square", 0.5);
}
function sfxWrong() { // cruz (X): zumbido grave tipo buzzer del show
  if (!audioCtx || audioCtx.state !== "running" || soundMuted) return;
  var t0 = audioCtx.currentTime;
  var osc = audioCtx.createOscillator();
  var g = audioCtx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(160, t0);
  osc.frequency.exponentialRampToValueAtTime(70, t0 + 0.4);
  g.gain.setValueAtTime(0.5, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
  osc.connect(g);
  g.connect(sfxGainNode);
  osc.start(t0);
  osc.stop(t0 + 0.5);
}
function sfxWin() { // fanfarria del ganador
  playTone(523.25, 0, 0.14, "square", 0.5);
  playTone(659.25, 0.12, 0.14, "square", 0.5);
  playTone(783.99, 0.24, 0.14, "square", 0.5);
  playTone(1046.50, 0.36, 0.3, "square", 0.55);
}
function sfxCountdown() { // bip de la cuenta atrás 3-2-1
  playTone(880.00, 0, 0.09, "square", 0.5);
}
function sfxGo() { // bip agudo de "¡a jugar!"
  playTone(1318.51, 0, 0.22, "square", 0.55);
}
function sfxDice() { // traqueteo de dados
  for (var i = 0; i < 5; i++) {
    playTone(1100 + Math.random() * 500, i * 0.07, 0.04, "square", 0.4);
  }
}
function sfxSteal() { // alerta de robo: dos notas descendentes
  playTone(440.00, 0, 0.16, "square", 0.5);
  playTone(349.23, 0.15, 0.22, "square", 0.5);
}
function sfxRoundEnd() { // jingle corto de fin de ronda
  playTone(392.00, 0, 0.12, "square", 0.45);
  playTone(523.25, 0.11, 0.12, "square", 0.45);
  playTone(659.25, 0.22, 0.2, "square", 0.5);
}
function sfxGameWin() { // fanfarria larga al ganar el juego
  playTone(523.25, 0, 0.14, "square", 0.5);
  playTone(659.25, 0.12, 0.14, "square", 0.5);
  playTone(783.99, 0.24, 0.14, "square", 0.5);
  playTone(1046.50, 0.36, 0.18, "square", 0.55);
  playTone(1318.51, 0.52, 0.4, "square", 0.55);
}
function sfxGameLose() { // tonada suave al perder
  playTone(659.25, 0, 0.16, "triangle", 0.5);
  playTone(523.25, 0.15, 0.16, "triangle", 0.5);
  playTone(440.00, 0.3, 0.3, "triangle", 0.5);
}

function revealedCount(state) {
  if (!state || !state.question || !state.question.answers) return 0;
  return state.question.answers.filter(function (a) { return a.revealed; }).length;
}

/* Dispara los sonidos según lo que cambió entre el estado anterior y el
 * nuevo. Se llama desde onState antes de renderizar. */
var prevSoundState = null;
function handleStateSounds(prev, next) {
  if (!next) return;
  if (!prev) { prevSoundState = next; return; }
  // Cruz nueva → zumbido de X.
  if (typeof next.strikes === "number" && typeof prev.strikes === "number" &&
      next.strikes > prev.strikes) {
    sfxWrong();
  }
  // Respuesta nueva revelada en el tablero → ding de acierto.
  if ((next.phase === "board" || next.phase === "roundEnd") &&
      revealedCount(next) > revealedCount(prev)) {
    sfxCorrect();
  }
  // Cambios de fase.
  if (prev.phase !== next.phase) {
    if (next.phase === "ready") sfxCorrect();
    else if (next.phase === "faceoffReveal") sfxWin();
    else if (next.phase === "dice") sfxDice();
    else if (next.phase === "board" && prev.phase === "faceoffReveal") sfxGo();
    else if (next.phase === "steal") sfxSteal();
    else if (next.phase === "roundEnd") sfxRoundEnd();
    else if (next.phase === "fastMoney") sfxWin();
    else if (next.phase === "fastMoneyReveal") {
      if (fmWildcardEarned(next)) sfxWin(); else sfxRoundEnd();
    } else if (next.phase === "gameOver") {
      if (next.winner === myId) sfxGameWin(); else sfxGameLose();
    }
  }
  prevSoundState = next;
}

/* ------------------------------------------------------------------ */
/* Conexión: crear sala / unirse / WebSocket                           */
/* ------------------------------------------------------------------ */

function recentExcludedIds() {
  try {
    var raw = localStorage.getItem(LS_RECENT);
    if (!raw) return [];
    var games = JSON.parse(raw);
    var out = [];
    games.forEach(function (g) { (g || []).forEach(function (id) { out.push(id); }); });
    return out;
  } catch (e) { return []; }
}

function recordGameQuestions() {
  if (savedGameRecorded || seenQuestionIds.length === 0) return;
  savedGameRecorded = true;
  try {
    var games = JSON.parse(localStorage.getItem(LS_RECENT) || "[]");
    games.unshift(seenQuestionIds.slice());
    games = games.slice(0, 3); // solo las últimas 3 partidas
    localStorage.setItem(LS_RECENT, JSON.stringify(games));
  } catch (e) { /* localStorage no disponible: no pasa nada */ }
}

function setConnected(on) {
  connected = on;
  var dot = $("connDot");
  if (dot) dot.className = "conn-dot " + (on ? "on" : "off");
}

function send(msg) {
  if (demoMode) {
    toast("🎭 Demo: se enviaría " + JSON.stringify(msg));
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    toast("Sin conexión con el servidor. Reintenta entrar a la sala.", "error");
  }
}

function connectWS(code) {
  var base = wsBase();
  if (!base) { showConfigWarning(); return; }
  var url = base + "/room/" + code + "/ws?name=" + encodeURIComponent(myName);
  try { ws = new WebSocket(url); } catch (e) {
    toast("No se pudo abrir la conexión: " + e.message, "error");
    return;
  }
  ws.onopen = function () {
    setConnected(true);
    send({ type: "join", name: myName });
  };
  ws.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "state" && msg.state) onState(msg.state);
    else if (msg.type === "error" && msg.message) buzzer("🔔 " + msg.message);
  };
  ws.onclose = function () {
    setConnected(false);
    if (currentState && currentState.phase !== "gameOver") {
      toast("Se perdió la conexión. Vuelve a entrar con el código de la sala.");
    }
  };
  ws.onerror = function () { setConnected(false); };
}

function createRoom() {
  var base = apiBase();
  if (!base) { showConfigWarning(); return; }
  var name = readName();
  if (!name) return;
  myName = name;
  toast("Creando sala…");
  fetch(base + "/api/room", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ excludeIds: recentExcludedIds() })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || !data.code) throw new Error("El servidor no devolvió código de sala.");
      roomCode = String(data.code).toUpperCase();
      myId = "p1"; // quien crea la sala es el primer jugador (el estado lo confirma)
      savedGameRecorded = false;
      seenQuestionIds = [];
      connectWS(roomCode);
    })
    .catch(function (e) { toast("No se pudo crear la sala: " + e.message, "error"); });
}

function joinRoom(code) {
  var base = apiBase();
  if (!base) { showConfigWarning(); return; }
  var name = readName();
  if (!name) return;
  code = (code || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (code.length !== 4) { toast("El código de sala tiene 4 letras.", "error"); return; }
  myName = name;
  roomCode = code;
  myId = null; // lo confirma el estado al entrar
  savedGameRecorded = false;
  seenQuestionIds = [];
  connectWS(code);
}

function readName() {
  var input = $("nameInput");
  var name = input ? input.value.trim() : myName;
  if (!name) { toast("Escribe tu nombre primero.", "error"); if (input) input.focus(); return ""; }
  try { localStorage.setItem(LS_NAME, name); } catch (e) {}
  return name;
}

function showConfigWarning() {
  var w = $("configWarning");
  if (w) w.hidden = false;
  toast("Falta configurar la dirección del servidor (config.js).", "error");
}

/* ------------------------------------------------------------------ */
/* Recepción del estado                                                */
/* ------------------------------------------------------------------ */

function onState(state) {
  var prev = currentState;
  currentState = state;
  identifyMe(state);
  if (state.code) {
    roomCode = state.code;
    var badge = $("roomBadge");
    if (badge) badge.hidden = false;
    var rc = $("roomCode");
    if (rc) rc.textContent = state.code;
  }
  // Registrar preguntas vistas para la rotación (SPEC §2)
  if (state.question && state.question.id && seenQuestionIds.indexOf(state.question.id) < 0) {
    seenQuestionIds.push(state.question.id);
  }
  if (state.fastMoney && state.fastMoney.questions) {
    state.fastMoney.questions.forEach(function (q) {
      if (q && q.id && seenQuestionIds.indexOf(q.id) < 0) seenQuestionIds.push(q.id);
    });
  }
  if (state.phase === "gameOver") recordGameQuestions();
  handleStateSounds(prev, state);
  render(state);
}

/* ------------------------------------------------------------------ */
/* Temporizador                                                        */
/*                                                                     */
/* El servidor guarda la fecha límite; si el estado la trae, se usa.   */
/* Si no la trae, el cliente usa un respaldo local de 20 s que se      */
/* reinicia cada vez que cambia la situación (nueva pregunta, nuevo    */
/* intento, etc.). El servidor ignora respuestas fuera de plazo, así   */
/* que el temporizador local es solo una ayuda visual.                 */
/* ------------------------------------------------------------------ */

function stateDeadlineMs(state) {
  if (!state) return null;
  var v = state.deadlineMs || state.deadline || state.endsAt || state.timerEndsAt || state.expiresAt;
  if (typeof v === "number" && v > 0) return v < 1e12 ? v * 1000 : v; // segundos o ms
  if (typeof v === "string" && v) { var t = Date.parse(v); return isNaN(t) ? null : t; }
  if (typeof state.timeLeftMs === "number") return Date.now() + state.timeLeftMs;
  if (typeof state.timeLeft === "number") return Date.now() + state.timeLeft * 1000;
  return null;
}

function timerSecondsFor(state) {
  if (!state) return 0;
  if (state.phase === "faceoff") return FACEOFF_SECONDS;
  if (state.phase === "board" || state.phase === "steal") return GUESS_SECONDS;
  if (state.phase === "fastMoney") return FASTMONEY_SECONDS;
  return 0;
}

function timerKeyFor(state) {
  if (!state) return "";
  var extra = "";
  if (state.phase === "board" || state.phase === "steal") {
    var rev = state.question ? state.question.answers.filter(function (a) { return a.revealed; }).length : 0;
    extra = "|" + (state.bank || 0) + "|" + (state.strikes || 0) + "|" + rev;
  } else if (state.phase === "fastMoney") {
    extra = "|" + fmAnswers(state).map(function (a) { return a == null ? "-" : "x"; }).join("");
  } else if (state.phase === "faceoff") {
    var fa = state.faceoff && state.faceoff.answers ? state.faceoff.answers : {};
    extra = "|" + (fa.p1 ? "1" : "0") + (fa.p2 ? "1" : "0");
  }
  return state.phase + "|" + (state.round || 0) + "|" + (state.question ? state.question.id : "") + extra;
}

function startTimerLoop() {
  if (timerInterval) return;
  timerInterval = setInterval(function () {
    var state = currentState;
    var wrap = $("timerWrap");
    if (!state || !wrap) return;
    var total = timerSecondsFor(state);
    if (!total) { wrap.hidden = true; return; }
    var key = timerKeyFor(state);
    if (key !== timerKey) {
      timerKey = key;
      timeoutSentForKey = "";
      var dl = stateDeadlineMs(state);
      localDeadline = dl != null ? dl : Date.now() + total * 1000;
    }
    var remainMs = localDeadline - Date.now();
    var remain = Math.max(0, Math.ceil(remainMs / 1000));
    wrap.hidden = false;
    var bar = $("timerBar"), txt = $("timerText");
    var pct = Math.max(0, Math.min(100, (remainMs / (total * 1000)) * 100));
    if (bar) {
      bar.style.width = pct + "%";
      bar.className = "timer-bar" + (remain <= 5 ? " low" : "");
    }
    if (txt) {
      txt.textContent = remain + " s";
      txt.className = "timer-text" + (remain <= 5 ? " low" : "");
    }
    if (remainMs <= 0 && timeoutSentForKey !== key) {
      timeoutSentForKey = key;
      onTimeout(state);
    }
  }, 250);
}

/* Al agotarse el tiempo: solo se auto-envía donde el protocolo define
 * respuesta nula / paso (faceoff-answer null, fastmoney-pass). En tablero
 * y robo el servidor resuelve con su propia fecha límite. */
function onTimeout(state) {
  if (demoMode) return;
  if (state.phase === "faceoff") {
    var fa = state.faceoff && state.faceoff.answers ? state.faceoff.answers : {};
    if (myId && fa[myId] == null) send({ type: "faceoff-answer", answer: null });
    toast("⏰ ¡Tiempo agotado en el cara a cara!");
  } else if (state.phase === "fastMoney") {
    if (state.fastMoney && state.fastMoney.player === myId) {
      var idx = fmCurrentIndex(state);
      if (idx >= 0) send({ type: "fastmoney-pass", index: idx });
    }
    toast("⏰ ¡Se acabaron los 20 segundos del Dinero Rápido!");
  } else if (state.phase === "board") {
    toast("⏰ ¡Tiempo agotado! El servidor marca la cruz.");
  } else if (state.phase === "steal") {
    toast("⏰ ¡Tiempo agotado para robar!");
  }
}

/* ------------------------------------------------------------------ */
/* Dinero Rápido — helpers (solo muestran el estado)                   */
/*                                                                     */
/* fastMoney: {player, questions:[{id,text}], answers:[...]}           */
/* Cada answers[i] puede ser: null, un string, o un objeto             */
/* {answer, points} / {text, points}. Se toleran las tres formas.     */
/* ------------------------------------------------------------------ */

function fmAnswers(state) {
  var fm = state && state.fastMoney;
  if (!fm) return [null, null, null, null, null];
  if (Array.isArray(fm.answers)) return fm.answers;
  // Compatibilidad con la forma anterior (p1Answers/p2Answers)
  if (fm.player && Array.isArray(fm[fm.player + "Answers"])) return fm[fm.player + "Answers"];
  return [null, null, null, null, null];
}

function fmAnswerText(entry) {
  if (entry == null) return null;
  if (typeof entry === "string") return entry;
  if (typeof entry === "object") return entry.answer || entry.text || null;
  return String(entry);
}

function fmAnswerPoints(entry) {
  if (entry && typeof entry === "object" && typeof entry.points === "number") return entry.points;
  return null;
}

function fmCurrentIndex(state) {
  var ans = fmAnswers(state);
  for (var i = 0; i < ans.length; i++) {
    if (ans[i] == null || fmAnswerText(ans[i]) == null) return i;
  }
  return -1; // las 5 ya están contestadas
}

function fmTotalPoints(state) {
  var total = 0, known = false;
  fmAnswers(state).forEach(function (a) {
    var p = fmAnswerPoints(a);
    if (p != null) { total += p; known = true; }
  });
  return known ? total : null;
}

/* ¿Ganó comodín? Lo decide el servidor; aquí solo se refleja el estado:
 * - si el estado trae fastMoney.wildcardEarned, manda eso;
 * - si no, se muestra cuando el total (con puntos del servidor) llega a 100
 *   y el conteo de comodines del jugador subió. */
function fmWildcardEarned(state) {
  var fm = state && state.fastMoney;
  if (fm && typeof fm.wildcardEarned === "boolean") return fm.wildcardEarned;
  if (state && typeof state.wildcardEarned === "boolean") return state.wildcardEarned;
  var total = fmTotalPoints(state);
  if (total != null && total >= WILDCARD_THRESHOLD) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Dados                                                               */
/* ------------------------------------------------------------------ */

function diceValues(state) {
  var d = state && state.faceoff ? state.faceoff.dice : null;
  if (!d) return null;
  if (Array.isArray(d) && d.length >= 2) return [d[0], d[1]];
  if (typeof d === "object") {
    if (Array.isArray(d.dice)) return [d.dice[0], d.dice[1]];
    if (d.p1 != null && d.p2 != null) return [d.p1, d.p2];
    if (d.a != null && d.b != null) return [d.a, d.b];
  }
  return null;
}

var DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

function animateDice(finalValues, key) {
  if (diceAnimKey === key) return;
  diceAnimKey = key;
  if (diceAnimTimer) clearInterval(diceAnimTimer);
  var d1 = $("die1"), d2 = $("die2");
  if (!d1 || !d2) return;
  d1.classList.add("rolling"); d2.classList.add("rolling");
  d1.classList.remove("settled"); d2.classList.remove("settled");
  var ticks = 0;
  diceAnimTimer = setInterval(function () {
    ticks++;
    d1.textContent = DICE_FACES[Math.floor(Math.random() * 6)];
    d2.textContent = DICE_FACES[Math.floor(Math.random() * 6)];
    if (ticks >= 14) {
      clearInterval(diceAnimTimer);
      diceAnimTimer = null;
      if (finalValues) {
        d1.textContent = DICE_FACES[finalValues[0] - 1] || "⚄";
        d2.textContent = DICE_FACES[finalValues[1] - 1] || "⚄";
      }
      d1.classList.remove("rolling"); d2.classList.remove("rolling");
      d1.classList.add("settled"); d2.classList.add("settled");
    }
  }, 90);
}

/* ------------------------------------------------------------------ */
/* Render — marcador                                                   */
/* ------------------------------------------------------------------ */

function renderScoreboard(state) {
  var box = $("players");
  if (!box || !state.players) return;
  box.innerHTML = state.players.map(function (p) {
    var isMe = p.id === myId;
    var hasControl = state.control === p.id && (state.phase === "board" || state.phase === "steal");
    var wc = typeof p.wildcards === "number" ? p.wildcards : 0;
    var tag = "";
    if (isMe) tag = "TÚ";
    if (hasControl) tag = isMe ? "TÚ · EN TURNO" : "EN TURNO";
    return '<div class="player-card' + (isMe ? " me" : "") + (hasControl ? " has-control" : "") + '">' +
      '<div class="p-tag' + (hasControl ? " control" : "") + '">' + esc(tag) + '</div>' +
      '<div class="p-name">' + esc(p.name) + '</div>' +
      '<div class="p-score">' + (typeof p.score === "number" ? p.score : 0) + '</div>' +
      '<div class="p-wildcards">' + (wc > 0 ? '<span class="wc">🃏 ×' + wc + ' comodín' + (wc > 1 ? 'es' : '') + '</span>' : '') + '</div>' +
      '</div>';
  }).join("");

  var info = $("roundInfo");
  if (info) {
    if (state.phase === "lobby" || state.phase === "gameOver") { info.hidden = true; return; }
    info.hidden = false;
    var mult = state.multiplier || 1;
    var multLabel = mult === 1 ? "Sencilla ×1" : mult === 2 ? "Doble ×2" : "Triple ×3";
    info.innerHTML = '<span>Ronda ' + (state.round || 1) + ' de 4 · <span class="mult">' + multLabel + '</span></span>' +
      '<span class="bank">Banco: ' + (typeof state.bank === "number" ? state.bank : 0) + ' pts</span>';
  }
}

/* ------------------------------------------------------------------ */
/* Render — piezas comunes                                             */
/* ------------------------------------------------------------------ */

function bulbsHTML() {
  var n = 14, top = "", bottom = "";
  for (var i = 0; i < n; i++) {
    var d = ((i % 2) * 0.5).toFixed(1);
    top += '<span class="bulb" style="--d:' + d + 's"></span>';
    bottom += '<span class="bulb" style="--d:' + (0.5 - parseFloat(d)).toFixed(1) + 's"></span>';
  }
  return '<div class="bulbs">' + top + '</div>';
}

function boardHTML(state, revealAll) {
  var answers = (state.question && state.question.answers) || [];
  var rows = answers.map(function (a, i) {
    var revealed = !!a.revealed || !!revealAll;
    if (revealed && a.text != null) {
      return '<div class="panel revealed"><span class="num">' + (i + 1) + '</span>' +
        '<span class="answer-text">' + esc(a.text) + '</span>' +
        '<span class="points">' + (typeof a.points === "number" ? a.points : "?") + '</span></div>';
    }
    return '<div class="panel"><span class="num">' + (i + 1) + '</span><span class="blank"></span></div>';
  }).join("");
  return '<div class="marquee">' + bulbsHTML() +
    '<div class="board">' + rows + '</div>' +
    '<div class="bulbs bottom">' + bulbsHTML().replace('<div class="bulbs">', "").replace("</div>", "") + '</div>' +
    '</div>';
}

function strikesHTML(state) {
  var n = typeof state.strikes === "number" ? state.strikes : 0;
  var out = '<div class="strikes" aria-label="Cruces: ' + n + ' de 3">';
  for (var i = 0; i < 3; i++) {
    out += '<div class="strike-slot' + (i < n ? " hit" : "") + '">' + (i < n ? "✕" : "") + '</div>';
  }
  return out + '</div>';
}

function questionHTML(state) {
  if (!state.question || !state.question.text) return "";
  return '<div class="question">❝ ' + esc(state.question.text) + ' ❞</div>';
}

function answerFormHTML(id, placeholder, buttonText, passText) {
  var pass = passText ? '<button type="button" class="btn btn-ghost" id="' + id + 'Pass">' + esc(passText) + '</button>' : "";
  return '<form class="answer-form" id="' + id + '">' +
    '<input type="text" id="' + id + 'Input" placeholder="' + esc(placeholder) + '" autocomplete="off" maxlength="80" required>' +
    '<button type="submit" class="btn">' + esc(buttonText) + '</button>' + pass +
    '</form>';
}

function wildcardButtonHTML(state) {
  if (!state || state.phase !== "board") return "";
  if (myWildcards(state) <= 0) return "";
  var label = WILDCARD_EFFECT_LABEL[WILDCARD_EFFECT] || WILDCARD_EFFECT;
  return '<button type="button" class="btn btn-wildcard" id="useWildcardBtn">🃏 Usar comodín: ' + esc(label) +
    ' <span>(' + myWildcards(state) + ' disponible' + (myWildcards(state) > 1 ? 's' : '') + ')</span></button>';
}

function bindWildcardButton(state) {
  var btn = $("useWildcardBtn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var key = JSON.stringify(currentState);
    if (wildcardUsedForState === key) return;
    wildcardUsedForState = key;
    send({ type: "use-wildcard" });
    toast("🃏 Comodín usado: " + (WILDCARD_EFFECT_LABEL[WILDCARD_EFFECT] || WILDCARD_EFFECT) + ".");
    btn.disabled = true;
  });
}

function bindForm(formId, onSubmit) {
  var form = $(formId);
  if (!form) return;
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var input = $(formId + "Input");
    var val = input ? input.value.trim() : "";
    if (!val) { if (input) input.focus(); return; }
    onSubmit(val);
    if (input) input.value = "";
  });
  var input = $(formId + "Input");
  if (input) input.focus();
}

/* ------------------------------------------------------------------ */
/* Render — fases                                                      */
/* ------------------------------------------------------------------ */

function renderLobby(state) {
  var stage = $("stage");
  var players = state.players || [];
  var code = state.code || roomCode;
  var name = "";
  try { name = localStorage.getItem(LS_NAME) || ""; } catch (e) {}
  var configured = !!apiBase();

  if (players.length >= 2) {
    stage.innerHTML = '<div class="lobby-card">' +
      '<div class="phase-title">¡SALA LLENA! 🎉</div>' +
      '<p class="phase-sub"><b>' + esc(players[0].name) + '</b> vs <b>' + esc(players[1].name) + '</b><br>El juego empieza en un momento…</p>' +
      '</div>';
    return;
  }

  stage.innerHTML = '<div class="lobby-card">' +
    '<div class="phase-title">¡A JUGAR! 🎤</div>' +
    '<form class="lobby-form" id="lobbyForm">' +
      '<label for="nameInput">Tu nombre</label>' +
      '<input type="text" id="nameInput" placeholder="Ej. Tato" value="' + esc(name) + '" maxlength="20" autocomplete="off">' +
      '<button type="submit" class="btn" id="createBtn" ' + (configured ? "" : "disabled") + '>➕ Crear sala</button>' +
      '<div class="lobby-or">— o —</div>' +
      '<label for="codeInput">Código de sala (4 letras)</label>' +
      '<input type="text" id="codeInput" class="code-input" placeholder="ABCD" maxlength="4" autocomplete="off">' +
      '<button type="button" class="btn btn-red" id="joinBtn" ' + (configured ? "" : "disabled") + '>🚪 Unirse a la sala</button>' +
    '</form>' +
    (code ? '<div class="lobby-code-big">' + esc(code) + '</div><p class="share-note">Comparte este código con tu rival para que se una. En cuanto entren los dos, sale el botón de <b>Listo a jugar</b> y el juego empieza cuando los dos lo opriman.</p>' : "") +
    (players.length === 1 ? '<p class="share-note"><b>' + esc(players[0].name) + '</b> ya está en la sala. Esperando rival…</p>' : "") +
    '</div>';

  var form = $("lobbyForm");
  if (form) form.addEventListener("submit", function (ev) { ev.preventDefault(); createRoom(); });
  var joinBtn = $("joinBtn");
  if (joinBtn) joinBtn.addEventListener("click", function () {
    var c = $("codeInput"); joinRoom(c ? c.value : "");
  });
  var nameInput = $("nameInput");
  if (nameInput && !nameInput.value) nameInput.focus();
}

/* Pantalla de "Listo a jugar": con los 2 en la sala, el juego NO arranca
 * solo. Cada uno oprime Listo cuando esté acomodado (revisar el sonido,
 * sentarse, etc.) y el cara a cara empieza solo cuando los dos están listos. */
function renderReady(state) {
  var stage = $("stage");
  var players = state.players || [];
  var ready = state.ready || {};
  var iReady = myId ? !!ready[myId] : false;

  var cards = players.map(function (p) {
    var isReady = !!ready[p.id];
    var isMe = p.id === myId;
    return '<div class="fo-card' + (isReady ? " winner" : "") + '">' +
      '<div class="fo-name">' + esc(p.name) + (isMe ? " (tú)" : "") + '</div>' +
      '<div class="fo-answer" style="font-size:26px">' + (isReady ? "✅ Listo" : "⏳ Esperando…") + '</div>' +
      '</div>';
  }).join("");

  stage.innerHTML = '<div class="phase-title">🎤 ¿LISTOS A JUGAR?</div>' +
    '<p class="phase-sub">¡Ya están los dos en la sala! Oprime <b>Listo a jugar</b> cuando estés acomodado.<br>' +
    'El cara a cara empieza solo cuando <b>los dos</b> estén listos.<br>' +
    'Aprovecha para revisar el sonido 🔊 (botón dorado abajo a la derecha).</p>' +
    '<div class="faceoff-answers">' + cards + '</div>' +
    (iReady
      ? '<div class="waiting">✅ ¡Listo! Esperando a tu rival<span class="dots"></span></div>'
      : '<div class="btn-row"><button class="btn" id="readyBtn">✅ ¡Listo a jugar!</button></div>');

  var btn = $("readyBtn");
  if (btn) btn.addEventListener("click", function () {
    btn.disabled = true;
    send({ type: "ready" });
  });
}

function renderFaceoff(state) {
  var stage = $("stage");
  var fa = state.faceoff || {};
  var answers = fa.answers || {};
  var myAns = myId ? answers[myId] : undefined;
  var opp = opponent(state);
  var oppAns = opp ? answers[opp.id] : undefined;
  var bothIn = myAns != null && oppAns != null;

  var html = '<div class="phase-title">⚔️ CARA A CARA</div>' +
    '<p class="phase-sub">Escriban su respuesta <b>en secreto</b>, sin ver la del otro. ¡20 segundos!</p>' +
    questionHTML(state);

  // Si el cara a cara se repitió porque nadie acertó, avisar para que no
  // parezca que el juego se quedó callado.
  var answeredMap = fa.answered || {};
  var anyoneAnswered = !!(answeredMap.p1 || answeredMap.p2);
  if ((fa.retries || 0) > 0 && !anyoneAnswered) {
    html += '<div class="retry-note">⏰ Nadie acertó la vez pasada. ¡Otra vez con la misma pregunta!</div>';
  }

  if (myAns == null) {
    html += answerFormHTML("faceoffForm", "Tu respuesta secreta…", "✅ Enviar mi respuesta");
  } else {
    html += '<div class="waiting">✅ Respuesta enviada. Esperando a tu rival<span class="dots"></span></div>';
  }

  // La respuesta del rival solo se muestra cuando las dos ya entraron (revelación simultánea).
  if (bothIn) {
    var myPlayer = me(state);
    var myPts = fa.points && myId ? fa.points[myId] : null;
    var oppPts = fa.points && opp ? fa.points[opp.id] : null;
    var myWin = state.control === myId;
    html += '<div class="faceoff-answers">' +
      '<div class="fo-card' + (myWin ? " winner" : "") + '"><div class="fo-name">' + esc(myPlayer ? myPlayer.name : "Tú") + ' (tú)</div>' +
      '<div class="fo-answer">' + esc(myAns) + '</div>' +
      (typeof myPts === "number" ? '<div class="fo-points">' + myPts + ' puntos</div>' : "") +
      (myWin ? '<div class="fo-points">🏆 ¡Gana el control!</div>' : "") + '</div>' +
      '<div class="fo-card' + (!myWin ? " winner" : "") + '"><div class="fo-name">' + esc(opp ? opp.name : "Rival") + '</div>' +
      '<div class="fo-answer">' + esc(oppAns) + '</div>' +
      (typeof oppPts === "number" ? '<div class="fo-points">' + oppPts + ' puntos</div>' : "") +
      (!myWin ? '<div class="fo-points">🏆 ¡Gana el control!</div>' : "") + '</div></div>';
  } else if (myAns != null) {
    html += '<div class="faceoff-answers"><div class="fo-card"><div class="fo-name">Tú</div><div class="fo-answer">' + esc(myAns) + '</div></div>' +
      '<div class="fo-card"><div class="fo-name">' + esc(opp ? opp.name : "Rival") + '</div><div class="fo-secret">🔒 ???</div></div></div>';
  }

  stage.innerHTML = html;
  bindForm("faceoffForm", function (val) { send({ type: "faceoff-answer", answer: val }); });
}

/* ------------------------------------------------------------------ */
/* Cuenta atrás de la revelación del ganador (3-2-1)                   */
/* ------------------------------------------------------------------ */

var revealCountdownTimer = null;
var revealCountdownLast = null;

function stopRevealCountdown() {
  if (revealCountdownTimer) { clearInterval(revealCountdownTimer); revealCountdownTimer = null; }
  revealCountdownLast = null;
}

/* La revelación dura 5 s: los primeros ~2 s se lee quién ganó y los
 * últimos 3 s muestran la cuenta atrás 3-2-1 con un bip por número. */
function startRevealCountdown(state) {
  stopRevealCountdown();
  var el = $("revealCountdown");
  if (!el || !state.deadline) return;
  var update = function () {
    var el2 = $("revealCountdown");
    if (!el2) { stopRevealCountdown(); return; }
    var remainMs = state.deadline - Date.now();
    if (remainMs <= 0) { el2.textContent = "¡YA!"; stopRevealCountdown(); return; }
    var secs = Math.ceil(remainMs / 1000);
    if (secs > 3) {
      el2.textContent = "¡Prepárate…";
      el2.classList.add("prep");
    } else {
      el2.textContent = String(secs);
      el2.classList.remove("prep");
      if (revealCountdownLast !== secs) {
        revealCountdownLast = secs;
        sfxCountdown();
      }
    }
  };
  update();
  revealCountdownTimer = setInterval(update, 200);
}

/* Revelación del ganador del cara a cara: nombre del ganador, las dos
 * respuestas con sus puntos, quién empieza el tablero y la cuenta 3-2-1. */
function renderFaceoffReveal(state) {
  var stage = $("stage");
  var fa = state.faceoff || {};
  var answers = fa.answers || {};
  var points = fa.points || {};
  var winnerId = state.control || fa.winner;
  var winnerName = otherPlayerName(state, winnerId);
  var iWon = winnerId === myId;
  var players = state.players || [];

  var cards = players.map(function (p) {
    var ans = answers[p.id];
    var pts = typeof points[p.id] === "number" ? points[p.id] : null;
    var isWinner = p.id === winnerId;
    return '<div class="fo-card' + (isWinner ? " winner" : "") + '">' +
      '<div class="fo-name">' + esc(p.name) + (p.id === myId ? " (tú)" : "") + '</div>' +
      '<div class="fo-answer">' + esc(ans == null ? "— sin respuesta —" : ans) + '</div>' +
      (pts != null ? '<div class="fo-points">' + pts + ' puntos</div>' : '<div class="fo-points">Sin puntos</div>') +
      (isWinner ? '<div class="fo-points">🏆 ¡Gana el control!</div>' : "") +
      '</div>';
  }).join("");

  stage.innerHTML = '<div class="reveal-banner">' +
    '<div class="reveal-trophy">🏆</div>' +
    '<div class="reveal-title">¡GANADOR' + (iWon ? "" : "") + '!</div>' +
    '<div class="reveal-name">' + esc(winnerName) + '</div>' +
    '<div class="reveal-sub">Siguiente turno: <b>' + esc(winnerName) + '</b> — ¡empieza el tablero!</div>' +
    '</div>' +
    questionHTML(state) +
    '<div class="faceoff-answers">' + cards + '</div>' +
    '<div class="countdown-wrap"><div id="revealCountdown" class="countdown-big">…</div>' +
    '<div class="countdown-label">El tablero empieza en</div></div>';
  startRevealCountdown(state);
}

function renderDice(state) {
  var stage = $("stage");
  var vals = diceValues(state);
  var p1 = state.players && state.players[0];
  var p2 = state.players && state.players[1];
  var key = vals ? vals.join("-") : "rolling";

  stage.innerHTML = '<div class="phase-title">🎲 ¡EMPATE! A LOS DADOS</div>' +
    '<p class="phase-sub">Dijeron <b>la misma respuesta</b>. El dado más alto gana el control de la ronda.</p>' +
    questionHTML(state) +
    '<div class="dice-area">' +
      '<div class="die-wrap"><div class="die rolling" id="die1">⚄</div><div class="die-name">' + esc(p1 ? p1.name : "Jugador 1") + '</div></div>' +
      '<div class="die-wrap"><div class="die" id="die2">⚄</div><div class="die-name">' + esc(p2 ? p2.name : "Jugador 2") + '</div></div>' +
    '</div>' +
    '<div class="die-result" id="diceResult">' + (vals ? "Tirando…" : "Tirando los dados…") + '</div>';

  animateDice(vals, state.round + "|" + key);
  if (vals && vals[0] !== vals[1]) {
    var winnerId = vals[0] > vals[1] ? (p1 && p1.id) : (p2 && p2.id);
    setTimeout(function () {
      var el = $("diceResult");
      if (el && currentState && currentState.phase === "dice") {
        el.textContent = "🏆 " + otherPlayerName(currentState, winnerId) + " gana el control con un " + Math.max(vals[0], vals[1]) + "!";
      }
    }, 1500);
  } else if (vals) {
    setTimeout(function () {
      var el = $("diceResult");
      if (el && currentState && currentState.phase === "dice") el.textContent = "😱 ¡Empate en los dados! Se vuelve a tirar…";
    }, 1500);
  }
}

function renderBoard(state) {
  var stage = $("stage");
  var iControl = state.control === myId;
  var ctrlName = otherPlayerName(state, state.control);
  var html = '<div class="phase-title">🎯 RONDA ' + (state.round || 1) + '</div>' +
    questionHTML(state) +
    boardHTML(state, false) +
    strikesHTML(state);

  if (iControl) {
    html += '<p class="phase-sub">🎤 <b>¡Es tu turno!</b> Adivina una respuesta del tablero.</p>' +
      answerFormHTML("guessForm", "Escribe una respuesta…", "🎯 ¡La digo!");
    html += wildcardButtonHTML(state);
  } else {
    html += '<div class="waiting">🎤 <b>' + esc(ctrlName) + '</b> está adivinando<span class="dots"></span></div>';
    // El comodín también se muestra si lo tengo, aunque no tenga el control:
    // el botón solo aplica en fase de tablero y el servidor valida el uso.
    html += wildcardButtonHTML(state);
  }
  stage.innerHTML = html;
  bindForm("guessForm", function (val) { send({ type: "guess", answer: val }); });
  bindWildcardButton(state);
}

function renderSteal(state) {
  var stage = $("stage");
  var iSteal = state.control !== myId; // el robo lo juega quien NO tiene el control
  var ctrlName = otherPlayerName(state, state.control);
  var html = '<div class="phase-title">🚨 ¡ROBO!</div>' +
    '<p class="phase-sub">Tres cruces… <b>' + esc(iSteal ? "¡Tienes UNA oportunidad!" : ctrlName + " se queda esperando") + '</b><br>' +
    'Si tu respuesta está en el tablero, te llevas <b>TODOS los puntos de la ronda</b>.</p>' +
    questionHTML(state) +
    boardHTML(state, false) +
    strikesHTML(state);
  if (iSteal) {
    html += answerFormHTML("stealForm", "Tu respuesta para robar…", "💰 ¡Robo la ronda!");
  } else {
    html += '<div class="waiting">😬 <b>' + esc(opponent(state) ? opponent(state).name : "Tu rival") + '</b> intenta robarte la ronda<span class="dots"></span></div>';
  }
  stage.innerHTML = html;
  bindForm("stealForm", function (val) { send({ type: "steal-answer", answer: val }); });
}

function renderRoundEnd(state) {
  var stage = $("stage");
  stage.innerHTML = '<div class="phase-title">📋 FIN DE LA RONDA ' + (state.round || 1) + '</div>' +
    '<p class="phase-sub">Así quedó el tablero completo:</p>' +
    questionHTML(state) +
    boardHTML(state, true) +
    '<p class="phase-sub">Banco de la ronda: <b>' + (typeof state.bank === "number" ? state.bank : 0) + ' puntos</b></p>' +
    '<div class="btn-row"><button class="btn" id="nextBtn">➡️ Siguiente ronda</button></div>';
  var btn = $("nextBtn");
  if (btn) btn.addEventListener("click", function () { send({ type: "next" }); });
}

function renderFastMoney(state) {
  var stage = $("stage");
  var fm = state.fastMoney || {};
  var fmPlayer = fm.player || state.winner;
  var questions = fm.questions || [];
  var answers = fmAnswers(state);
  var iPlay = fmPlayer === myId;
  var playerName = otherPlayerName(state, fmPlayer);
  var idx = fmCurrentIndex(state);
  var answered = answers.filter(function (a) { return a != null && fmAnswerText(a) != null; }).length;

  if (!iPlay) {
    // Vista de espectador: el perdedor ve en vivo, sin jugar.
    var items = questions.map(function (q, i) {
      var done = answers[i] != null && fmAnswerText(answers[i]) != null;
      var txt = done ? fmAnswerText(answers[i]) : null;
      return '<div class="fm-item' + (done ? " done" : "") + '"><b>' + (i + 1) + '.</b> ' + esc(q.text) +
        (done ? '<div class="fm-answer">✅ ' + esc(txt) + '</div>' : '<div class="fm-answer">⏳ Esperando respuesta…</div>') + '</div>';
    }).join("");
    stage.innerHTML = '<div class="spectator"><div class="big-emoji">👀</div>' +
      '<h3>¡DINERO RÁPIDO!</h3>' +
      '<p class="phase-sub"><b>' + esc(playerName) + '</b> está jugando el Dinero Rápido.<br>' +
      'Si llega a <b>100 puntos</b> se gana una carta comodín 🃏 para la siguiente partida.</p>' +
      '<p class="phase-sub">Respuestas: <b>' + answered + ' de 5</b></p></div>' +
      '<div class="fm-list">' + items + '</div>';
    return;
  }

  // Vista del ganador que juega.
  var list = questions.map(function (q, i) {
    var done = answers[i] != null && fmAnswerText(answers[i]) != null;
    var cls = done ? " done" : (i === idx ? " current" : "");
    return '<div class="fm-item' + cls + '"><b>' + (i + 1) + '.</b> ' + esc(q.text) +
      (done ? '<div class="fm-answer">✅ ' + esc(fmAnswerText(answers[i])) + '</div>' : "") + '</div>';
  }).join("");

  stage.innerHTML = '<div class="phase-title">💰 ¡DINERO RÁPIDO!</div>' +
    '<p class="phase-sub">¡Ganaste el juego y ahora vas por el comodín!<br>Contesta las <b>5 preguntas en 20 segundos</b>. Si sumas <b>100 puntos o más</b>, te llevas una <b>carta comodín 🃏</b> para la siguiente partida.</p>' +
    '<div class="fm-list">' + list + '</div>';

  if (idx >= 0 && questions[idx]) {
    stage.innerHTML += '<div class="question" style="margin-top:14px">❝ ' + esc(questions[idx].text) + ' ❞</div>' +
      answerFormHTML("fmForm", "Tu respuesta… ¡rápido!", "✅ Siguiente", "⏭️ Pasar");
    bindForm("fmForm", function (val) { send({ type: "fastmoney-answer", index: idx, answer: val }); });
    var passBtn = $("fmFormPass");
    if (passBtn) passBtn.addEventListener("click", function () { send({ type: "fastmoney-pass", index: idx }); });
  } else {
    stage.innerHTML += '<div class="waiting">¡Listo! Revelando tus puntos<span class="dots"></span></div>';
  }
}

function renderFastMoneyReveal(state) {
  var stage = $("stage");
  var fm = state.fastMoney || {};
  var fmPlayer = fm.player || state.winner;
  var playerName = otherPlayerName(state, fmPlayer);
  var questions = fm.questions || [];
  var answers = fmAnswers(state);
  var total = fmTotalPoints(state);
  var earned = fmWildcardEarned(state);

  var rows = questions.map(function (q, i) {
    var entry = answers[i];
    var txt = fmAnswerText(entry);
    var pts = fmAnswerPoints(entry);
    return '<div class="fm-item done"><b>' + (i + 1) + '.</b> ' + esc(q.text) +
      (pts != null ? '<span class="fm-points">' + pts + '</span>' : "") +
      '<div class="fm-answer">' + (txt ? esc(txt) : "— sin respuesta —") + (pts == null && txt ? " · (0 pts)" : "") + '</div></div>';
  }).join("");

  var html = '<div class="phase-title">💰 DINERO RÁPIDO — RESULTADO</div>' +
    '<p class="phase-sub"><b>' + esc(playerName) + '</b> jugó el Dinero Rápido:</p>' +
    '<div class="fm-list">' + rows + '</div>';

  if (total != null) {
    html += '<div class="fm-total">' + total + ' PUNTOS<small>Meta del comodín: 100 puntos</small></div>';
  }
  if (earned) {
    html += '<div class="wildcard-card"><div class="wc-emoji">🃏</div>' +
      '<h3>¡COMODÍN GANADO!</h3>' +
      '<p><b>' + esc(playerName) + '</b> llegó a los 100 puntos y se lleva una carta comodín para la siguiente partida.</p>' +
      '<p class="wc-effect">Efecto: ' + esc(WILDCARD_EFFECT_LABEL[WILDCARD_EFFECT] || WILDCARD_EFFECT) + '.</p></div>';
  } else {
    html += '<p class="wildcard-miss">No se llegó a los 100 puntos esta vez.<br>¡La próxima partida será la buena! 🃏</p>';
  }
  html += '<div class="btn-row"><button class="btn" id="nextBtn">🏆 Ver resultado final</button></div>';
  stage.innerHTML = html;
  var key = "fmreveal|" + (state.code || "") + "|" + (total == null ? "?" : total);
  if (earned && confettiDoneForKey !== key) {
    confettiDoneForKey = key;
    spawnConfetti(70);
  }
  var btn = $("nextBtn");
  if (btn) btn.addEventListener("click", function () { send({ type: "next" }); });
}

function renderGameOver(state) {
  var stage = $("stage");
  var winner = state.winner ? playerById(state, state.winner) : null;
  var iWon = state.winner === myId;
  var scores = (state.players || []).map(function (p) {
    var wc = typeof p.wildcards === "number" ? p.wildcards : 0;
    return '<div class="fs"><b>' + esc(p.name) + (p.id === state.winner ? " 👑" : "") + '</b>' +
      '<span>' + (typeof p.score === "number" ? p.score : 0) + '</span>' +
      (wc > 0 ? '<div class="p-wildcards"><span class="wc">🃏 ×' + wc + '</span></div>' : "") + '</div>';
  }).join("");

  stage.innerHTML = '<div class="gameover"><div class="trophy">' + (iWon ? "🏆" : "🎉") + '</div>' +
    '<h2>' + (winner ? "¡" + esc(winner.name) + " GANA EL JUEGO!" : "¡FIN DEL JUEGO!") + '</h2>' +
    '<p class="phase-sub">' + (iWon ? "¡Felicidades, campeón! 🎊" : "Buen juego. ¡La revancha te espera!") + '</p>' +
    '<div class="final-scores">' + scores + '</div>' +
    '<p class="phase-sub">Los comodines 🃏 se guardan para la siguiente partida en esta misma sala.</p>' +
    '<div class="btn-row"><button class="btn" id="rematchBtn">🔄 ¡Revancha!</button></div>' +
    '<div class="btn-row"><button class="btn btn-ghost" id="leaveBtn">🚪 Salir de la sala</button></div></div>';

  var key = "gameover|" + (state.code || "") + "|" + (state.winner || "");
  if (confettiDoneForKey !== key) {
    confettiDoneForKey = key;
    spawnConfetti(120);
  }
  var rb = $("rematchBtn");
  if (rb) rb.addEventListener("click", function () {
    savedGameRecorded = false;
    seenQuestionIds = [];
    send({ type: "rematch" });
    toast("🔄 ¡Revancha! Nuevas preguntas, mismos comodines.");
  });
  var lb = $("leaveBtn");
  if (lb) lb.addEventListener("click", function () {
    if (ws) ws.close();
    myId = null; roomCode = ""; currentState = null;
    render({ phase: "lobby", players: [], code: "" });
  });
}

/* ------------------------------------------------------------------ */
/* Render principal                                                    */
/* ------------------------------------------------------------------ */

function render(state) {
  if (!state) return;
  renderScoreboard(state);
  startTimerLoop();
  stopRevealCountdown(); // solo corre durante la revelación del ganador
  switch (state.phase) {
    case "lobby": renderLobby(state); break;
    case "ready": renderReady(state); break;
    case "faceoff": renderFaceoff(state); break;
    case "faceoffReveal": renderFaceoffReveal(state); break;
    case "dice": renderDice(state); break;
    case "board": renderBoard(state); break;
    case "steal": renderSteal(state); break;
    case "roundEnd": renderRoundEnd(state); break;
    case "fastMoney": renderFastMoney(state); break;
    case "fastMoneyReveal": renderFastMoneyReveal(state); break;
    case "gameOver": renderGameOver(state); break;
    default:
      $("stage").innerHTML = '<div class="waiting">Fase desconocida: ' + esc(state.phase) + '</div>';
  }
}

/* ------------------------------------------------------------------ */
/* Modo demo (?demo=1): estados de ejemplo incrustados, sin servidor   */
/* ------------------------------------------------------------------ */

function demoStates() {
  var base = {
    code: "DEMO",
    round: 1, multiplier: 1, control: "p1", strikes: 0, bank: 0, winner: null,
    players: [
      { id: "p1", name: "Tato", score: 120, wildcards: 1 },
      { id: "p2", name: "Ledya", score: 85, wildcards: 0 }
    ],
    question: {
      id: "q12", text: "Mencionen algo que siempre hay en una fiesta mexicana",
      answers: [
        { text: "Música", points: 32, revealed: true },
        { text: "Comida / antojitos", points: 28, revealed: true },
        { text: null, points: null, revealed: false },
        { text: null, points: null, revealed: false },
        { text: "Bebidas", points: 12, revealed: false },
        { text: null, points: null, revealed: false }
      ]
    },
    faceoff: { answers: {}, dice: null },
    fastMoney: { player: "p1", questions: [], answers: [null, null, null, null, null] }
  };
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function withPhase(o, patch) { var s = clone(o); Object.assign(s, patch); return s; }

  var fmQs = [
    { id: "f1", text: "Mencionen algo que llevas a la playa" },
    { id: "f2", text: "Mencionen un sabor de helado" },
    { id: "f3", text: "Mencionen algo que huele rico" },
    { id: "f4", text: "Mencionen un animal de la granja" },
    { id: "f5", text: "Mencionen algo que se rompe fácil" }
  ];
  var fmAns = [
    { answer: "Toalla", points: 30 },
    { answer: "Chocolate", points: 25 },
    { answer: "Pan recién horneado", points: 20 },
    { answer: "Gallina", points: 18 },
    { answer: "Vaso", points: 19 }
  ];

  return [
    { label: "🏠 Lobby", state: withPhase(base, { phase: "lobby", players: [{ id: "p1", name: "Tato", score: 0, wildcards: 0 }], question: null }) },
    { label: "✅ Listo a jugar", state: withPhase(base, { phase: "ready", ready: { p1: true, p2: false }, question: null }) },
    { label: "⚔️ Cara a cara", state: withPhase(base, { phase: "faceoff", question: clone(base.question) }) },
    { label: "⚔️ Cara a cara (revelado)", state: withPhase(base, { phase: "faceoff", faceoff: { answers: { p1: "Música", p2: "Comida" }, dice: null, points: { p1: 32, p2: 28 }, retries: 0 } }) },
    { label: "🏆 Ganador del cara a cara", state: withPhase(base, { phase: "faceoffReveal", control: "p1", deadline: Date.now() + 5000, faceoff: { answers: { p1: "Música", p2: "Comida" }, dice: null, winner: "p1", points: { p1: 32, p2: 28 }, retries: 0 } }) },
    { label: "🎲 Dados", state: withPhase(base, { phase: "dice", faceoff: { answers: { p1: "Música", p2: "Música" }, dice: { p1: 4, p2: 6 } } }) },
    { label: "🎯 Tablero (tu turno + comodín)", state: withPhase(base, { phase: "board", strikes: 1, bank: 60 }) },
    { label: "🚨 Robo", state: withPhase(base, { phase: "steal", control: "p1", strikes: 3, bank: 60 }) },
    { label: "📋 Fin de ronda", state: withPhase(base, { phase: "roundEnd", strikes: 1, bank: 88 }) },
    { label: "💰 Dinero Rápido (tú juegas)", state: withPhase(base, { phase: "fastMoney", winner: "p1", fastMoney: { player: "p1", questions: fmQs, answers: ["Toalla", "Chocolate", null, null, null] } }) },
    { label: "👀 Dinero Rápido (espectador)", state: withPhase(base, { phase: "fastMoney", winner: "p1", fastMoney: { player: "p1", questions: fmQs, answers: ["Toalla", "Chocolate", null, null, null] } }) },
    { label: "🃏 Revelación (comodín ganado)", state: withPhase(base, { phase: "fastMoneyReveal", winner: "p1", players: [{ id: "p1", name: "Tato", score: 210, wildcards: 1 }, { id: "p2", name: "Ledya", score: 150, wildcards: 0 }], fastMoney: { player: "p1", questions: fmQs, answers: fmAns } }) },
    { label: "🏆 Fin del juego", state: withPhase(base, { phase: "gameOver", winner: "p1", players: [{ id: "p1", name: "Tato", score: 210, wildcards: 1 }, { id: "p2", name: "Ledya", score: 150, wildcards: 0 }] }) }
  ];
}

function startDemo() {
  demoMode = true;
  myName = "Tato";
  myId = "p1";
  roomCode = "DEMO";
  var bar = $("demoBar");
  if (bar) bar.hidden = false;
  var btns = $("demoButtons");
  var list = demoStates();
  if (btns) {
    btns.innerHTML = "";
    list.forEach(function (item, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = item.label;
      b.addEventListener("click", function () { showDemo(i); });
      btns.appendChild(b);
    });
  }
  showDemo(0);
}

function showDemo(i) {
  var list = demoStates();
  demoIndex = ((i % list.length) + list.length) % list.length;
  // La vista de espectador usa p2 como "yo".
  myId = list[demoIndex].label.indexOf("espectador") >= 0 ? "p2" : "p1";
  var btns = $("demoButtons");
  if (btns) {
    Array.prototype.forEach.call(btns.children, function (b, j) {
      b.classList.toggle("active", j === demoIndex);
    });
  }
  onState(list[demoIndex].state);
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

function init() {
  // Botón de silencio (🔊/🔇) en la barra superior.
  var soundBtn = $("soundBtn");
  if (soundBtn) {
    soundBtn.textContent = soundMuted ? "🔇" : "🔊";
    soundBtn.title = soundMuted ? "Sonido apagado (tocar para encender)" : "Sonido encendido (tocar para apagar)";
    soundBtn.addEventListener("click", function () {
      unlockAudio();
      setMuted(!soundMuted);
    });
  }
  // La música 8-bit arranca con el primer toque (política de autoplay).
  // Se escucha pointerdown y touchstart por si el navegador no dispara
  // el primero (iOS antiguo), y también se intenta al crear/unirse a sala.
  var unlockOnce = function () {
    document.removeEventListener("pointerdown", unlockOnce);
    document.removeEventListener("touchstart", unlockOnce);
    unlockAudio();
  };
  document.addEventListener("pointerdown", unlockOnce);
  document.addEventListener("touchstart", unlockOnce);
  var params = new URLSearchParams(window.location.search || "");
  if (params.get("demo") === "1") { startDemo(); return; }
  if (!apiBase()) {
    showConfigWarning();
    render({ phase: "lobby", players: [], code: "" });
    return;
  }
  // Si la URL trae ?sala=ABCD, prellenar el código.
  var preset = (params.get("sala") || "").toUpperCase();
  render({ phase: "lobby", players: [], code: "" });
  if (preset) {
    var c = $("codeInput");
    if (c) c.value = preset;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

/* Expuesto solo para pruebas locales (no afecta el juego). */
window.__100MXD__ = {
  renderState: onState,
  demoStates: demoStates,
  fmCurrentIndex: fmCurrentIndex,
  fmTotalPoints: fmTotalPoints,
  fmWildcardEarned: fmWildcardEarned,
  diceValues: diceValues,
  WILDCARD_EFFECT: WILDCARD_EFFECT
};
