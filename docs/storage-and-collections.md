# 存储目录、整体注册表、记忆包导出与 usage 持久化(storage-and-collections)

回答四个存储与用量问题(Q0 目录改名 / Q2 整体注册表 / Q3 记忆包导出 / Q4 usage
持久化)的设计。目录约定部分接续 concept.md 与 data-contract.md,本文是这三项
能力实现的单一依据。

## Q0/Q1 目录改名:`memory/` → `lmemory/`

### 决策

四层记忆目录统一改名为 `lmemory/`:

| 层 | 现路径(写/读) | 旧路径(一次性迁移来源) |
|---|---|---|
| 用户 dsh | `~/.dsh/lmemory/` | `~/.dsh/memory/` |
| 用户 agents | `~/.agents/lmemory/` | `~/.agents/memory/` |
| 项目 dsh | `<repo>/.dsh/lmemory/` | `<repo>/.dsh/memory/` |
| 项目 agents | `<repo>/.agents/lmemory/` | `<repo>/.agents/memory/` |
| 内置(候选) | 包内 `lmemory/` | 包内 `memory/` |

理由:`memory` 作为 `~/.dsh/` 顶级目录名太泛——host 里每个能力占一个顶级目录
(`voice/`、`sessions/`、`storages/`),插件叫 `dsh-memory`、命令叫 `/lmemory`,
数据目录用 `lmemory/` 与两者一致且不与任何他方 `memory` 概念冲突。

`~/.dsh/` 本身即是 dsh 指定的宿主数据目录(DSH_HOME),不存在「<root>/<dsh 数据
目录>/lmemory」再嵌套一层;`<repo>/.dsh/lmemory/` 与内置 `.dsh` 项目约定同构。
settings 命名空间仍叫 `memory`(settings 是注册表键,不是文件路径,保持不变)。

### 旧目录迁移(一次性,幂等,带防御)

- 触发点:`visibleMemoryDirs()` 与 `memoryWriteRoots()`——全部读写路径的发现
  咽喉。两者都先执行 `migrateLegacyMemoryDirs(cwd)`。
- 规则:对每个(父目录, 层),若旧目录存在且新目录不存在 → `renameSync` 旧 → 新。
- **防御**:仅当旧目录「像我们的记忆目录」才迁移——含任一 `*.remember.jsonl` /
  `catalog.json`,或为空目录。内容不符(可能是他方工具的同名目录)则不动,
  logger.warn 提示人工处理。已存在新目录时旧目录原样保留(只读兼容)。
- 效果:存量 `~/.dsh/memory/`、`<repo>/.dsh/memory/` 首次访问时自动搬入新名,
  数据零丢失;此后全链路只认 `lmemory/`。

## Q2 整体注册表:`~/.dsh/lmemory/registry.json`

host 级「有哪些记忆根」的真相源。路径固定:`join(dshHome(), 'lmemory',
'registry.json')`(注册表自己长在用户根里,随用户根一起被备份)。

```json
{
  "formatVersion": 1,
  "updatedAt": 1786000000000,
  "roots": [
    { "root": "/Users/x/.dsh/lmemory", "kind": "user",
      "firstSeenAt": 1786000000000, "lastSeenAt": 1786100000000,
      "entries": 0, "files": 0 },
    { "root": "/Users/x/Downloads/sandbox/.dsh/lmemory", "kind": "project",
      "firstSeenAt": 1786000000000, "lastSeenAt": 1786100000000,
      "entries": 64, "files": 4 }
  ]
}
```

- **发现策略(不做全盘扫描)**:固定根 = 用户 dsh + 用户 agents(存在才登记);
  项目根**惰性注册**——apply 启动时登记当前 cwd 的项目根,每次
  `agent/session-start` 再登记该会话 cwd 的项目根。历史根保留在注册表中:
  刷新时仍存在的重算 `entries`/`files`/`lastSeenAt`,已消失的保持最后已知
  计数(供「曾经的记忆根」展示)。
- **读写**:`src/registry.ts` 纯模块——`loadRegistry`(缺失/损坏 → 空表,不抛)、
  `saveRegistry`(原子:写临时文件后 rename)、`refreshRegistry(cwd?)`(登记 +
  重算计数)、`forgetRoot(root)`。
- **命令面**:`/lmemory collections list`(刷新并渲染表格:root / kind /
  条目数 / 文件数 / lastSeenAt)、`collections add <root>`(手动登记一个根,
  须含记忆文件或为空目录)、`collections forget <root>`(从注册表移除,不动数据)。
- 记忆根计数用只读扫描(`*.remember.jsonl` 经 readJsonlMigrating),与
  computeStats 同源,不引入第二套统计。

## Q3 记忆包导出:`/lmemory collections export`

```sh
/lmemory collections export [--out <dir>] [--root <path>...]
```

- 默认导出注册表里全部根;`--root` 指定子集(路径精确匹配注册表条目)。
- `--out` 缺省 `~/dsh-memory-exports/`;产物目录
  `<out>/dsh-memory-<YYYYMMDD>-<HHmmss>/`:

```
manifest.json                     # formatVersion=1, exportedAt, 各根:root/entries/文件清单
roots/<nn>/<YYYY-MM-DD[.p].<type>.remember.jsonl
roots/<nn>/<YYYY-MM-DD[.p].<type>.remember.md
```

