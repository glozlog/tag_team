# Claude AI Training Driver — Tag Team

This document tells Claude everything it needs to know to drive the AI training project for Tag Team. Read this before touching any training code.

---

## What You Are Doing

Training a reinforcement learning agent that can play Tag Team against a human. The agent must learn:
1. How to pick fighters and set initial deck order (SETUP phase)
2. How to make construction choices — which card to insert, where in the deck, and how to order the bottom two cards (CONSTRUCTION phase)
3. How to pick elf spirits when a spirit gets KO'd (rare, character-specific)

**The battle phase requires no decisions.** Both players flip cards simultaneously and effects resolve automatically. All meaningful strategy lives in SETUP and CONSTRUCTION phases.

---

## Game Mechanics Summary (What the Agent Must Understand)

### Phases
| Phase | Description | Agent Decisions |
|-------|-------------|-----------------|
| SETUP | Pick 2 fighters, set deck order | Fighter selection, which card goes on top |
| BATTLE | Cards flip simultaneously, effects auto-resolve | None (just advance) |
| CONSTRUCTION | Triggered when both battle decks run out; reconstruction from unused cards | Insert 1 card into deck + position + bottom-2 order |
| GAME_OVER | Terminal | None |

### State Space (What the Agent Sees)
Per player (×2 players):
- 2 fighters, each with: HP, maxHp, power, koLine, character-specific counters (revelation, battleship, snake, rage, flame, ning, guard, plan, elf spirit states)
- battleDeck: ordered list of remaining cards (card identity, flipped status)
- resolvedPile: cards already played (ordered)
- constructionDeck: remaining unplayed cards (count + identities)

Global:
- phase (SETUP / BATTLE / CONSTRUCTION / GAME_OVER)
- turn number, round number
- pendingElfPickByPlayer
- pendingDoubleQueue (golem rebirth)
- winner (terminal only)

### Action Space
**SETUP phase:**
- Fighter selection from available pool (varies by mode: free-pick or draft)
- Deck order: which fighter's card goes on top of battle deck

**CONSTRUCTION phase (main learning target):**
- Which of 3 drawn cards to insert
- Where in the battle deck to insert it (position 0 through len)
- Order of the bottom 2 cards (swap or keep)

**ELF phase (rare):**
- Which of up to 3 spirits to activate (index 0/1/2)

### Win Condition
- Opponent's fighters reach HP ≤ koLine → you win
- Both KO'd simultaneously → draw
- Flame counter reaches 5 on a fighter → automatic KO

### Key Randomness Sources
1. Constructor deck shuffle at game start
2. 靡菲斯特's initial snake state (50/50)
3. 米莱狄's plan selection (random from available pool)

All other resolution is fully deterministic given the deck order.

---

## Codebase Interface Points

The agent will interact with the game through these surfaces:

### Server WebSocket Protocol (`shared/protocol.js`)
```
Client → Server:
  C_PICK_FIGHTERS      — select fighters in free-pick mode
  C_DRAFT_PICK1        — draft mode pick 1
  C_DRAFT_PICK2        — draft mode pick 2
  C_DECK_ORDER         — set which card goes on top
  C_ADVANCE_BATTLE     — both players must send this to flip cards
  C_CONSTRUCTION_CHOICE — {cardIndex, insertAt, bottomOrder}
  C_ELF_PICK           — {spiritIndex}

Server → Client:
  S_STATE_SYNC         — full serialized game state (per-player view)
  S_ERROR              — invalid action
  S_GAME_OVER          — terminal signal with winner
```

### Game Engine (`shared/game-logic.js`)
- `createInitialState(p1Fighters, p2Fighters)` — line ~434: construct game state
- `settleEffects(state, p1Card, p2Card)` — line ~1248: resolve one battle turn
- `applyDeltas(state, settlement)` — line ~2457: apply HP/power changes
- `enterConstructionIfNeeded(state)` — line ~2770: trigger construction phase
- `applyConstructionChoice(state, playerId, choice)` — line ~2846: apply a construction decision
- `checkWinner(state)` — line ~2756: determine if game over

### Server Turn Handler (`server.mjs`)
- `serverBattleTurn(room)` — line ~454: full turn execution
- `handleMessage(ws, data)` — line ~739: dispatch client messages
- Construction handler — line ~754: `C_CONSTRUCTION_CHOICE` processing

---

## Hardware Requirements

### Minimum (Self-play training, CPU only)
- CPU: 8+ cores (parallel game simulation)
- RAM: 16 GB
- Storage: 20 GB (checkpoints, replay buffers)
- Node.js 18+ (to run the game server)
- Python 3.10+ (for training infrastructure)

### Recommended (Faster convergence)
- GPU: NVIDIA RTX 3060 or better (for policy/value network inference and training)
- RAM: 32 GB
- Storage: 100 GB SSD
- CUDA 11.8+ / cuDNN 8+

### Cloud Option
- AWS `p3.2xlarge` (V100) or `g4dn.xlarge` (T4) — sufficient for this game's complexity
- The game state is small (~200 floats) so GPU is not strictly required but speeds up batch training

---

## Software Stack

### Python Environment
```
python >= 3.10
torch >= 2.0          # policy/value network
numpy >= 1.24
gymnasium             # RL environment interface
stable-baselines3     # optional: off-the-shelf RL algorithms
tensorboard           # training visualization
websockets            # Python WebSocket client to talk to game server
```

### Node.js (Game Server)
```
node >= 18
ws (already in package.json)
```

---

## Key Constraints and Gotchas

1. **Fighter logic is extremely complex.** Do not rewrite or simplify `game-logic.js`. Wrap it — do not touch it.

2. **The server is authoritative.** The agent must send valid WebSocket messages; it cannot directly mutate game state.

3. **Card effects are not serialized.** `getEffects()` and `getOnInsertEffects()` methods live in server memory only. The agent sees card text strings in state, not parsed effect trees.

4. **State sync is per-player.** The server strips opponent hidden info before sending `S_STATE_SYNC`. The agent's view is intentionally incomplete (opponent's deck order is hidden).

5. **Construction choices have high branching factor.** With 3 cards × N insertion positions × 2 bottom orders, the action space in construction phase can be large. Use action masking.

6. **Some fighters have character-specific state** (revelation, rage, snake, elf spirits, plan). The state encoder must handle all of these even if most are zero for a given matchup.

7. **Golem rebirth** causes a double-settlement turn. The agent does not need to decide anything, but the state transition is non-standard and must be handled in the environment wrapper.

---

## Running the Game Server

```bash
cd /Users/justgloz/Documents/tag_team
node server.mjs
# Server starts on http://localhost:2603
```

For headless AI training, the server can run without a browser. The agent connects via WebSocket to `ws://localhost:2603`.

---

## Files to Read Before Coding

| File | Why |
|------|-----|
| `shared/game-logic.js` lines 348–461 | State initialization — understand all state fields |
| `shared/game-logic.js` lines 2789–2844 | Construction phase mechanics — main agent decision loop |
| `shared/game-logic.js` lines 2756–2768 | Win detection |
| `shared/protocol.js` | All message types |
| `server.mjs` lines 454–589 | How a full battle turn executes |
| `server.mjs` lines 739–758 | Message dispatch table |
| `战士库.txt` | Fighter definitions (Chinese) — understand what fighters exist |

---

## What Not to Do

- Do not modify `game-logic.js` for "cleanliness" or to expose internals — wrap, don't touch
- Do not hardcode fighter names in English — the system uses Chinese text keys internally
- Do not assume the agent can peek at opponent's deck order — that is hidden information
- Do not skip reading `CLAUDE.md` in the root — it contains critical project constraints
