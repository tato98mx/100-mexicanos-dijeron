// Smoke test del cliente (app.js) con un DOM mínimo.
// Verifica: render de faceoffReveal (ganador, puntos, cuenta atrás),
// aviso de repetición del cara a cara, y que los sonidos no fallen
// sin AudioContext. No toca red.
"use strict";
const fs = require("fs");
const path = require("path");

function makeEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    style: {},
    className: "",
    _html: "",
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    listeners: {},
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    focus() {},
    querySelector() { return null; },
  };
  return el;
}

const elements = {};
function getEl(id) {
  if (!elements[id]) {
    const el = makeEl("div");
    el.id = id;
    elements[id] = el;
  }
  return elements[id];
}

const listeners = {};
global.window = global;
global.document = {
  getElementById: (id) => getEl(id),
  createElement: (tag) => makeEl(tag),
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: () => {},
  readyState: "complete",
};
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
global.URLSearchParams = URLSearchParams;
global.WebSocket = class { constructor() {} };
global.fetch = () => Promise.reject(new Error("sin red en el test"));
global.window.GAME_API_URL = "https://example.workers.dev";
global.location = { search: "" };

// Cargar app.js (se auto-inicializa: init() corre al final).
const code = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
eval(code);

const api = global.window.__100MXD__;
if (!api) { console.error("FALLO: window.__100MXD__ no quedó expuesto"); process.exit(1); }

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log("  ✔ " + name); }
  else { failures++; console.log("  ✖ " + name + (extra ? " — " + extra : "")); }
}

const base = {
  code: "ABCD", round: 1, multiplier: 1, control: "p1", strikes: 0, bank: 0, winner: null,
  players: [
    { id: "p1", name: "Tato", score: 120, wildcards: 0 },
    { id: "p2", name: "Ledya", score: 85, wildcards: 0 },
  ],
  question: {
    id: "q1", text: "Mencionen algo que le pueden poner a los tacos",
    answers: [
      { text: "Limón", points: 32, revealed: false },
      { text: null, points: null, revealed: false },
      { text: null, points: null, revealed: false },
    ],
  },
  faceoff: { answers: {}, answered: {}, dice: null, winner: null, points: {}, retries: 0 },
  fastMoney: null,
  deadline: null,
};
function clone(o) { return JSON.parse(JSON.stringify(o)); }

console.log("faceoffReveal:");
{
  const s = clone(base);
  s.phase = "faceoffReveal";
  s.control = "p1";
  s.deadline = Date.now() + 5000;
  s.faceoff = {
    answers: { p1: "Limón", p2: "Salsa" },
    answered: { p1: true, p2: true },
    dice: null, winner: "p1", points: { p1: 32, p2: 28 }, retries: 0,
  };
  api.renderState(s);
  const html = getEl("stage").innerHTML;
  check("anuncia GANADOR con el nombre", html.includes("¡GANADOR") && html.includes("Tato"), html.slice(0, 200));
  check("dice Siguiente turno: Tato", html.includes("Siguiente turno") && html.includes("Tato"));
  check("muestra la respuesta Limón con 32 puntos", html.includes("Limón") && html.includes("32 puntos"));
  // La respuesta del PERDEDOR (Salsa, 28) se esconde del oponente: si no, el
  // que tiene el control la ve gratis y la adivina en el tablero.
  // Solo se muestra la del ganador (pública, ya queda en el tablero).
  check("esconde la respuesta del perdedor (Salsa)", !html.includes("Salsa") && !html.includes("28 puntos") && html.includes("Respuesta oculta"));
  check("tiene la cuenta atrás (revealCountdown)", html.includes('id="revealCountdown"'));
  check("la tarjeta del ganador lleva la clase winner", html.includes("fo-card winner"));
}

console.log("cara a cara con repetición (nadie acertó):");
{
  const s = clone(base);
  s.phase = "faceoff";
  s.faceoff = { answers: {}, answered: {}, dice: null, winner: null, points: {}, retries: 1 };
  api.renderState(s);
  const html = getEl("stage").innerHTML;
  check("avisa que nadie acertó y se repite", html.includes("Nadie acertó") && html.includes("Otra vez"), html.slice(0, 300));
}

