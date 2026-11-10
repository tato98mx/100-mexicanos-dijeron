// Tests de la lógica pura del juego (src/game.ts) con node:test.
// Se ejecutan con `npm test` (node --test). No tocan red ni Cloudflare.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FACEOFF_MS,
  FAST_MONEY_COUNT,
  MULTIPLIERS,
  addPlayer,
  advance,
  createGame,
  matchAnswer,
  multiplierForRound,
  normalizeAnswer,
  pickQuestions,
  publicState,
  rematch,
  rollDice,
  setWildcardEffect,
  startGame,
  submitFaceoffAnswer,
  submitFastMoneyAnswer,
  submitGuess,
  submitStealAnswer,
  tick,
  useWildcard,
} from "../src/game.ts";
import bank from "../src/questions.json" with { type: "json" };

// Banco pequeño y determinista para las pruebas de flujo.
const fixture = {
  rounds: [
    {
      id: "q1",
      text: "Q1",
      answers: [
        { text: "Comal", points: 40, aliases: ["comal de barro"] },
        { text: "Sartén", points: 30, aliases: [] },
        { text: "Licuadora", points: 20, aliases: [] },
        { text: "Molcajete", points: 10, aliases: [] },
      ],
    },
    {
      id: "q2",
      text: "Q2",
      answers: [
        { text: "Rojo", points: 40, aliases: [] },
        { text: "Azul", points: 30, aliases: [] },
        { text: "Verde", points: 20, aliases: [] },
        { text: "Negro", points: 10, aliases: [] },
      ],
    },
    {
      id: "q3",
      text: "Q3",
      answers: [
        { text: "Perro", points: 40, aliases: ["perrito"] },
        { text: "Gato", points: 30, aliases: [] },
        { text: "Pájaro", points: 20, aliases: ["pajarito"] },
        { text: "Pez", points: 10, aliases: [] },
      ],
    },
    {
      id: "q4",
      text: "Q4",
      answers: [
        { text: "Tacos", points: 40, aliases: [] },
        { text: "Pizza", points: 30, aliases: [] },
        { text: "Sopa", points: 20, aliases: [] },
        { text: "Ensalada", points: 10, aliases: [] },
      ],
    },
    {
      id: "q5",
      text: "Q5",
      answers: [
        { text: "Lunes", points: 40, aliases: [] },
        { text: "Martes", points: 30, aliases: [] },
        { text: "Miércoles", points: 20, aliases: [] },
        { text: "Jueves", points: 10, aliases: [] },
      ],
    },
    {
      id: "q6",
      text: "Q6",
      answers: [
        { text: "Sol", points: 40, aliases: [] },
        { text: "Luna", points: 30, aliases: [] },
        { text: "Estrella", points: 20, aliases: [] },
        { text: "Nube", points: 10, aliases: [] },
      ],
    },
  ],
  fastMoney: [
    {
      id: "f1",
      text: "F1",
      answers: [
        { text: "Rojo", points: 32, aliases: [] },
        { text: "Azul", points: 26, aliases: [] },
        { text: "Verde", points: 16, aliases: [] },
        { text: "Amarillo", points: 12, aliases: [] },
        { text: "Rosa", points: 8, aliases: [] },
        { text: "Negro", points: 6, aliases: [] },
      ],
    },
    {
      id: "f2",
      text: "F2",
      answers: [
        { text: "Enero", points: 34, aliases: [] },
        { text: "Mayo", points: 22, aliases: [] },
        { text: "Junio", points: 16, aliases: [] },
        { text: "Julio", points: 12, aliases: [] },
        { text: "Agosto", points: 9, aliases: [] },
        { text: "Septiembre", points: 7, aliases: [] },
      ],
    },
    {
      id: "f3",
      text: "F3",
      answers: [
        { text: "Uno", points: 40, aliases: [] },
        { text: "Dos", points: 30, aliases: [] },
        { text: "Tres", points: 20, aliases: [] },
        { text: "Cuatro", points: 10, aliases: [] },
      ],
    },
    {
      id: "f4",
      text: "F4",
      answers: [
        { text: "Casa", points: 40, aliases: [] },
        { text: "Coche", points: 30, aliases: [] },
        { text: "Perro", points: 20, aliases: [] },
        { text: "Gato", points: 10, aliases: [] },
      ],
    },
    {
      id: "f5",
      text: "F5",
      answers: [
        { text: "Agua", points: 40, aliases: [] },
        { text: "Leche", points: 30, aliases: [] },
        { text: "Jugo", points: 20, aliases: [] },
        { text: "Café", points: 10, aliases: [] },
      ],
    },
    {
      id: "f6",
      text: "F6",
      answers: [
        { text: "Alto", points: 40, aliases: [] },
        { text: "Bajo", points: 30, aliases: [] },
        { text: "Ancho", points: 20, aliases: [] },
        { text: "Largo", points: 10, aliases: [] },
      ],
    },
  ],
};

