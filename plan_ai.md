# AI Agent Training Plan — Tag Team

Step-by-step plan for training an RL agent to play Tag Team. Follow phases in order — each phase must be stable before moving to the next.

---

## Phase 0 — Environment Audit & Baseline Understanding

**Goal:** Know exactly what information the agent can observe and act on before writing any training code.

- [ ] 0.1 Map all fighter names from `战士库.txt` and list their special mechanics (revelation, snake, rage, elf, plan, etc.)
- [ ] 0.2 Document every field of `S_STATE_SYNC` payload the agent receives — write it out explicitly
- [ ] 0.3 Enumerate all possible construction choices for a typical game turn (how many cards drawn, how many positions in a typical deck, bottom order = 2 options)
- [ ] 0.4 Enumerate elf pick options per character
- [ ] 0.5 Identify which fields in state are hidden from the agent (opponent's deck order, opponent's construction deck contents)
- [ ] 0.6 Write a game trace by hand: start a game in two browser tabs, record every state sync and action for one complete game, save as `training/traces/manual_game_001.json`

**Deliverable:** `training/docs/state_spec.md` — complete specification of the observable state and action space.

---

## Phase 1 — Headless Game Environment

**Goal:** Run complete games programmatically, with no browser, driven by Python.

### 1.1 — Python WebSocket Client
- [ ] Create `training/env/game_client.py` — a Python class that:
  - Connects to `ws://localhost:2603`
  - Sends/receives JSON messages using the protocol in `shared/protocol.js`
  - Parses `S_STATE_SYNC` into a structured Python dict
  - Exposes `send_action(action_type, payload)` and `await_state()` methods

### 1.2 — Dual-Client Match Runner
- [ ] Create `training/env/match_runner.py` — runs one full game between two agents:
  - Spawns two `GameClient` instances (player 1 and player 2)
  - Drives both through SETUP → BATTLE → CONSTRUCTION → GAME_OVER
  - Handles the alternating turn structure (both must send `C_ADVANCE_BATTLE`)
  - Returns outcome: `{winner: "p1"|"p2"|"draw", turns: int, log: [...]}`

### 1.3 — Random Agent Baseline
- [ ] Create `training/agents/random_agent.py` — picks uniformly random valid actions:
  - Random fighter selection
  - Random deck order
  - Random construction choice (random card, random insert position, random bottom order)
  - Random elf pick

### 1.4 — Environment Validation
- [ ] Run 1000 random-vs-random games, collect stats:
  - Win rate p1/p2/draw
  - Average game length (turns)
  - Average construction phases per game
  - Verify no crashes or protocol errors
- [ ] Fix any server-side issues surfaced by headless execution

**Deliverable:** `training/env/` package, `training/agents/random_agent.py`, validation script and results in `training/docs/baseline_stats.md`.

---

## Phase 2 — State Encoder

**Goal:** Convert raw game state (Python dict from `S_STATE_SYNC`) into a fixed-size float tensor for neural network input.

### 2.1 — Fighter State Encoding
For each of the 4 fighters (p1_main, p1_support, p2_main, p2_support), encode:
- [ ] HP normalized: `hp / maxHp`
- [ ] HP raw value (some effects trigger at exact values)
- [ ] power normalized: `power / 10`
- [ ] Flame count: one-hot `[0..5]`
- [ ] Guard: binary
- [ ] Fighter identity: one-hot over all fighters in `战士库.txt`
- [ ] Character-specific counters:
  - revelation: `[0..4]` normalized
  - battleship: `[0..20]` normalized
  - snake: binary (0 or 1)
  - rage: `[0..7]` normalized, plus bear-form binary
  - ning tokens (per-opponent): `[0..2]` each
  - elf soul count, active spirit index, each spirit's HP (if elf fighter)
  - plan state: current plan one-hot + drafted plans bitfield (if 米莱狄)