console.log("cara a cara: aviso inmediato y barra bloqueada tras contestar:");
{
  // Sin contestar: sale el formulario.
  const s0 = clone(base);
  s0.phase = "faceoff"; s0.myId = "p1";
  s0.faceoff = { answers: { p1: null, p2: null }, answered: {}, dice: null, winner: null, points: {}, correct: { p1: null, p2: null }, retries: 0 };
  api.renderState(s0);
  let html = getEl("stage").innerHTML;
  check("sin contestar sale el formulario", html.includes('id="faceoffForm"'));
  // Contesté bien: el formulario DESAPARECE (barra bloqueada) y sale la palomita.
  // OJO: answers sigue en null (el servidor las esconde); lo que dice que ya
  // contesté es answered + correct. Antes el cliente usaba answers y nunca
  // quitaba el formulario.
  const s1 = clone(base);
  s1.phase = "faceoff"; s1.myId = "p1";
  s1.faceoff = { answers: { p1: null, p2: null }, answered: { p1: true }, dice: null, winner: null, points: {}, correct: { p1: true, p2: null }, retries: 0 };
  api.renderState(s1);
  html = getEl("stage").innerHTML;
  check("tras contestar bien se quita el formulario", !html.includes('id="faceoffForm"'));
  check("tras contestar bien sale la palomita", html.includes("✅") && html.includes("está en el tablero"));
  // Contesté mal: sale el tache, sin revelar la respuesta en el tablero.
  const s2 = clone(base);
  s2.phase = "faceoff"; s2.myId = "p1";
  s2.faceoff = { answers: { p1: null, p2: null }, answered: { p1: true }, dice: null, winner: null, points: {}, correct: { p1: false, p2: null }, retries: 0 };
  api.renderState(s2);
  html = getEl("stage").innerHTML;
  check("tras contestar mal se quita el formulario", !html.includes('id="faceoffForm"'));
  check("tras contestar mal sale el tache", html.includes("❌") && html.includes("no está en el tablero"));
}
{
  const s = clone(base);
  s.phase = "faceoff";
  s.faceoff = { answers: {}, answered: {}, dice: null, winner: null, points: {}, retries: 0 };
  api.renderState(s);
  const html = getEl("stage").innerHTML;
  check("sin repeticiones no muestra el aviso", !html.includes("Nadie acertó"));
}

console.log("Dinero Rápido: la revelación muestra los puntos del servidor (no 0 pts):");
{
  // La revelación trae fastMoney.points[i] y fastMoney.total del servidor.
  // Antes el cliente buscaba los puntos en la respuesta (texto plano) y TODAS
  // salían con "(0 pts)" aunque el servidor sí las había puntuado.
  const s = clone(base);
  s.phase = "fastMoneyReveal";
  s.winner = "p1";
  s.fastMoney = {
    player: "p1",
    questions: [
      { id: "f16", text: "Digan un electrodoméstico" },
      { id: "f1", text: "Nombren un color" },
      { id: "f2", text: "Digan un mes del año" },
      { id: "f3", text: "Nombren un día de la semana" },
      { id: "f4", text: "Digan un número de la suerte" },
    ],
    answers: ["licuadora", "rojo", "enero", null, "siete"],
    points: [9, 32, 28, 0, 12],
    total: 81,
    wildcardEarned: false,
  };
  api.renderState(s);
  const html = getEl("stage").innerHTML;
  check("licuadora muestra 9 puntos (no 0 pts)", html.includes("licuadora") && html.includes(">9<") && !html.includes("licuadora · (0 pts)"));
  check("muestra el total 81 puntos", html.includes("81") && html.includes("PUNTOS"));
  check("una respuesta sin contestar no inventa puntos", html.includes("sin respuesta"));
}

console.log("demo de Listo a jugar:");
{
  const demos = api.demoStates();
  const d = demos.find((x) => x.state.phase === "ready");
  check("existe el demo de Listo a jugar", !!d);
  if (d) {
    api.renderState(d.state);
    const html = getEl("stage").innerHTML;
    check("la pantalla de listos muestra el título y el botón", html.includes("LISTOS A JUGAR") && html.includes("Listo a jugar"));
    check("la pantalla de listos muestra quién está listo y quién espera", html.includes("Listo") && html.includes("Esperando"));
  }
}

console.log("demo de faceoffReveal:");
{
  const demos = api.demoStates();
  const d = demos.find((x) => x.label.includes("Ganador del cara a cara"));
  check("existe el demo del ganador", !!d);
  if (d) {
    api.renderState(d.state);
    const html = getEl("stage").innerHTML;
    check("el demo muestra el ganador y la cuenta atrás", html.includes("¡GANADOR") && html.includes("revealCountdown"));
  }
}

console.log("sonidos sin AudioContext (no deben fallar):");
{
  // Sin AudioContext, playTone y los SFX son no-op. Se ejerce el flujo
  // de sonidos por cambio de estado (faceoff -> faceoffReveal -> board).
  const s1 = clone(base); s1.phase = "faceoff";
  const s2 = clone(base); s2.phase = "faceoffReveal"; s2.control = "p1"; s2.deadline = Date.now() + 5000;
  s2.faceoff = { answers: { p1: "Limón", p2: "Salsa" }, answered: { p1: true, p2: true }, dice: null, winner: "p1", points: { p1: 32, p2: 28 }, retries: 0 };
  const s3 = clone(base); s3.phase = "board"; s3.control = "p1"; s3.deadline = Date.now() + 20000;
  try {
    api.renderState(s1); api.renderState(s2); api.renderState(s3);
    check("transiciones de estado con sonidos no fallan", true);
  } catch (e) {
    check("transiciones de estado con sonidos no fallan", false, e.message);
  }
}

if (failures > 0) { console.log(`\nFALLOS: ${failures}`); process.exit(1); }
console.log("\nOK: smoke test del cliente pasa.");
// app.js deja intervalos corriendo (temporizador, cuenta atrás); salir a mano.
process.exit(0);
