/**
 * E2E local de "100 Mexicanos Dijeron" contra `wrangler dev --local`.
 *
 * Uso:
 *   1) En una terminal:  cd worker && npm run dev   (puerto 8787)
 *   2) En otra terminal: node worker/tests/e2e-local.mjs
 *
 * Simula dos jugadores (Tato y Ledya) jugando una partida completa por
 * WebSocket: cara a cara (con repetición por nadie acertar y con desempate
 * por dados), ronda con 3 cruces y robo, multiplicadores, Dinero Rápido
 * (solo el ganador, 100+ = comodín) y revancha. Verifica que los dos
 * clientes reciban el mismo estado y que el servidor nunca filtre
 * respuestas no reveladas. Usa el banco de preguntas local SOLO para saber
 * qué respuestas son correctas (el cliente real no las conoce).
 */

const BASE = "http://127.0.0.1:8787";
const BANK = JSON.parse(
  await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../questions.json", import.meta.url), "utf8"),
  ),
);

const findRound = (id) => BANK.rounds.find((q) => q.id === id);
const findFM = (id) => BANK.fastMoney.find((q) => q.id === id);
const NONSENSE = "zzzx qwerty inexistente";

let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!cond) failures++;
}

class Client {
  constructor(name) {
    this.name = name;
    this.lastState = null;
    this.states = 0;
    this.errors = [];
  }
  async connect(code) {
    this.ws = new WebSocket(`${BASE.replace("http", "ws")}/room/${code}/ws?name=${encodeURIComponent(this.name)}`);
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") {
        this.lastState = msg.state;
        this.states++;
        // El servidor nunca debe filtrar respuestas no reveladas.
        const q = msg.state.question;
        if (q) {
          for (const a of q.answers) {
            if (!a.revealed && (a.text !== null || a.points !== null)) {
              check(false, `fuga de respuesta no revelada en ${this.name}`);
            }
          }
        }
        if (msg.state.phase === "faceoff") {
          for (const v of Object.values(msg.state.faceoff.answers)) {
            if (v !== null) check(false, `respuesta de cara a cara visible antes de tiempo en ${this.name}`);
          }
        }
      } else if (msg.type === "error") {
        this.errors.push(msg.message);
      }
    };
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.send({ type: "join", name: this.name });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  async waitFor(pred, label, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.lastState && pred(this.lastState)) return this.lastState;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout esperando: ${label} (fase actual: ${this.lastState?.phase})`);
  }
}

function sameState(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- Crear sala ---
const roomRes = await fetch(`${BASE}/api/room`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ usedQuestionIds: [] }),
});
const { code } = await roomRes.json();
check(/^[A-Z]{4}$/.test(code), `sala creada con código ${code}`);

const tato = new Client("Tato");
const ledya = new Client("Ledya");
await tato.connect(code);
await ledya.connect(code);

const gameQuestions = [];
const fmQuestions = [];

// ============ RONDA 1: nadie acierta el cara a cara, se repite ============
let s = await tato.waitFor((x) => x.phase === "faceoff", "cara a cara ronda 1");
gameQuestions.push(s.question.id);
console.log(`\nRonda 1 (x${s.multiplier}): ${s.question.text}`);
tato.send({ type: "faceoff-answer", answer: NONSENSE });
ledya.send({ type: "faceoff-answer", answer: NONSENSE });
s = await tato.waitFor((x) => x.phase === "faceoff" && !x.faceoff.answered.p1, "repetición del cara a cara");
check(s.question.id === gameQuestions[0], "se repite el cara a cara con la misma pregunta");
const q1 = findRound(s.question.id);
tato.send({ type: "faceoff-answer", answer: q1.answers[0].text }); // mejor rankeada
ledya.send({ type: "faceoff-answer", answer: q1.answers[2].text }); // peor rankeada
s = await tato.waitFor((x) => x.phase === "board", "tablero ronda 1");
check(s.control === "p1", "Tato gana el control (respuesta mejor rankeada)");
check(sameState(tato.lastState, ledya.lastState), "los dos clientes ven el mismo estado");
// Tato revela todo el tablero
for (const a of q1.answers) {
  tato.send({ type: "guess", answer: a.text });
  await new Promise((r) => setTimeout(r, 150));
}
s = await tato.waitFor((x) => x.phase === "roundEnd", "fin ronda 1");
check(s.roundResult.winner === "p1" && s.roundResult.points === 100, `Tato se lleva el banco: ${s.roundResult.points} (x1)`);
check(tato.lastState.players[0].score === 100, "marcador de Tato = 100");
tato.send({ type: "next" });

// ============ RONDA 2: misma respuesta -> DADOS; 3 cruces -> ROBO ============
s = await tato.waitFor((x) => x.phase === "faceoff" && x.round === 2, "cara a cara ronda 2");
gameQuestions.push(s.question.id);
console.log(`\nRonda 2 (x${s.multiplier}): ${s.question.text}`);
const q2 = findRound(s.question.id);
tato.send({ type: "faceoff-answer", answer: q2.answers[0].text });
ledya.send({ type: "faceoff-answer", answer: q2.answers[0].text }); // ¡misma respuesta!
s = await tato.waitFor((x) => x.phase === "dice", "fase de dados");
check(s.faceoff.dice && s.faceoff.dice.rolls.p1 !== s.faceoff.dice.rolls.p2, `dados: Tato ${s.faceoff.dice.rolls.p1} vs Ledya ${s.faceoff.dice.rolls.p2} (sin empate)`);
const diceWinner = s.faceoff.dice.winner;
s = await tato.waitFor((x) => x.phase === "board", "tablero tras dados", 10000);
check(s.control === diceWinner, `el ganador de los dados (${diceWinner === "p1" ? "Tato" : "Ledya"}) toma el control`);
const controlClient = diceWinner === "p1" ? tato : ledya;
const stealClient = diceWinner === "p1" ? ledya : tato;
controlClient.send({ type: "guess", answer: q2.answers[0].text }); // 1 acierto
await new Promise((r) => setTimeout(r, 200));
for (let i = 0; i < 3; i++) {
  controlClient.send({ type: "guess", answer: NONSENSE }); // 3 cruces
  await new Promise((r) => setTimeout(r, 200));
}
s = await tato.waitFor((x) => x.phase === "steal", "fase de robo");
check(s.strikes === 3, "3 cruces acumuladas");
check(s.stealPlayer === (diceWinner === "p1" ? "p2" : "p1"), "el robo le toca al otro jugador");
const bankBeforeSteal = s.bank;
const stealAnswer = q2.answers.find((a) => !s.question.answers.some((r) => r.revealed && r.text === a.text));
stealClient.send({ type: "steal-answer", answer: stealAnswer.text });
s = await tato.waitFor((x) => x.phase === "roundEnd", "fin ronda 2");
check(s.roundResult.winner === s.stealPlayer || s.roundResult.winner === (diceWinner === "p1" ? "p2" : "p1"), "el ladrón se lleva el banco");
check(s.roundResult.points > bankBeforeSteal, `el robo suma su respuesta al banco (${bankBeforeSteal} -> ${s.roundResult.points})`);
tato.send({ type: "next" });

// ============ RONDA 3 (x2): Ledya gana el cara a cara y revela todo ============
s = await tato.waitFor((x) => x.phase === "faceoff" && x.round === 3, "cara a cara ronda 3");
gameQuestions.push(s.question.id);
console.log(`\nRonda 3 (x${s.multiplier}): ${s.question.text}`);
const q3 = findRound(s.question.id);
ledya.send({ type: "faceoff-answer", answer: q3.answers[0].text });
tato.send({ type: "faceoff-answer", answer: q3.answers[3].text });
s = await tato.waitFor((x) => x.phase === "board", "tablero ronda 3");
check(s.control === "p2", "Ledya gana el control");
for (const a of q3.answers) {
  ledya.send({ type: "guess", answer: a.text });
  await new Promise((r) => setTimeout(r, 150));
}
s = await tato.waitFor((x) => x.phase === "roundEnd", "fin ronda 3");
check(s.roundResult.points === 200, `banco x2 = 200 (fue ${s.roundResult.points})`);
tato.send({ type: "next" });

// ============ RONDA 4 (x3): Tato gana y revela todo ============
s = await tato.waitFor((x) => x.phase === "faceoff" && x.round === 4, "cara a cara ronda 4");
gameQuestions.push(s.question.id);
console.log(`\nRonda 4 (x${s.multiplier}): ${s.question.text}`);
const q4 = findRound(s.question.id);
tato.send({ type: "faceoff-answer", answer: q4.answers[0].text });
ledya.send({ type: "faceoff-answer", answer: NONSENSE });
s = await tato.waitFor((x) => x.phase === "board", "tablero ronda 4");
check(s.control === "p1", "Tato gana el control");
for (const a of q4.answers) {
  tato.send({ type: "guess", answer: a.text });
  await new Promise((r) => setTimeout(r, 150));
}
s = await tato.waitFor((x) => x.phase === "roundEnd", "fin ronda 4");
check(s.roundResult.points === 300, `banco x3 = 300 (fue ${s.roundResult.points})`);
const scores = Object.fromEntries(s.players.map((p) => [p.name, p.score]));
console.log(`\nMarcador final de rondas: Tato ${scores.Tato} - Ledya ${scores.Ledya}`);
const winnerName = scores.Tato > scores.Ledya ? "Tato" : "Ledya";
const winnerClient = winnerName === "Tato" ? tato : ledya;
tato.send({ type: "next" });

// ============ DINERO RÁPIDO: solo el ganador ============
s = await tato.waitFor((x) => x.phase === "fastMoney", "Dinero Rápido");
check(s.fastMoney.player === (winnerName === "Tato" ? "p1" : "p2"), `solo juega el ganador: ${winnerName}`);
const loserClient = winnerName === "Tato" ? ledya : tato;
console.log(`\nDinero Rápido — juega ${winnerName}:`);
for (const q of s.fastMoney.questions) fmQuestions.push(q.id);
for (let i = 0; i < 5; i++) {
  const fq = findFM(s.fastMoney.questions[i].id);
  console.log(`  ${i + 1}. ${fq.text} -> ${fq.answers[0].text} (${fq.answers[0].points} pts)`);
  winnerClient.send({ type: "fastmoney-answer", index: i, answer: fq.answers[0].text });
  await new Promise((r) => setTimeout(r, 150));
}
s = await tato.waitFor((x) => x.phase === "fastMoneyReveal", "revelación Dinero Rápido");
const fmTotal = s.fastMoney.total;
console.log(`  Total Dinero Rápido: ${fmTotal} puntos`);
check(fmTotal >= 100, "100+ puntos en Dinero Rápido");
check(s.fastMoney.wildcardEarned === true, "comodín ganado");
check(s.players.find((p) => p.name === winnerName).wildcards === 1, `${winnerName} tiene 1 comodín`);
check(sameState(tato.lastState, ledya.lastState), "los dos clientes ven la revelación igual");
tato.send({ type: "next" });

// ============ FIN DEL JUEGO + REVANCHA ============
s = await tato.waitFor((x) => x.phase === "gameOver", "fin del juego");
check(s.winner === (winnerName === "Tato" ? "p1" : "p2"), `ganador del juego: ${winnerName}`);
check(new Set(gameQuestions).size === 4, "las 4 preguntas de ronda fueron distintas");
check(new Set(fmQuestions).size === 5, "las 5 preguntas de Dinero Rápido fueron distintas");
check(!gameQuestions.some((id) => fmQuestions.includes(id)), "ronda y Dinero Rápido sin solaparse");

// GET /api/room debe devolver el mismo estado
const getRes = await fetch(`${BASE}/api/room/${code}`);
const getState = await getRes.json();
check(getState.phase === "gameOver" && getState.code === code, "GET /api/room devuelve el estado actual");

// Revancha: preguntas nuevas, comodín conservado
tato.send({ type: "rematch" });
s = await tato.waitFor((x) => x.phase === "faceoff" && x.round === 1, "revancha");
check(s.question.id !== gameQuestions[0], "la revancha usa preguntas nuevas");
check(s.players.find((p) => p.name === winnerName).wildcards === 1, "el comodín se conserva en la revancha");
check(s.players.every((p) => p.score === 0), "marcador reiniciado en la revancha");

console.log(`\nEstados recibidos: Tato ${tato.states}, Ledya ${ledya.states}`);
console.log(`Errores del servidor: Tato [${tato.errors.join("; ")}] Ledya [${ledya.errors.join("; ")}]`);
console.log(failures === 0 ? "\n✅ E2E COMPLETO: sin fallos" : `\n❌ E2E con ${failures} fallos`);
tato.ws.close();
ledya.ws.close();
process.exit(failures === 0 ? 0 : 1);