- **合并安全性**:记忆 id 是 crypto 随机全局唯一(`m-` + 10 位 base36),跨根
  永不碰撞;manifest 记录来源根,多包合并展开也不冲突。备份=真相源直拷,
  分享给另一台 host 可直接放进 `<root>/.dsh/lmemory/` 被扫描。
- 纯逻辑模块 `src/collections.ts`:`exportCollections(cwd, options)` 返回
  `{ dir, totalEntries, rootsExported }`。**本轮只做导出**;import(记忆包合并
  回来,按 entry+type 去重)是后续扩展,manifest 的 formatVersion 已预留。
- 导出快照以导出时刻的 jsonl 为准;`timestamp` 由调用方传入(可测)。

## Q4 usage 持久化:`~/.dsh/lmemory/usage.jsonl`

### 追加日志

```jsonl
{"ts":1786100000000,"label":"recall","inputTokens":1200,"outputTokens":300,"cacheReadTokens":0}
{"ts":1786100000000,"label":"extract","inputTokens":800,"outputTokens":150,"cacheReadTokens":0}
```

- **写入点**:`callFlash` 在一次调用结束(成功或失败)时把该调用的 usage 聚合为
  一行 appendFileSync——同一代码路径覆盖 recall/extract/review 三类,进程内计数器
  (实时视图)照旧更新;失败调用同样落盘,保证 `/lmemory usage --days` 与状态页
  每日图不因失败调用少计。
- **位置**:用户根(记录这台 host 的消耗,与项目无关;随用户根备份)。
- **容量**:单行约 100B;一天 100 次调用 10KB,无旋转策略。损坏行跳过。
- **读侧**:`src/usage-log.ts` 纯模块——`appendUsageRow` / `readUsageRows`
  (跳过坏行)/ `aggregateByDay(rows, days)`(零填充近 N 天,按 label 分桶)
  / `localDay(ts)`(本地日期键)。

### 命令面

`/lmemory usage` 保持现状(实时视图);新增 `/lmemory usage --days <N>`
(1..90,缺省 14)渲染每日聚合表:日期 | recall 调用/token | extract | review |
合计。`/lmemory help usage` 同步更新。

### 状态页每日图(两者都要,纯 SVG/div,零外部库)

`dashboard-get` 的 `usage` 新增 `daily`:近 **84 天**(12 周)按日聚合数组
(`{day, recall:{calls,tokens}, extract:{...}, review:{...}, total}`),服务端
零填充。状态页 usage 区新增两张图:

- **近 14 天堆叠柱状图**:x=日期(MM-DD),每列 recall/extract/review 三色分段
  (复用条形图配色),列顶显示当日 total(≥1k 时 compact)。
- **近 12 周日历热力图**:GitHub 风格 12 列 × 7 行格子,按当日 total token 落入
  5 档强度(0 / >0 / >1k / >10k / >100k),着色用 deepseek 蓝的透明度插值;
  周行自周一起排,非当日数据留空档。
- 两张图都纯 div/SVG 实现,满足 CSP `default-src 'none'`;零调用日渲染空列/空
  色档(与「本进程尚无调用」文案不同,该文案只针对实时 counters)。

## 验收标准(AC)

**Q0/Q1 目录改名**
- [ ] 四层 + 内置候选全部指向 `lmemory/`;`/lmemory` 全命令与面板在
  `~/.dsh/lmemory/`、`<repo>/.dsh/lmemory/` 读写一致。
- [ ] 旧 `memory/` 目录在首次发现时被 rename 到 `lmemory/`,数据(条目数、
  id、createdAt)不变;重复执行幂等。
- [ ] 内容不似记忆目录(无 `*.remember.jsonl`/`catalog.json` 且非空)的旧
  `memory/` 不被迁移,有 warn 日志。
- [ ] 单元测试覆盖:迁移发生/幂等/防御不迁/新目录已存在不覆盖。

**Q2 注册表**
- [ ] 启动与 session-start 后,`~/.dsh/lmemory/registry.json` 登记用户根与
  当前项目根;`collections list` 渲染全部根与计数。
- [ ] `add` / `forget` 生效;缺失/损坏的 registry.json 加载为空表不抛。

**Q3 导出**
- [ ] 默认导出全部根;`--root` 子集;`--out` 落点;manifest 与 roots/ 副本内容
  与 jsonl 一致;导出目录命名含时间戳。
- [ ] 空注册表导出 → 成功但 rootsExported=0(带说明文案)。

**Q4 usage 持久化**
- [ ] 每次 recall/extract/review 调用写入一行;重启后 `usage --days` 能读到
  历史;损坏行跳过。
- [ ] 状态页两张每日图渲染正确:84 天 fixture 下柱状图 14 列、热力图 12×7
  格子、强度分档与 total 一致;零数据日渲染空档。

## 非目标(本轮不做)

- 记忆包 **import**(合并回 host)与跨根去重合并。
- usage 日志的轮转/压缩/多 host 聚合;usage 只按本机本进程日志聚合。
- 注册表的自动全盘扫描(不做 find / 全盘遍历);项目根只惰性登记。
- `memory` settings 命名空间改名(那是配置键,非文件路径)。
