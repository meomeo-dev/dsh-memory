# 价格表与成本估算设计(pricing-and-cost)

模型 API 只返回 usage(token 数),**不返回 cost**——计费在 provider 侧,官方价格随时间调整(限时优惠、永久调价、峰谷定价),且调价会提前公告生效日期。本设计把「官方价格表(按时段)」持久化,**cost 永远即时计算、绝不落盘**:价格表错了/变了,用户只改价格记录,历史成本即按新表自动重算。

## 背景与事实(2026-08-15 调研,来源见文末)

- 模型返回的 usage 归一化为三桶:`inputTokens`(缓存未命中输入)/ `cacheReadTokens`(缓存命中输入)/ `outputTokens`——正好对应官方计价的三档。
- 当前价格(官方定价页):
  - `deepseek-v4-flash`:输入 1 元 / 缓存命中 0.02 元 / 输出 2 元(每百万 tokens;起始时间官方未公告)
  - `deepseek-v4-pro`:输入 3 元 / 缓存命中 0.025 元 / 输出 6 元(2026-05-22 公告「2.5 折永久化」,2026-05-31 起永久生效;此前为限时 2.5 折促销,原价为现行价 4 倍)
- **2026-08-13 调价公告,2026-08-17 00:00 北京时间生效**,改为峰谷定价(高峰=北京时间 9:00–12:00、14:00–18:00,即 UTC 01:00–04:00、06:00–10:00;其余为空闲):

| 模型 | 时段 | 输入 | 缓存命中 | 输出 |
|---|---|---|---|---|
| v4-flash | 空闲 | 1.5 元 | 0.05 元 | 4.5 元 |
| v4-flash | 高峰 | 3.0 元 | 0.10 元 | 9.0 元 |
| v4-pro | 空闲 | 4.5 元 | 0.15 元 | 13.5 元 |
| v4-pro | 高峰 | 9.0 元 | 0.30 元 | 27.0 元 |

所有生效时间均换算为 UTC+8(北京时间)记录;内部存储用 epoch 毫秒(时区无关),文档与种子注释标注北京时刻。2025-02-26 的 V3/R1 错峰优惠(00:30–08:30)与本插件无关(只使用 v4 模型),不录入。

## 用户故事

1. 作为用户,我想按 usage 与各时段的官方价格估算成本——包括调价前的历史使用量按当时价格计,调价后按新价格(含峰谷)计。
2. 作为用户,官方公告涨价后,我只需在价格表里加/改一条记录(含生效时间),所有成本展示自动重算——不改代码、不发版。
3. 作为用户,cost 绝不落盘:价格记录错了,改价格表即可纠正历史成本;我不希望磁盘上存着一份随时可能被官方调价作废的成本快照。
4. 作为用户,我想知道每笔估算依据的是哪条价格记录、哪些调用因缺价格而未计入,避免把「无价」误读成「免费」。

## 机制

### 价格表(pricing.json,持久化)

- 位置:`~/.dsh/lmemory/pricing.json`(host 级,与 registry/usage 同级,随用户根备份)。
- 缺失时用**内置种子**创建(插件启动即种子,与 registry 同节奏,不依赖首次面板/命令访问);已存在时绝不覆盖用户修改。损坏/格式不符 → 启动告警 + 读侧报错可见(成本显示「价格表不可用」)——价格错误比没有价格更糟,fail loud。
- 结构(formatVersion = 1):

```json
{
  "formatVersion": 1,
  "currency": "CNY",
  "updatedAt": 1755225600000,
  "periods": [
    {
      "model": "deepseek-v4-flash",
      "effectiveFrom": 0,
      "source": "官方定价页(2026-08-15 抓取);起始时间未公告",
      "prices": { "inputPerMTok": 1, "cacheHitPerMTok": 0.02, "outputPerMTok": 2 }
    },
    {
      "model": "deepseek-v4-flash",
      "effectiveFrom": 1776643200000,
      "source": "2026-08-13 公告,2026-08-17 00:00 北京时间生效",
      "prices": { "inputPerMTok": 1.5, "cacheHitPerMTok": 0.05, "outputPerMTok": 4.5 },
      "peakPrices": { "inputPerMTok": 3, "cacheHitPerMTok": 0.1, "outputPerMTok": 9 },
      "peakWindowsBeijing": [[9, 12], [14, 18]]
    }
  ]
}
```

