# 开发计划 — Computer-Use Automation System (interface.ai Assignment A)

> 本文是实施计划，不是最终交付物。最终交付物是 `/README.md`、`/REPORT.md`、`/evidence/` 和源码。
> 每个模块都标注了「已有成熟方案」——**能抄设计的抄设计，能直接用的直接用，抄不了的写清楚为什么自己造**。
> 参考资料索引见文末 §10，已下载到 `research/`。

---

## 0. 一句话结论（技术选型总表）

| 维度 | 选择 | 一句话理由 | 参考的成熟方案 |
|---|---|---|---|
| 语言/运行时 | **TypeScript + Node 22** | artifact schema 是评分重心，zod 一份定义同时给出运行时校验 + JSON Schema（喂给 agent 当 tool 契约），省掉一整层胶水 | MCP `inputSchema`/`outputSchema` 约定 |
| 浏览器控制 | **Playwright（CDP 直连）** | 需要 `ariaSnapshot({mode:'ai'})` 的 ref 机制 + trace + CDP screencast 三件事，Playwright 一个栈全给 | playwright-mcp 的 snapshot/ref 模型 |
| 感知层 | **a11y 树为主 + 截图坐标兜底（hybrid）** | 纯 a11y 在 legacy table 布局上会瞎；纯视觉贵且不稳。2026 的共识就是 hybrid routing | Anthropic `browser_toolset_20260801`（结构+像素双通道）、Playwright MCP |
| LLM | **Claude（Opus/Sonnet 5）+ 严格 tool-calling** | 发现阶段要结构化 action 输出，不要自由文本 | — |
| 目标应用 | **自建 Docker「信用社后台」legacy app**（frameset + table 布局 + 无 test-id） | 见 §2，这是本项目**最重要的一个决定** | ParaBank（形态参考，不直接用） |
| Artifact | **zod 定义的 `Capability` JSON，语义步骤 + 候选定位器束** | 见 §4 | workflow-use 的 workflow.json、Skyvern code-cache、Stagehand selector cache |
| 定位器 | **multi-locator 候选束 + 投票解析** | 学术上已被证明比任何单一算法都稳 | Robula+ / Multi-locator (Leotta et al., ICST'15) |
| Replay | **零 LLM，checkpoint 断言 + 三分类结果契约** | PDF 明说这是评分核心 | Skyvern `run_with="code"`、workflow-use |
| 人工接管 | **CDP `Page.startScreencast` + `Input.dispatch*` 的最小 operator console，同 session** | 抄 Steel/Browserbase 的控制转移模型，自己实现传输层 | Steel `interactive=true`、Browserbase Live View |
| 安全 | **确定性策略引擎（非 LLM）allowlist + 动作风险分级 + 日志脱敏** | 用 LLM 当 guardrail 是已知反模式 | OPA 的 input+policy→decision 模型（不引入 OPA 本体） |
| 证据 | **JSONL 结构化日志 + Playwright trace + 失败时截图/DOM 快照** | 免费拿到 step 级证据 | Playwright Trace Viewer、rrweb |

**总时间盒：约 5–6 个有效工作日。** 超出就砍 §8 的清单，不砍能力项。

---

## 1. 需求 → 模块映射

PDF §3 的六条硬要求，逐条落到模块，避免最后漏项：

| 要求 | 模块 | 交付判据 |
|---|---|---|
| 3.1 goal-driven agent loop | `packages/discovery` | 一次真实 LLM 跑通目标，证据在 `/evidence/` |
| 3.2 结构化 artifact | `packages/schema` | zod schema + 版本号 + 一份真实产出的 `.capability.json` |
| 3.3 确定性 replay | `packages/replay` | 同 artifact 跑 5 次结果一致；错误场景有 3 类不同返回 |
| 3.4 安全护栏 | `packages/policy` | allowlist 单测；越界动作被拦截有日志 |
| 3.5 可观测性 | `packages/evidence` | 每次 run 一个目录，含 JSONL + trace |
| 3.6 人工介入 | `packages/handoff` + `apps/operator` | 能在同一 session 暂停→人操作→恢复 |
| 3.7 异构/多租户（只做设计） | `REPORT.md` §4 + schema 里的 `surface` / `variant` 字段 | 抽象层不写死 web |

---

## 2. 最先做的决定：目标应用自建（M0）

**决定：不用公开 demo 站，自己写一个 Docker 化的假信用社后台。**

理由（要写进 REPORT）：
1. PDF §3.3 要求 replay 能检测「validation error / record not found / 权限拒绝 / 意外弹窗 / session 超时 / 慢加载」。**公开站点无法按需触发这些**，而这恰恰是评分权重第三高的项。自建 app 可以用 query param 注入故障（`?inject=timeout`）。
2. PDF §8 的 stretch goal「跨租户复用」需要**同一 vendor 产品的两个变体**。自建才能造出 `tenant-a` / `tenant-b` 两份皮肤 + 微调 DOM。
3. PDF §4 明确鼓励「intentionally hostile surface（iframes/framesets, table-based layouts, no test IDs）」。
4. 不碰真实站点的 ToS / 限流问题。

**形态**：Express + 服务端渲染 EJS，刻意做成 2003 年风格
- `<frameset>`：左侧导航 frame + 右侧内容 frame
- 全部 `<table>` 布局，`<td>` 套 4 层，class 名是 `.tbl1 .r2 .c3`
- 零 `data-testid`，零语义标签，按钮是 `<input type="button" value="Search">`
- 流程：登录 → 会员检索 → 会员详情（储蓄余额） → 开子账户表单 → 确认页
- **故障注入开关**（这是关键卖点）：
  - `MEMBER_NOT_FOUND`（检索空结果页）
  - `VALIDATION_ERROR`（表单红字报错）
  - `PERMISSION_DENIED`（403 内容页）
  - `SESSION_EXPIRED`（跳登录页）
  - `SLOW_LOAD`（随机 sleep 8s）
  - `SURPRISE_DIALOG`（一个「系统维护通知」的 confirm 拦路）
- 形态参考 ParaBank（JSP + table 布局 + 无 test-id）的观感，但代码自己写。

**产出**：`apps/legacy-app/`，`docker compose up` 起在 `localhost:8080`，一条 seed 数据脚本。

> ⏱ 0.5–0.75 天。这一步别做漂亮，做「难看且可控」。

---

## 3. 架构

```
                    ┌──────────────────────────────────────┐
   goal + target →  │  Discovery Runner  (LLM in the loop)  │
                    │  observe → decide → act → verify      │
                    └───────┬──────────────────────┬────────┘
                            │ 每步记录 trace         │ 卡住
                            ▼                      ▼
                    ┌───────────────┐      ┌───────────────┐
                    │  Compiler     │      │  Escalation   │
                    │ trace→Capability│    │  (§6 接管)     │
                    └───────┬───────┘      └───────┬───────┘
                            ▼                      │
                 ┌──────────────────────┐          │
                 │ Capability Store      │          │
                 │ *.capability.json     │          │
                 └───────┬──────────────┘          │
    params + name →      ▼                         │
                 ┌──────────────────────┐          │
                 │  Replay Engine        │──卡住───▶┘
                 │  零 LLM，checkpoint    │
                 └───────┬──────────────┘
                         ▼
                  ReplayResult (三分类)

    横切：SurfaceDriver 抽象 | PolicyEngine | Evidence | Redactor
```

**关键边界（要在 REPORT 里defend）：**

- **`SurfaceDriver` 接口是整个设计的承重墙。** 它只暴露 `observe(): Observation` / `act(Action): void` / `resolve(LocatorBundle): Handle`。web 是一个实现，desktop（UIA/AX/AT-SPI）是另一个实现。**Capability artifact 里不出现任何 CSS/XPath 字符串以外的 web 专有概念**，定位器是 `{strategy, value, confidence}` 的列表，desktop 实现换成 `{strategy:'uia-automationid', value:'btnSearch'}` 即可。这就是 PDF §3.7 问的「seam」。
- **单进程 + 文件存储。** PDF §7 明说不奖励队列/集群。artifact 存本地 JSON 文件，run 存本地目录。
- **Compiler 是独立一步**，不是在 loop 里顺手写。原因：PDF §3.2 要求 artifact「decoupled from the raw model transcript」。所以是 `trace.jsonl → compile() → capability.json` 两个 artifact 分明。

---

## 4. Artifact Schema（评分焦点，投最多时间）

### 4.1 抄谁

| 来源 | 抄什么 | 不抄什么 |
|---|---|---|
| **browser-use / workflow-use** | 「录一次、无限重放，步骤里带变量」的整体形状；失败回落 agent 的设计 | 它的 schema 偏 DOM 事件流水，语义层太薄；且仓库自己说 not production ready |
| **Skyvern code-caching** | explore→replay 两态；按 block 缓存、渐进式覆盖分支；条件块不缓存 | 它缓存的是**生成的代码**，不可 review、不可跨租户 diff。我们要数据不要代码 |
| **Stagehand caching** | 缓存的是**解析后的 selector + 元数据**，执行前先验证页面仍匹配；敏感信息不入缓存 | 它是 per-action 缓存，没有 capability 级的输入/输出契约 |
| **MCP tool 定义** | `name` / `description` / `inputSchema` / `outputSchema` 的契约形状，让 agent 能 `tools/list` 发现、`tools/call` 调用 | — |

**我们的差异点（写进 REPORT）**：以上三家缓存的都是「怎么做」，没人把它当成**有类型契约、可 review、可版本化、可跨租户特化**的一等公民。这个作业问的正是后者。

### 4.2 读 workflow-use 真实源码得到的结论

> 本节不是搜索摘要,是读 `research/workflow-use/workflows/workflow_use/schema/views.py`(已本地 clone)得到的。
> 博客和 README 说的是「record once, replay forever」,**代码里说的东西更有价值**:

| 代码里的事实 | 对我们的意义 |
|---|---|
| `cssSelector` / `xpath` / `elementHash` 全部被标注 `[LEGACY] avoid in new workflows` | 一个真跑过生产流量的项目,**主动把 CSS/XPath 降级了**。这是对 §4.3 决策 2 最强的经验背书 |
| 新增 `selectorStrategies: List[{type, value, priority, metadata}]`,注释写 "fallback strategies ordered by priority" | 和 multi-locator 论文结论撞车。**独立的理论来源 + 工程来源指向同一设计**,我可以放心把候选束当承重结构 |
| `target_text` 是 PRIMARY,注释举例 `"Submit (in Personal Information)"`、`"Edit (item 2 of 3)"` | 语义定位靠**带层级上下文的文本**消歧 |
| 单独有 `container_hint` / `position_hint` / `interaction_type`,注释明说 "stored as text, not selectors" | **偷这个。** 消歧信息存成人话而不是选择器,artifact 就同时可 review 又抗 drift。我原方案没有这层,补进 `target` |
| 每步有 `verification_checks` + `expected_outcome`(后者供 AI 校验) | 印证 checkpoint 该打在步级。但他们的 `expected_outcome` 要 LLM 判,**我们坚持确定性断言**——这是要在 REPORT 里主动对比的差异 |
| 有 `AgentTaskWorkflowStep{type:'agent', task, max_steps}`,可混在确定性步骤里 | 「确定性流程中嵌一个有界的 agent 步」这个逃生舱设计很聪明。但它会破坏 replay 的确定性保证,**我不放进主路径**,只在 REPORT §7 里作为 stretch「assisted fallback」的形态引用 |
| `input_schema` 是扁平 `list[{name, type:'string'|'number'|'bool', format, required, default}]` | **这是他们最弱的一环,也是我的超越点。** 没有 pattern/enum/嵌套/敏感度标注,没有 output schema。我用完整 JSON Schema + `sensitivity` + `outputs` + `businessOutcomes`,直接对上 PDF §3.2 要的「clear contract」 |
| `model_config = {'extra': 'allow'}`,注释 "fields captured from raw events but not explicitly modeled" | 录制器原始字段直接漏进 artifact。**这正是 PDF §3.2 要求「decoupled from raw model transcript」所反对的**,也是脱敏漏洞。我用严格 schema + 显式 `provenance.traceRef` 引用 |
| validator 强制 workflow 最后一步必须是 `extract`,理由 "AI processing is always needed at the end" | 不抄。这是把「必须有产出」和「必须调 AI」绑死了。我们的 `successCondition` + `outputs` 能表达同样的意图且不需要 LLM |

**净收获**:候选束、`container_hint`/`position_hint`(新增)、步级 verification。**净超越点**:完整类型契约、严格 schema、确定性断言、business outcome 一等公民。这四条就是 REPORT §2 要 defend 的内容。

### 4.3 Schema 草案

> **状态更新**:本节的草案已经落地为真实代码,见 [packages/contracts/src/capability.ts](packages/contracts/src/capability.ts),
> 样例 artifact 见 [examples/](packages/contracts/examples/member.read_savings_balance.capability.json)。
> 落地过程中相对下面草案的实质改动:
> - 所有**跨字段一致性规则移进了 schema 的 `superRefine`**,不再放在校验脚本里(见 AGENTS.md I9)。
>   起因是脚本里那条"禁止内联敏感字面量"的检查写错了 key,从上线起就没生效过一次。
> - 新增了草案里没有的几条硬约束:声明了却没人产出的 output、不可逆步骤缺 checkpoint、
>   `optional` 的 mutating 步骤(会造成静默半写)、`secret` 被当作调用参数、批准了却没记录批准人。
> - `stuckReason` 从 replay 移到 common —— discovery 也会卡住,handoff 不该为了描述"为什么叫我"而依赖 replay 引擎。

```jsonc
{
  "schemaVersion": "1.0.0",
  "id": "cu.member.read_savings_balance",
  "version": "1.2.0",              // capability 自身版本，semver
  "displayName": "Read member savings balance",
  "description": "Looks up a member by ID and returns their current savings balance.",

  // —— 契约：给调用方 agent 的部分 ——
  "inputs": {                       // JSON Schema（zod 生成）
    "type": "object",
    "required": ["memberId"],
    "properties": {
      "memberId": { "type": "string", "pattern": "^[0-9]{5}$",
                    "sensitivity": "identifier" }
    }
  },
  "outputs": {
    "type": "object",
    "properties": {
      "savingsBalance": { "type": "string", "format": "money" },
      "accountStatus":  { "type": "string", "enum": ["active","dormant","frozen"] }
    }
  },
  "businessOutcomes": [             // 不是失败，是合法返回
    { "code": "MEMBER_NOT_FOUND", "detect": { "ref": "chk.no_results" } },
    { "code": "PERMISSION_DENIED", "detect": { "ref": "chk.denied_banner" } }
  ],

  // —— 绑定：跑在哪个面之上 ——
  "surface": {
    "kind": "web",                  // web | legacy-web | desktop
    "app": "cu-coreadmin",          // vendor 产品标识，跨租户复用的 key
    "appVersion": "9.x",
    "entryPoint": "/admin/index.htm"
  },

  // —— 步骤 ——
  "steps": [
    {
      "id": "s1",
      "intent": "Open member search screen",     // 人类可读意图（review 用）
      "action": { "type": "click" },
      "target": {
        "frame": ["nav"],                        // frameset 路径
        "containerHint": "Left navigation",      // ← 抄 workflow-use：消歧信息存人话
        "positionHint": null,                    //    (不是选择器，可 review 且抗 drift)
        "candidates": [                          // ← multi-locator 候选束，有序
          { "strategy": "role-name", "value": "link:Member Search", "confidence": 0.9 },
          { "strategy": "text",      "value": "Member Search",      "confidence": 0.7 },
          { "strategy": "robula-xpath",
            "value": "//table[2]//td[1]/a[contains(.,'Member')]",   "confidence": 0.5 },
          { "strategy": "coords",    "value": [84, 212],            "confidence": 0.2 }
        ]
      },
      "risk": "safe",                            // safe | mutating | irreversible
      "checkpoint": { "id": "chk.on_search",
                      "assert": "aria-contains", "value": "textbox:Member ID" },
      "timeoutMs": 8000,
      "recover": [ { "on": "SURPRISE_DIALOG", "do": "dismiss_known_interstitial" },
                   { "on": "SLOW_LOAD",       "do": "wait_retry", "max": 2 } ]
    },
    {
      "id": "s3",
      "intent": "Type the member id",
      "action": { "type": "type", "valueFrom": "$.inputs.memberId" },  // 参数注入
      "target": { "...": "..." },
      "risk": "safe"
    },
    {
      "id": "s5",
      "intent": "Read savings balance from the accounts table",
      "action": { "type": "extract", "into": "$.outputs.savingsBalance",
                  "pattern": "money" },
      "target": { "...": "..." },
      "risk": "safe"
    }
  ],

  // —— 成功条件 ——
  "successCondition": { "allOf": ["chk.on_detail", "outputs.savingsBalance != null"] },

  // —— 治理 ——
  "provenance": {
    "discoveredBy": "claude-opus-5",
    "discoveredAt": "2026-09-09T...",
    "traceRef": "evidence/run-<id>/trace.jsonl",   // 指向，不内联
    "humanEdits": []
  },
  "approval": { "state": "draft" },                 // draft | approved（§8 stretch）
  "tenantOverrides": {                              // ← 跨租户复用的核心
    "tenant-b": { "steps": { "s1": { "target": { "candidates": [ /* 覆盖 */ ] } } } }
  }
}
```

### 4.4 这个 schema 的几个刻意决定（都要能 defend）

1. **`intent` 是人话，`target` 是机器话。** review 的人读 intent 就懂这个 capability 干什么，不用读 XPath。
2. **`candidates` 是有序束不是单一 selector。** 直接来自 multi-locator 论文的结论：加权多定位器比最好的单算法（Robula+）还稳，即使不加权也更稳。replay 时按序尝试，若前 N 个指向**不同元素**则判定为 drift 并升级。
3. **`businessOutcomes` 是 schema 的一等公民，不是 error。** PDF glossary 明说「Conflating the two is the most common design mistake here」——所以要在类型上就分开。
4. **`risk` 打在步骤上不是 capability 上。** 一个 flow 里前 4 步只读、第 5 步提交，粒度必须到步。
5. **`tenantOverrides` 是稀疏 patch 不是整份复制。** 基线 capability 绑 `surface.app`（vendor 产品），租户只存 diff。drift 检测 = 某租户 override 数量超阈值就告警「该重录基线」。
6. **`traceRef` 是引用不是内联。** artifact 必须干净可 review，且原始 transcript 里可能有敏感数据。

> ⏱ 1 天（含 zod 实现 + 单测）。这里花的时间最值。

---

## 5. Discovery / Replay / 错误处理

### 5.1 Discovery loop（M2，~1 天）

- 单轮上下文 = `ariaSnapshot({mode:'ai'})`（带 ref + box）+ 上一步结果 + 目标 + 已走步骤摘要。
- 页面 a11y 树超过阈值（legacy table 会爆）→ 截断到可交互元素 + 附截图，走 hybrid。
- LLM 输出严格 tool-call：`click(ref)` / `type(ref, text)` / `navigate(url)` / `extract(ref, as)` / `assert(desc)` / `done(outputs)` / `stuck(reason)`。
- **每个动作先过 PolicyEngine**，拒绝就把拒绝理由回灌给模型（让它换路，不是崩）。
- 停止条件：`done` / max 25 步 / 5 分钟 / 连续 3 步无状态变化（dead-end 检测）。
- 全程写 `trace.jsonl`：`{step, observationHash, prompt摘要, action, policyDecision, result, screenshotPath}`。

**成熟方案参考**：browser-use 的 agent loop、Stagehand 的 `observe()` 返回带 selector 的候选动作（observe-then-act 模式，正好对应我们的「先拿候选定位器再执行」）。

### 5.2 Compiler（M3，~0.5 天）

`trace.jsonl → capability.json`：
- 丢掉探索噪音（回退、重试、失败尝试）—— workflow-use 管这叫 noise filtering。
- 对每个保留动作，回放当时的 DOM 快照，用 4 种策略各生成一个候选定位器 → 组成 `candidates` 束。
- 把 discovery 时用到的字面量（`12345`）反向提升为 `$.inputs.memberId` 参数（LLM 辅助 + 人工确认）。
- 推断 checkpoint：取动作后页面新出现的稳定 a11y 节点。
- 跑一次 redactor，确保没有敏感值落进 artifact。

### 5.3 Replay（M4，~1 天，评分核心）

**结果契约（三分类，直接对应 PDF §3.3）：**

```ts
type ReplayResult =
  | { kind: 'success';  outputs: Record<string, unknown>; evidence: RunRef }
  | { kind: 'outcome';  code: string; message: string; evidence: RunRef }   // 业务结果
  | { kind: 'failure';  class: FailureClass; stepId: string;
      expected: string; observed: string; evidence: RunRef }
```

**运行时状态检测表**（每步执行后都跑一遍，顺序有讲究）：

| 检测到 | 分类 | 处理 |
|---|---|---|
| `businessOutcomes` 里声明的条件命中 | `outcome` | 立即返回，**这是成功的调用** |
| 已知拦路弹窗 | recoverable | 按 `recover` 关掉，重试当前步 |
| 慢加载 / 元素暂不可见 | recoverable | 指数退避重试，上限 2 次 |
| session 过期（跳登录页） | recoverable→有限 | 若配了凭据则重登一次并从 checkpoint 续跑；否则升级人工 |
| 校验错误红字 | 看是否声明 | 声明了→`outcome`；没声明→`failure` |
| 候选定位器全失效 / 候选互相矛盾 | `failure: DRIFT` | 停，升级人工，附截图 |
| checkpoint 断言失败 | `failure: CHECKPOINT` | 停，报「期望 X 观察到 Y」 |
| policy 拒绝 | `failure: POLICY` | 停 |

- **确定性保证**：零 LLM 调用（在 replay 进程里直接不注入 LLM client，用类型隔离而不是靠自觉）；固定视口；关闭动画；显式等待而非 sleep；参数从入参注入而非从 artifact 读。
- 单测：同一 artifact + 同一入参跑 5 次，断言输出逐字节相同（这同时是 §8 stretch「multi-run stability」的底子）。

---

## 6. 人工接管（M5，~0.75 天）

这是最容易做成 TODO 的一项，PDF 明说「not just a TODO」。

**控制转移模型（核心是这个，UI 可以丑）：**

```
Session 有一个 controlLease: { holder: 'automation'|'operator'|null, since, reason }
```

1. **Detect**：replay/discovery 抛 `StuckSignal{ capabilityId, stepId, reason, observation, screenshot }`。
2. **Route**：写一条 `intervention request` 到 `runs/<id>/intervention.json` + 控制台打印 operator console URL。（真实系统里这里换成队列/工单，seam 留好。）
3. **Cede**：automation 释放 lease，**但不关 browser context**。这是关键——PDF 强调「same live session, not a fresh one」。
4. **Operator 接管**：本地起一个 `apps/operator`（单页），WebSocket 双向。

   > **实现直接照抄 `research/steel-browser/api/src/plugins/browser-socket/casting.handler.ts`（已本地 clone，MIT）。**
   > 读过代码后确认，整套接管机制核心不到 200 行，配方是：
   >
   > | 方向 | CDP 调用 | 代码里的细节 |
   > |---|---|---|
   > | 初始化 | `Page.setDeviceMetricsOverride` | 先钉死视口，否则人看到的和 automation 看到的不是一个画面 |
   > | 出（看） | `Page.startScreencast {format:'jpeg', quality:75, maxWidth, maxHeight}` | jpeg + q75 是他们跑出来的平衡点，直接用 |
   > | 出（看） | `Page.screencastFrame` → WS | **收到帧立刻 `Page.screencastFrameAck`**，注释写的是 "free up memory"。不 ack 会卡死流，这是个容易踩的坑 |
   > | 入（控） | `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` | WS 消息按 `case "mouseEvent"` / `"keyEvent"` / `"navigation"` / `"closeTab"` 分发 |
   > | 保活 | 30s `ws.ping()` + `targetdestroyed` 清理 | 死连接检测，不加的话 lease 会永久悬空 |
   >
   > 我们**只加一样 Steel 没有的东西：`controlLease`**。Steel 的 live view 是「随时都能插手」的调试工具，没有「谁在控制」的概念；我们要的是可审计的控制权交接。这就是本项目在这一项上的增量，也是 REPORT §5 的论点。

   - 抄 **Steel** 的参数模型：`interactive` / `showControls` 两个开关，view-only 和可操作分离。
   - 抄 **Browserbase Live View** 的安全提示：live URL 等同于凭据，必须短时签名 token。
   - 备选（如果时间紧）：Xvfb + x11vnc + noVNC 的 Docker 组合，`view_only` 标志切换观看/接管——现成镜像就有。**但既然 Steel 的 CDP 实现读下来这么短，就没有理由退回 VNC**：CDP 版能天然把每个 `dispatch*` 事件落成 JSONL（「人做了什么」的结构化证据），VNC 只能给录像。这个理由要写进 REPORT。
5. **Record**：接管期间所有 input 事件 + 前后 a11y 快照差异写入 `intervention.json`，作为「人做了什么」的证据。
6. **Resume**：operator 点 "hand back" → lease 回 automation → 从**下一个 checkpoint** 而不是下一步继续（因为人可能已经把状态推进了好几步）。这个「按 checkpoint 而非按步恢复」的决定是本节的亮点。

**明确 mock 掉的**：工单系统、多 operator 调度、鉴权、并发 lease 竞争。写进 REPORT §7 Cuts。

---

## 7. 安全（M6，~0.5 天）

三层，全部确定性，**不用 LLM 做 guardrail**（理由：已有研究表明 LLM-judge guardrail 可被 prompt 注入拖入无限推理，且对「不可逆」这种结构性事实不敏感）。

1. **Allowlist（默认拒绝）**：`policy.yaml` 声明允许的 origin/路径前缀 + 允许的 action 类型 + 每个 capability 允许的最大步数。任何 action 执行前过 `evaluate(principal, action, context) → allow|deny|require_confirmation`。形状抄 OPA 的 `input + policy → decision`，但**不引入 OPA 本体**（一个 YAML + 200 行判定足够，引入 Rego 是 PDF §7 点名批评的 framework name-dropping）。
2. **动作风险分级**：
   - `safe`：读、导航、填表（不提交）→ 直接放行
   - `mutating`：提交表单、改状态 → discovery 阶段**要求确认**（CLI 交互 / `--auto-approve-mutating` 显式开启）；replay 阶段看 capability 的 `approval.state`
   - `irreversible`：转账、删除、发送 → **一律阻断**并升级人工。理由：这是受监管的金融数据，误操作不可回滚，宁可多一次人工。
3. **脱敏**：`Redactor` 在三个出口强制过一遍——artifact 写盘、日志写盘、发给 LLM 的 prompt。
   - 规则：账号/卡号/SSN/邮箱/电话/金额上下文 的正则 + 已知字段名白/黑名单。
   - 设计抄 **Presidio**：**检测与脱敏分离**，所以日志里可以记「在 step 3 发现 1 个 CREDIT_CARD，置信度 0.9」而不记值本身——这个审计属性很值钱。
   - 截图：失败截图前先对匹配到的 box 打黑条（Presidio image redactor 的思路，我们用 a11y box 坐标做，不上 OCR）。
   - 凭据只从 env 读，永不入 artifact / trace（Stagehand 也是这么划线的）。

**限制要写进 REPORT §6**：正则脱敏会漏；allowlist 挡不住「允许范围内的错误操作」；截图黑条依赖 box 准确。

---

## 8. 里程碑与时间盒

| M | 内容 | 产出 | 时间 |
|---|---|---|---|
| M0 | legacy 目标 app + 故障注入 | `apps/legacy-app` | 0.75d |
| **M1a** ✅ | **契约层(已完成)** | `packages/contracts` 10 个模块 · typecheck 通过 · 38 个不变量测试通过 · 一份真实 artifact 样例 | — |
| M1b | policy 引擎 + redactor + SurfaceDriver 实现 | `packages/{policy,redact,surface-web}` | 1.0d |
| M2 | discovery loop（真实 LLM 跑通一次） | `/evidence/discovery-*/` | 1.0d |
| M3 | compiler：trace → capability | 一份真 artifact | 0.5d |
| M4 | replay 引擎 + 错误分类 + 5 次稳定性 | `/evidence/replay-*/`（含 3 个错误场景） | 1.0d |
| M5 | 接管：lease + operator console | `/evidence/handoff-*/` | 0.75d |
| M6 | 安全收口 + 脱敏 + 单测 | 测试通过 | 0.5d |
| M7 | README + REPORT（7 个标题）+ evidence 整理 | 文档 | 0.5d |

**只做 1 个 stretch goal**（PDF 说至多 1–2 个，深度优先）：
> **跨租户复用** —— 把 legacy app 复制成 `tenant-b`（换皮肤、挪一个按钮、改一个字段名），演示同一 capability 靠 `tenantOverrides` 在两个变体上都跑通。理由：它同时覆盖 PDF §3.7（评分项「Generalization」）和 §8 stretch，一份工作拿两份分。
>
> 如果还有余力再加：把 capability 目录暴露成一个 MCP server（`tools/list` + `tools/call`），演示 agent 按名字调用。成本极低（schema 已经是 JSON Schema 了），观感极好。

**主动砍掉、写进 REPORT §7**：desktop surface 实现（只留接口 + 设计）、真队列/多租户基础设施、operator 鉴权与多人调度、OCR 脱敏、LLM 辅助恢复（stretch 里的 assisted fallback）。

---

## 9. 主要风险

| 风险 | 概率 | 对策 |
|---|---|---|
| legacy frameset 让 Playwright 定位很痛 | 高 | schema 里 `target.frame` 是数组路径，driver 层统一处理 frame 下钻；先用一个 frame 跑通再加嵌套 |
| a11y 树在 table 布局上几乎无信息 | 高 | 这正是 hybrid 的存在理由；候选束里保留 `robula-xpath` 和 `coords` 两档兜底 |
| CDP screencast 接管延迟差、体验糟 | 中 | 接受。PDF 明说 operator console 可以 mock，我们要的是**机制真实**不是体验好 |
| 自建 app 花太多时间 | 中 | 硬性 0.75 天上限，超时就砍到「登录+检索+详情」三屏 |
| discovery 一次跑不过烧钱 | 低 | 先用 mock LLM 把 loop 骨架调通，最后才接真模型跑正式那次 |

---

## 10. 参考资料索引

> **检索方法上的一个自我修正**：第一轮我把可下载的论文存了下来、repo 只留了二手摘要，导致「论文有实体、代码只有转述」。
> 这是个偏差——本作业的评分点（schema 设计、控制转移模型）答案在别人的代码里，不在论文里。已纠正：下面两个仓库是本地 clone 后**读过源码**的，§4.2 和 §6 的结论直接来自源码而非博客。

**已 clone 到本地（读过源码）：**
- `research/workflow-use/` — 关键文件 `workflows/workflow_use/schema/views.py`（Pydantic schema 全貌）、`workflows/examples/workflows/form_filling/v1.fully-semantic.json`（真实产出样例，建议动手前再读一遍）。结论见 §4.2。
- `research/steel-browser/` — 关键文件 `api/src/plugins/browser-socket/casting.handler.ts`（screencast + input 注入全实现）、`api/src/modules/sessions/sessions.schema.ts`。结论见 §6。MIT 许可，可直接借鉴实现。

**已下载到本地（论文）：**
- `research/papers/agentrr-record-replay-2505.17716.pdf` — *Get Experience from Practice: LLM Agents with Record & Replay*（arXiv 2505.17716）。综述了 record&replay 这一路的做法，明确点评 workflow-use「只生成脚本重放同一 workflow，不做多层经验抽象」——正好是我们要超越的点。
- `research/papers/multi-locator-leotta-icst2015.pdf` — *Using Multi-Locators to Increase the Robustness of Web Test Cases*（Leotta et al., ICST 2015）。§4.3 候选定位器束的直接理论依据。

**待读（按优先级，不必全下）：**
- [browser-use/workflow-use](https://github.com/browser-use/workflow-use) — RPA 2.0，record-once/replay-forever，自动抽取变量。**注意其 README 自述 early development、not production ready**，且近期有「deterministic replay 在 browser-use 0.13 上坏掉」的 PR，别直接依赖。
- [Skyvern Code Caching](https://www.skyvern.com/docs/developers/features/code-caching) — explore→replay 模式；按 block 缓存、渐进式分支覆盖、条件块不缓存。
- [Stagehand caching 原理](https://www.browserbase.com/blog/stagehand-caching) — 缓存解析后 selector、执行前校验页面匹配、敏感信息不入缓存、缓存失效回落 LLM 自愈。
- [Stagehand act 文档](https://docs.stagehand.dev/v3/basics/act) — observe-then-act 模式。
- [Playwright MCP snapshots](https://playwright.dev/mcp/snapshots) 与 [Locator API](https://playwright.dev/docs/api/class-locator) — ref 机制、`ariaSnapshot({mode:'ai'})` 带 ref 与 box。
- [Steel human-in-the-loop](https://docs.steel.dev/overview/sessions-api/human-in-the-loop) 与 [steel-browser 源码](https://github.com/steel-dev/steel-browser) — `interactive` / `showControls` 控制模型，开源可读。
- [Browserbase Session Live View](https://docs.browserbase.com/features/session-live-view) — debug URL / `debuggerFullscreenUrl`、断连事件、live URL 视同凭据。
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) / [rrweb](https://rrweb.com/) — 证据层。trace 记「agent 做了什么」，rrweb 记「agent 看到了什么」。
- [microsoft/presidio](https://github.com/microsoft/presidio) — 检测/脱敏分离的审计属性；image redactor 思路。
- [Why OPA is the missing guardrail for AI agents](https://codilime.com/blog/why-use-open-policy-agent-for-your-ai-agents/) — `input+policy+data→decision`；OPA 只管判定，审计/审批队列要自己建。
- [ParaBank](https://parabank.parasoft.com/parabank/index.htm) — legacy 银行 demo 站形态参考（JSP、table 布局、无 test-id）；仅作观感参考，不作为自动化目标。
- [Playwright MCP + noVNC Docker（HN 讨论）](https://news.ycombinator.com/item?id=47544662) — 如果 CDP 接管方案翻车，这是 fallback。

**Sources（本计划所依据的检索结果）：**
- [Get Experience from Practice: LLM Agents with Record & Replay](https://arxiv.org/pdf/2505.17716)
- [browser-use/workflow-use](https://github.com/browser-use/workflow-use) · [HN 讨论](https://news.ycombinator.com/item?id=44007065)
- [How caching works in Stagehand](https://www.browserbase.com/blog/stagehand-caching) · [Stagehand Act](https://docs.stagehand.dev/v3/basics/act) · [stagehand repo](https://github.com/browserbase/stagehand)
- [Skyvern Code Caching](https://www.skyvern.com/docs/developers/features/code-caching)
- [Browserbase Session Live View](https://docs.browserbase.com/features/session-live-view) · [Steel human-in-the-loop](https://docs.steel.dev/overview/sessions-api/human-in-the-loop) · [steel-browser](https://github.com/steel-dev/steel-browser)
- [Playwright MCP Snapshots](https://playwright.dev/mcp/snapshots) · [Playwright Locator](https://playwright.dev/docs/api/class-locator) · [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer)
- [Multi-Locators (Leotta et al., ICST 2015)](https://tsigalko18.github.io/assets/pdf/2015-Leotta-ICST.pdf) · [ROBULA+ (JSEP 2016)](https://www.researchgate.net/publication/299336358_Robula_An_algorithm_for_generating_robust_XPath_locators_for_web_testing)
- [microsoft/presidio](https://github.com/microsoft/presidio)
- [Why OPA is the missing guardrail for your AI agents](https://codilime.com/blog/why-use-open-policy-agent-for-your-ai-agents/)
- [rrweb](https://rrweb.com/) · [ParaBank](https://parabank.parasoft.com/parabank/index.htm)
- [Playwright MCP with noVNC (HN)](https://news.ycombinator.com/item?id=47544662)
