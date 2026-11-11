# 100 Mexicanos Dijeron — Especificación del juego (1v1 en línea)

Repo: `tato98mx/100-mexicanos-dijeron` (público). Frontend en GitHub Pages
(`https://tato98mx.github.io/100-mexicanos-dijeron/`). Backend: Cloudflare Worker
+ Durable Object (plan gratuito) en `worker/`. Todo gratis.

## 1. Reglas del formato (estándar del programa de TV, adaptado a 1v1)

Fuentes: Wikipedia "100 mexicanos dijeron" y reglas estándar de Family Feud.
Variantes del formato: la versión mexicana clásica jugaba 5 rondas (2 sencillas,
dobles y triples) con meta de 300 puntos; la versión de 4 rondas (2 sencillas,
1 doble, 1 triple) también es estándar. **Para este juego 1v1 se adopta el
formato de 4 rondas fijas** (más ágil para dos jugadores por teléfono):

| Ronda | Multiplicador |
|-------|---------------|
| 1     | ×1 (sencilla) |
| 2     | ×1 (sencilla) |
| 3     | ×2 (doble)    |
| 4     | ×3 (triple)   |

- Gana la partida quien tenga **más puntos al terminar la ronda 4**.
- Empate en puntos tras la ronda 4 → **muerte súbita**: una pregunta cara a cara
  (respuestas simultáneas); gana quien dé la respuesta mejor rankeada (dados si
  empatan con la misma respuesta). Esa persona gana la partida.
- En la tele el ganador del cara a cara podía elegir jugar o pasar la ronda;
  **en 1v1 no hay opción de pasar**: quien gana el cara a cara juega la ronda.
  (Simplificación documentada.)

### Listo a jugar (fase `ready`)
- Cuando el segundo jugador entra a la sala, el juego **NO arranca solo**.
  La sala pasa a la fase **`ready`**: cada jugador oprime el botón
  **"✅ ¡Listo a jugar!"** cuando esté acomodado (revisar el sonido,
  sentarse, etc.). El primer cara a cara solo empieza cuando **los dos**
  están listos. Así nadie entra a la primera pregunta sin estar preparado.
- La pantalla muestra a los dos jugadores con su estado (**✅ Listo** /
  **⏳ Esperando…**) y un aviso de revisar el sonido (botón dorado abajo
  a la derecha).
- La fase `ready` **no tiene fecha límite**: pueden tomarse el tiempo que
  quieran. El servidor guarda quién está listo en `ready` (`{p1: true}`).
- Mensaje cliente → servidor: `{type:"ready"}`. Si los dos ya están listos,
  el servidor arranca la partida (elige las preguntas y abre el primer
  cara a cara). La revancha no pasa por `ready`: arranca directo.
- El botón de sonido es flotante, abajo a la derecha (al alcance del
  pulgar), y la página respeta el área segura del teléfono para que el
  encabezado no quede tapado por el notch.
- **Reconexión automática:** si se cae el WebSocket (red móvil, el teléfono
  se duerme, etc.), el cliente vuelve a entrar solo a la misma sala con el
  mismo nombre (espera creciente 1 s, 2 s, 4 s… hasta 30 s, máximo 12
  intentos). El servidor reasocia al jugador por su nombre. Sin esto, la
  pantalla se quedaba en "Esperando rival" aunque el otro ya hubiera entrado.
- **Sonido (volúmenes en escala de Tato, 1 a 5):** la música 8-bit va en **2**
  (ganancia 0.05, bajita, que apenas se oiga) y los efectos van en **5**
  (ganancia 0.9, bien fuertes: ding de acierto, zumbido de X, bips, dados,
  botones). La música arranca con el primer toque. El desbloqueo de audio se
  reintenta en CADA toque (si el contexto se suspendió, el siguiente toque lo
  vuelve a arrancar). En el lobby hay un botón **"🔊 Probar sonido"** que suena
  un ding fuerte para comprobar que se oye; si no suena nada, el teléfono está
  en silencio o el volumen está bajo. Al tocar el botón de sonido para
  encenderlo también suena un ding inmediato. Los archivos CSS/JS llevan
  versión (`?v=11`) para que el teléfono no se quede con la versión vieja en
  caché.
