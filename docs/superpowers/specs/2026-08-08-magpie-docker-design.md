# magpie — Docker 部署设计

- 日期:2026-08-08
- 状态:已通过设计评审,待编写实现计划

## 1. 目标

为 magpie 增加 Docker 部署支持:`docker compose up` 即可在容器内跑起 magpie,外部浏览器客户端能通过 WebRTC 观看并操作远程页面(默认 gitee.com)。范围 = **完整**:Dockerfile + docker-compose.yml + .dockerignore + 必要代码改动 + README。

## 2. 基础镜像选型

**选定:Chromium-only slim build** —— `node:22-bookworm-slim` + `npx playwright install --with-deps chromium`。

理由:magpie 只用 Chromium。已实测 Docker Hub 的 `playwright/chromium` 不可用:Node **v16.18.1**(过旧,`node --test`/`fetch` 不可用)、**无 chromium 二进制**(`/ms-playwright` 为空)、**仅 amd64**(在 Apple Silicon 上走 QEMU 模拟)。slim build 提供原生 arm64、Node 22、仅 Chromium(约 700MB–1GB),`npx playwright install --with-deps` 自动拉取 apt 依赖,稳健。

排除:官方 `mcr.microsoft.com/playwright`(捆绑三浏览器 ~2GB,浪费)、`playwright/chromium`(实测不可用)、distroless(依赖难装)。

## 3. 代码改动(必要)

Docker 有两处必须的代码改动 + 一个共享 helper:

1. **新 `src/browser/launch-options.js`** —— `export function chromiumLaunchOptions()` 返回 `{ headless: true, args }`;当 `process.env.MAGPIE_NO_SANDBOX === "1"` 时追加 `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage`。单一来源,两处 launch 复用,避免重复。
2. **`src/index.js`** —— 共享浏览器改用 `chromium.launch(chromiumLaunchOptions())`;新增 `const HOST = process.env.HOST ?? "0.0.0.0"`,`server.listen(PORT, HOST, r)`。原 `"127.0.0.1"` 绑定在容器外不可达。
3. **`src/browser/BrowserSession.js`** —— 自启动分支改用 `chromiumLaunchOptions()`(一致性;测试不设该 env,本地仍带 sandbox)。

默认 `HOST=0.0.0.0` 对"远程访问服务"合理;`HOST=127.0.0.1` 可恢复本地-only。E2E 用自己的 `server.listen(0,"127.0.0.1")`,不受影响。

## 4. Dockerfile

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force
COPY --chown=node:node src ./src
ENV NODE_ENV=production MAGPIE_NO_SANDBOX=1 HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
```

浏览器装到 `/ms-playwright`(root 所有,全局可读),`node` 用户可执行;无需 chown。

## 5. docker-compose.yml

```yaml
services:
  magpie:
    build: .
    network_mode: host     # WebRTC:ICE host candidate 必须对外部客户端可达
    shm_size: 2gb          # Chromium 稳定性(避免 /dev/shm 崩溃)
    environment:
      - MAGPIE_URL=https://gitee.com
      - MAGPIE_NO_SANDBOX=1
      - HOST=0.0.0.0
      - PORT=8080
    restart: unless-stopped
    healthcheck:
      test: ["CMD","node","-e","fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
```

## 6. WebRTC 网络约束(关键)

bridge 网络下,streamer 页的 ICE host candidate 是容器私有 IP(172.x),外部浏览器客户端不可达 → **视频连不上**。故 compose 用 **`network_mode: host`**(Linux),candidate 即宿主 IP。

注意:
- host 模式下 `ports:` 被忽略,容器直接占用宿主 8080。
- **Docker Desktop(macOS/Windows)不完全支持 host 网络**;跨 VM 的 WebRTC 需 STUN/TURN + `iceServers` 配置(超出 v1;v1 面向 Linux host 网络)。

## 7. .dockerignore

排除:`node_modules/`、`.git/`、`.superpowers/`、`*.log`、`.DS_Store`、`mitmproxy`(指向仓库外的软链,`COPY` 会断)。

## 8. README

新增 Docker 章节:`docker build` / `docker compose up` / 环境变量 / host 网络说明 / Docker Desktop 限制 / 镜像内 playwright 版本须与 `package-lock.json` 同步。

## 9. 测试

- **单元**:`chromiumLaunchOptions` 在 `MAGPIE_NO_SANDBOX` 未设/已设时返回正确的 `args`(纳入 `npm test`)。
- **Docker 本身**:`docker build -t magpie .` + `docker compose up` + `curl http://localhost:8080/healthz` + 浏览器打开客户端验收 —— 作为**人工**验收,不接入 `npm test`(测试环境无 Docker daemon)。代码改动(0.0.0.0 绑定、launch args)由单元测试和现有 E2E 覆盖。

## 10. 不在范围(YAGNI)

STUN/TURN、多架构 buildx、推送到镜像仓库、CI 集成。均可后续补充。
