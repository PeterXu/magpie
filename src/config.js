// Pure config loader: reads MAGPIE_* env, validates, returns a structured cfg.
// Same family as coords.js / keys.js / ice-servers.js — pure & unit-tested.
// NEVER throws: bad env is clamped/fallback + console.warn, so the crash→restart
// loop can't be bricked by a typo'd env value.

const DEFAULTS = { WIDTH: 1280, HEIGHT: 800, QUALITY: 80, FPS: 10 };
const RANGE = {
  WIDTH:  [320, 3840],
  HEIGHT: [320, 3840],
  QUALITY: [1, 100],
  FPS:    [1, 60],
};
const DEGRADATIONS = ["maintain-resolution", "maintain-framerate", "balanced"];
const DEFAULT_DEGRADATION = "maintain-resolution";

// Parse an int env value: non-int/empty -> default; out of range -> clamp. Warns either way.
function clampInt(raw, def, [lo, hi], name) {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) { console.warn(`magpie: ${name}=${raw} not an int, using default ${def}`); return def; }
  if (n < lo) { console.warn(`magpie: ${name}=${n} below ${lo}, clamped`); return lo; }
  if (n > hi) { console.warn(`magpie: ${name}=${n} above ${hi}, clamped`); return hi; }
  return n;
}

// Adaptive bitrate floor for desktop content: ~2.5 bps/pixel, clamped to [1.5M, 8M].
// fps intentionally excluded — the cap is detail-bound (text), not motion-bound.
export function defaultBitrate(width, height) {
  return Math.min(8_000_000, Math.max(1_500_000, Math.round(width * height * 2.5)));
}

// Resolve MAGPIE_MAX_BITRATE to a bps number, or null when explicitly disabled.
//   unset/empty      -> adaptive default (defaultBitrate)
//   none/off         -> null (disabled, no cap)
//   <n>[k|M] <= 0    -> null (disabled)
//   <n>[k|M] > 0     -> that bps
//   non-numeric      -> warn + adaptive default
export function resolveMaxBitrate(raw, width, height) {
  const def = defaultBitrate(width, height);
  if (raw === undefined || raw === null || raw === "") return def;
  const t = String(raw).trim().toLowerCase();
  if (t === "none" || t === "off") return null;
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) { console.warn(`magpie: MAGPIE_MAX_BITRATE=${raw} invalid, using default`); return def; }
  const mul = m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1000 : 1;
  const bps = Math.round(Number(m[1]) * mul);
  return bps <= 0 ? null : bps;
}


export function loadConfig(env = process.env) {
  const width  = clampInt(env.MAGPIE_WIDTH,  DEFAULTS.WIDTH,  RANGE.WIDTH,  "MAGPIE_WIDTH");
  const height = clampInt(env.MAGPIE_HEIGHT, DEFAULTS.HEIGHT, RANGE.HEIGHT, "MAGPIE_HEIGHT");
  const quality = clampInt(env.MAGPIE_QUALITY, DEFAULTS.QUALITY, RANGE.QUALITY, "MAGPIE_QUALITY");
  const fps = clampInt(env.MAGPIE_FPS, DEFAULTS.FPS, RANGE.FPS, "MAGPIE_FPS");
  const every = Math.max(1, Math.round(1000 / fps));

  const maxBitrate = resolveMaxBitrate(env.MAGPIE_MAX_BITRATE, width, height);

  let maxFramerate = null;
  const mfRaw = env.MAGPIE_MAX_FRAMERATE;
  if (mfRaw !== undefined && mfRaw !== null && mfRaw !== "") {
    const n = Number(mfRaw);
    if (Number.isInteger(n) && n > 0) maxFramerate = n;
    else console.warn(`magpie: MAGPIE_MAX_FRAMERATE=${mfRaw} invalid, ignored`);
  }

  let degradation = DEFAULT_DEGRADATION;
  const degRaw = env.MAGPIE_DEGRADATION;
  if (degRaw !== undefined && degRaw !== null && degRaw !== "") {
    if (DEGRADATIONS.includes(degRaw)) degradation = degRaw;
    else console.warn(`magpie: MAGPIE_DEGRADATION=${degRaw} invalid, using default`);
  }

  return {
    viewport: { width, height },
    screencast: { quality, every },
    webrtc: {
      streamFps: fps,
      maxBitrate,
      maxFramerate,
      degradation
    },
  };
}