- **Aplausos al ganar la ronda:** al terminar cada ronda, el fin de ronda
  muestra el nombre del ganador **EN GRANDE** (👏 ¡GANA LA RONDA! [nombre] —
  se lleva X puntos) y suenan **aplausos** (ruido de público, ~2 s) junto con
  el jingle de fin de ronda. Lo mismo aplica cuando alguien gana por robo.

### Cara a cara (al inicio de cada ronda)
- La computadora muestra la pregunta a los dos jugadores **al mismo tiempo**.
- Cada jugador escribe **UNA respuesta en secreto** (sin ver la del otro),
  con límite de 20 segundos. Si no contesta a tiempo, su respuesta es nula.
- **Aviso inmediato al contestar:** al enviar la respuesta, la barra se
  bloquea (desaparece el formulario) y sale una palomita **✅ ¡Tu respuesta
  está en el tablero!** si acertó, o un tache **❌ Esa respuesta no está en
  el tablero** si no acertó — SIN revelar la respuesta ni sus puntos en el
  tablero. El servidor manda `faceoff.correct` (`{p1: true/false/null, p2:
  ...}`) en el estado público para esto. El cliente decide si ya contestó
  con `faceoff.answered[myId]` (visible), NO con `faceoff.answers[myId]`
  (el servidor las esconde durante el cara a cara, así que siempre es null
  y el formulario nunca se quitaba: ese era el fallo).
- Se revelan las dos respuestas a la vez.
- Gana el control quien dio la respuesta **mejor rankeada** (número más bajo
  = más popular). Una respuesta válida gana siempre contra una respuesta no
  válida o nula.
- Si los dos dieron **LA MISMA respuesta válida** → dados: el servidor tira
  un dado para cada uno (animación en pantalla); gana el número mayor. Si los
  dados empatan, se vuelve a tirar automáticamente.
- Si **ninguno** dio una respuesta válida → se repite el cara a cara con la
  misma pregunta (nuevo intento simultáneo). El estado lleva
  `faceoff.retries` (cuántas veces se repitió) para que el cliente avise
  "Nadie acertó la vez pasada. ¡Otra vez con la misma pregunta!" y no parezca
  que el juego se quedó callado.

### Revelación del ganador del cara a cara (fase `faceoffReveal`)
- Cuando el cara a cara se resuelve con un ganador claro (no por dados), el
  servidor NO pasa directo al tablero: entra en la fase **`faceoffReveal`**
  de **5 segundos** para anunciar al ganador antes de que empiece la ronda.
- En esa fase el cliente muestra, en grande: **🏆 ¡GANADOR: [nombre]!**,
  **solo la respuesta del ganador** con sus puntos de encuesta, y
  **"Siguiente turno: [nombre] — ¡empieza el tablero!"**. La respuesta del
  perdedor se esconde del oponente (**🔒 Respuesta oculta**): si no, el que
  tiene el control la ve gratis y la adivina en el tablero, y en el robo ya
  no sirve. El perdedor sí ve su propia respuesta (él sabe lo que escribió).
- Los últimos **3 segundos** muestran una cuenta atrás grande **3-2-1** con
  un bip por número, y al terminar suena el bip agudo de "¡a jugar!" y
  empieza el tablero con el ganador en control (el control ya se fijó al
  entrar en la revelación).
- El servidor guarda los puntos de cada respuesta en `faceoff.points`
  (`{p1: 32, p2: 28}` o `null` si no acertó) y los envía en el estado
  público para mostrarlos en la revelación.
- **La respuesta ganadora queda en el tablero:** al entrar al tablero, la
  respuesta con la que el ganador ganó el cara a cara ya aparece revelada
  y sus puntos ya están en el banco (como en el programa de TV). El ganador
  NO tiene que volver a adivinarla. Lo mismo pasa con los dados: la
  respuesta empatada queda revelada.

### Ronda del tablero
- El jugador con el control adivina respuestas una por una (escribe la
  respuesta, 20 s por intento).
- **Acierto**: se revela la respuesta en el tablero con su puntaje y se suma
  al banco de la ronda (puntos × multiplicador de la ronda).
- **Respuesta ya revelada** (p. ej. la del cara a cara): NO es fallo ni cruz;
  solo avisa "¡Esa respuesta ya está en el tablero! Prueba con otra." y se
  puede intentar otra dentro del tiempo. Lo mismo en el robo.
- **Fallo** (respuesta no está en el tablero, o tiempo agotado): una cruz
  (X). **Con 3 cruces → robo.**
