// GSM 03.38 basic character set plus the extension table. Anything outside this
// forces the message to UCS-2, halving the per-segment character budget, which
// is how a "160 character" message silently becomes two segments.

const BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

// Extension characters cost two septets each.
const EXTENDED = '^{}\\[~]|€';

const BASIC_SET = new Set(BASIC);
const EXTENDED_SET = new Set(EXTENDED);

export function isGsm7(text) {
  for (const ch of text) {
    if (!BASIC_SET.has(ch) && !EXTENDED_SET.has(ch)) return false;
  }
  return true;
}

/** Characters outside GSM-7, deduplicated, in order of first appearance. */
export function nonGsm7Chars(text) {
  const bad = [];
  const seen = new Set();
  for (const ch of text) {
    if (BASIC_SET.has(ch) || EXTENDED_SET.has(ch)) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    bad.push(ch);
  }
  return bad;
}

/** Septet count. Extension characters cost two. Non-GSM text returns null. */
export function septetLength(text) {
  let n = 0;
  for (const ch of text) {
    if (EXTENDED_SET.has(ch)) n += 2;
    else if (BASIC_SET.has(ch)) n += 1;
    else return null;
  }
  return n;
}

/** Segments this body would occupy over the wire. */
export function segmentCount(text) {
  const septets = septetLength(text);
  if (septets === null) {
    const units = [...text].reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
    return units <= 70 ? 1 : Math.ceil(units / 67);
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}
