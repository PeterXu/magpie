// Pure: pick the first codec (from a priority chain) that BOTH sides support.
// Used by the client (offerer) to narrow the offer's video m-line to a single
// codec — the encoder follows the OFFER's m-line order, so selection must happen
// on the offerer. Returns null when no chain element is mutually supported
// (caller then leaves preferences at the browser default).
const DEFAULT_CHAIN = ["av1", "vp9", "vp8", "h264"];

export function pickCodec(magpieCodecs, clientCodecs, chain = DEFAULT_CHAIN) {
  const toSet = (xs) => new Set((xs || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  const m = toSet(magpieCodecs);
  const c = toSet(clientCodecs);
  for (const name of chain) {
    const n = String(name).trim().toLowerCase();
    if (n && m.has(n) && c.has(n)) return n;
  }
  return null;
}
