/**
 * UTF-16-safe truncation helpers.
 *
 * JS strings are UTF-16 code unit sequences; `String.prototype.slice(0, n)`
 * can split a surrogate pair (e.g. an emoji or a CJK extension-B character)
 * when `n` lands between its halves. The orphan surrogate survives JSON
 * serialization as a `\ud83d`-style escape and renders as U+FFFD (�) in
 * clients. `truncateUtf16` backs the cut off by one code unit so a pair is
 * never split.
 */

/** Truncates `text` to at most `maxCodeUnits` UTF-16 code units without
 * splitting a surrogate pair. `maxCodeUnits <= 0` yields the empty string. */
export function truncateUtf16(text: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0) {
    return "";
  }
  if (text.length <= maxCodeUnits) {
    return text;
  }
  const high = text.charCodeAt(maxCodeUnits - 1);
  const low = text.charCodeAt(maxCodeUnits);
  const splitPair =
    high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return text.slice(0, splitPair ? maxCodeUnits - 1 : maxCodeUnits);
}