- Si se revela **todo el tablero** antes de las 3 cruces, el jugador con el
  control se lleva todos los puntos de la ronda.
- **Robo**: el otro jugador tiene UNA oportunidad: da una respuesta; si está
  en el tablero y no ha sido revelada, se lleva **TODOS los puntos de la
  ronda** (el banco completo, ya multiplicado); si no, el jugador que tenía
  el control se queda con los puntos de la ronda.
  - **Respuesta ya revelada en el robo:** NO pierde el robo; solo avisa y
    puede intentar con otra dentro del tiempo (se renueva la fecha límite).
    El aviso es **persistente y en grande** en la pantalla de robo (no solo
    el toast que se desvanece), con la regla escrita: "Para robar tienes que
    dar una respuesta que esté en el tablero pero que todavía NO se haya
    revelado". Antes el aviso era solo un toast: el jugador repetía una
    respuesta ya revelada, no entendía por qué no ganaba, se le acababa el
    tiempo y el control se quedaba con la ronda.
- Al final de la ronda se revelan las respuestas que nadie dijo.

### Dinero Rápido (decisión del usuario, 2026-11-09 — CORREGIDA: solo juega el ganador)
- El Dinero Rápido **NO es por dinero ni decide el partido**. Su propósito
  es dar una **ventaja para el siguiente juego mediante una carta comodín**.
- **Solo participa el ganador del juego**, como en el programa de TV. El
  perdedor NO juega el Dinero Rápido (lo ve en vivo como espectador).
- El ganador del partido (más puntos en las rondas del tablero) juega solo
  el Dinero Rápido: **5 preguntas en 1 minuto** en total, contestadas
  una tras otra.
- Puntos: valor de encuesta de cada respuesta, **sin multiplicador**. El
  servidor manda los puntos por pregunta en `fastMoney.points[i]` y el total
  en `fastMoney.total`; el cliente los lee de ahí. Antes el cliente buscaba
  los puntos en la respuesta misma (texto plano, sin puntos) y TODAS salían
  con "(0 pts)" aunque el servidor sí las había puntuado (p. ej. "licuadora"
  valía 9 y salía 0). Ese era el fallo del puntaje del Dinero Rápido.
- Si el ganador logra **100 puntos o más** en sus 5 respuestas, se gana
  **una carta comodín para la siguiente partida**. (El 100 es el número
  correcto: en el programa son 200 puntos entre los dos jugadores de la
  familia ganadora, o sea 100 por persona; aquí juega una sola persona.)
- El ganador de la partida sigue decidiéndose por los puntos de las 4 rondas
  (con muerte súbita si empatan); el Dinero Rápido solo reparte el comodín
  al ganador si llega a 100.

### Carta comodín (efecto pendiente de elegir por el usuario)
- El comodín se guarda en el estado de la sala por jugador
  (`players[].wildcards`) y se conserva al hacer revancha en la misma sala.
- Efecto configurable con un parámetro (`WILDCARD_EFFECT`): las dos opciones
  son **perdonar una cruz** (anula una X que el jugador acabaría de recibir)
  o **revelar una respuesta del tablero** (revela gratis una respuesta no
  revelada con sus puntos). Valor por defecto: `forgive-strike` (perdonar
  una cruz), fácil de cambiar en un solo lugar del código del Worker y del
  cliente. El jugador usa su comodín con un botón "Usar comodín" cuando
  aplique (en fase de tablero, si tiene comodines disponibles).
- Mensaje cliente → servidor: `{type:"use-wildcard"}` (solo en fase de
  tablero, solo si el jugador tiene comodines).

## 2. Preguntas

- Banco: **60 preguntas de ronda** + **30 preguntas de Dinero Rápido**,
  en español mexicano, estilo encuesta a 100 mexicanos
  (p. ej. "Mencionen algo que..."). Cada pregunta: 5 a 8 respuestas, puntos
  que **sumen 100**. Cada respuesta puede tener 1-3 alias (sinónimos) para
  el matching.
- Cada partida usa **4 preguntas de ronda + 5 de Dinero Rápido, todas
  diferentes**, elegidas al azar.
- Rotación entre partidas: el cliente guarda en `localStorage` los IDs de
  preguntas usadas en las últimas 3 partidas y los envía al crear la sala;
  el servidor excluye esos IDs al elegir. Si el banco disponible se agota,
  se reinicia la rotación. (El servidor nunca repite una pregunta dentro de
  la misma partida.)

