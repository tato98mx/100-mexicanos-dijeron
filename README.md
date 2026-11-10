# 100 Mexicanos Dijeron — Juego en línea 1v1

Juego en línea de **100 Mexicanos Dijeron** para jugar **Tato vs Ledya**,
cada uno desde su teléfono, en tiempo real. Lo más parecido posible al
programa de TV: tablero con luces, cruces, dados, marcador luminoso y
Dinero Rápido.

- **Juego (cuando esté publicado):** `https://tato98mx.github.io/100-mexicanos-dijeron/`
- **Repositorio:** `https://github.com/tato98mx/100-mexicanos-dijeron`
- **Backend:** Cloudflare Worker `cien-mexicanos-dijeron` + Durable Object
  (SQLite), plan gratuito.

> ⚠️ **Estado:** el código está terminado y verificado en local, pero el
> repositorio aún no existe en GitHub (la app de Muse no tiene permiso para
> crear repositorios) y el Worker aún no está desplegado. Ver
> [Pasos pendientes](#pasos-pendientes) abajo.

## Cómo se juega

1. Uno de los dos abre el juego, escribe su nombre y pulsa **Crear sala**.
   El juego muestra un **código de 4 letras** (por ejemplo `KLHB`).
2. El otro abre el juego, escribe su nombre, pone el código y pulsa
   **Unirse**.
3. En cuanto entran los dos, la partida empieza sola. No hay que instalar
   nada: funciona en el navegador del teléfono.
4. Al terminar, pueden jugar la **revancha** en la misma sala.

También hay un **modo demo** para ver el aspecto sin servidor:
`https://tato98mx.github.io/100-mexicanos-dijeron/?demo=1` (11 pantallas
de ejemplo para recorrer).

## Reglas implementadas

Formato estándar del programa (Family Feud / 100 Mexicanos Dijeron),
adaptado al 1v1 y a las decisiones de Tato:

- **4 rondas de tablero** con multiplicadores: ronda 1 ×1, ronda 2 ×1,
  ronda 3 ×2 (doble), ronda 4 ×3 (triple). Gana quien tenga más puntos al
  final de la ronda 4. Si empatan, hay **muerte súbita**: un solo cara a
  cara decide al ganador.
- **Cara a cara:** la computadora presenta la pregunta y los dos contestan
  **al mismo tiempo, sin ver la respuesta del otro**. Gana el control del
  tablero quien dé la respuesta **mejor rankeada** (más puntos de encuesta).
  - Si **nadie** acierta, el cara a cara se repite con la misma pregunta.
  - Si dan **la misma respuesta**, se decide con **dados animados**: cada
    uno tira un dado, gana el número mayor; si empatan, se vuelve a tirar.
- **Ronda del tablero:** el jugador con el control adivina respuestas una
  por una. Cada acierto **revela la respuesta y suma sus puntos** al banco
  (con el multiplicador de la ronda). Cada fallo es una **cruz (X)**.
  - Con **3 cruces**, el otro jugador tiene **una oportunidad de robar**:
    si da una respuesta no revelada que está en el tablero, se lleva
    **todos los puntos de la ronda**; si no, el jugador que tenía el control
    se queda con el banco.
  - Si se revelan todas las respuestas del tablero, el jugador con el
    control se lleva el banco.
- **Dinero Rápido (al final, como en la tele):** **solo juega el ganador
  del juego**. Contesta sus **5 preguntas en 20 segundos**. No es por
  dinero ni decide el partido: si logra **100 puntos o más**, se gana una
  **carta comodín para la siguiente partida**.
- **Carta comodín:** se guarda por jugador y se conserva en la revancha.
  En el tablero aparece el botón **🃏 Usar comodín**. Su poder está
  pendiente de que Tato elija entre dos opciones:
  - **perdonar una cruz** (valor actual por defecto), o
  - **revelar una respuesta del tablero**.
  - El efecto es un parámetro en un solo lugar: `WILDCARD_EFFECT` en
    `app.js` (frontend) y en `worker/src/game.ts` (backend). Cambiarlo ahí
    basta.

## Preguntas: cada partida es diferente

- Banco de **90 preguntas** en español mexicano, estilo encuesta a 100
  mexicanos (`questions.json`): **60 de ronda + 30 de Dinero Rápido**.
  Cada pregunta tiene **6 respuestas** con puntos que **suman 100**.
- El servidor elige las preguntas **al azar por partida, sin repetir
  ninguna dentro de la misma partida**.
- Para no repetir las de partidas recientes, el juego **guarda los IDs de
  las preguntas usadas** (en el navegador, las últimas 3 partidas) y los
  envía al crear la sala; el servidor los excluye al elegir. Si el banco
  se agotara, la rotación se reinicia sola.
- La revancha usa preguntas nuevas y conserva los comodines.

## Tecnología (todo gratis)

| Pieza | Servicio | Plan |
|---|---|---|
| Frontend (HTML/CSS/JS) | GitHub Pages | Gratis |
| Multijugador en tiempo real | Cloudflare Workers + Durable Objects (SQLite, WebSockets) | Plan gratuito (100,000 peticiones/día; Durable Objects con SQLite incluidos) |
| Despliegue del Worker | GitHub Actions (`cloudflare/wrangler-action`) | Gratis |

El servidor es **autoritativo**: es el único que conoce las respuestas
correctas y nunca envía al cliente el texto ni los puntos de una respuesta
no revelada, así que nadie puede hacer trampa mirando el tráfico.

## Estructura del proyecto

```
index.html                  Frontend (pantalla del juego)
app.js                      Lógica del cliente (WebSocket, pantallas, demo)
style.css                   Set de TV: luces, paneles dorados, cruces, dados
config.js                   URL del Worker (ver Pasos pendientes)
questions.json              Banco de preguntas (60 rondas + 30 Dinero Rápido)
SPEC.md                     Especificación completa (reglas, protocolo, estado)
worker/
  wrangler.toml             Worker "cien-mexicanos-dijeron" + Durable Object RoomDO
  src/index.ts              Worker: /api/room, WebSocket, Durable Object
  src/game.ts               Lógica pura del juego (testeable sin Cloudflare)
  src/questions.json        Copia del banco para el Worker
  tests/logic.test.mjs      32 tests de la lógica (node:test)
  tests/e2e-local.mjs       Prueba de 2 jugadores contra wrangler dev --local
.github/workflows/
  deploy-worker.yml         Despliega el Worker al hacer push a main
```

## Pasos pendientes

### 1. Crear el repositorio (lo hace Tato)

La app de Muse en GitHub **no tiene permiso para crear repositorios**, así
que este paso es manual:

1. Entra a <https://github.com/new>.
2. **Repository name:** `100-mexicanos-dijeron`.
3. **Public** (público).
4. No marques ninguna casilla de README, .gitignore ni licencia (el código
   ya las trae).
5. Pulsa **Create repository**.
6. **Añade el repo a la app de Muse en GitHub** para que Milly pueda subir
   los archivos: en GitHub, foto de perfil → **Settings** →
   **Applications** → **Installed GitHub Apps** → **Muse** → **Configure**
   → **Repository access** → **Only select repositories** → selecciona
   `100-mexicanos-dijeron` → **Save**.

Después de esto, Milly sube todos los archivos del proyecto al repo.

### 2. Activar GitHub Pages (lo hace Tato)

En el repositorio: **Settings → Pages → Build and deployment → Source:
Deploy from a branch → Branch: `main`, carpeta `/(root)` → Save**.
El juego quedará en
`https://tato98mx.github.io/100-mexicanos-dijeron/`.

### 3. Agregar los secrets de Cloudflare (lo hace Tato)

El despliegue del Worker es automático por GitHub Actions, pero necesita
dos secrets en el repositorio
(**Settings → Secrets and variables → Actions → New repository secret**):

| Secret | Valor |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token de API de Cloudflare con permiso **Edit Cloudflare Workers** (se crea en <https://dash.cloudflare.com/profile/api-tokens> → Create Token → plantilla "Edit Cloudflare Workers" o un token personalizado con ese permiso). |
| `CLOUDFLARE_ACCOUNT_ID` | ID de la cuenta de Cloudflare (se ve en el panel de Cloudflare, abajo a la derecha). |

Sin esos dos secrets, el workflow `Deploy Worker` falla. No se guardan
tokens en ningún archivo del repo.

### 4. Conectar el frontend con el Worker (lo hace Milly)

Cuando el Worker esté desplegado, Milly pone su URL en `config.js`:

```js
window.GAME_API_URL = "https://cien-mexicanos-dijeron.<tu-subdominio>.workers.dev";
```

y hace push. A partir de ahí, crear sala y unirse ya funcionan en vivo.

### 5. Probar los dos (Tato y Ledya)

Abrir el enlace en los dos teléfonos, crear la sala en uno, unirse con el
código en el otro y jugar una partida completa.

## Verificación realizada (en local, 2026-11-10)

- **Banco de preguntas:** 60 rondas + 30 Dinero Rápido, 540 respuestas;
  todas las preguntas suman 100 puntos; IDs únicos; sin duplicados.
- **Tests de lógica:** 32/32 en verde (`cd worker && npm test`) y
  typecheck limpio (`npm run typecheck`).
- **Partida completa de 2 jugadores contra el Worker local**
  (`worker/tests/e2e-local.mjs`): sin fallos. Se jugaron las 4 rondas
  (cara a cara repetido por nadie acertar, desempate con dados, 3 cruces y
  robo, bancos ×1/×1/×2/×3), Dinero Rápido solo del ganador (170 puntos →
  comodín ganado), fin del juego y revancha con preguntas nuevas y comodín
  conservado. Los dos clientes recibieron el mismo estado en todo momento
  y el servidor no filtró ninguna respuesta no revelada.
- **Pendiente de verificar en vivo** (cuando el repo y el Worker existan):
  que la página publicada cargue y una partida real entre los dos
  teléfonos.
