// Splits an Asana task name into the room / location and the work order.
// Asana names were typed freely ("203 leak", "259- toilet needs fixed",
// "Fix sink 232", "Dining Room - A/C running"), so this tries, in order:
//   1. a room number at the start:   "203 leak"          -> 203 | leak
//   2. a short place before a dash:  "Dining Room - A/C" -> Dining Room | A/C
//   3. a room number anywhere:       "Fix sink 232"      -> 232 | Fix sink 232
//   4. otherwise:                    "Keys"              -> General | Keys
// When the room comes from inside the name (3), the whole name is kept as the
// work order, so nothing typed in Asana is lost. Room history also matches
// these through search, which reads the whole name.

export const FALLBACK_ROOM = "General";

// A room "number": 1–4 digits, optionally with up to two letters in front and
// one after (203, D5, B6, 12A, AL204).
const ROOM = "[A-Za-z]{0,2}\\d{1,4}[A-Za-z]?";
const DASH = "[-–—:]";
// "Unit 210", "Room 210", "Apt 210", "#210" all mean room 210, so room history
// counts them together.
const PREFIX = "(?:(?:unit|room|rm\\.?|apt\\.?|apartment|suite|ste\\.?)\\s*#?\\s*|#\\s*)?";

export function splitRoom(name: string): { room: string; title: string; how: number } {
  const full = (name || "").replace(/\s+/g, " ").trim();
  if (!full) return { room: FALLBACK_ROOM, title: "", how: 4 };

  // 1. "203 leak", "259- toilet", "D5 - Urgent! Pilot light", "127"
  const start = full.match(new RegExp("^" + PREFIX + "(" + ROOM + ")(,?)(?:\\s*" + DASH + "+\\s*|\\s+|$)(.*)$", "i"));
  if (start) {
    const rest = start[3].trim();
    // "226, 203 - check TV boxes" or "213 and 209 no hot water": several rooms,
    // so keep the whole name as the work order.
    const several = /^(,|&|and\b|\/)/i.test(rest) || start[2] === ",";
    return several
      ? { room: start[1].toUpperCase(), title: full, how: 3 }
      : { room: start[1].toUpperCase(), title: rest, how: 1 };
  }

  // 2. "Dining Room - A/C running still": one or two words before a spaced dash.
  const place = full.match(/^([^-–—:]{2,20}?)\s+[-–—]\s+(.+)$/);
  if (place) {
    const left = place[1].trim();
    if (left.split(" ").length <= 2 && !/urgent|asap|please/i.test(left)) {
      return { room: left, title: place[2].trim(), how: 2 };
    }
  }

  // 3. "Fix sink 232", "Mailbox Keys 207": a 3–4 digit number somewhere.
  const inside = full.match(/(?:^|[\s(#])([A-Za-z]?\d{3,4}[A-Za-z]?)(?=$|[\s,.)!?-])/);
  if (inside) return { room: inside[1].toUpperCase(), title: full, how: 3 };

  return { room: FALLBACK_ROOM, title: full, how: 4 };
}
