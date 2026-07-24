# 路线图

[English](ROADMAP.md) | [简体中文](ROADMAP.zh-CN.md)

本文档说明 `v0.1.0` 之后下一版本的方向。这是一份会随 eval 与用户反馈调整的活文档。

- 当前版本：`v0.1.1`（见 [CHANGELOG.md](CHANGELOG.md)）
- 下一目标：`v0.2.0`
- 主题：**可信的自我改进，更低成本** —— 能被测量的进化 —— **∥ 桌面 companion**（并行产品面）。

## 如何阅读本文档

每个工作项都带标签，方便贡献者快速找到可上手的切入点：

- **Ownership（归属）**
  - `maintainer` —— 需要设计决策、触及安全/治理核心，或依赖付费真实模型验证。不外包。
  - `community` —— 边界清晰、自包含；欢迎外部贡献者认领。
  - `mixed` —— 规格由维护者确定，实现可由贡献者认领。
- **Difficulty（难度）**：`good-first-issue`、`intermediate`、`advanced`。
- **Paid model（是否需付费模型）**：验证改动是否需要真实（付费）provider，还是可用 mock / scripted-smoke 验证。

想认领某项工作前，请先在对应 tracking issue 下评论声明，并阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 为什么是这些方向

`v0.1.0` 已经是一套较成熟的 local-first agent（sandbox、审批、trace、audit、rollback、memory、experience、调度、gateway、MCP）。本版本主要补两处缺口：

1. **成本：缓存已计量，但从未主动触发。** 运行时已端到端记账 `cachedInputTokens`（成本计算器、budget、telemetry、replay、eval），但 Anthropic-compatible provider 并未发送 `cache_control` 断点 —— 因此缓存命中只在「碰巧发生」时被记录，从未被主动创建。补上这一步风险低、ROI 高。
2. **质量：自进化闭环未被验证。** `ExperiencePlane` 与 `PromotionAdvisor`（从重复成功模式自动晋升 skill）已存在，但 eval 套件只测盲测能力。没有任何评测去衡量复利闭环：*经验被捕获 → 被晋升 → 性能真的提升*。

其余工作都建立在：先让这个闭环可测，再用同一套测量去证明成本与质量收益。

第三个产品缺口是缺少图形化 companion。`v0.2.0` 增加一条**并行**桌面赛道（Tauri 壳 + session-api sidecar），不取代 TUI，也不取代测量/降本主线。见
[docs/dev/desktop-companion.md](docs/dev/desktop-companion.md)。

## 依赖关系概览

```
M1 测量骨架 ─┬─→ M2 降本（用数字证明省了多少）
             └─→ 性能工作（用数字证明变强了）
M3 硬化 = 贯穿各里程碑的卫生任务
M4 降门槛 = 独立赛道，本版若冲采用量再做
M5 桌面 companion = 并行赛道（Tauri + session-api；不取代 TUI）
```

建议节奏：**M1 与 M2 并跑**（M1 立测量骨架，M2 先落地高 ROI 降本），M3 持续内化，M4 在本版冲采用量时启动，**M5 并行推进**且不阻塞测量/降本的发版标准。

---

## M1 — 测量骨架

目标：让「agent 变强了」「自进化起作用了」可被证明，而非口头主张。

| 工作项 | Ownership | Difficulty | Paid model | 说明 |
| --- | --- | --- | --- | --- |
| 将「性能」定义为固定 eval 指标（成功率 / 平均回合数 / 每次成功的 token 数），并接入 gate 阈值 | `maintainer` | — | 否 | 设计决策；之后所有改进都相对该 baseline 报告。 |
| 自进化 **compounding eval** runner：同一任务集在「经验/skill 为空」与「已积累」下各跑一遍，并 diff 指标 | `maintainer` | advanced | 是 | 整合 eval core + experience plane；gate 增加「自进化不得回退」。 |
| 扩充 compounding eval **任务数据集**（runner 落地后） | `community` | intermediate | 否 | 在现有 `EvalSuiteManifest` 契约下的数据工作；每个任务至少一个必需确定性 scorer。 |

参考：`src/evaluation/`、`fixtures/eval-baselines/`、
[docs/dev/evaluation.md](docs/dev/evaluation.md)、
[docs/experience-plane.md](docs/experience-plane.md)。

## M2 — 降低 token 成本

目标：用 prompt caching 降本，并用数字证明（记账链路已通过 `cost_report` 与 eval tokens 暴露效果）。

| 工作项 | Ownership | Difficulty | Paid model | 说明 |
| --- | --- | --- | --- | --- |
| 在 Anthropic-compatible provider 的稳定前缀（system prompt、tool schema、稳定 memory 前缀）上发送 `cache_control: { type: "ephemeral" }` 断点 | `mixed` | advanced | 部分 | 维护者确认断点策略与 `anthropic-beta` header 要求；实现可认领。 |
| Prompt **前缀稳定化** —— 将 prompt 排成「稳定 → 可变」以最大化缓存命中 | `mixed` | intermediate | 否 | 不得破坏现有 compaction / 尾部保护。 |
| OpenAI-compatible **缓存 token 计量核对** —— 确认 usage 解析把缓存命中字段映射进 `cachedInputTokens` | `community` | intermediate | 否 | telemetry 层、自包含、可用单测。 |
| 缓存配置与预期节省的文档 | `community` | good-first-issue | 否 | 纯文档。 |

参考：`src/providers/anthropic-compatible-provider.ts`（`system` + `messages` 附近的请求体构造）、
`src/providers/provider-telemetry.ts`、`src/runtime/budget/cost-calculator.ts`、
`src/runtime/kernel/budget-recorder.ts`、
[docs/dev/context-window.md](docs/dev/context-window.md)、
[docs/provider-routing-budget.md](docs/provider-routing-budget.md)。

