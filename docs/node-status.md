# 节点状态页设计(node-status)

新增 `/memory/nodes` 页面:展示 host 上**所有** dsh-memory 进程的运行时状态——身份、装载状态(预热 team)、3 类节点(recall / extract / review)的运行状态。解决「同时运行多个 LLM 主对话时,无法知道每个进程的节点在做什么、装载了什么」的观测盲区。

## 背景与目标

现状:状态页(`/memory/status`)只展示**本进程**的 team 状态与累计用量;`/lmemory usage` 同样只反映本进程。多个 dsh 会话(多个进程)并跑时,某进程的召回卡住、抽取报错、team 未预热都只能在那个进程自己的面板/日志里看,没有一处总览。

目标:一个页面看全部进程的:

- **身份**:pid、启动时间、cwd、web 端口(web 模式)、是否本进程。
- **装载状态**:每个 project root 的预热 team(节点数 + 文本体积)、system prompt 摘要体积;未预热的进程一眼可见。
- **3 类节点运行状态**:空闲 / 运行中(并发计数 + 起始时刻)、累计调用次数、最近一次调用的时间 / 耗时 / 成败(含错误消息)。

## 用户故事

1. 作为用户,同时开着多个 dsh web 会话时,我想在一个面板看到每个进程的 3 类节点正在做什么(空闲/运行中)与装载了哪些 team,以便快速定位哪个会话的召回/抽取卡住或报错。
2. 作为用户,我想看到每个进程每类节点最近一次调用的时间、耗时与成败(含错误消息),以判断记忆链路是否健康。
3. 作为用户,崩溃残留的进程不应一直显示为「在线」,应明确标为已退出,并在足够久后自动清理,不误导也不堆积。

## 机制:进程状态文件(host 级,文件即协议)

沿用 storage 设计已确立的**文件式跨进程通道**(registry.json / usage.jsonl 同款心智:每进程只写自己的文件,读取端做聚合)。插件是 Cordis 插件、进程内无对等 RPC,不引入新 IPC 依赖。

- **目录**:`~/.dsh/lmemory/runtime/`(用户 lmemory 根内,随用户根一起备份)。
- **每进程一个文件**:`<pid>-<startedAtMs>.json`(pid + 启动时刻双键,pid 复用不撞),**原子写**(临时文件 + rename)。
- **写入时机**:
  1. 进程启动立即写一次(面板可即刻看到自己);
  2. 每次节点调用状态变化(开始 / 结束)立即写;
  3. **心跳每 15s** 写一次(顺带刷新 team 装载快照;team 预热/释放的变化最多延迟一个心跳周期可见);
  4. 进程 dispose 时删除自己的文件。
- **失效判定**:`lastSeenAt` 距今 > 60s 判「已退出」(stale,置灰展示);> 24h 的文件在读取端清理(只可能是死进程残留——活进程心跳 15s 一次)。
- **竞态安全**:多进程各自写各自文件,互不覆盖;读取端只做列目录 + 解析,坏文件跳过。

### 状态文件 schema(formatVersion = 1)

```json
{
  "formatVersion": 1,
  "pid": 12345,
  "startedAt": 1755234567890,
  "cwd": "/Users/luojin/git/git-my-code/deepseek-harness",
  "port": 3080,
  "lastSeenAt": 1755234599999,
  "teams": [{ "root": "", "nodes": 3, "chars": 12345 }],
  "summaryChars": 2345,
  "nodes": {
    "recall": { "running": 1, "runningSince": 1755234598000, "calls": 5, "lastAt": 1755234597000, "lastDurationMs": 812, "lastOk": true },
    "extract": { "running": 0, "calls": 2, "lastAt": 1755234400000, "lastDurationMs": 3400, "lastOk": false, "lastError": "timeout" },
    "review": { "running": 0, "calls": 0, "lastAt": 0, "lastDurationMs": 0, "lastOk": true }
  }
}
```

- `runningSince` 仅在 `running > 0` 时存在(最早一个在飞调用的起始时刻)。
- `calls` 取自本进程 usage 累计(单一真相源,不重复计数)。
- `lastAt = 0` 表示该类节点从未调用过。

## 信息结构(页面)

- **顶部**:标题 + 手动刷新按钮;**5s 自动轮询**(运行状态是活数据;其他页面一次拉取,本页是唯一轮询页)。
- **进程卡片列表**,排序:**本进程置顶并高亮**(「本进程」徽标)→ 在线进程按启动时间倒序 → 已退出沉底置灰(「已退出」徽标)。
- 每张卡片三段:
  1. **身份带**:`pid` · `port`(web 模式)· 启动于(绝对时间,title 属性)· cwd(等宽、溢出省略号)。
  2. **装载带**:每 root 一行(`root` 路径 + `N nodes` + 文本体积);无预热显示「未预热 (no warm team)」;另起一行摘要体积(`system prompt 摘要: X chars`)。
  3. **节点带**:3 行(recall / extract / review),每行 = 状态点(灰=空闲 / 蓝=运行中)+ 运行中指示(「运行中 ×2 · 12s」)+ 累计 calls + 最近一次(「3m ago · 812ms」;失败时红色错误文本替代耗时)。
- **空态**:理论上不出现(打开面板的进程自己就会发布);仍按既有 empty 风格兜底。

## 端点

```
POST /memory-api/nodes-get  { acToken }  →  { processes: [ ProcessRow ] }
```

`ProcessRow` = 状态文件内容 + 读取端派生两字段:`stale`(心跳失效)、`isCurrent`(pid 匹配)。排序在 host 端完成(本进程 → 在线 → 已退出)。

## 验收标准(AC)

- **单进程**:打开面板即见本进程卡片(「本进程」徽标),装载带与 `/lmemory status` 一致,节点带 calls 与 `/lmemory usage` 一致。
- **节点状态**:触发 recall 模型调用时,该行变为「运行中」;结束后恢复空闲并记录耗时;注入失败后 lastError 可见(页面红色文本)。
- **多进程**:两个 dsh 进程同时运行,任一面板可见两张在线卡片,pid / cwd 各自正确。
- **失效判定**:手工写一个 `lastSeenAt` 距今 90s 的状态文件 → 页面显示「已退出」且文件保留;写一个 > 24h 的 → 读取后文件被清理、不显示。
- **安全**:`/memory/nodes` 无 token 访问 403;`nodes-get` 无/错 token 返回 bad-request(复用既有 token 门 + 信任栅栏,不新增暴露面)。
- **视觉**:与既有页面同设计令牌,无自由配色;chromium / firefox / webkit 三引擎 xbrowser 通过(零 console 错误)。

## 非目标

- 不做进程间互操作:不停/不重启其他进程的 team,只读展示(操作仍去对应进程自己的面板)。
- 不做节点调用历史明细(每类只保留最近一次;历史用量在 usage.jsonl,见状态页图表)。
- 不加 CLI 子命令(`/lmemory nodes`),本页是面板专属。
- 不透视 dsh 主对话的流式细节(那属于主会话观测,不在记忆插件边界内)。
