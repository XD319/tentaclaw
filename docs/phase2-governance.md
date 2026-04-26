# Phase 2 Governance Notes

## Policy Engine

The Phase 2 policy engine lives in `src/policy/policy-engine.ts` and evaluates a typed `PolicyEvaluationInput` into:

- `allow`
- `allow_with_approval`
- `deny`

Rule source is local-only for now. Rules are defined in `src/policy/default-policy-config.ts` and matched by descending `priority`.

Supported policy dimensions:

- `userId`
- `workspaceRoot`
- `agentProfileId`
- `toolName`
- `capability`
- `riskLevel`
- `privacyLevel`
- `pathScope`

## Approval Flow

Approval data is persisted through `ApprovalRepository` and is intentionally separate from tool-call rows.

Approval lifecycle:

- `pending`
- `approved`
- `denied`
- `timed_out`

Runtime lifecycle around approvals:

- tool call enters `awaiting_approval`
- task enters `waiting_approval`
- execution checkpoint is written
- approval allow resumes the task
- approval deny or timeout fails the task

CLI commands:

- `talon approve pending`
- `talon approve allow <approval_id>`
- `talon approve deny <approval_id>`

## Sandbox

The sandbox MVP lives in `src/sandbox/sandbox-service.ts` and enforces:

- workspace-root file read boundaries
- write-root file write boundaries
- shell cwd restriction
- env allowlist
- shell executable allowlist
- obvious dangerous shell pattern denylist
- network access closed to shell and controlled through `web_fetch`

Sandbox planning happens before tool execution and every allow/deny outcome is recorded into trace and audit.

## Audit vs Trace

Trace is the execution-chain view:

- provider request/response
- policy decision
- approval request/resolution
- sandbox allow/deny
- tool call start/finish/fail
- final task outcome

Audit is the governance view:

- high-risk tool requests
- policy decisions
- approval actions
- file writes
- shell executions
- web fetches
- rejections and failures

## Reviewer Profile

The `reviewer` profile reuses the same execution kernel as other profiles but changes:

- prompt
- execution policy
- applicable policy rules

Boundaries:

- no custom scheduler
- no multi-agent orchestration
- visible mutation tools may still be denied at execution time
