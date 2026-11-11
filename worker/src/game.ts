/**
 * 100 Mexicanos Dijeron — lógica pura del juego.
 *
 * SIN dependencias del runtime de Cloudflare: máquina de estados, selección
 * de preguntas, matching de respuestas, dados, puntos, strikes, robo,
 * Dinero Rápido y comodines. Importable y testeable con node.
 *
 * El servidor es autoritativo: `publicState()` es lo único que se envía al
 * cliente y NUNCA incluye el texto ni los puntos de las respuestas no
 * reveladas (tampoco los alias).
 */

// ---------------------------------------------------------------------------
// Parámetros del juego (un solo lugar para cambiarlos)
// ---------------------------------------------------------------------------

/** Efecto de la carta comodín. Opciones: "forgive-strike" (perdona una cruz)
 *  o "reveal-answer" (revela gratis una respuesta del tablero con sus puntos).
 *  Valor por defecto: "forgive-strike". */
export type WildcardEffect = "forgive-strike" | "reveal-answer";
export let WILDCARD_EFFECT: WildcardEffect = "forgive-strike";
export function setWildcardEffect(effect: WildcardEffect): void {
  WILDCARD_EFFECT = effect;
}

/** Multiplicadores por ronda: ronda 1 y 2 sencillas (x1), ronda 3 doble (x2),
 *  ronda 4 triple (x3). */
export const MULTIPLIERS = [1, 1, 2, 3] as const;
export function multiplierForRound(round: number): number {
  return MULTIPLIERS[round - 1] ?? 1;
}

/** Duración de los temporizadores (ms). */
export const FACEOFF_MS = 20_000; // cara a cara: 20 s por jugador
export const GUESS_MS = 20_000; // intento en el tablero: 20 s
export const FAST_MONEY_MS = 20_000; // Dinero Rápido: 20 s en total (5 preguntas)
export const DICE_MS = 3_000; // pausa para animar los dados antes de seguir
/** Revelación del ganador del cara a cara: 5 s para leer quién ganó y la
 *  cuenta atrás 3-2-1 antes de que empiece el tablero. */
export const FACEOFF_REVEAL_MS = 5_000;

/** Puntos necesarios en Dinero Rápido para ganar un comodín. */
export const FAST_MONEY_WILDCARD_THRESHOLD = 100;

/** Número de rondas del tablero por partida. */
export const TOTAL_ROUNDS = 4;
/** Preguntas de Dinero Rápido por partida. */
export const FAST_MONEY_COUNT = 5;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface AnswerDef {
  text: string;
  points: number;
  aliases: string[];
}

export interface QuestionDef {
  id: string;
  text: string;
  answers: AnswerDef[];
}

export interface QuestionBank {
  rounds: QuestionDef[];
  fastMoney: QuestionDef[];
}

export type Phase =
  | "lobby"
  | "ready"
  | "faceoff"
  | "faceoffReveal"
  | "dice"
  | "board"
  | "steal"
  | "roundEnd"
  | "fastMoney"
  | "fastMoneyReveal"
  | "gameOver";

export interface PlayerState {
  id: string;
  name: string;
  score: number;
  wildcards: number;
}

export interface BoardAnswerState {
  text: string;
  points: number;
  aliases: string[];
  revealed: boolean;
}

export interface DiceState {
  rolls: Record<string, number>;
  winner: string | null;
}

export interface FastMoneyState {
  player: string | null;
  questions: { id: string; text: string }[];
  answers: (string | null)[];
  answered: boolean[];
  points: (number | null)[];
  total: number | null;
  wildcardEarned: boolean;
}

export interface RoundResult {
  winner: string;
  points: number;
}

