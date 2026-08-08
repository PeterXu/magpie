// Build Playwright Chromium launch options. In Docker (MAGPIE_NO_SANDBOX=1)
// Chromium must run without the setuid sandbox and use /tmp instead of /dev/shm
// (avoids the default 64MB container /dev/shm crash). Single source for both
// launch sites (index.js shared browser + BrowserSession self-launch).
export function chromiumLaunchOptions() {
  const args = [];
  if (process.env.MAGPIE_NO_SANDBOX === "1") {
    args.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage");
  }
  return { headless: true, args };
}