## 3. Matching de respuestas (servidor, autoritativo)

Normalizar: minúsculas, sin acentos, sin puntuación, espacios colapsados.
Como en el programa, **no hace falta la respuesta exacta**: basta con
acercarse mucho. Una respuesta del jugador es válida si, normalizada:
1. es igual a una respuesta del tablero o a uno de sus alias;
2. tiene 5+ caracteres y es subcadena de la respuesta del tablero (o viceversa);
3. tiene pocos typos (distancia de Levenshtein pequeña: 1 edición en
   respuestas cortas, 2 en medianas, 3 en largas, con similitud ≥ 0.75);
4. cubre las palabras importantes de la respuesta del tablero, sin importar
   el orden ni las palabras de relleno (artículos, preposiciones).
Una respuesta muy distinta (otra palabra) sigue sin valer. El servidor
decide; el cliente nunca puntúa.

## 4. Arquitectura y protocolo

- Frontend estático en GitHub Pages. Backend: Cloudflare Worker
  (`worker/`) + **un Durable Object (SQLite) por sala**, con WebSocket.
  Plan gratuito: Workers Free incluye Durable Objects con backend SQLite
  (100.000 peticiones/día, 13.000 GB-s/día, 5M lecturas de filas/día).
  Usar la **WebSocket Hibernation API** para no gastar duración.
- Sala con código de 4 letras (A-Z, sin O/0/I/1 para evitar confusión).
  Uno crea la sala, el otro se une con el código. Máximo 2 jugadores.
- `config.js` en la raíz del frontend: `window.GAME_API_URL` con la URL
  del Worker (placeholder vacío hasta desplegar; el juego muestra un aviso
  claro si falta configurarla).

### Endpoints del Worker
- `POST /api/room` → `{code}` (crea la sala; el DO se crea al primer WS).
- `GET /api/room/:code` → estado actual (solo lectura, para depurar).
- `WebSocket wss://<worker>/room/:code/ws?name=<nombre>`

### Mensajes cliente → servidor
- `{type:"join", name}` — justo después de conectar por WS.
- `{type:"faceoff-answer", answer}` — respuesta del cara a cara (o
  `answer:null` si se agotó el tiempo).
- `{type:"guess", answer}` — intento en la ronda del tablero (solo el
  jugador con el control).
- `{type:"steal-answer", answer}` — respuesta del robo (solo el otro
  jugador).
- `{type:"fastmoney-answer", index, answer}` — una respuesta de Dinero
  Rápido (el cliente las envía una por una según el jugador contesta).
- `{type:"fastmoney-pass", index}` — pasar una pregunta de Dinero Rápido.
- `{type:"next"}` — avanzar (de fin de ronda a la cuenta atrás de la
  siguiente ronda, o a Dinero Rápido tras la ronda 4; de la revelación de
  Dinero Rápido al fin del juego).
- `{type:"rematch"}` — nueva partida en la misma sala (nuevas preguntas).

### Mensajes servidor → cliente
- `{type:"state", state}` — snapshot completo y autoritativo del estado
  tras cada cambio. **Los clientes solo renderizan este estado; nunca
  calculan puntos ni transiciones.**
- `{type:"error", message}` — sala llena, movimiento no válido, etc.

### Cuenta atrás antes de la siguiente ronda (fase `roundCountdown`)
- Al oprimir "Siguiente ronda" en el fin de ronda, el servidor NO despliega
  la siguiente pregunta directo: entra en la fase **`roundCountdown`** de
  **5 segundos** (`ROUND_COUNTDOWN_MS`), y al terminar pasa al cara a cara
  de la siguiente ronda (la ronda ya se incrementó al entrar en la cuenta
  atrás, así que el cliente muestra "RONDA X"). Lo mismo aplica a la muerte
  súbita por empate tras la ronda 4.
- El cliente muestra la cuenta atrás en grande (**5-4-3-2-1**) con un bip por
  número, y "¡YA!" al terminar. El servidor guarda la pregunta pendiente en
  `pendingFaceoffIndex` (solo servidor) y la despliega con `setupFaceoff`
  cuando el `tick` agota la fecha límite.

### Sonido (cliente, Web Audio API, sin archivos de audio)
- **Música de fondo 8-bit** en loop (melodía con onda cuadrada + bajo),
  **bajita (nivel 2 de 5, ganancia 0.05)**, que arranca con el primer toque
  del usuario (autoplay) y se puede apagar con el botón 🔊/🔇 de la barra
  superior (se guarda en `localStorage`).
