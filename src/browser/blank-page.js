// Blank page HTML with magpie watermark, shown when all tabs are closed
// or a new tab is opened. Pure CSS gradient + text, no external assets.
export const BLANK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>about:blank</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    .container {
      text-align: center;
      opacity: 0.6;
    }
    .logo {
      font-size: 48px;
      font-weight: 300;
      color: #00d9ff;
      letter-spacing: 8px;
      margin-bottom: 20px;
      text-transform: lowercase;
    }
    .hint {
      font-size: 14px;
      color: #8892b0;
      letter-spacing: 1px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">magpie</div>
    <div class="hint">navigate to a URL to start browsing</div>
  </div>
</body>
</html>`;