# Architecture

```mermaid
flowchart LR
  CLI[CLIEntry] --> Bootstrap[createApplication]
  Bootstrap --> SchedulerSvc[SchedulerService]
  Bootstrap --> JobRunner[JobRunner]
  Bootstrap --> ThreadSvc[ThreadService]
  Bootstrap --> SnapshotSvc[SessionSnapshotService]
  Bootstrap --> CtxCompactor[ContextCompactor]
  Bootstrap --> Kernel[ExecutionKernel]
  ThreadSvc --> Kernel
  SnapshotSvc --> Kernel
  CtxCompactor --> Kernel
  SchedulerSvc --> JobRunner
  JobRunner --> Kernel
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