export interface GameState {
  code: string;
  phase: Phase;
  players: PlayerState[];
  round: number;
  multiplier: number;
  suddenDeath: boolean;
  questionId: string | null;
  questionText: string | null;
  /** Respuestas del tablero de la pregunta actual (con alias, solo servidor). */
  board: BoardAnswerState[];
  faceoff: {
    answers: Record<string, string | null>;
    answered: Record<string, boolean>;
    dice: DiceState | null;
    winner: string | null;
    /** Puntos de encuesta de cada respuesta del cara a cara (null si la
     *  respuesta no está en el tablero o no se contestó). Se revelan junto
     *  con las respuestas para que se vea quién ganó y por cuánto. */
    points: Record<string, number | null>;
    /** Cuántas veces se repitió el cara a cara porque nadie acertó. */
    retries: number;
  };
  control: string | null;
  stealPlayer: string | null;
  /** Quiénes ya oprimieron "Listo a jugar" en la fase "ready".
   *  El juego solo empieza cuando los dos están listos. */
  ready: Record<string, boolean>;
  strikes: number;
  bank: number;
  roundResult: RoundResult | null;
  winner: string | null;
  fastMoney: FastMoneyState | null;
  /** Fecha límite (epoch ms) de la fase actual con tiempo, o null. */
  deadline: number | null;
  // --- Solo servidor (nunca se envía al cliente) ---
  /** Preguntas de ronda elegidas para esta partida (la 5ª es reserva para
   *  muerte súbita; solo se usa si hay empate tras la ronda 4). */
  roundQuestions: QuestionDef[];
  /** Preguntas de Dinero Rápido elegidas para esta partida. */
  fastMoneyQuestions: QuestionDef[];
  /** IDs de preguntas ya usadas en esta sala (incluye los que envió el
   *  cliente al crearla): se excluyen al elegir preguntas nuevas. */
  usedIdsHistory: string[];
}

export type Rng = () => number;

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function ok(): ActionResult {
  return { ok: true };
}
function fail(error: string): ActionResult {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Aleatoriedad por defecto: criptográfica cuando está disponible. */
export function defaultRng(): number {
  try {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] / 2 ** 32;
  } catch {
    return Math.random();
  }
}

/** Normalizar una respuesta: minúsculas, sin acentos, sin puntuación,
 *  espacios colapsados. */
