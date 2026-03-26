// Client → Server message types
export const C_CREATE_ROOM = "C_CREATE_ROOM";
export const C_JOIN_ROOM = "C_JOIN_ROOM";
export const C_PICK_FIGHTERS = "C_PICK_FIGHTERS";
export const C_DECK_ORDER = "C_DECK_ORDER";
export const C_ADVANCE_BATTLE = "C_ADVANCE_BATTLE";
export const C_ELF_PICK = "C_ELF_PICK";
export const C_CONSTRUCTION_CHOICE = "C_CONSTRUCTION_CHOICE";
export const C_CONFIRM_END = "C_CONFIRM_END";
export const C_CONFIRM_INSERT_DISPLAY = "C_CONFIRM_INSERT_DISPLAY";

// Server → Client message types
export const S_ROOM_CREATED = "S_ROOM_CREATED";
export const S_ROOM_JOINED = "S_ROOM_JOINED";
export const S_OPPONENT_JOINED = "S_OPPONENT_JOINED";
export const S_OPPONENT_DISCONNECTED = "S_OPPONENT_DISCONNECTED";
export const S_OPPONENT_RECONNECTED = "S_OPPONENT_RECONNECTED";
export const S_PICKS_LOCKED = "S_PICKS_LOCKED";
export const S_GAME_START = "S_GAME_START";
export const S_BATTLE_RESULT = "S_BATTLE_RESULT";
export const S_WAITING = "S_WAITING";
export const S_ELF_PICK_NEEDED = "S_ELF_PICK_NEEDED";
export const S_CONSTRUCTION_START = "S_CONSTRUCTION_START";
export const S_CONSTRUCTION_DONE = "S_CONSTRUCTION_DONE";
export const S_GAME_OVER = "S_GAME_OVER";
export const S_STATE_SYNC = "S_STATE_SYNC";
export const S_ERROR = "S_ERROR";

export function makeMsg(type, payload = {}) {
  return JSON.stringify({ type, ...payload });
}

export function parseMsg(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && obj.type ? obj : null;
  } catch {
    return null;
  }
}
