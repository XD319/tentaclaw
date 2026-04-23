# Architecture

```mermaid
flowchart LR
  CLI[CLIEntry] --> Bootstrap[createApplication]
  Bootstrap --> SchedulerSvc[SchedulerService]
  Bootstrap --> JobRunner[JobRunner]
  Bootstrap --> DeliverySvc[DeliveryService]
  Bootstrap --> InboxSvc[InboxService]
  Bootstrap --> InboxCollector[InboxCollector]
  Bootstrap --> CommitmentSvc[CommitmentService]
  Bootstrap --> NextActionSvc[NextActionService]
  Bootstrap --> CommitmentCollector[CommitmentCollector]
  Bootstrap --> CommitmentProjector[ThreadCommitmentProjector]
  Bootstrap --> ThreadSvc[ThreadService]
  Bootstrap --> SnapshotSvc[SessionSnapshotService]
  Bootstrap --> CtxCompactor[ContextCompactor]
  Bootstrap --> Kernel[ExecutionKernel]
  ThreadSvc --> Kernel
  SnapshotSvc --> Kernel
  CtxCompactor --> Kernel
  SchedulerSvc --> JobRunner
  JobRunner --> Kernel
  Trace --> InboxCollector
  Trace --> CommitmentCollector
  InboxCollector --> InboxSvc
  CommitmentCollector --> CommitmentSvc
  CommitmentCollector --> NextActionSvc
  CommitmentSvc --> CommitmentProjector
  NextActionSvc --> CommitmentProjector
  InboxSvc --> Storage
  InboxSvc --> DeliverySvc
  Kernel --> Tools[ToolOrchestrator]
  Tools --> Policy[PolicyEngine]
  Kernel --> Trace[TraceService]
  Kernel --> Memory[MemoryPlane]
  Kernel --> Experience[ExperiencePlane]
  Bootstrap --> Storage[SQLiteStorage]
```

Core data path:

1. CLI parses command and resolves app config.
2. Kernel creates task/run metadata.
3. Provider loop executes with policy + tool orchestration.
4. Trace/audit/memory/experience are persisted in SQLite.
5. Threads own cross-run continuity; each task run is linked into thread lineage.
6. Compaction emits structured `thread_snapshots`, and resume injects snapshot-derived goal/open-loop context.
7. SchedulerService persists due work into `schedule_runs`; JobRunner executes queued runs, records retries with backoff, and links each background run back to task/thread.
8. InboxCollector maps trace/approval/experience signals into `inbox_items` via InboxService; delivery events fan out through DeliveryService so CLI/Gateway read the same stream.
9. CommitmentCollector maps task/snapshot/approval/success/failure trace signals into `commitments` and `next_actions` so continuation can restore the next step.
10. Resume packets include commitment summaries (`current objective`, `next action`, `blocked reason`, `pending decision`) in `threadResume` metadata.
11. External channels must consume runtime delivery subscriptions and must not bypass runtime to write direct notifications.
