你现在在实现一个“Agent Runtime MVP（无 Web UI 版）”项目。

项目目标：
做一个以 CLI + 轻 TUI 为主入口的 agent runtime。首版优先打磨统一执行内核、工具治理、记忆治理、权限治理与任务可观测性，而不是先做 Web UI、多消息平台或复杂 swarm。

技术栈要求：
1. 使用 TypeScript 作为主语言。
2. 运行时基于 Node.js 20+。
3. 使用 pnpm 管理依赖。
4. CLI 使用 commander 或 yargs。
5. TUI 使用 React + Ink。
6. 测试使用 vitest。
7. 输入校验与 schema 校验优先使用 zod。
8. 持久化优先使用 SQLite。
9. 数据访问必须通过 storage/repositories 层封装，禁止在 runtime、tools、policy、memory 中直接执行 SQL。
10. 所有核心模块必须有清晰的 TypeScript types/interfaces，开启 strict mode。
11. 不要引入 LangChain、Mastra、AutoGen 等会主导系统骨架的 agent 框架。
12. 模型调用必须通过 Provider 接口抽象，禁止在 Runtime Core 中直接依赖某家模型 SDK。可以先实现 MockProvider，后续再接真实 Provider。

请严格遵循以下架构原则：
1. 执行内核驱动外壳：CLI/TUI 只是入口和观察面，不能把核心业务逻辑散落到 UI 层。
2. 核心分层必须清晰：Execution Kernel、Tool Orchestrator、Memory Plane、Policy Plane、Persistence、Tracing。
3. 所有能力优先做最小可用版本，但代码结构必须为后续扩展留好边界。
4. 默认强调可治理、可审计、可解释，而不是“先能跑再说”。
5. 所有高风险动作必须可追踪。
6. 不实现 Web UI，不实现多消息平台，不实现自由 swarm，不实现复杂自我改进闭环。
7. 后续可能扩展 Gateway / Adapter 层，但当前阶段不能让这部分侵入 Runtime Core。
8. 要重视信息边界控制：进入模型上下文、进入持久化、进入 memory、进入 trace 的内容都要有明确边界。
9. 要重视记忆质量控制：错误记忆、冲突记忆、过时记忆不能被当作正常记忆直接使用。
10. 要重视 trace 可用性：trace 不是简单日志堆积，而是可以重建一次长任务的完整决策链。

工程实现要求：
1. 建立 package.json、tsconfig.json、eslint 配置、基础 scripts。
2. 所有核心类型放在独立模块中，避免循环依赖。
3. 所有阶段都要补最小必要测试。
4. 每完成一个阶段：
   - 运行测试并修复明显问题
   - 输出“本阶段完成项 / 未完成项 / 已知风险”
   - git add -A
   - git commit，commit message 使用主流格式

TypeScript/Node.js 工程风格要求：
1. 使用组合与接口，不要设计过深的继承体系。
2. 避免 giant class。
3. 避免 any。
4. 优先用纯函数、service 边界、工厂函数和清晰依赖注入组织复杂逻辑。
5. 避免在命令层和 Ink 组件中塞核心业务逻辑。
6. 尽量减少隐式共享状态。
7. 建立统一的 types/ 或 domain/ 类型模块，集中定义 Task、TraceEvent、ToolCall、PolicyDecision、MemoryRecord、Approval、AdapterCapability 等核心类型，避免重复定义和隐式结构。

如果遇到实现分歧，优先选择：
- 更强可维护性
- 更强可审计性
- 更强边界清晰度
- 更少隐式魔法
- 更符合 TypeScript/Node.js 工程最佳实践