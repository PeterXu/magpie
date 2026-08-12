// Build WebRTC iceServers (STUN + TURN) for a reachable coturn host. coturn
// serves both STUN binding and TURN allocate on the same port (3478). Returns
// [] when TURN credentials or host are absent (e.g. native run, no relay).
export function buildIceServers({ host, user, pass, port = 3478 }) {
  if (!host || !user || !pass) return [];
  return [
    { urls: `stun:${host}:${port}` },
    { urls: `turn:${host}:${port}`, username: user, credential: pass },
  ];
}