/** RNG determinista que devuelve siempre el mismo valor. */
const constRng = (v) => () => v;
/** RNG que devuelve los valores de la lista en orden (y repite el último). */
function seqRng(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

/** Partida nueva con 2 jugadores, ya empezada. */
function newGame(now = 1000, rng = constRng(0.5)) {
  const state = createGame("ABCD");
  addPlayer(state, "Tato");
  addPlayer(state, "Ledya");
  const res = startGame(state, fixture, { rng, now });
  assert.equal(res.ok, true, res.error);
  return state;
}

/** Juega el cara a cara: p1 y p2 contestan; devuelve el control. */
function playFaceoff(state, a1, a2, now = 1000, rng = constRng(0.5)) {
  assert.equal(submitFaceoffAnswer(state, "p1", a1, now, rng).ok, true);
  assert.equal(submitFaceoffAnswer(state, "p2", a2, now, rng).ok, true);
  // Si hubo dados, avanzar la animación con tick.
  if (state.phase === "dice") {
    tick(state, now + 3001, fixture, rng);
  }
  assert.equal(state.phase, "board", `fase inesperada: ${state.phase}`);
  return state.control;
}

/** Resuelve la ronda actual: el control acierta todas las respuestas. */
function sweepBoard(state, now = 1000) {
  for (const a of [...state.board]) {
    if (!a.revealed) {
      assert.equal(submitGuess(state, state.control, a.text, now).ok, true);
    }
    if (state.phase !== "board") break;
  }
  assert.equal(state.phase, "roundEnd", `fase inesperada: ${state.phase}`);
}

describe("matching de respuestas", () => {
  it("normaliza acentos, mayúsculas y puntuación", () => {
    assert.equal(normalizeAnswer("  Sartén!! "), "sarten");
    assert.equal(normalizeAnswer("OLLÁ   DE   PRESIÓN"), "olla de presion");
  });

  it("vale por texto exacto, alias y subcadena (5+ caracteres)", () => {
    const answers = fixture.rounds[0].answers;
    assert.equal(matchAnswer("comal", answers), 0);
    assert.equal(matchAnswer("COMAL DE BARRO", answers), 0); // alias
    assert.equal(matchAnswer("licuadora de vaso", answers), 2); // alias
    assert.equal(matchAnswer("licuadora", answers), 2);
    assert.equal(matchAnswer("molca", answers), 3); // subcadena 5+
    assert.equal(matchAnswer("nada que ver", answers), -1);
    assert.equal(matchAnswer(null, answers), -1);
    assert.equal(matchAnswer("", answers), -1);
  });
});

describe("cara a cara", () => {
  it("gana la respuesta mejor rankeada", () => {
    const s = newGame();
    // p1 dice la #2 (Sartén), p2 la #1 (Comal) de la pregunta actual.
    const top = s.board[0].text;
    const second = s.board[1].text;
    const control = playFaceoff(s, second, top);
    assert.equal(control, "p2");
  });

  it("una respuesta válida gana contra una no válida o nula", () => {
    const s = newGame();
    const control = playFaceoff(s, s.board[0].text, "invento total");
    assert.equal(control, "p1");
    const s2 = newGame();
    const control2 = playFaceoff(s2, null, s2.board[2].text);
    assert.equal(control2, "p2");
  });

  it("misma respuesta válida → dados; gana el número mayor", () => {
    const s = newGame();
    const top = s.board[0].text;
    // Dados: p1 saca 2 (0.2*6=1 → +1 = 2), p2 saca 5 (0.7*6=4 → +1 = 5).
    submitFaceoffAnswer(s, "p1", top, 1000, seqRng([0.2, 0.7]));
    assert.equal(s.phase, "faceoff");
    submitFaceoffAnswer(s, "p2", top, 1000, seqRng([0.2, 0.7]));
    assert.equal(s.phase, "dice");
    assert.deepEqual(s.faceoff.dice.rolls, { p1: 2, p2: 5 });
    assert.equal(s.faceoff.dice.winner, "p2");
    tick(s, 1000 + 3001, fixture);
    assert.equal(s.phase, "board");
    assert.equal(s.control, "p2");
  });

  it("dados empatados se vuelven a tirar automáticamente", () => {
    // Primera tirada: 3 y 3 (empate); segunda: 1 y 6.
    const { a, b } = rollDice(seqRng([0.4, 0.4, 0.1, 0.9]));
    assert.notEqual(a, b);
    assert.deepEqual([a, b], [1, 6]);
  });

  it("si nadie acierta, se repite el cara a cara con la misma pregunta", () => {
    const s = newGame();
    const qid = s.questionId;
    submitFaceoffAnswer(s, "p1", "invento uno", 1000);
    submitFaceoffAnswer(s, "p2", "invento dos", 1000);
    assert.equal(s.phase, "faceoff");
    assert.equal(s.questionId, qid);
    assert.deepEqual(s.faceoff.answered, {});
  });

  it("si se acaba el tiempo sin contestar, las respuestas son nulas", () => {
    const s = newGame();
    const changed = tick(s, 1000 + FACEOFF_MS + 1, fixture);
    assert.equal(changed, true);
    // Nadie contestó → se repite el cara a cara.
    assert.equal(s.phase, "faceoff");
    assert.ok(s.deadline > 1000 + FACEOFF_MS);
  });
});

describe("ronda del tablero", () => {
  it("acierto suma puntos × multiplicador y revela la respuesta", () => {
    const s = newGame();
    const control = playFaceoff(s, s.board[0].text, s.board[1].text);
    const top = s.board.find((a) => !a.revealed);
    const expected = top.points * s.multiplier;
    assert.equal(submitGuess(s, control, top.text, 1000).ok, true);
    assert.equal(s.bank, expected);
    assert.equal(top.revealed, true);
  });

  it("fallar 3 veces lleva al robo; robo que acierta se lleva el banco", () => {
    const s = newGame();
    const control = playFaceoff(s, s.board[0].text, s.board[1].text);
    const stealer = control === "p1" ? "p2" : "p1";
    // El control acierta una (40 pts) y falla 3 veces.
    const first = s.board[0].text;
    submitGuess(s, control, first, 1000);
    assert.equal(s.bank, 40);
    for (let i = 0; i < 3; i++) {
      assert.equal(submitGuess(s, control, "invento", 1000).ok, true);
    }
    assert.equal(s.phase, "steal");
    assert.equal(s.strikes, 3);
    assert.equal(s.stealPlayer, stealer);
    // El robo acierta la segunda respuesta (30 pts): se lleva 40 + 30.
    const before = s.players.find((p) => p.id === stealer).score;
    assert.equal(submitStealAnswer(s, stealer, s.board[1].text, 1000).ok, true);
    assert.equal(s.phase, "roundEnd");
    assert.equal(s.players.find((p) => p.id === stealer).score - before, 70);
    assert.equal(s.roundResult.winner, stealer);
  });

  it("robo que falla deja el banco al jugador con el control", () => {
    const s = newGame();
    const control = playFaceoff(s, s.board[0].text, s.board[1].text);
    const stealer = control === "p1" ? "p2" : "p1";
    submitGuess(s, control, s.board[0].text, 1000);
    for (let i = 0; i < 3; i++) submitGuess(s, control, "invento", 1000);
    assert.equal(s.phase, "steal");
    const before = s.players.find((p) => p.id === control).score;
    assert.equal(submitStealAnswer(s, stealer, "invento", 1000).ok, true);
    assert.equal(s.roundResult.winner, control);
    assert.equal(s.players.find((p) => p.id === control).score - before, 40);
  });

  it("revelar todo el tablero da la ronda al control sin robo", () => {
    const s = newGame();
    playFaceoff(s, s.board[0].text, s.board[1].text);
    sweepBoard(s);
    // Suma de puntos del tablero ×1.
    const total = s.roundQuestions[0].answers.reduce((n, a) => n + a.points, 0);
    assert.equal(s.roundResult.points, total);
    assert.equal(s.players.find((p) => p.id === s.roundResult.winner).score, total);
  });

  it("decir una respuesta ya revelada cuenta como fallo", () => {
    const s = newGame();
    const control = playFaceoff(s, s.board[0].text, s.board[1].text);
    submitGuess(s, control, s.board[0].text, 1000);
    assert.equal(s.strikes, 0);
    submitGuess(s, control, s.board[0].text, 1000);
    assert.equal(s.strikes, 1);
  });

  it("el tiempo agotado en un intento cuenta como cruz", () => {
    const s = newGame();
    const control = playFaceoff(s, s.board[0].text, s.board[1].text);
    assert.equal(s.control, control);
    tick(s, 1000 + 20001, fixture);
    assert.equal(s.strikes, 1);
    assert.equal(s.phase, "board");
  });

  it("solo el jugador con el control puede adivinar", () => {
    const s = newGame();
    const control = playFaceoff(s, s.board[0].text, s.board[1].text);
    const other = control === "p1" ? "p2" : "p1";
    assert.equal(submitGuess(s, other, s.board[0].text, 1000).ok, false);
  });
});

describe("multiplicadores", () => {
  it("rondas 1 y 2 ×1, ronda 3 ×2, ronda 4 ×3", () => {
    assert.deepEqual(
      [1, 2, 3, 4].map(multiplierForRound),
      [1, 1, 2, 3],
    );
    assert.deepEqual([...MULTIPLIERS], [1, 1, 2, 3]);
  });

  it("la ronda 3 paga doble: una partida simulada lo refleja en el banco", () => {
    const s = newGame();
    // Rondas 1 y 2: el control barre el tablero (100 pts cada una).
    for (let round = 1; round <= 2; round++) {
      assert.equal(s.round, round);
      assert.equal(s.multiplier, 1);
      playFaceoff(s, s.board[0].text, s.board[1].text);
      sweepBoard(s);
      assert.equal(advance(s, fixture, 1000).ok, true);
    }
    // Ronda 3 (×2): un solo acierto de 40 pts deja el banco en 80.
    assert.equal(s.round, 3);
    assert.equal(s.multiplier, 2);
    const control = playFaceoff(s, s.board[0].text, s.board[1].text);
    const top = s.board.find((a) => !a.revealed);
    submitGuess(s, control, top.text, 1000);
    assert.equal(s.bank, 80);
  });
});

describe("Dinero Rápido", () => {
  /** Lleva un estado hasta fastMoney con el ganador indicado. */
  function fastMoneyState(winnerId = "p1") {
    const s = newGame();
    s.phase = "fastMoney";
    s.winner = winnerId;
    s.fastMoney = {
      player: winnerId,
      questions: s.fastMoneyQuestions.map((q) => ({ id: q.id, text: q.text })),
      answers: Array(FAST_MONEY_COUNT).fill(null),
      answered: Array(FAST_MONEY_COUNT).fill(false),
      points: Array(FAST_MONEY_COUNT).fill(null),
      total: null,
      wildcardEarned: false,
    };
    s.deadline = 1000 + 20000;
    return s;
  }

  it("100 puntos o más = comodín; menos = sin comodín", () => {
    const s = fastMoneyState("p1");
    // Respuestas top de cada pregunta de Dinero Rápido elegida.
    const tops = s.fastMoneyQuestions.map((q) => q.answers[0]);
    const totalTop = tops.reduce((n, a) => n + a.points, 0);
    assert.ok(totalTop >= 100, `el fixture debería sumar 100+, suma ${totalTop}`);
    tops.forEach((a, i) => {
      assert.equal(submitFastMoneyAnswer(s, "p1", i, a.text, 1000).ok, true);
    });
    assert.equal(s.phase, "fastMoneyReveal");
    assert.equal(s.fastMoney.total, totalTop);
    assert.equal(s.fastMoney.wildcardEarned, true);
    assert.equal(s.players.find((p) => p.id === "p1").wildcards, 1);

    // Con respuestas flojas (<100) no hay comodín.
    const s2 = fastMoneyState("p2");
    const lows = s2.fastMoneyQuestions.map((q) => q.answers[q.answers.length - 1]);
    const totalLow = lows.reduce((n, a) => n + a.points, 0);
    assert.ok(totalLow < 100, `el fixture flojo debería sumar <100, suma ${totalLow}`);
    lows.forEach((a, i) => {
      assert.equal(submitFastMoneyAnswer(s2, "p2", i, a.text, 1000).ok, true);
    });
    assert.equal(s2.fastMoney.total, totalLow);
    assert.equal(s2.fastMoney.wildcardEarned, false);
    assert.equal(s2.players.find((p) => p.id === "p2").wildcards, 0);
  });

  it("solo el ganador juega el Dinero Rápido; el perdedor no puede", () => {
    const s = fastMoneyState("p1");
    assert.equal(submitFastMoneyAnswer(s, "p2", 0, "Rojo", 1000).ok, false);
    assert.equal(submitFastMoneyAnswer(s, "p1", 0, "Rojo", 1000).ok, true);
  });

  it("pasar una pregunta vale 0 puntos; el tiempo agotado cierra la fase", () => {
    const s = fastMoneyState("p1");
    assert.equal(submitFastMoneyAnswer(s, "p1", 0, null, 1000).ok, true);
    assert.equal(s.fastMoney.points[0], 0);
    tick(s, 1000 + 20001, fixture);
    assert.equal(s.phase, "fastMoneyReveal");
    assert.equal(s.fastMoney.total, 0);
  });

  it("de fastMoneyReveal se avanza a gameOver", () => {
    const s = fastMoneyState("p1");
    s.fastMoneyQuestions.forEach((q, i) => {
      submitFastMoneyAnswer(s, "p1", i, q.answers[0].text, 1000);
    });
    assert.equal(s.phase, "fastMoneyReveal");
    assert.equal(advance(s, fixture, 1000).ok, true);
    assert.equal(s.phase, "gameOver");
  });
});

describe("comodines", () => {
  it("forgive-strike (por defecto): anula una cruz", () => {
    setWildcardEffect("forgive-strike");
    try {
      const s = newGame();
      const control = playFaceoff(s, s.board[0].text, s.board[1].text);
      s.players.find((p) => p.id === control).wildcards = 1;
      submitGuess(s, control, "invento", 1000);
      assert.equal(s.strikes, 1);
      assert.equal(useWildcard(s, control, 1000).ok, true);
      assert.equal(s.strikes, 0);
      assert.equal(s.players.find((p) => p.id === control).wildcards, 0);
    } finally {
      setWildcardEffect("forgive-strike");
    }
  });

  it("reveal-answer: revela gratis la respuesta de más puntos", () => {
    setWildcardEffect("reveal-answer");
    try {
      const s = newGame();
      const control = playFaceoff(s, s.board[0].text, s.board[1].text);
      s.players.find((p) => p.id === control).wildcards = 1;
      const top = s.board[0];
      assert.equal(useWildcard(s, control, 1000).ok, true);
      assert.equal(top.revealed, true);
      assert.equal(s.bank, top.points * s.multiplier);
      assert.equal(s.players.find((p) => p.id === control).wildcards, 0);
    } finally {
      setWildcardEffect("forgive-strike");
    }
  });

  it("sin comodines no se puede usar", () => {
    const s = newGame();
    const control = playFaceoff(s, s.board[0].text, s.board[1].text);
    assert.equal(useWildcard(s, control, 1000).ok, false);
  });
});

describe("rotación de preguntas", () => {
  it("no repite preguntas dentro de la partida", () => {
    const s = newGame();
    const roundIds = s.roundQuestions.map((q) => q.id);
    assert.equal(new Set(roundIds).size, roundIds.length);
    const fmIds = s.fastMoneyQuestions.map((q) => q.id);
    assert.equal(new Set(fmIds).size, fmIds.length);
    assert.equal(new Set([...roundIds, ...fmIds]).size, roundIds.length + fmIds.length);
  });

  it("excluye los IDs usados recientemente que envía el cliente", () => {
    // Excluir 2 de 6 rondas y 1 de 6 de Dinero Rápido: quedan justo las
    // necesarias, sin tener que reiniciar la rotación.
    const s = createGame("ABCD", { usedQuestionIds: ["q1", "q2", "f1"] });
    addPlayer(s, "Tato");
    addPlayer(s, "Ledya");
    startGame(s, fixture, { rng: constRng(0.5), now: 1000 });
    const used = [...s.roundQuestions, ...s.fastMoneyQuestions].map((q) => q.id);
    assert.ok(!used.includes("q1") && !used.includes("q2"));
    assert.ok(!used.includes("f1"));
  });

  it("si el banco disponible se agota, se reinicia la rotación", () => {
    const all = [...fixture.rounds.map((q) => q.id), ...fixture.fastMoney.map((q) => q.id)];
    const picked = pickQuestions(fixture.rounds, 4, all, constRng(0.5));
    assert.equal(picked.length, 4);
  });

  it("la revancha usa preguntas nuevas y conserva los comodines", () => {
    // Con el banco real (60 + 30) hay preguntas de sobra para no repetir.
    const s = createGame("ABCD");
    addPlayer(s, "Tato");
    addPlayer(s, "Ledya");
    assert.equal(startGame(s, bank, { rng: constRng(0.1), now: 1000 }).ok, true);
    // Simular fin de partida con un comodín ganado.
    s.phase = "gameOver";
    s.players[0].wildcards = 1;
    s.players[0].score = 150;
    const oldIds = [...s.roundQuestions, ...s.fastMoneyQuestions].map((q) => q.id);
    assert.equal(rematch(s, bank, { rng: constRng(0.1), now: 2000 }).ok, true);
    assert.equal(s.phase, "faceoff");
    assert.equal(s.round, 1);
    assert.equal(s.players[0].score, 0);
    assert.equal(s.players[0].wildcards, 1);
    const newIds = [...s.roundQuestions, ...s.fastMoneyQuestions].map((q) => q.id);
    assert.ok(!newIds.some((id) => oldIds.includes(id)), "la revancha repitió preguntas");
  });

  it("el banco real tiene 60 rondas + 30 de Dinero Rápido y sus puntos suman 100", () => {
    assert.equal(bank.rounds.length, 60);
    assert.equal(bank.fastMoney.length, 30);
    for (const q of [...bank.rounds, ...bank.fastMoney]) {
      const sum = q.answers.reduce((n, a) => n + a.points, 0);
      assert.equal(sum, 100, `la pregunta ${q.id} suma ${sum}`);
    }
    const picked = pickQuestions(bank.rounds, 4, [], constRng(0.5));
    assert.equal(new Set(picked.map((q) => q.id)).size, 4);
  });
});

describe("estado público (seguridad del tablero)", () => {
  it("nunca envía el texto ni los puntos de respuestas no reveladas", () => {
    const s = newGame();
    const pub = publicState(s);
    const raw = JSON.stringify(pub);
    assert.ok(!raw.includes("Comal") || s.board[0].revealed);
    for (const a of pub.question.answers) {
      if (!a.revealed) {
        assert.equal(a.text, null);
        assert.equal(a.points, null);
      }
    }
    // Tampoco alias ni preguntas futuras (ningún otro ID de ronda).
    assert.ok(!raw.includes("comal de barro"));
    for (const q of fixture.rounds) {
      if (q.id !== s.questionId) assert.ok(!raw.includes(`"${q.id}"`), `se filtró ${q.id}`);
    }
  });

  it("durante el cara a cara oculta las respuestas hasta que ambas están", () => {
    const s = newGame();
    submitFaceoffAnswer(s, "p1", s.board[0].text, 1000);
    const pub = publicState(s);
    assert.equal(pub.faceoff.answers.p1, null);
    assert.equal(pub.faceoff.answered.p1, true);
    assert.equal(pub.faceoff.answered.p2, undefined);
  });

  it("la sala admite como máximo 2 jugadores", () => {
    const s = createGame("ABCD");
    assert.equal(addPlayer(s, "Tato"), "p1");
    assert.equal(addPlayer(s, "Ledya"), "p2");
    assert.equal(addPlayer(s, "Tercero"), null);
  });
});