- **Efectos (nivel 5 de 5, ganancia 0.9, bien fuertes):** acierto (ding
  ascendente), cruz/X (**zumbido grave tipo buzzer del show**), fanfarria del
  ganador, bip de la cuenta atrás 3-2-1, bip agudo de "¡a jugar!", traqueteo
  de dados, alerta de robo, jingle de fin de ronda, **aplausos al ganar la
  ronda** (ruido de público, ~2 s) y fanfarria de fin de juego. El cliente
  los dispara al detectar el cambio de estado (nueva cruz, nueva respuesta
  revelada, cambio de fase); nunca decide puntos ni transiciones.

### Forma del estado (JSON)
```json
{
  "code": "ABCD",
  "phase": "lobby|ready|faceoff|faceoffReveal|dice|board|steal|roundEnd|roundCountdown|fastMoney|fastMoneyReveal|gameOver",
  "ready": {"p1": true},
  "players": [{"id": "p1", "name": "Tato", "score": 0, "wildcards": 0},
              {"id": "p2", "name": "Ledya", "score": 0, "wildcards": 0}],
  "round": 1, "multiplier": 1,
  "question": {"id": "q12", "text": "Mencionen algo que...",
    "answers": [{"text": null, "points": null, "revealed": false}]},
  "faceoff": {"answers": {"p1": "X", "p2": null}, "dice": null,
    "winner": "p1", "points": {"p1": 32, "p2": 28}, "retries": 0},
  "control": "p1",
  "strikes": 0,
  "bank": 0,
  "winner": null,
  "fastMoney": {"player": "p1", "questions": [{"id": "f3", "text": "..."}],
    "answers": [null, null, null, null, null]}
}
```
**Seguridad del tablero:** el servidor NUNCA envía el texto ni los puntos
de las respuestas no reveladas (`text:null, points:null` hasta revelarlas).
Los alias tampoco se envían al cliente.

### Dados
El servidor genera los dos dados con aleatoriedad criptográfica y los envía
en el estado; los clientes animan la tirada y aterrizan en esos valores. Si
empatan, el servidor vuelve a tirar automáticamente tras una pausa corta.

### Temporizadores
El servidor guarda la fecha límite de cada fase con tiempo (cara a cara 20 s,
revelación del ganador 5 s, intento del tablero 20 s, Dinero Rápido 1 minuto por jugador). El cliente muestra
la cuenta regresiva; si se agota sin respuesta, el cliente envía la
respuesta nula / paso correspondiente. El servidor ignora respuestas que
lleguen fuera de plazo.

## 5. Visual (REQUISITO: llamativo, como el set de TV)

- Fondo de escenario oscuro (azul profundo / morado) con **marco de luces
  animadas** (bombillas tipo marquesina persiguiéndose) alrededor del tablero.
- Tablero con paneles grandes que se **revelan con animación** (giro/deslizamiento),
  texto dorado/amarillo sobre azul oscuro, insignias de puntos.
- Logo **"100 MEXICANOS DIJERON"** en letras grandes doradas/rojas con brillo,
  arriba del tablero.
- Cruces (X) **grandes en rojo** que entran con animación de golpe y sacudida.
- **Dados animados** que giran y aterrizan en el valor del servidor.
- **Marcador luminoso** con números grandes dorados.
- Colores vivos del show (azul profundo, dorado, rojo, blanco), confeti al ganar.
- Móvil primero: botones grandes, tablero que cabe en la pantalla del teléfono
  en vertical. Fuentes: Google Fonts (Archivo Black / Montserrat) con
  respaldo a fuentes del sistema si no hay conexión.
- Al abrirlo debe sentirse como estar en el set del programa.

## 6. Archivos del repo

```
/index.html, /app.js, /style.css, /config.js   (frontend, GitHub Pages)
/questions.json                                (banco, referencia; el Worker lo importa)
/tests-client/smoke.test.cjs                   (prueba de humo del cliente con DOM mínimo)
/worker/wrangler.toml, /worker/package.json
/worker/src/index.ts                           (Worker + RoomDO)
/worker/src/questions.json                     (copia que importa el Worker)
/.github/workflows/deploy-worker.yml          (despliegue del Worker por push)
/README.md                                     (reglas, cómo jugar, despliegue)
```