- `prices` = 基础价(峰谷期的「空闲价」);`peakPrices` 存在 = 该时段启用峰谷,`peakWindowsBeijing` 缺省 `[[9,12],[14,18]]`;不存在 = 单一价。
- 单位:每百万 tokens 的**元**(CNY);成本展示保留两位小数(分)。

### 计价查找

- usage 行新增 `model` 字段(追加兼容:旧行无 model → 按 label 回退当前配置映射 recall/extract → `model`、review → `reviewModel`;单一真相源仍是 usage 行本身,回退仅覆盖历史行)。
- 对一行(ts, model, 三桶 token):取该 model 下 `effectiveFrom <= ts` 的最新一条;一条都没有则回退该 model 最早一条(记为回退,覆盖「起始时间未公告」的时段)。再判 `peakPrices` 是否存在且 ts 落在北京高峰窗口 → 用峰价。
- **cost = input×inputPerMTok + cacheRead×cacheHitPerMTok + output×outputPerMTok** ÷ 1M(元)。
- **cost 只即时计算**(面板 dashboard-get 与 `/lmemory usage` 每次重算),任何组件不写 cost 到磁盘——价格表是唯一持久化事实。
- **提升评审预估**(`estimatePromoteCost`,global-layer-design.md §7.3):输入按
  `nodeCount × maxNodeKb × 1024 字符` 估 token(满容量假设),输出按
  `nodeCount × GLOBAL_PROMOTE_MAX 条 × 150 字符` 估(逐节点输出上限近似),
  逐节点用 `costFor` 计价(线性可合并为一次调用),模型 = `reviewModel`(v4-pro),
  与 usage 行 label='review' 回退语义一致。假设写死在函数 JSDoc,非运行时可变。

### 展示

- 状态页用量明细表:新增「估算成本 (¥)」列(每职责一行)+ 卡片头部「近 14 天估算成本 ¥X.XX」;缺价格的行显示「—」。
- `/lmemory usage` 增加一行估算成本合计(同口径);缺价格时显式说明。
- 新增 `/lmemory pricing` 命令:打印价格表全文 + 文件路径(用户改表后自检)。

## 验收标准(AC)

- **时段正确**:同一模型跨越调价日的 usage,按各自时段价计价;08-17 后落在北京高峰窗口的行按峰价、其余按空闲价(单测锁定边界:00:59/09:00/11:59/12:00/13:59/14:00/17:59/18:00 北京)。
- **回退语义**:无 model 的旧行按 label 映射计价;model 无任何价格记录时该行计「缺价」,不静默为 0。
- **成本公式**:cost = 三桶×对应单价(单测锁定)。
- **不落盘**:估算函数纯计算(不触 fs);写入成本相关文件的行为不存在(测试断言 DSH_HOME 沙箱内估算前后文件清单不变)。
- **坏表可见**:pricing.json 损坏 → 面板成本区显示「价格表不可用」,`/lmemory pricing` 报错,不影响其他面板功能。
- **视觉**:与既有页面同设计令牌;xbrowser 三引擎通过(零 console 错误)。

## 非目标

- 不联网自动拉取/更新价格(官方定价页是网页,无价格 API;价格表由人维护)。
- 不做多币种(官方页人民币口径,存 CNY)。
- 不录入 V3/R1 历史价格(本插件只用 v4 模型;用户可自行加条目)。
- 不做成本告警/预算/账单导出。

## 来源

- [官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)(2026-08-15 抓取)
- [21 经济网:DeepSeek 发布 API 调价公告](https://m.21jingji.com/article/20260813/herald/0ff869d9da4382d38234ad9f700a3cab_zaker.html)
- [新华财经:峰谷定价方案](https://m.cnfin.com/kx//zixun/20260813/4454952_1.html)
