# SessionRegistry Domain 分组设计

> 2026-08-20。修复登录状态管理列表中同一网站出现多条的问题（如 baidu.com + www.baidu.com）。

## 1. 问题

`SessionRegistry.list()` 按 cookie 的完整 domain 字符串分组。Chromium cookie 有两种形态：

| 形态 | domain 字段 | 语义 |
|------|------------|------|
| Domain cookie | `.baidu.com`（带前导点） | 网站声明**跨所有子域共享**（登录态共享） |
| Host-only cookie | `www.baidu.com`（不带点） | 仅在该主机生效 |

同一网站的两种 cookie 形态被拆成两条记录。而"子域是否同一登录态"各网站不同：baidu 的子域共享登录，有些网站子域是独立账号体系——不能一律按主域合并。

## 2. 分组算法（Cookie 语义归并）

利用 cookie 自身形态判断，无需 public suffix list：

1. **Domain cookie（`.baidu.com`）** → 去掉前导点作为**组键**（`baidu.com`）。存在 domain cookie 即代表网站声明子域共享登录态。
2. **Host-only cookie（`www.baidu.com`）**：
   - 若存在组键 K 使 `cookie.domain` 以 `.` + K 结尾（即 `www.baidu.com`.endsWith(`.baidu.com`)）→ 归入组 K，并记录到该组的 `subDomains`；
   - 否则 → 独立成组（该网站无共享声明，子域各自独立）。

效果：
- baidu.com 场景：`.baidu.com` domain cookie + `www.baidu.com` host-only cookie → 合并为一组 `baidu.com`，subDomains 含 `www.baidu.com`。
- 子域独立的站点（所有 cookie 均 host-only）→ 各子域独立成组，不误合并。

边界：一个 host-only domain 理论上可能匹配多个组键（如 `a.example.co` 同时匹配 `example.co` 组）——按组键最长匹配归入；实际场景罕见。

## 3. list() 返回结构

```javascript
[
  {
    domain: 'baidu.com',           // 组键
    cookieCount: 12,               // 整组 cookie 总数
    subDomains: ['www.baidu.com']  // 归并入组的 host-only 域名；无则空数组
  }
]
```

## 4. delete() 整组删除

分组阶段在 `list()` 内部建立 **组键 → 组内 cookie 实际 domain 值集合** 的映射（如 `baidu.com` → `{.baidu.com, www.baidu.com}`，保留 domain cookie 的前导点原样）。`delete(domain)` 流程：

1. 重新读取 cookies 并按相同分组算法重建映射（不复用可能过期的 list 缓存）；
2. 取出该组键的 domain 值集合，对每个**实际原始值** d 调用 `clearCookies({ domain: d })`——用原始值而非组键，避免 `.baidu.com`（带点）与组键 `baidu.com`（无点）因 clearCookies 的 domain 匹配语义不确定而漏删；
3. 不使用子串匹配思路（传 `baidu.com` 会连带误删 `notbaidu.com`）；
4. 若组键不存在（已无 cookie），直接返回，不报错。

## 5. UI 显示

列表项在 stats 行展示子域信息：

```
baidu.com                              [验证] [删除]
12 cookies · 含子域: www.baidu.com

github.com                             [验证] [删除]
5 cookies
```

subDomains 为空时不显示"含子域"部分。`client.html` 的 `renderSessions()` 相应调整。

## 6. 测试

| 测试 | 断言 |
|------|------|
| domain cookie + 同站 host-only cookie | 合并为一组，subDomains 记录子域 |
| 仅 host-only cookie 的不同子域 | 各自独立成组 |
| delete 组键 | 组键与所有 subDomains 的 cookie 均被清除 |
| delete 不误删 | 相似后缀的无关域名（如 `notbaidu.com`）cookie 保留 |
| 无 cookie | 返回空数组（现有行为不变） |

## 7. 影响范围

| 文件 | 变更 |
|------|------|
| `src/session/SessionRegistry.js` | `list()` 分组算法、返回结构；`delete()` 整组收集删除 |
| `src/public/client.html` | `renderSessions()` 显示 subDomains |
| `test/session/SessionRegistry.test.js` | 新增分组/整组删除/不误删测试 |