### 2.2 — Deck State Encoding
For each player's battle deck:
- [ ] Remaining deck depth: normalized `len / max_deck_size`
- [ ] Known top card identity (only if agent is looking at own deck): one-hot over card IDs
- [ ] Resolved pile depth: normalized
- [ ] Construction deck depth: normalized
- [ ] Drawn construction cards (visible during construction phase): one-hot × 3 slots

### 2.3 — Game Context Encoding
- [ ] Phase: one-hot `[BATTLE, CONSTRUCTION, ELF_PICK]`
- [ ] Turn number: normalized `turn / 100`
- [ ] Round number: one-hot `[1..5]`

### 2.4 — Opponent Information
- [ ] Opponent fighter states are fully observable (HP, power, counters are public)
- [ ] Opponent deck order is NOT observable — encode only depth
- [ ] Mark opponent-owned fields clearly so the network can learn asymmetric play

### 2.5 — Implementation
- [ ] Create `training/env/state_encoder.py` with `encode_state(state_dict, player_id) -> np.ndarray`
- [ ] Write unit tests: verify shape is always fixed, values are always in `[0, 1]` or one-hot
- [ ] Verify encoder handles all character-specific fields gracefully (zero-fill unused slots)

**Deliverable:** `training/env/state_encoder.py`, documented tensor layout in `training/docs/state_encoding.md`.

---

## Phase 3 — Action Space & Action Masking

**Goal:** Define a discrete action space and compute which actions are legal at each step.

### 3.1 — Action Indexing
Define a flat integer action space covering all phases:

| Phase | Actions | Count |
|-------|---------|-------|
| SETUP fighter pick | index into available fighters × 2 picks | up to ~30 per step |
| SETUP deck order | binary (fighter A or fighter B on top) | 2 |
| CONSTRUCTION card pick | which of 3 drawn cards to insert | 3 |
| CONSTRUCTION insert position | slot 0..N in current battle deck | max ~20 |
| CONSTRUCTION bottom order | keep or swap bottom 2 cards | 2 |
| ELF pick | which spirit (0, 1, or 2) | 3 |
| BATTLE advance | single action (must advance) | 1 |

- [ ] Create `training/env/action_space.py`:
  - `get_legal_actions(state_dict, player_id) -> List[int]`
  - `decode_action(action_int, state_dict, player_id) -> (action_type, payload_dict)`
  - `encode_action(action_type, payload_dict, state_dict, player_id) -> int`

### 3.2 — Action Masking
- [ ] Implement action masking in the policy: zero out logits for illegal actions before softmax
- [ ] Test mask generation against random games — verify no illegal actions are ever taken

**Deliverable:** `training/env/action_space.py` with full encode/decode + mask logic.

---

## Phase 4 — Gymnasium Environment Wrapper

**Goal:** Wrap the game into a standard `gymnasium.Env` interface so any RL library can use it.

- [ ] Create `training/env/tag_team_env.py`:
  ```python
  class TagTeamEnv(gymnasium.Env):
      observation_space: Box(shape=(N,), dtype=float32)
      action_space: Discrete(M)

      def reset() -> (obs, info)
      def step(action) -> (obs, reward, terminated, truncated, info)
      def close()
  ```
- [ ] `reset()`:
  - Start a new game (both players)
  - Return encoded state for the learning agent (player 1 perspective by default)
- [ ] `step(action)`:
  - Decode action, send to server via `GameClient`
  - If opponent's turn: run opponent policy (initially random, later self-play)
  - After both act, receive new state sync
  - Return encoded new state + reward
- [ ] Reward function (start simple, tune later):
  - `+1.0` on win
  - `-1.0` on loss
  - `0.0` on draw
  - `0.0` for all intermediate steps (sparse reward)
- [ ] Add `info` dict with: `{phase, turn, winner, legal_actions}`
- [ ] Wrap with action masking support (pass mask to policy)

**Deliverable:** `training/env/tag_team_env.py`, tested with `gymnasium.utils.env_checker`.

---

## Phase 5 — Neural Network Architecture