## M3 — 硬化

目标：挡住回归。修 bug 是卫生工作，不是支柱 —— 单个 bug 边界天然清晰，适合作为入门任务。

| 工作项 | Ownership | Difficulty | Paid model | 说明 |
| --- | --- | --- | --- | --- |
| eval / replay 暴露出的回归修复 | `community` | good-first-issue → intermediate | 视情况 | 一个 issue 对应一个 bug。 |
| 任何涉及 sandbox / approval / policy 的改动 | `maintainer` | — | — | 安全/治理核心；不外包。 |

参考：[docs/user/replay-and-eval.md](docs/user/replay-and-eval.md)、
[docs/beta-readiness.md](docs/beta-readiness.md)。

## M4 — 降低使用门槛

目标：减少首次跑通摩擦。若 `v0.2.0` 冲采用量则做；否则可顺延。

| 工作项 | Ownership | Difficulty | Paid model | 说明 |
| --- | --- | --- | --- | --- |
| ripgrep 缺失 → 优雅降级与明确指引 | `community` | good-first-issue | 否 | 独立、可测。 |
| `talon doctor --fix` 迁移体验改进 | `community` | intermediate | 否 | 边界清晰；用测试覆盖。 |
| 交互式 `provider setup` UX 改进 | `community` | good-first-issue → intermediate | 否 | 低风险 UX。 |
| Quickstart / README 打磨（无凭据 mock 全流程） | `community` | good-first-issue | 否 | 文档；保持 `README.md` 与 `README.zh-CN.md` 同步。 |

参考：[docs/user/quickstart.md](docs/user/quickstart.md)、
[docs/user/windows-troubleshooting.md](docs/user/windows-troubleshooting.md)、
`scripts/setup.ps1`。

## M5 — 桌面 companion（并行）

目标：本地优先的图形化 companion，通过 `session-api` 驱动**现有** Node runtime，不另起第二套 kernel。

锁定技术栈：Tauri 2 壳、Vite + React UI、`talon session-api serve` 作为 sidecar（loopback + Bearer）。

| 阶段 | 工作项 | Ownership | Difficulty | Paid model | 说明 |
| --- | --- | --- | --- | --- | --- |
| M5a | 落地 `apps/desktop`（Tauri 2 + Vite/React）、sidecar 拉起、健康检查、token 注入 | `mixed` | advanced | 否 | [#11](https://github.com/XD319/auto-talon/issues/11)。规格见 ADR；维护者确认后可认领。**必达**。 |
| M5b | 只读会话浏览器与 transcript 查看 | `community` | intermediate | 否 | [#13](https://github.com/XD319/auto-talon/issues/13)。视需要依赖 API。**必达**。 |
| M5b API | 在 session-api 暴露只读 ops 视图（tasks / trace / pending approvals） | `mixed` | intermediate | 否 | [#12](https://github.com/XD319/auto-talon/issues/12)。契约由维护者主导。 |
| M5c | 审批队列 + allow/deny（经 API 走与 TUI 相同的 PolicyEngine） | `mixed` | advanced | 否 | [#14](https://github.com/XD319/auto-talon/issues/14)。安全敏感；v0.2 **尽力而为**。 |
| M5d | 在 companion 内用 session `continue` / 新会话聊天（先非流式） | `community` | intermediate | 否 | [#15](https://github.com/XD319/auto-talon/issues/15)。stretch；流式另开。 |
| M5e | Windows 打包 + 首次打开选 workspace | `mixed` | advanced | 否 | [#16](https://github.com/XD319/auto-talon/issues/16)。stretch；Windows 优先。 |
| docs | 保持 companion ADR / 安全边界准确 | `community` | good-first-issue | 否 | [#10](https://github.com/XD319/auto-talon/issues/10)。ADR 已落地。 |

**v0.2.0 对 M5 的成功标准：** M5a + M5b 必达；M5c 尽力而为；M5d/M5e 为 stretch，不得阻塞以测量/降本为主的发版。

安全红线（不可认领）：公网绑定、弱化 HTTP 鉴权、绕过审批/沙箱、在壳内重写执行内核。

参考：[docs/dev/desktop-companion.md](docs/dev/desktop-companion.md)、
[docs/dev/session-api.md](docs/dev/session-api.md)、`src/session-api/server.ts`、
`src/core/http-auth.ts`。

---

## 贡献者速览

按难度大致递增，适合起步的切入点：

1. Quickstart / README 打磨（M4）—— `good-first-issue`，文档。
2. ripgrep 降级与指引（M4）—— `good-first-issue`。
3. 交互式 `provider setup` UX（M4）—— `good-first-issue`。
4. 缓存配置文档（M2）—— `good-first-issue`，文档。
5. OpenAI-compatible 缓存 token 计量核对（M2）—— `intermediate`。
6. `doctor --fix` 迁移体验（M4）—— `intermediate`。
7. 桌面只读会话浏览器（M5b，API 就绪后）—— `intermediate`。
8. 桌面聊天（经 `continue`，M5d）—— `intermediate`。
9. Compounding eval 数据集扩充（M1，runner 落地后）—— `intermediate`。
10. Anthropic `cache_control` 发火（M2）—— `advanced`，需维护者先确认规格。
11. 桌面 Tauri 脚手架 / 打包（M5a/M5e）—— `advanced`，ADR 确认后。

维护者主导（请勿开成会削弱这些边界的社区认领 issue）：

- 性能指标定义与 gate 阈值（M1）。
- Compounding eval runner 架构（M1）。
- 任何绕过治理的 sandbox / approval / policy 改动（M3 / M5）。
- 公网 HTTP 绑定、取消鉴权，或在 companion 内另起第二套执行内核。
