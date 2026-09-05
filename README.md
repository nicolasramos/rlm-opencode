# rlm-opencode — RLM plugin for OpenCode

Port of Prime Agent's **RLM (Recursive Language Model)** programming model to
OpenCode: a persistent Python kernel the model composes capabilities with,
plus native background subagents.

- `plugin/rlm.ts` — the OpenCode plugin (tools + hooks)
- `kernel/kernel.py` — self-contained persistent Python REPL runtime
- `tests/test_kernel.py` — 20 protocol tests (all pass)
- `ANALYSIS.md` — deep investigation of prime-agent's RLM and the port design

## What you get

| Tool | What it does |
|---|---|
| `ipython` | Execute Python in a **persistent kernel**. Variables, imports, functions and results survive across calls. `%%bash` for shell, `%cd` for persistent cwd. Output is capped to keep the model context lean. |
| `rlm` | Spawn a **background subagent** and get an admission handle immediately. The child runs with its own context; results arrive later. |
| `rlm_list` | List the children of the current session. |
| `rlm_result` | Get a child's answer (`{status: running|completed|error, text}`). |
| `rlm_delete` | Delete a child (cancels its session). |
| `rlm_snapshot` | Persist the kernel namespace to disk. |
| `rlm_restore` | Reload the kernel namespace from the last snapshot. |

Plus hooks: automatic snapshot + variable summary injected into the
compaction prompt, RLM usage instructions in the system prompt, kernel
cleanup on session delete.

## Install

```bash
cp plugin/rlm.ts ~/.config/opencode/plugins/rlm.ts
mkdir -p ~/.config/opencode/rlm-kernel
cp kernel/kernel.py ~/.config/opencode/rlm-kernel/kernel.py
# restart opencode (plugins load at startup)
```

Optional env vars:

- `RLM_KERNEL` — alternate path to `kernel.py`
- `RLM_KERNEL_PYTHON` — Python interpreter (default: `python3` on PATH)

Snapshots live in `~/.config/opencode/rlm-state/<sessionID>/kernel-state.pkl`.

## Example session

```
> Store the first 5 primes in a variable, then double the last one.

⚙ ipython {"code": "primes = [2, 3, 5, 7, 11]"}
⚙ ipython {"code": "primes[-1] * 2"}
→ 22
```

```
> Review the auth flow in the background while I keep working.

⚙ rlm {"prompt": "Review the authentication flow for security issues", "name": "auth-reviewer"}
→ {"rlm_child_id": "ses_...", "name": "auth-reviewer", "status": "running"}

⚙ rlm_result {"child": "auth-reviewer"}
→ {"status": "completed", "text": "..."}
```

## How it works

```
OpenCode server (Bun)
  └─ plugin/rlm.ts
       ├─ ipython ──► kernel.py subprocess (JSON-lines over stdio)
       │               persistent namespace · top-level await · %%bash · %cd
       │               snapshot/restore · interrupt · timeouts · output caps
       ├─ rlm ─────► child OpenCode session (parentID) + fire-and-forget prompt
       │               → handle immediately; child processes in background
       ├─ rlm_list / rlm_result / rlm_delete
       ├─ rlm_snapshot / rlm_restore
       ├─ session.compacting hook → snapshot + inject variable summary
       └─ system.transform hook → RLM usage instructions
```

One kernel per OpenCode session, spawned lazily on first `ipython` use.
Children get their own session → their own kernel (same as prime-agent).

## Requirements

- OpenCode ≥ 1.18 (plugin API with `tool` hook)
- Python 3.9+ (3.11+ recommended) — stdlib only; `dill` optional for richer
  snapshots

## Test

```bash
python3 tests/test_kernel.py          # kernel protocol tests (20/20)
```

## Notes / gotchas

- `noReply: true` on `session.prompt` adds the message as context only — the
  child session never runs. The plugin uses a fire-and-forget prompt instead.
- Children die with the server: with `opencode run` (ephemeral server) a child
  may not finish; in the TUI or a persistent server they survive.
- The kernel is a durable control environment, **not a security sandbox** —
  same trust model as prime-agent. Use an external sandbox for untrusted
  repos.
- Recursion depth is limited to 2 (root → child → grandchild).

## License

MIT