**Goal:** Design a policy network suited to the game's structure.

### 5.1 — Architecture Choice
The game has two very different sub-tasks:
1. **Construction phase**: Sequential card selection with combinatorial structure
2. **SETUP phase**: Fighter evaluation and team composition

Recommended: **Actor-Critic with shared backbone**

```
Input (state tensor, ~300 floats)
  ↓
Shared Trunk: MLP [512 → 256 → 256] with LayerNorm + ReLU
  ├── Policy Head: Linear [256 → action_space_size] + masked softmax
  └── Value Head: Linear [256 → 1]
```

- [ ] Create `training/models/policy.py` — PyTorch `nn.Module` implementing above
- [ ] Input size: sum of all encoder dimensions (document in `state_encoding.md`)
- [ ] Action masking: add a `forward(obs, action_mask)` method that zeroes illegal logit values before softmax
- [ ] Verify parameter count is reasonable (~500K parameters for initial training)

### 5.2 — Alternative: Transformer Backbone (optional, later)
- The deck is a sequence — a small transformer over card embeddings may outperform MLP
- Defer until MLP baseline is trained and evaluated

**Deliverable:** `training/models/policy.py`.

---

## Phase 6 — Self-Play Training Infrastructure

**Goal:** Train the agent through self-play using PPO (Proximal Policy Optimization).

### 6.1 — Self-Play Setup
- [ ] Create `training/selfplay/trainer.py`:
  - Maintain a pool of past checkpoints (opponent pool, size ~10)
  - Each game: agent plays against a randomly sampled past checkpoint
  - Periodically replace weakest checkpoint in pool with current policy
- [ ] Self-play prevents overfitting to a fixed opponent

### 6.2 — PPO Training Loop
- [ ] Use `stable-baselines3` PPO with masked actions, OR implement custom PPO if needed
- [ ] Hyperparameters to start with:
  ```
  learning_rate: 3e-4
  n_steps: 2048 (steps per rollout)
  batch_size: 64
  n_epochs: 10
  gamma: 0.99
  gae_lambda: 0.95
  clip_range: 0.2
  ent_coef: 0.01   (exploration bonus)
  ```
- [ ] Training runs for 10M environment steps initially

### 6.3 — Parallelization
- [ ] Run 8–16 parallel environments using `subprocess` + separate Node.js server instances on different ports
- [ ] Use `stable-baselines3` `SubprocVecEnv` or implement custom async game runners

### 6.4 — Logging
- [ ] Log to TensorBoard: win rate vs random agent, win rate vs past self, episode length, value loss, policy loss, entropy
- [ ] Save checkpoints every 100K steps

**Deliverable:** `training/selfplay/trainer.py`, training launch script `training/train.py`.

---

## Phase 7 — Reward Shaping (if sparse reward is insufficient)

**Goal:** Add intermediate rewards to speed up learning if the agent is not progressing after 10M steps.

Only add these if needed — shaped rewards can introduce unintended behaviors:

- [ ] `+0.01` per HP point dealt to opponent main fighter
- [ ] `-0.005` per HP point lost on own main fighter
- [ ] `+0.05` when opponent fighter reaches flame=4 (one step from KO)
- [ ] `+0.02` per construction card inserted that has a known strong effect (heuristic)
- [ ] Normalize all intermediate rewards so terminal reward (`±1.0`) still dominates

**Deliverable:** `training/env/reward.py` with configurable reward modes.

---

## Phase 8 — Evaluation

**Goal:** Measure how good the trained agent actually is.

### 8.1 — Benchmarks
- [ ] Win rate vs random agent (target: >90% after convergence)
- [ ] Win rate vs a simple heuristic agent (see below)
- [ ] Win rate vs previous checkpoint (track Elo-style improvement)

### 8.2 — Heuristic Agent
- [ ] Create `training/agents/heuristic_agent.py`:
  - Construction: prefer cards that have attack effects; insert near top if above-average HP deficit
  - SETUP: prefer fighters with high beginHp + beginPower sum
  - Battle: always advance (forced)
  - This serves as a non-trivial evaluation baseline

