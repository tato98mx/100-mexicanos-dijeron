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
  check("muestra la respuesta Salsa con 28 puntos", html.includes("Salsa") && html.includes("28 puntos"));
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
{
  const s = clone(base);
  s.phase = "faceoff";
  s.faceoff = { answers: {}, answered: {}, dice: null, winner: null, points: {}, retries: 0 };
  api.renderState(s);
  const html = getEl("stage").innerHTML;
  check("sin repeticiones no muestra el aviso", !html.includes("Nadie acertó"));
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
