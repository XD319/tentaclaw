# AutoTalon v0.1.0

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/XD319/auto-talon/actions/workflows/ci.yml/badge.svg)](https://github.com/XD319/auto-talon/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.0-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

面向日常执行的轻量级个人助理。

AutoTalon 面向希望长期运行个人助理、同时又不想放弃可检查性、本地控制权和成本感知的知识工作者。`talon tui`
是日常工作的默认入口：today、inbox、threads、memory review 以及受治理的任务执行都集中在同一个工作区中。CLI
仍然承担自动化、诊断和维护接口的角色，而 Feishu/Lark 与 webhook gateway 则提供接入同一运行时的正式外部聊天入口。

## 主要入口

- `talon tui`
  日常主工作区，用于对话、处理 inbox、跟进线程，以及带记忆能力的执行。
- `talon gateway serve-feishu`
  Feishu/Lark 的外部即时通讯入口，适合把助手放进聊天工作流中。
- `talon run` / `talon continue`
  面向自动化、批处理和精确排查的终端脚本化入口。

## 能力概览

- 通过 `talon tui` 打开个人助理工作区，围绕 today / inbox / thread 工作流运行。
- 通过 Feishu/Lark 和本地 webhook adapter 提供正式聊天接入。
- 在本地 SQLite 工作区中记录任务状态、trace 事件、tool call、approval 和 audit log。
- 用策略和显式审批流拦截高风险工具调用。
- 在 TUI 和 CLI 中都提供 memory review，包括 used-memory 反馈和 inbox 驱动的建议。
- 提供分层记忆模型（`profile` / `project` / `working` + `experience_ref` / `skill_ref`）以支持可复用工作。
- 通过 `talon ops` 和 CLI 检查命令保留运行时观测能力。
- 支持 replay、smoke tests、eval reports 和维护者 release checks。

## 演示

```text
$ talon init --yes
Initialized .auto-talon workspace files.

$ talon tui
# 打开日常工作区。
# 启动或继续线程、处理 inbox 项、查看 memory 建议。

$ talon task list
$ talon trace <task_id> --summary
$ talon audit <task_id> --summary
# 当你需要精确检查或自动化时，再切回 CLI。
```

## 快速开始

环境要求：

- Node.js `>=22.13.0`
- 从源码安装时需要启用 Corepack

安装发布包：

```bash
npm install -g auto-talon
talon init --yes
talon tui
```

可选的聊天平台入口：

```bash
pnpm add @larksuiteoapi/node-sdk
talon gateway serve-feishu --cwd .
```

源码运行：

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev tui
```

## 典型使用流

在 TUI 中完成日常工作：

```bash
talon tui
talon ops
```

把助手接入聊天平台：

```bash
talon gateway serve-feishu --cwd .
talon gateway list-adapters
```

通过 CLI 自动化或排查：

```bash
talon run "review the changed files"
talon continue --last
talon task list
talon trace <task_id> --summary
talon audit <task_id> --summary
```

本地 API / SDK 集成：

```bash
talon gateway serve-webhook --port 7070
```

验证 provider 和发布就绪度：

```bash
talon provider list
talon provider test
talon eval smoke
talon release check
```

## 适用场景

- 你想要一个以 TUI 为中心、同时具备可审计执行历史的个人助理工作区。
- 你希望 today / inbox / thread 操作仍然贴近终端工作流，但又不希望产品退化成一次性 prompt 执行器。
- 你希望助手可以在 TUI、CLI 和聊天平台入口之间切换，同时共享同一套 governed runtime、memory、approvals 和 audit trail。
- 你需要在文件或 shell 操作前具备策略与审批行为。
- 你想围绕持续性知识工作使用 durable memory、skill recall、replay 和 eval 工具，而不仅仅是一次性问答。

## 产品定位

AutoTalon 是一个面向个人操作者和知识工作者的本地优先个人助理产品，背后是可检查的运行时，而不是托管黑盒。面向用户的承诺是一个低成本、可长期使用的助手：以 TUI 工作区为主入口，辅以 CLI 自动化与诊断，并通过 Feishu/Lark 等 adapter 提供正式外部聊天入口。核心包刻意保持轻量，相关集成只会在对应 gateway 命令运行时才加载。运行时观测通过 `talon ops` 提供，而 `talon dashboard` 仍作为兼容别名保留。

## 文档

用户文档：

- `docs/user/install.md`
- `docs/user/quickstart.md`
- `docs/user/commands.md`
- `docs/user/replay-and-eval.md`
- `docs/user/approvals.md`
- `docs/user/skills.md`
- `docs/user/gateway.md`
- `docs/user/mcp.md`
- `docs/user/config-reference.md`

开发者文档：

- `docs/dev/architecture.md`
- `docs/dev/module-boundaries.md`
- `docs/dev/plugin-development.md`
- `docs/dev/testing.md`

故障排查：

- `docs/troubleshooting/provider.md`
- `docs/troubleshooting/sandbox.md`
- `docs/troubleshooting/gateway.md`
- `docs/troubleshooting/memory.md`

## 发布校验

```bash
corepack pnpm check
corepack pnpm dev release check
```

`talon release check` 是这个仓库面向维护者的发布门禁。普通用户工作区健康检查请使用 `talon doctor`。
