// Client → Server message types
export const C_JOIN_ROOM = "C_JOIN_ROOM";
export const C_ICON_SELECT = "C_ICON_SELECT";
export const C_PICK_FIGHTERS = "C_PICK_FIGHTERS";
export const C_DECK_ORDER = "C_DECK_ORDER";
export const C_ADVANCE_BATTLE = "C_ADVANCE_BATTLE";
export const C_ELF_PICK = "C_ELF_PICK";
export const C_CONSTRUCTION_CHOICE = "C_CONSTRUCTION_CHOICE";
export const C_CONFIRM_END = "C_CONFIRM_END";
export const C_CONFIRM_INSERT_DISPLAY = "C_CONFIRM_INSERT_DISPLAY";
export const C_DRAFT_PICK1 = "C_DRAFT_PICK1";       // { pick: string, discard: string }
export const C_DRAFT_PICK2 = "C_DRAFT_PICK2";       // { pick: string }
export const C_SWITCH_TO_FREE = "C_SWITCH_TO_FREE"; // {} — switch room to free-pick mode

// Server → Client message types
export const S_GALLERY_INIT = "S_GALLERY_INIT";
export const S_ICON_PENDING = "S_ICON_PENDING";
export const S_ICON_HINT = "S_ICON_HINT";
export const S_ICON_EXPIRED = "S_ICON_EXPIRED";
export const S_PAIRED = "S_PAIRED";
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
export const S_DRAFT_ASSIGNED = "S_DRAFT_ASSIGNED"; // { myPool: string[] } — sent individually
export const S_DRAFT_REVEAL = "S_DRAFT_REVEAL";     // { opponentPick: string, exchangePool: string[] }
export const S_SWITCH_TO_FREE = "S_SWITCH_TO_FREE"; // {} — room switched to free-pick mode

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
