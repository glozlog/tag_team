# Tag Team — Online Multiplayer Refactor

## Project Context
This is a 2-player board card game (Chinese text UI) being refactored from local shared-terminal play to online multiplayer via WebSocket.

## Critical Rule
**The fighter/battle mechanism must NOT be modified.** All game logic functions (parsing, settlement, HP rules, character-specific mechanics) must be extracted verbatim into `shared/game-logic.js` — moved, not changed. Zero logic edits allowed.

## Architecture
- `shared/game-logic.js` — Pure game logic extracted from app.js (lines 1–2815). Server-side authoritative. No DOM, no network.
- `shared/protocol.js` — WebSocket message type constants.
- `server.mjs` — HTTP static server + WebSocket + room management + game orchestration. Imports game-logic.js. Single source of truth.
- `app.js` — Client: rendering + input + WebSocket communication. No direct game logic calls.
- `index.html` / `styles.css` — Updated with lobby, waiting indicators, per-player views.

## Key Sync Points (server gates on both players before proceeding)
1. Fighter selection — both pick independently, server validates no duplicates
2. Deck order — both order independently
3. Battle turn — server executes `battleTurn()`, broadcasts result
4. Elf spirit pick — only owner picks, opponent waits
5. Construction entry — automatic server transition
6. Construction choice — both choose independently, server waits for both

## Information Hiding (online only)
- Setup: each player sees only own picks/ordering
- Construction: each player sees only own drawn cards and deck
- Deck toggle: only shows own decks, never opponent's
- Elf pick UI: only shown to owner

## Refactoring Progress
See `PLAN.md` for step-by-step checklist with current progress.

## Serialization Gotcha
Card objects have `getEffects()` and `getOnInsertEffects()` methods. These must live server-side in memory — only send display data (text, fighterName, cardNo) to clients. Never serialize card methods over WebSocket.
