# RLM extension for PI (pi-mono)

Port of the RLM plugin to PI's extension API. Reuses the same `kernel/kernel.py`
and the same context-lake JSONL format as the OpenCode plugin, so state is
portable between editors.

## Tools registered

| Tool | What it does |
|---|---|
| `ipython` | Persistent Python kernel (state survives across calls, `%%bash`, `%cd`, top-level await, timeouts, output caps) |
| `rlm_store` / `rlm_get` / `rlm_search` / `rlm_find` / `rlm_stats` / `rlm_forget` | Context lake — large data that never enters the LLM prompt |
| `rlm` | Background subagent via `pi --mode json "<prompt>"` — returns an admission handle immediately |
| `rlm_result` / `rlm_list` | Child results and listing |

## Install (local)

```bash
# 1. Copy the extension
cp pi-extension/rlm.ts ~/.pi/agent/extensions/rlm.ts

# 2. Copy the kernel
mkdir -p ~/.pi/agent/rlm-kernel
cp kernel/kernel.py ~/.pi/agent/rlm-kernel/kernel.py

# 3. Reload pi (/reload) or restart
```

Optional env vars: `RLM_KERNEL`, `RLM_KERNEL_PYTHON`.

## Publish to pi.dev

PI's plugin registry is **https://pi.dev/packages** (5,000+ packages). Extensions
are npm packages. To publish:

```bash
# package.json for the extension
npm init
# name it e.g. "rlm-pi" — the extension file is the main entry
# then:
npm publish
```

Users install it with `pi`'s package mechanism (npm or git package installs
under `~/.pi/agent/`), or by copying the file to `~/.pi/agent/extensions/`.

## Notes

- The `rlm` subagent tool spawns `pi --mode json "<prompt>"` as a subprocess
  and streams its JSON events to a file; `rlm_result` reads the tail.
- The kernel is the same `kernel/kernel.py` used by the OpenCode plugin — one
  runtime, two editors.
- The context lake file format is identical to the OpenCode plugin
  (`~/.pi/agent/rlm-state/lake/` here vs `~/.config/opencode/rlm-state/lake/`
  there) — data written by one editor is readable by the other.