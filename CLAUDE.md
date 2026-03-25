# CLAUDE.md

## Project Overview
Two-player online board game with fighter-based battle mechanics. The game involves complex combat systems where fighters interact through layered rules, conditions, and state transitions. The project is functional — current work focuses on debugging detail functionalities, polishing, and fixing edge cases.

## Architecture
- **Frontend:** Single-page app in `app.js` (2287 lines). Uses a `createApp()` closure pattern — all state and DOM refs live inside one function scope. Renders via direct DOM manipulation (no framework). Imports only display-related helpers from `shared/game-logic.js`.
- **Backend:** `server.mjs` (921 lines). Node.js HTTP static file server + WebSocket server. Server is authoritative — it runs all game logic, manages rooms, and broadcasts state to clients. Imports the full game engine from `shared/game-logic.js`.
- **Game Engine / Logic:** `shared/game-logic.js` (2832 lines). Pure game logic — fighter parsing, card effect parsing/settlement, battle resolution, construction phase, HP/damage rules. No DOM, no network code. Exported functions are consumed by both server (full engine) and client (display helpers only).
- **Networking:** WebSocket via the `ws` npm package. Protocol defined in `shared/protocol.js` (39 lines) with `C_*` (client→server) and `S_*` (server→client) message constants. Messages are JSON strings with a `type` field. Client reconnects automatically with exponential backoff.
- **Folder Structure:**

```
tag_team/
├── index.html              # Single-page HTML (lobby + game layout)
├── app.js                  # Client: rendering, input, WebSocket comm
├── styles.css              # All styles (lobby, game, waiting, dialogs)
├── server.mjs              # Server: HTTP + WebSocket + room mgmt + game orchestration
├── shared/
│   ├── game-logic.js       # Pure game engine (fighters, cards, battle, construction)
│   └── protocol.js         # WebSocket message type constants + makeMsg/parseMsg
├── headshots/              # Fighter portrait images (PNG)
├── 战士库.txt               # Fighter definitions (parsed at server startup)
├── 卡牌词条.txt             # Card text data
├── 规则.txt                 # Game rules text (served to client)
├── 结算过程与示例.txt        # Settlement examples
├── package.json            # Node.js config (sole dependency: ws)
├── PLAN.md                 # Refactoring progress checklist
└── CLAUDE.md               # This file
```

## Tech Stack
- Language: JavaScript (ES modules, no TypeScript)
- Frameworks: None — vanilla JS, no build step, no bundler
- Runtime: Node.js (server), browser (client)
- Key Libraries: `ws` (WebSocket server, sole npm dependency)

## Commands
- **Dev server:** `node server.mjs` (serves on port 2603, open `http://localhost:2603`)
- **Build:** None — no build step, raw JS served directly
- **Test:** No automated test suite. Manual testing via two browser tabs
- **Lint:** None configured

## ⚠️ CRITICAL: Battle & Fighter Logic Rules

**The fighter system and battle mechanisms are extremely complicated.** Many functions are deeply interconnected with non-obvious dependencies. Before touching ANY existing logic:

1. **Trace all references first.** Before modifying a function related to fighters, battles, damage, status effects, turns, or any combat mechanic — grep/search for every place that function is called, referenced, or relied upon. Understand the full dependency chain.

2. **Do not refactor battle logic for "cleanliness."** If it works, don't restructure it. Refactors in this area have a high risk of introducing subtle bugs that only surface in specific fighter matchups or edge cases.

3. **Prefer additive changes over modifications.** When fixing a bug or enhancing performance in battle logic, try to:
   - Add a new helper function rather than changing an existing one
   - Use wrappers or overrides rather than editing core battle functions
   - Only modify in place when the change is surgical and isolated

4. **Keep token usage efficient.** Don't dump entire files to "understand context." Instead:
   - Use grep/search to find specific references
   - Read only the relevant functions, not whole files
   - Ask targeted questions rather than scanning everything

5. **When in doubt, ask before changing.** If a battle-related function has more than 3 call sites, flag it and ask before modifying.

## Coding Conventions
- Naming patterns: camelCase for functions/variables. Constants are UPPER_SNAKE_CASE (e.g. `PHASE`, `C_CREATE_ROOM`). Fighter/card data uses Chinese text keys matching the source `.txt` files.
- File organization: Section headers use `// ─── Section Name ───` comment banners. Client code lives in a single `createApp()` closure. Server handlers are organized by message type.
- State management: Server holds authoritative `gameState` per room. Client receives serialized state snapshots via `S_STATE_SYNC` and renders from them. Client uses `requestAnimationFrame`-batched `scheduleRender()` to coalesce updates.
- Error handling: Minimal — server sends `S_ERROR` messages for invalid client actions. No try/catch in game logic. HTTP 404 on missing files. WebSocket errors trigger reconnect.

## Key Decisions & Context
- **Server-authoritative model:** All game logic runs on the server. Clients are thin renderers that send actions and receive state snapshots. This prevents cheating and ensures consistency.
- **Card methods are not serialized:** Card objects have `getEffects()` and `getOnInsertEffects()` methods. Only display data (text, fighterName, cardNo) is sent over WebSocket. Card methods live server-side in memory only.
- **Room lifecycle:** Rooms persist for 10 minutes after a player disconnects (for reconnection). Room state includes full game state, picks, deck orders, and log. Rooms are destroyed after timeout or when game ends.
- **State sync strategy:** Server sends `S_STATE_SYNC` with per-player serialized state (opponent hidden info stripped) after every game action. Client replaces its entire state and re-renders.
- **Chinese text data files:** Fighter definitions (`战士库.txt`), card text (`卡牌词条.txt`), rules (`规则.txt`) are plain-text files with custom formatting, parsed at server startup. Encoding handled via GB18030→UTF-8 fallback.
- **No build tooling:** Deliberate choice — the project uses native ES modules (`"type": "module"` in package.json) with `<script type="module">` in the browser. No bundler, transpiler, or minifier.

## Don'ts
- **Don't** refactor battle/fighter logic unless explicitly asked
- **Don't** rename or restructure combat-related functions — other parts of the system depend on exact signatures
- **Don't** assume a function is unused just because it looks dead — fighters may invoke things conditionally at runtime
- **Don't** batch multiple battle logic changes together — do them one at a time so breakage is traceable

## Session Resume Instructions
When starting a new session:
1. Read this file first
2. Read `plan.md`
3. Read the latest entries in the **Session Log** below
4. Pick up from the next incomplete task in `plan.md`
5. After completing each task, update:
   - `plan.md` — check off task, update current status & changelog
   - This file — add a Session Log entry below

---

## Session Log

> Record every session here. Include timestamp, what was worked on, what changed, and any context the next session needs.

| Timestamp | Task / Area | Changes Made | Files Touched | Notes for Next Session |
|-----------|-------------|--------------|---------------|----------------------|
| | | | | |

### How to Log
- Add a row **after every completed task**, not just at end of session
- **Timestamp:** Use `YYYY-MM-DD HH:MM` format
- **Task / Area:** Which plan.md task or what area of the code
- **Changes Made:** 1-2 sentence summary of what was done
- **Files Touched:** List modified files so the next session can review diffs
- **Notes for Next Session:** Anything the next session needs to know — gotchas found, things left half-done, decisions made

### On Rate Limit / Session End
Before ending (or if you sense a rate limit coming):
1. Update the Session Log with everything done so far
2. Update `plan.md` current status
3. Note any in-progress work that isn't committed yet
