import crypto from "node:crypto";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createRoomCode(length = 6) {
  let output = "";

  for (let index = 0; index < length; index += 1) {
    const randomByte = crypto.randomBytes(1)[0];
    output += ROOM_CODE_ALPHABET[randomByte % ROOM_CODE_ALPHABET.length];
  }

  return output;
}

export function makePointerColor(userId) {
  const hash = crypto.createHash("md5").update(userId).digest("hex");
  const hue = parseInt(hash.slice(0, 2), 16) % 360;
  return `hsl(${hue} 80% 58%)`;
}
