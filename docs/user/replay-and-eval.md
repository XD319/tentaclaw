# Replay and Eval

## Replay

```bash
agent replay <task_id>
agent replay <task_id> --provider mock --from-iteration 2
agent replay <task_id> --dry-run
```

## Eval

```bash
agent eval run
agent eval run --provider scripted-smoke --explain
agent eval smoke
agent eval beta
```

For auto-talon maintainer release verification, run `agent release check` from the repository root.