### 8.3 — Elo Tracking
- [ ] Run round-robin tournaments between: random, heuristic, checkpoints at 1M / 2M / 5M / 10M steps
- [ ] Plot Elo progression in `training/docs/elo_progress.md`

**Deliverable:** `training/agents/heuristic_agent.py`, `training/eval/run_tournament.py`.

---

## Phase 9 — Human Play Interface

**Goal:** Let a human play against the trained agent through the existing game UI.

- [ ] Create `training/play/ai_player.py`:
  - Loads trained checkpoint
  - Connects as player 2 via WebSocket
  - Responds to `S_STATE_SYNC` with appropriate actions
  - Runs as a background process alongside the existing Node.js server
- [ ] Add a lobby option: "Play vs AI" (human picks in browser, AI joins the same room programmatically)
- [ ] The AI should introduce a small random delay before acting (0.5–1.5s) to feel natural
- [ ] No UI changes needed to the game itself — AI is just another WebSocket client

**Deliverable:** `training/play/ai_player.py`, `training/play/README.md` (how to start an AI game).

---

## Phase 10 — Iteration & Fighter-Specific Tuning

**Goal:** Improve performance on specific fighter matchups.

- [ ] Analyze which fighter matchups the agent loses most on
- [ ] Generate more training data for those matchups by oversampling (use fighter-specific environment seeds)
- [ ] Consider separate policy heads or fine-tuned models for characters with unique mechanics (elf, golem rebirth)
- [ ] Track per-fighter win rates in evaluation logs

---

## Directory Structure

```
training/
├── docs/
│   ├── state_spec.md          # Observable state specification
│   ├── state_encoding.md      # Tensor layout documentation
│   ├── baseline_stats.md      # Random-vs-random game stats
│   └── elo_progress.md        # Elo over training
├── traces/
│   └── manual_game_001.json   # Hand-recorded game trace
├── env/
│   ├── game_client.py         # WebSocket client
│   ├── match_runner.py        # Full game runner
│   ├── state_encoder.py       # State → tensor
│   ├── action_space.py        # Action encoding + masking
│   ├── tag_team_env.py        # Gymnasium environment
│   └── reward.py              # Reward modes
├── models/
│   └── policy.py              # Neural network
├── agents/
│   ├── random_agent.py        # Random baseline
│   └── heuristic_agent.py     # Heuristic baseline
├── selfplay/
│   └── trainer.py             # Self-play loop
├── eval/
│   └── run_tournament.py      # Elo tournament runner
├── play/
│   ├── ai_player.py           # Human vs AI interface
│   └── README.md
├── checkpoints/               # Saved model weights
├── runs/                      # TensorBoard logs
├── train.py                   # Main training entry point
└── requirements.txt
```

---

## Phase Checklist Summary

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Environment audit | [ ] |
| 1 | Headless game environment | [ ] |
| 2 | State encoder | [ ] |
| 3 | Action space + masking | [ ] |
| 4 | Gymnasium wrapper | [ ] |
| 5 | Neural network | [ ] |
| 6 | Self-play training | [ ] |
| 7 | Reward shaping (if needed) | [ ] |
| 8 | Evaluation | [ ] |
| 9 | Human play interface | [ ] |
| 10 | Iteration & tuning | [ ] |

---

## Critical Notes

- **Do not modify `game-logic.js` or `server.mjs`** to make training easier. The server is the source of truth. If you need to expose information, add a debug/observation endpoint rather than changing game logic.
- **Phases 0–4 are blocking.** Do not start training until the environment is validated (random agent completes 1000 games without error).
- **Start with sparse rewards.** Only add reward shaping (Phase 7) if the agent fails to learn with sparse rewards after 5M steps.
- **Track Elo from the start.** It is the clearest signal of whether the agent is improving.