export function normalizeAnswer(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Matching de respuestas (servidor, autoritativo).
 * Devuelve el índice de la respuesta del tablero, o -1 si no es válida.
 * Vale si la respuesta normalizada es igual al texto o a un alias; como
 * respaldo, si tiene 5+ caracteres y es subcadena del texto (o viceversa),
 * también vale.
 */
export function matchAnswer(
  raw: string | null | undefined,
  answers: { text: string; aliases?: string[] }[],
): number {
  if (!raw) return -1;
  const n = normalizeAnswer(raw);
  if (!n) return -1;

  // 1) Igualdad exacta (texto o alias).
  for (let i = 0; i < answers.length; i++) {
    if (normalizeAnswer(answers[i].text) === n) return i;
    for (const alias of answers[i].aliases ?? []) {
      if (normalizeAnswer(alias) === n) return i;
    }
  }

  // 2) Respaldo por subcadena (solo respuestas de 5+ caracteres).
  if (n.length >= 5) {
    for (let i = 0; i < answers.length; i++) {
      const t = normalizeAnswer(answers[i].text);
      if (t.includes(n) || n.includes(t)) return i;
      for (const alias of answers[i].aliases ?? []) {
        const a = normalizeAnswer(alias);
        if (a.includes(n) || n.includes(a)) return i;
      }
    }
  }
  return -1;
}

/**
 * Elige `count` preguntas al azar, sin repetir, excluyendo `exclude`.
 * Si el banco disponible se agota, se reinicia la rotación (se vuelve a
 * considerar todo el banco).
 */
export function pickQuestions<T extends { id: string }>(
  pool: T[],
  count: number,
  exclude: string[] | Set<string>,
  rng: Rng = defaultRng,
): T[] {
  const excluded = new Set(exclude);
  let available = pool.filter((q) => !excluded.has(q.id));
  if (available.length < count) available = [...pool];
  const shuffled = [...available];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/** Tira dos dados (1-6). Si empatan, se vuelve a tirar automáticamente. */
export function rollDice(rng: Rng = defaultRng): { a: number; b: number } {
  const die = () => 1 + Math.floor(rng() * 6);
  let a = die();
  let b = die();
  let guard = 0;
  while (a === b && guard++ < 100) {
    a = die();
    b = die();
  }
  return { a, b };
}

// ---------------------------------------------------------------------------
// Creación y jugadores
// ---------------------------------------------------------------------------

export interface CreateGameOptions {
  /** IDs de preguntas usadas en partidas recientes (los envía el cliente). */
  usedQuestionIds?: string[];
}

export function createGame(code: string, opts: CreateGameOptions = {}): GameState {
  return {
    code,
    phase: "lobby",
    players: [],
    round: 0,
    multiplier: 1,
    suddenDeath: false,
    questionId: null,
    questionText: null,
    board: [],
    faceoff: { answers: {}, answered: {}, dice: null, winner: null, points: {}, retries: 0 },
    control: null,
    stealPlayer: null,
    ready: {},
    strikes: 0,
    bank: 0,
    roundResult: null,
    winner: null,
    fastMoney: null,
    deadline: null,
    roundQuestions: [],
    fastMoneyQuestions: [],
    usedIdsHistory: [...(opts.usedQuestionIds ?? [])],
  };
}

/** Añade un jugador a la sala. Máximo 2. Devuelve su id o null si está llena. */
export function addPlayer(state: GameState, name: string): string | null {
  const clean = name.trim().slice(0, 30);
  if (!clean) return null;
  if (state.players.length >= 2) return null;
  const id = state.players.length === 0 ? "p1" : "p2";
  state.players.push({ id, name: clean, score: 0, wildcards: 0 });
  return id;
}

export function otherPlayer(state: GameState, playerId: string): PlayerState | undefined {
  return state.players.find((p) => p.id !== playerId);
}

function playerById(state: GameState, playerId: string): PlayerState | undefined {
  return state.players.find((p) => p.id === playerId);
}

// ---------------------------------------------------------------------------
// Flujo de la partida
// ---------------------------------------------------------------------------

export interface StartGameOptions {
  rng?: Rng;
  now?: number;
}

/** Arranca la partida: elige 4 preguntas de ronda + 5 de Dinero Rápido
 *  (sin repetir en la partida y excluyendo el historial) y abre el primer
 *  cara a cara. Requiere 2 jugadores y estar en lobby o en "ready"
 *  (los dos ya oprimieron "Listo a jugar"). */
export function startGame(
  state: GameState,
  bank: QuestionBank,
  opts: StartGameOptions = {},
): ActionResult {
  if (state.phase !== "lobby" && state.phase !== "ready") return fail("La partida ya empezó.");
  if (state.players.length !== 2) return fail("Falta un jugador para empezar.");
  const rng = opts.rng ?? defaultRng;
  const now = opts.now ?? Date.now();

  state.roundQuestions = pickQuestions(bank.rounds, TOTAL_ROUNDS, state.usedIdsHistory, rng);
  state.fastMoneyQuestions = pickQuestions(
    bank.fastMoney,
    FAST_MONEY_COUNT,
    state.usedIdsHistory,
    rng,
  );
  for (const q of [...state.roundQuestions, ...state.fastMoneyQuestions]) {
    if (!state.usedIdsHistory.includes(q.id)) state.usedIdsHistory.push(q.id);
  }
  state.round = 1;
  state.multiplier = multiplierForRound(1);
  state.suddenDeath = false;
  state.winner = null;
  state.ready = {};
  for (const p of state.players) p.score = 0;
  setupFaceoff(state, 0, now);
  return ok();
}

/** Cuando ya están los 2 jugadores, la sala pasa a la fase "ready": nadie
 *  juega todavía; cada uno oprime "Listo a jugar" cuando esté acomodado
 *  (revisar el sonido, sentarse, etc.). Sin fecha límite: pueden tomarse
 *  el tiempo que quieran. */
export function enterReadyPhase(state: GameState): ActionResult {
  if (state.phase !== "lobby") return fail("La sala no está en el lobby.");
  if (state.players.length !== 2) return fail("Falta un jugador para estar listos.");
  state.phase = "ready";
  state.ready = {};
  state.deadline = null;
  return ok();
}

/** Un jugador oprime "Listo a jugar". Cuando los dos están listos, arranca
 *  la partida (primer cara a cara). */
export function markReady(
  state: GameState,
  playerId: string,
  bank: QuestionBank,
  now: number = Date.now(),
): ActionResult {
  if (state.phase !== "ready") return fail("No estamos en la pantalla de listos.");
  if (!playerById(state, playerId)) return fail("Jugador desconocido.");
  if (state.ready[playerId]) return fail("Ya estás listo.");
  state.ready[playerId] = true;
  if (state.players.every((p) => state.ready[p.id])) {
    return startGame(state, bank, { now });
  }
  return ok();
}

/** Prepara el cara a cara de la pregunta `questionIndex` de la ronda. */
function setupFaceoff(state: GameState, questionIndex: number, now: number): void {
  const q = state.roundQuestions[questionIndex];
  state.questionId = q.id;
  state.questionText = q.text;
  state.board = q.answers.map((a) => ({
    text: a.text,
    points: a.points,
    aliases: [...(a.aliases ?? [])],
    revealed: false,
  }));
  state.faceoff = { answers: {}, answered: {}, dice: null, winner: null, points: {}, retries: 0 };
  state.control = null;
  state.stealPlayer = null;
  state.strikes = 0;
  state.bank = 0;
  state.roundResult = null;
  state.phase = "faceoff";
  state.deadline = now + FACEOFF_MS;
}

/** Respuesta del cara a cara (o null si se agotó el tiempo). */
export function submitFaceoffAnswer(
  state: GameState,
  playerId: string,
  answer: string | null,
  now: number = Date.now(),
  rng: Rng = defaultRng,
): ActionResult {
  if (state.phase !== "faceoff") return fail("No estamos en el cara a cara.");
  if (!playerById(state, playerId)) return fail("Jugador desconocido.");
  if (state.faceoff.answered[playerId]) return fail("Ya contestaste el cara a cara.");
  state.faceoff.answers[playerId] = answer;
  state.faceoff.answered[playerId] = true;
  if (state.players.every((p) => state.faceoff.answered[p.id])) {
    resolveFaceoff(state, now, rng);
  }
  return ok();
}

/** Decide el cara a cara una vez que ambos contestaron (o se acabó el tiempo). */
function resolveFaceoff(state: GameState, now: number, rng: Rng): void {
  const [p1, p2] = state.players;
  const rank = (pid: string): number =>
    matchAnswer(state.faceoff.answers[pid] ?? null, state.board);
  const r1 = rank(p1.id);
  const r2 = rank(p2.id);
  const valid1 = r1 >= 0;
  const valid2 = r2 >= 0;
  // Puntos de encuesta de cada respuesta, para mostrarlos en la revelación.
  state.faceoff.points = {
    [p1.id]: valid1 ? state.board[r1].points : null,
    [p2.id]: valid2 ? state.board[r2].points : null,
  };

  if (valid1 && valid2 && r1 === r2) {
    // Misma respuesta válida: dados.
    const { a, b } = rollDice(rng);
    const winner = a > b ? p1.id : p2.id;
    state.faceoff.dice = { rolls: { [p1.id]: a, [p2.id]: b }, winner };
    state.faceoff.winner = winner;
    state.phase = "dice";
    state.deadline = now + DICE_MS;
    return;
  }
  if (valid1 && valid2) {
    finishFaceoff(state, r1 < r2 ? p1.id : p2.id, now);
    return;
  }
  if (valid1) {
    finishFaceoff(state, p1.id, now);
    return;
  }
  if (valid2) {
    finishFaceoff(state, p2.id, now);
    return;
  }
  // Nadie acertó: se repite el cara a cara con la misma pregunta.
  // Se conserva `retries` para que el cliente avise que nadie acertó.
  const retries = (state.faceoff.retries ?? 0) + 1;
  state.faceoff = { answers: {}, answered: {}, dice: null, winner: null, points: {}, retries };
  state.phase = "faceoff";
  state.deadline = now + FACEOFF_MS;
}

/** El ganador del cara a cara toma el control (o gana la muerte súbita).
 *  En vez de ir directo al tablero, pasa por la fase "faceoffReveal" para
 *  anunciar el ganador con su nombre, mostrar las dos respuestas con sus
 *  puntos y hacer la cuenta atrás 3-2-1 antes de empezar el tablero. */
function finishFaceoff(state: GameState, winnerId: string, now: number): void {
  state.faceoff.winner = winnerId;
  if (state.suddenDeath) {
    // La muerte súbita se decide solo con el cara a cara.
    state.winner = winnerId;
    beginFastMoney(state, now);
    return;
  }
  state.control = winnerId;
  state.phase = "faceoffReveal";
  state.deadline = now + FACEOFF_REVEAL_MS;
}

/** Intento en el tablero (solo el jugador con el control). */
export function submitGuess(
  state: GameState,
  playerId: string,
  answer: string | null,
  now: number = Date.now(),
): ActionResult {
  if (state.phase !== "board") return fail("No estamos en la ronda del tablero.");
  if (playerId !== state.control) return fail("No tienes el control del tablero.");
  applyGuess(state, answer, now);
  return ok();
}

function applyGuess(state: GameState, answer: string | null, now: number): void {
  const idx = matchAnswer(answer, state.board);
  if (idx >= 0 && !state.board[idx].revealed) {
    state.board[idx].revealed = true;
    state.bank += state.board[idx].points * state.multiplier;
    if (state.board.every((a) => a.revealed)) {
      endRound(state, state.control as string);
    } else {
      state.deadline = now + GUESS_MS;
    }
    return;
  }
  // Fallo: respuesta no está, ya fue revelada, o tiempo agotado.
  state.strikes += 1;
  if (state.strikes >= 3) {
    state.stealPlayer = otherPlayer(state, state.control as string)?.id ?? null;
    state.phase = "steal";
    state.deadline = now + GUESS_MS;
  } else {
    state.deadline = now + GUESS_MS;
  }
}

/** Respuesta del robo (solo el jugador que NO tiene el control). */
export function submitStealAnswer(
  state: GameState,
  playerId: string,
  answer: string | null,
  now: number = Date.now(),
): ActionResult {
  if (state.phase !== "steal") return fail("No estamos en el robo.");
  if (playerId !== state.stealPlayer) return fail("No te toca robar.");
  const idx = matchAnswer(answer, state.board);
  if (idx >= 0 && !state.board[idx].revealed) {
    // Acierta el robo: se revela su respuesta, suma al banco y se lleva TODO.
    state.board[idx].revealed = true;
    state.bank += state.board[idx].points * state.multiplier;
    endRound(state, playerId);
  } else {
    // Falla el robo: el jugador con el control se queda con el banco.
    endRound(state, state.control as string);
  }
  return ok();
}

/** Cierra la ronda: el ganador se lleva el banco y se revelan las respuestas
 *  que nadie dijo. */
function endRound(state: GameState, winnerId: string): void {
  const winner = playerById(state, winnerId);
  if (winner) winner.score += state.bank;
  state.roundResult = { winner: winnerId, points: state.bank };
  for (const a of state.board) a.revealed = true;
  state.bank = 0;
  state.strikes = 0;
  state.phase = "roundEnd";
  state.deadline = null;
}

/** Avanzar: de fin de ronda al siguiente cara a cara (o a muerte súbita /
 *  Dinero Rápido); de la revelación de Dinero Rápido al fin del juego. */
export function advance(
  state: GameState,
  bank: QuestionBank,
  now: number = Date.now(),
  rng: Rng = defaultRng,
): ActionResult {
  if (state.phase === "roundEnd") {
    if (state.round < TOTAL_ROUNDS) {
      state.round += 1;
      state.multiplier = multiplierForRound(state.round);
      setupFaceoff(state, state.round - 1, now);
      return ok();
    }
    // Fin de la ronda 4: ¿empate?
    const [p1, p2] = state.players;
    if (p1.score === p2.score) {
      state.suddenDeath = true;
      const spare = pickQuestions(bank.rounds, 1, state.usedIdsHistory, rng);
      if (spare.length > 0) {
        state.roundQuestions = [...state.roundQuestions, spare[0]];
        if (!state.usedIdsHistory.includes(spare[0].id)) {
          state.usedIdsHistory.push(spare[0].id);
        }
      }
      setupFaceoff(state, state.roundQuestions.length - 1, now);
      return ok();
    }
    state.winner = p1.score > p2.score ? p1.id : p2.id;
    beginFastMoney(state, now);
    return ok();
  }
  if (state.phase === "fastMoneyReveal") {
    state.phase = "gameOver";
    state.deadline = null;
    return ok();
  }
  return fail("No hay nada que avanzar en esta fase.");
}

/** Prepara el Dinero Rápido: solo juega el ganador del juego. */
function beginFastMoney(state: GameState, now: number): void {
  state.phase = "fastMoney";
  state.fastMoney = {
    player: state.winner,
    questions: state.fastMoneyQuestions.map((q) => ({ id: q.id, text: q.text })),
    answers: Array(FAST_MONEY_COUNT).fill(null),
    answered: Array(FAST_MONEY_COUNT).fill(false),
    points: Array(FAST_MONEY_COUNT).fill(null),
    total: null,
    wildcardEarned: false,
  };
  state.deadline = now + FAST_MONEY_MS;
}

/** Una respuesta de Dinero Rápido (o null si pasa la pregunta). */
export function submitFastMoneyAnswer(
  state: GameState,
  playerId: string,
  index: number,
  answer: string | null,
  now: number = Date.now(),
): ActionResult {
  if (state.phase !== "fastMoney" || !state.fastMoney) {
    return fail("No estamos en el Dinero Rápido.");
  }
  if (playerId !== state.fastMoney.player) {
    return fail("El Dinero Rápido lo juega solo el ganador del juego.");
  }
  if (index < 0 || index >= FAST_MONEY_COUNT) return fail("Pregunta inválida.");
  if (state.fastMoney.answered[index]) return fail("Esa pregunta ya se contestó.");
  const def = state.fastMoneyQuestions[index];
  const idx = matchAnswer(answer, def.answers);
  state.fastMoney.answers[index] = answer;
  state.fastMoney.answered[index] = true;
  state.fastMoney.points[index] = idx >= 0 ? def.answers[idx].points : 0;
  if (state.fastMoney.answered.every(Boolean)) {
    revealFastMoney(state);
  }
  return ok();
}

/** Cierra el Dinero Rápido: suma puntos y otorga el comodín si llega a 100. */
function revealFastMoney(state: GameState): void {
  if (!state.fastMoney) return;
  const total = state.fastMoney.points.reduce<number>(
    (sum, p) => sum + (p ?? 0),
    0,
  );
  state.fastMoney.total = total;
  state.fastMoney.wildcardEarned = total >= FAST_MONEY_WILDCARD_THRESHOLD;
  if (state.fastMoney.wildcardEarned) {
    const player = playerById(state, state.fastMoney.player as string);
    if (player) player.wildcards += 1;
  }
  state.phase = "fastMoneyReveal";
  state.deadline = null;
}

/**
 * Usar un comodín (solo en fase de tablero, solo el jugador con el control,
 * solo si tiene comodines).
 * - "forgive-strike": anula una cruz que ya tiene el jugador.
 * - "reveal-answer": revela gratis la respuesta no revelada de más puntos.
 */
export function useWildcard(
  state: GameState,
  playerId: string,
  now: number = Date.now(),
): ActionResult {
  if (state.phase !== "board") return fail("El comodín solo se usa en el tablero.");
  if (playerId !== state.control) return fail("No tienes el control del tablero.");
  const player = playerById(state, playerId);
  if (!player || player.wildcards <= 0) return fail("No tienes comodines.");

  if (WILDCARD_EFFECT === "forgive-strike") {
    if (state.strikes <= 0) return fail("No tienes cruces que perdonar.");
    player.wildcards -= 1;
    state.strikes -= 1;
    state.deadline = now + GUESS_MS;
    return ok();
  }

  // reveal-answer
  let best = -1;
  for (let i = 0; i < state.board.length; i++) {
    if (!state.board[i].revealed && (best < 0 || state.board[i].points > state.board[best].points)) {
      best = i;
    }
  }
  if (best < 0) return fail("El tablero ya está completo.");
  player.wildcards -= 1;
  state.board[best].revealed = true;
  state.bank += state.board[best].points * state.multiplier;
  if (state.board.every((a) => a.revealed)) {
    endRound(state, state.control as string);
  } else {
    state.deadline = now + GUESS_MS;
  }
  return ok();
}

/** Nueva partida en la misma sala: conserva jugadores y comodines. */
export function rematch(
  state: GameState,
  bank: QuestionBank,
  opts: StartGameOptions = {},
): ActionResult {
  if (state.phase !== "gameOver") return fail("La partida aún no termina.");
  const rng = opts.rng ?? defaultRng;
  const now = opts.now ?? Date.now();
  state.roundQuestions = pickQuestions(bank.rounds, TOTAL_ROUNDS, state.usedIdsHistory, rng);
  state.fastMoneyQuestions = pickQuestions(
    bank.fastMoney,
    FAST_MONEY_COUNT,
    state.usedIdsHistory,
    rng,
  );
  for (const q of [...state.roundQuestions, ...state.fastMoneyQuestions]) {
    if (!state.usedIdsHistory.includes(q.id)) state.usedIdsHistory.push(q.id);
  }
  state.round = 1;
  state.multiplier = multiplierForRound(1);
  state.suddenDeath = false;
  state.winner = null;
  state.fastMoney = null;
  for (const p of state.players) p.score = 0;
  setupFaceoff(state, 0, now);
  return ok();
}

// ---------------------------------------------------------------------------
// Temporizadores (el servidor los hace cumplir)
// ---------------------------------------------------------------------------

/**
 * Aplica lo que toque si se agotó la fecha límite de la fase actual.
 * Devuelve true si el estado cambió. `bank` solo se necesita si el avance
 * puede caer en muerte súbita (requiere elegir una pregunta extra).
 */
export function tick(
  state: GameState,
  now: number = Date.now(),
  bank?: QuestionBank,
  rng: Rng = defaultRng,
): boolean {
  if (state.deadline === null || now < state.deadline) return false;

  switch (state.phase) {
    case "faceoff": {
      // Los que no contestaron quedan con respuesta nula.
      for (const p of state.players) {
        if (!state.faceoff.answered[p.id]) {
          state.faceoff.answers[p.id] = null;
          state.faceoff.answered[p.id] = true;
        }
      }
      resolveFaceoff(state, now, rng);
      return true;
    }
    case "faceoffReveal": {
      // Terminó el anuncio del ganador y la cuenta atrás: empieza el tablero
      // con el ganador del cara a cara en control (ya se fijó en finishFaceoff).
      state.phase = "board";
      state.deadline = now + GUESS_MS;
      return true;
    }
    case "dice": {
      const diceWinner = state.faceoff.dice?.winner ?? null;
      if (state.suddenDeath) {
        // En muerte súbita los dados deciden la partida, no hay tablero.
        state.winner = diceWinner;
        beginFastMoney(state, now);
      } else {
        state.control = diceWinner;
        state.phase = "board";
        state.deadline = now + GUESS_MS;
      }
      return true;
    }
    case "board": {
      // Tiempo agotado: cuenta como fallo.
      applyGuess(state, null, now);
      return true;
    }
    case "steal": {
      // Tiempo agotado: el robo falla, el control se queda con el banco.
      endRound(state, state.control as string);
      return true;
    }
    case "fastMoney": {
      if (state.fastMoney) {
        for (let i = 0; i < FAST_MONEY_COUNT; i++) {
          if (!state.fastMoney.answered[i]) {
            state.fastMoney.answers[i] = null;
            state.fastMoney.answered[i] = true;
            state.fastMoney.points[i] = 0;
          }
        }
      }
      revealFastMoney(state);
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Estado público (lo único que se envía al cliente)
// ---------------------------------------------------------------------------

/**
 * Snapshot autoritativo para el cliente. NUNCA incluye el texto ni los
 * puntos de las respuestas no reveladas, ni los alias, ni las preguntas
 * futuras, ni el historial de IDs usados.
 * Durante el cara a cara las respuestas se ocultan hasta que ambas están
 * (se revela solo si el jugador ya contestó, con `answered`).
 */
export function publicState(state: GameState): Record<string, unknown> {
  const hideFaceoffAnswers = state.phase === "faceoff";
  return {
    code: state.code,
    phase: state.phase,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      wildcards: p.wildcards,
    })),
    round: state.round,
    multiplier: state.multiplier,
    suddenDeath: state.suddenDeath,
    question:
      state.questionId === null
        ? null
        : {
            id: state.questionId,
            text: state.questionText,
            answers: state.board.map((a) =>
              a.revealed
                ? { text: a.text, points: a.points, revealed: true }
                : { text: null, points: null, revealed: false },
            ),
          },
    faceoff: {
      answers: Object.fromEntries(
        state.players.map((p) => [
          p.id,
          hideFaceoffAnswers ? null : (state.faceoff.answers[p.id] ?? null),
        ]),
      ),
      answered: { ...state.faceoff.answered },
      dice: state.faceoff.dice,
      winner: state.faceoff.winner,
      // Los puntos del cara a cara solo se muestran tras la resolución
      // (en faceoffReveal, dice, board…); en "faceoff" aún no hay ganador.
      points: state.phase === "faceoff" ? {} : { ...state.faceoff.points },
      retries: state.faceoff.retries ?? 0,
    },
    control: state.control,
    stealPlayer: state.stealPlayer,
    ready: { ...state.ready },
    strikes: state.strikes,
    bank: state.bank,
    roundResult: state.roundResult,
    winner: state.winner,
    fastMoney: state.fastMoney
      ? {
          player: state.fastMoney.player,
          questions: state.fastMoney.questions,
          answers: state.fastMoney.answers,
          // Los puntos solo se revelan en fastMoneyReveal.
          points:
            state.phase === "fastMoneyReveal"
              ? state.fastMoney.points
              : Array(FAST_MONEY_COUNT).fill(null),
          total: state.phase === "fastMoneyReveal" ? state.fastMoney.total : null,
          wildcardEarned:
            state.phase === "fastMoneyReveal" ? state.fastMoney.wildcardEarned : false,
        }
      : null,
    deadline: state.deadline,
  };
}
