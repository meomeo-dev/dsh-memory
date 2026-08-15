# Web 面板设计(web-panel)

记忆 Web 面板:web 模式下给用户一个图形界面看记忆、改配置。两个页面 + 一个 RPC 通道,全部注册在 dsh-memory 包内,不依赖 dsh monorepo 改动。

## 形态与入口

| 项 | 值 |
|---|---|
| 页面 | `/memory`(记忆页)、`/memory/settings`(设置页) |
| 静态资源 | `/memory-assets/*`(panel.js / style.css,前缀路由) |
| RPC | `/memory-api` channel(entries / config-get / config-set 三个端点) |
| 打开方式 | ① `/lmemory ui` 命令返回可点击链接(主入口);② 启动时经 harness logger 打印一行(web 模式下是否可见取决于 logger 接线) |

URL 恒带 `ac_token`(每次进程启动用 crypto 随机重新生成,64 位 hex);token 不写盘、不跨进程复用。

## 安全模型(三层,全部复用或对齐 dsh 既有防线)

1. **token 门(自建,但只做「存在性」)**:GET 页面、静态资源、RPC 载荷三层都校验 `ac_token`(常量时间比较)。防的是 DNS rebinding 下的导航读取(浏览器对顶级导航与 iframe 不带 Origin,信任栅栏无法区分)与同机其他进程越权。
2. **信任栅栏(dsh 官方)**:RPC channel 经 `connection.rpc.handle(channel, handler, { authority: 'loopback' })` 注册,每个请求自动过 `isTrustedApiRequest`——浏览器请求必须同源、非浏览器客户端必须来自 loopback。LAN 部署(`host: 0.0.0.0`)下本面板对 LAN 也不开放。
3. **XSS 钉死**:HTML 壳带 CSP `default-src 'none'` + 同源 script/style/img/font/connect;React 渲染只用文本节点(无 `dangerouslySetInnerHTML`),记忆内容永不进 HTML 执行路径;bootstrap JSON 注入前把 `<` 转义为 `\u003c`(破坏 `</script>` 终止符的只有 `<`)。

面板读的就是 agent 经工具本来能读的同一份记忆文件,不扩权;变更面只有 `config-set`(settings scope 校验,与 `/lmemory config set` 同一条路径)。

## 路由与 RPC

```
GET  /memory?ac_token=<t>          → 记忆页 HTML 壳(403 当 token 缺失/不匹配)
GET  /memory/settings?ac_token=<t> → 设置页 HTML 壳(同上)
GET  /memory-assets/<file>?ac_token=<t> → 静态资源(白名单后缀 .js/.css/.map/.svg/.png/.woff2,
                                     单段文件名、拒绝 .. 与分隔符,防路径穿越)
POST /memory-api/entries    { acToken, cwd?, filters?: { type?, domain?, layer?, query? } }
                            → { entries: [{ entry(含 createdAt), file }] },按 createdAt 降序
POST /memory-api/config-get { acToken } → { config: [{ key, meta, value }] }(13 键,按 CONFIG_KEYS 顺序)
POST /memory-api/config-set { acToken, patch } → 经 settings scope 校验并 applyConfig,返回写后 config
```

RPC 信封与 dsh 主 `/api` 相同:`{type:"client-request",rpcId,method,payload}` / `{type:"server-response",rpcId,result:{ok,value}}`;错误码只用 `bad-request`(载荷/token 非法)与 `internal`(依赖抛错)。

面板只读 user/global 层记忆(浏览器没有项目 cwd;`cwd` 载荷字段保留给未来扩展)。Timeline 依赖的 `createdAt` 由 schema v2 提供(v1 旧数据由迁移 0002 按文件名日期回填,见 data-contract.md)。

## 页面

- **记忆页**:顶部筛选组件(全文搜索 entry/scope/domain + type/domain/layer 下拉 + 计数),正文区 Timeline / Table 两种布局切换。Timeline 按创建日期分组(降序),卡片含 type/domain/layer 徽标、条目文本、scope/file/entryPoint/references 溯源;Table 平铺全部 10 列。
- **设置页**:13 个配置键的表单,按 kind 出控件(number / boolean / enum / string / textarea),统一「保存」提交 config-set,成功/失败横幅反馈。键集合与展示元数据在 `src/web-ui/ui.ts` 的 `PANEL_CONFIG_META`(测试锁定与 `CONFIG_KEYS` 不漂移)。

## 代码组织与构建

```
src/web-ui/ui.ts           host 侧纯逻辑(不 import cordis):token、URL、HTML 壳、资源防穿越、RPC 分发
src/web-ui/panel/          React 18 面板应用(vite 构建,React 打进单文件、零 CDN)
src/web-ui/panel/src/      api.ts(线协议客户端)/ App.tsx(两页)/ main.tsx / styles.css
src/index.ts               接线:registerPanel(webServer + connection 存在时注册)+ /lmemory ui
```

- 样式令牌按值镜像 dsh 设计系统(`@deepseek-ai/dsh-client-ui-theme` 的 `--dsw-static-*` / `--dsw-alias-*` light 主题与 `base.css` 字体栈/缓动曲线);面板是独立页不加载 dsh SPA 样式表,镜像以注释标明来源,漂移只影响视觉。
- 构建:`pnpm build` = gen:schema → tsc → `panel:build`(vite,产物落包根 `panel/dist/`,随 npm files 发布)。`prepare` 与 `build` 同链(含 `panel:build`)——git/github 形式安装依赖 prepare 产出 panel 产物;`panel:build` 的 `emptyOutDir` 负责清理旧产物。
- host 侧 `findPanelDist()` 在「lib 运行」与「源码运行」两处相对位置上探测产物目录,均不存在时跳过面板注册并告警(`run pnpm panel:build`)。
- 面板构建产物不进 git(`.gitignore` 排除),但必须进 npm tarball——`.npmignore` 置空覆盖该排除。

## 非目标

- 不做记忆内容编辑/删除(面板只读浏览;写记忆仍走模型工具与 /lmemory 命令)。
- 不做 stats/usage 面板(已有 `/lmemory stats` / `/lmemory usage` 命令)。
- 不做 LAN 访问(loopback only);不集成进 dsh SPA 布局(独立页,路径 B)。
