# magpie — TURN/STUN 中继设计

- 日期:2026-08-08
- 状态:已确认设计,待编写实现计划
- 分支:`feat/docker`

## 1. 目标

为 magpie 的 Docker 部署增加 coturn(STUN + TURN)中继服务,使 Docker 容器与外部浏览器之间的 WebRTC **媒体**能穿越 Docker 网络边界(尤其 macOS Docker Desktop)。信令(TCP 8080,已 `ports` 映射)本来就通;本设计解决"页面能打开但 `<video>` 黑屏"的媒体不通问题。

## 2. 背景 / 为什么

- 当前 `docker-compose.yml` 用 bridge + `ports: 8080`:信令通,但 streamer 页(容器内 headless Chromium)收集的 ICE host candidate 是容器内 `172.x`,Mac 浏览器在 VM 外路由不到 → 媒体握手失败 → 黑屏。
- Chromium 的浏览器 WebRTC **无法**注入"对外声明 host-ip"(无 API/flag),所以纯 P2P 在 Docker Desktop 上做不到。
- 解法:加 **TURN 中继**,媒体经已知固定的 `host-ip:3478` 中继;同时配 **STUN**,让 WebRTC 在多种部署下自动选最优路径。

## 3. 架构

coturn 作为 compose 兄弟服务,与 magpie 同默认网络,`3478` 同时提供 STUN binding 与 TURN allocate。magpie 把 `iceServers`(STUN + TURN)分别下发给两端:

- **streamer 页(容器内)**:addr 用服务名 `coturn` → `stun:coturn:3478` / `turn:coturn:3478`。
- **客户端(浏览器)**:addr 用 `MAGPIE_HOST_IP` → `stun:<host-ip>:3478` / `turn:<host-ip>:3478`,经 `/signaling` 的 `hello` 消息下发。

`iceTransportPolicy = "all"`(默认),WebRTC 自动选择:host 直连优先(Linux host 网络),Docker 下落到 relay(TURN)。两个 TURN 凭证一致。

## 4. 组件

### 4.1 coturn 服务

- `docker/turnserver.conf`:long-term 凭证(`lt-cred-mech` + `user`),`realm=magpie`,`listening-port=3478`,`relay-min-port=49160` / `relay-max-port=49200`,`no-tls/no-dtls/no-cli`(v1 走 UDP/TCP)。
- `docker-compose.yml` 新增 `coturn` 服务,`depends_on` 无强约束;端口映射:`3478:3478`(tcp)、`3478:3478/udp`、`49160-49200:49160-49200/udp`。
- 账号密码与 magpie 共享同一组 env(默认值 `magpie`/`magpie`,可覆盖)。

### 4.2 env 配置

- `MAGPIE_HOST_IP`(**启动 docker 时必传**):客户端可达的宿主地址(Mac 本机浏览器可用 `localhost` 或 Mac LAN IP;Linux 部署填宿主/外网 IP)。
- `MAGPIE_TURN_USER` / `MAGPIE_TURN_PASS`:TURN 凭证,默认 `magpie`/`magpie`,coturn 与 magpie 共用。

### 4.3 代码改动

- `src/index.js`:从 env 构造两套 `iceServers`——服务端侧(addr=`coturn`)与客户端侧(addr=`MAGPIE_HOST_IP`),含 STUN + TURN + 凭证;注入 server 与 StreamerPeer。
- `src/server.js`:`hello` 消息增加 `iceServers`(客户端侧)。
- `src/streamer/StreamerPeer.js`:`relayOffer`/`start` 接收服务端侧 `iceServers` 并经 `page.evaluate` 传给页面。
- `src/streamer/streamer.html`:`relayOffer` 用 `new RTCPeerConnection({ iceServers })`。
- `src/public/client.html`:用 `hello` 下发的 `iceServers` 建 `RTCPeerConnection`(`iceTransportPolicy: "all"`)。`iceServers` 缺省时退化为无 iceServers(纯 host candidate,保留 `npm start` 本机直连可用)。

### 4.4 README

新增 TURN 小节:启动示例 `MAGPIE_HOST_IP=localhost docker compose up`;说明 host-ip 取值、凭证 env、relay 端口段、生产可换时限凭证。

## 5. 数据流

- **信令**:client → `/signaling`(`offer`→`relayOffer`→`answer`)——不变。
- **媒体**:两端 `RTCPeerConnection` 用 `iceServers`(STUN + TURN)。Linux host 网络下 ICE 选 host 直连;Docker bridge 下 ICE 选 relay,媒体经 coturn 中继。

## 6. 验证

- coturn 服务起来(健康);magpie 启动并使用 iceServers(日志/行为)。
- 用 `iceTransportPolicy: "relay"` **强制 relay** 跑一遍 `docker/verify-webrtc.mjs` → `VIDEO_OK` 证明媒体确实经 TURN 中继(而非又走容器内 host candidate)。默认 `all` 策略下,Mac 浏览器人工打开应看到画面。

## 7. v1 取舍 / 范围

- 静态 TURN 凭证(生产可换 coturn `use-auth-secret` + magpie 生成 HMAC 时限凭证)。
- STUN 与 TURN 都指向 coturn 同一端口(3478),不依赖公网 STUN。
- `iceTransportPolicy: all`,WebRTC 自动选择。
- 不在范围:TURN 集群 / 负载均衡、`MAGPIE_HOST_IP` 自动探测、TLS(TURNS)。
