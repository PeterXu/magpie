// Pure config loader: reads MAGPIE_* env, validates, returns a structured cfg.
// Same family as coords.js / keys.js / ice-servers.js — pure & unit-tested.
// NEVER throws: bad env is clamped/fallback + console.warn, so the crash→restart
// loop can't be bricked by a typo'd env value.
import { buildIceServers } from "./utils/ice-servers.js";

const DEFAULTS = { WIDTH: 1280, HEIGHT: 800, QUALITY: 80, FPS: 10 };
const RANGE = {
  WIDTH:  [320, 3840],
  HEIGHT: [320, 3840],
  QUALITY: [1, 100],
  FPS:    [1, 60],
};

// Page.startScreencast's ONLY rate param is `everyNthFrame`, and it is a frame
// DIVISOR ("send every Nth composited frame") — NOT a ms interval and NOT a true
// rate cap. We intentionally do NOT set it (CDP then defaults to 1 = emit every
// repaint): any N>1 delays the FIRST frame and starves static / low-repaint
// pages, which need N repaints before emitting anything (probed: a fully static
// page yields 1 frame at everyNthFrame=1 but 0 at everyNthFrame=2 or 10).
// magpie serves arbitrary, often-static pages, so N must stay 1. The real
// output-fps cap is canvas.captureStream(fps) on the streamer page: CDP pushes
// one JPEG per repaint, and captureStream samples the canvas at fps. (The old
// code passed `every: round(1000/fps)` — a non-existent param CDP silently
// ignored, so capture ran uncapped at the ~98fps compositor rate anyway.)
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

export function buildStreamerUrl(base, indexHtml, c) {
  const w = c.webrtc;
  const parts = [
    `w=${c.viewport.width}`,
    `h=${c.viewport.height}`,
    `fps=${w.streamFps}`,
  ];
  if (w.maxBitrate) parts.push(`bitrate=${w.maxBitrate}`);
  if (w.maxFramerate) parts.push(`maxFps=${w.maxFramerate}`);
  if (w.degradation) parts.push(`degradation=${w.degradation}`);
  return `${base}/${indexHtml}?${parts.join("&")}`;
}

export function loadConfig(env = process.env) {
  const width  = clampInt(env.MAGPIE_WIDTH,  DEFAULTS.WIDTH,  RANGE.WIDTH,  "MAGPIE_WIDTH");
  const height = clampInt(env.MAGPIE_HEIGHT, DEFAULTS.HEIGHT, RANGE.HEIGHT, "MAGPIE_HEIGHT");
  const quality = clampInt(env.MAGPIE_QUALITY, DEFAULTS.QUALITY, RANGE.QUALITY, "MAGPIE_QUALITY");
  const fps = clampInt(env.MAGPIE_FPS, DEFAULTS.FPS, RANGE.FPS, "MAGPIE_FPS");

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

  const baseCfg = {
    viewport: { width, height },
    screencast: { quality },
    webrtc: {
      streamFps: fps,
      maxBitrate,
      maxFramerate,
      degradation
    },
    DEFAULT_URL: env.MAGPIE_URL ?? "about:blank",
    IDLE_TIMEOUT_MINUTES: Number(env.MAGPIE_IDLE_TIMEOUT ?? 30),
    // Empty string disables persistent mode (fresh in-memory profile per start).
    USER_DATA_DIR: env.MAGPIE_USER_DATA_DIR || null,
    // "0" opts out of background-tab freezing (non-active tabs keep running).
    FREEZE_BACKGROUND: env.MAGPIE_FREEZE_BACKGROUND !== "0",
  };

  const netCfg = {
    PORT: Number(env.PORT ?? 8080),
    HOST: env.HOST ?? "0.0.0.0",
    HOST_IP: env.MAGPIE_HOST_IP ?? "",
    TURN_USER: env.MAGPIE_TURN_USER ?? "magpie",
    TURN_PASS: env.MAGPIE_TURN_PASS ?? "magpie",
    TURN_HOST: env.MAGPIE_TURN_HOST ?? "iceturn" // Container name for Docker, or custom TURN host
  };

  const authCfg = {
    ADMIN_USER: env.MAGPIE_ADMIN_USER || "admin",
    ADMIN_PASSWORD: env.MAGPIE_ADMIN_PASSWORD || "",
    JWT_SECRET: env.MAGPIE_JWT_SECRET || "",
    JWT_EXPIRES_IN: parseInt(env.MAGPIE_JWT_EXPIRES_IN || "86400", 10)
  };

  return {
    // base config
    ...baseCfg,
    buildStreamerUrl: (indexHtml) => {
      const base = `http://127.0.0.1:${netCfg.PORT}`;
      return buildStreamerUrl(base, indexHtml, baseCfg);
    },

    // net config
    net: netCfg,
    serverIceServers: () => {
      return netCfg.HOST_IP ? buildIceServers({
        host: netCfg.TURN_HOST, user: netCfg.TURN_USER, pass: netCfg.TURN_PASS
      }) : [];
    },
    clientIceServers: () => {
      return buildIceServers({ host: netCfg.HOST_IP, user: netCfg.TURN_USER, pass: netCfg.TURN_PASS });
    },

    // auth config
    auth: authCfg
  };
}
