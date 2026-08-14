# dsh-memory

DeepSeek Harness 的「长期记忆(Long-Term Memory)」插件(bundle)。跨会话持久化**提炼过的语义事实**——用户偏好、经验教训、项目约定——而不是整段历史会话。

## 定位

与 dsh 内置的 `session-reference`(整段历史会话快照)互补:

| 能力 | 记什么 |
|---|---|
| `session-reference`(内置) | 整段历史会话快照 |
| `dsh-memory`(本插件) | 提炼的语义事实(只含 `rules` / `lessons` 两类) |

## 用法

```sh
dsh plugin --profile demo add @meomeo-dev/dsh-memory
dsh --profile demo
```

模型在会话里主动调用工具:

- `remember` —— 写入一条记忆(`type` / `domain` / `scope` / `layer` / `entry` + 可选 `entryPoint` / `references`)
- `recall` —— 经多 `deepseek-v4-flash` 记忆节点 team 召回相关条目
- `forget` —— 按 `entry` 精确匹配删除(`rules` 删除需 `confirm: true`)
- `memory-find` —— 按 `id` 或 `type` / `domain` / `scope` / `layer` 过滤查找
- `memory-update` —— 按 `id` 改写可改字段(`entry` / `domain` / `scope` / `entryPoint` / `references`)
- `memory-delete` —— 按 `id` 删除(`rules` 删除需 `confirm: true`)

人可操作 `/lmemory` 命令:

- `/lmemory status` —— 查看 team 节点数 / 每节点状态
- `/lmemory team start|stop|restart` —— 组装 / 释放 / 重新组装 team
- `/lmemory query <text>` —— 人主动查询长期记忆
- `/lmemory review [layer|domain]` —— 用 `deepseek-v4-pro` 质检记忆,发现矛盾/重复/过时/背离,报告注入主会话
- `/lmemory catalog rebuild` —— 从全部 jsonl 重建 catalog
- `/lmemory config get|set <key> [value]` —— 读写配置(见 `docs/design.md` §9 / `docs/auto-extraction.md` §7)

## 存储模型

- **真相源** `.remember.jsonl`:一行一条 JSON,逐行 schema 校验(`id` 唯一编号、`type` ∈ rules/lessons、`domain` ∈ 21 枚举、`scope` 非空自由文本(影响范围)、`layer` ∈ global/user/project、`entry` 非空)。
- **渲染投影** `.remember.md`:8 列 Markdown 表格(首列 `id` + 7 个字段),由纯函数渲染生成,绝不解析 MD。
- **派生索引** `catalog.json`:每层 `memory/` 目录一个,记录「记忆 id → 所在文件」,全量重写、可 `rebuild` 重建(真相源仍是 jsonl)。
- 命名规范:`YYYY-MM-DD[.<partition>].<type>.remember.{jsonl,md}`。
- 目录发现:内置 < 用户 `~/.agents/memory` < 用户 `~/.dsh/memory` < 项目 `<repo>/.agents/memory` < 项目 `<repo>/.dsh/memory`。

## 文档

- [concept.md](docs/concept.md) —— 领域模型:scope/domain 框架、21 个 domain、两类信息、时间衰减、表格格式
- [design.md](docs/design.md) —— 技术设计:接缝、目录发现、数据模型、工具、AC
- [auto-extraction.md](docs/auto-extraction.md) —— 自动提取设计:三种触发形态、抽取器、抽取窗口
- [memory-review.md](docs/memory-review.md) —— 记忆寻址、目录与质检:唯一编号 id、catalog、review
- [data-contract.md](docs/data-contract.md) —— 数据契约与演进式数据设计:ER/3NF、Data+Schema+Migrate

## 状态

已实现主动记忆(remember / recall / forget)+ 质检(review)+ 自动提取(auto-extraction)+ 数据契约(schema.yaml + 迁移引擎)。单元测试 117 个全绿(模型调用以 mock 注入);召回 / 质检 / 抽取需真实 `DEEPSEEK_API_KEY` 端到端验证,npm 发布待人工配置 Automation token 后经 release workflow 触发。
