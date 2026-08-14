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

- `remember` —— 写入一条记忆(`type` / `domain` / `scope` / `entry` + 可选 `entryPoint` / `references`)
- `recall` —— 经多 `deepseek-v4-flash` 记忆节点 team 召回相关条目
- `forget` —— 按 `entry` 精确匹配删除(`rules` 删除需 `confirm: true`)

人可操作 `/lmemory` 命令:

- `/lmemory status` —— 查看 team 节点数 / 每节点状态
- `/lmemory team start|stop|restart` —— 组装 / 释放 / 重新组装 team
- `/lmemory query <text>` —— 人主动查询长期记忆
- `/lmemory config get|set <key> [value]` —— 读写 `maxNodeKb` / `recallTopK` / `rerankPrompt` / `warmupOnStart` / `provider` / `model`

## 存储模型

- **真相源** `.remember.jsonl`:一行一条 JSON,逐行 schema 校验(`type` ∈ rules/lessons、`domain` ∈ 21 枚举、`scope`/`layer` ∈ global/user/project、`entry` 非空)。
- **渲染投影** `.remember.md`:7 列 Markdown 表格,由纯函数渲染生成,绝不解析 MD。
- 命名规范:`YYYY-MM-DD[.<partition>].<type>.remember.{jsonl,md}`。
- 目录发现:内置 < 用户 `~/.agents/memory` < 用户 `~/.dsh/memory` < 项目 `<repo>/.agents/memory` < 项目 `<repo>/.dsh/memory`。

## 文档

- [concept.md](docs/concept.md) —— 领域模型:scope/domain 框架、21 个 domain、两类信息、时间衰减、表格格式
- [design.md](docs/design.md) —— 技术设计:接缝、目录发现、数据模型、工具、AC

## 状态

阶段 0(概念)+ 阶段 1(设计)+ 阶段 2(开发)已完成。v4-flash 召回需真实 `DEEPSEEK_API_KEY` 验证(单元测试已用 mock 覆盖),npm 发布待人工配置 Automation token 后经 release workflow 触发。
