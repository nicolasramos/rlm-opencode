# rlm-opencode

**RLM (Recursive Language Model) for OpenCode** — a persistent Python kernel, native background subagents, and a context lake that keeps large data **out of the LLM prompt**.

Ported from [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)'s RLM runtime and the [RLM paper (arXiv:2512.24601)](https://arxiv.org/abs/2512.24601). Self-contained: no dependency on prime-agent.

---

## Why RLM?

LLM agents degrade as context grows: cost rises linearly, performance drops ("context rot"), and every turn re-sends the same data. RLM treats context as **variables** instead of stuffing everything into the prompt:

```
Traditional:  Context (huge) → prompt → LLM → 💀 context rot, cost explosion
RLM:          Context → kernel / lake (external) → LLM calls tools to get only what it needs → ✅
```

The model keeps working state in a **persistent Python kernel** and large reference data in a **context lake**, then queries both with small tool calls. The big data **never enters the prompt**.

## What you get

| Tool | What it does | RLM aspect |
|---|---|---|
| `ipython` | Execute Python in a **persistent kernel**. Variables, imports, functions and results survive across calls. `%%bash` for shell, `%cd` for persistent cwd, top-level `await`, timeouts, output caps. | Programmatic execution |
| `rlm` | Spawn a **background subagent** and get an admission handle immediately. The child runs with its own context; results arrive later. | Recursive subagents |
| `rlm_list` / `rlm_result` / `rlm_delete` | Manage children: list, read results, delete. | Recursive subagents |
| `rlm_snapshot` / `rlm_restore` | Persist / reload the kernel namespace to disk. Survives compaction and restarts. | Durable state |
| `rlm_store` | Store large data in the **context lake** (per-project, persistent). Stored data is NOT in the prompt. | Context folding |
| `rlm_get` / `rlm_search` / `rlm_find` | Retrieve from the lake: by key, by regex, by text — snippets only, on demand. | Context folding |
| `rlm_stats` / `rlm_forget` | Lake statistics and cleanup. | Context folding |
| `rlm_lake` (in kernel) | From Python cells: `rlm_lake.store(key, data)` writes a kernel variable straight into the lake — no prompt round-trip. | Context folding |

Plus hooks: automatic kernel snapshot + variable summary injected into the **compaction prompt**, RLM usage instructions in the **system prompt**, **auto-capture** of large tool outputs (>10KB) into the lake, kernel cleanup on session delete.

## Architecture

```
OpenCode server (Bun)
  └─ plugin/rlm.ts
       ├─ ipython ──► kernel.py subprocess (JSON-lines over stdio)
       │               persistent namespace · top-level await · %%bash · %cd
       │               snapshot/restore · interrupt · timeouts · output caps
       ├─ rlm ─────► child OpenCode session (parentID) + fire-and-forget prompt
       │               → handle immediately; child processes in background
       ├─ rlm_store/get/search/find/stats/forget ──► context lake (JSONL, per project)
       ├─ tool.execute.after hook → auto-captures outputs >10KB into the lake
       ├─ session.compacting hook → kernel snapshot + variable summary
       └─ system.transform hook → RLM usage instructions
```

One kernel per OpenCode session, spawned lazily on first `ipython` use. Children get their own session → their own kernel (same as prime-agent). The context lake is per project directory, shared across sessions.

## Install

Requirements: OpenCode ≥ 1.18, Python 3.9+ (3.11+ recommended, stdlib only; `dill` optional for richer snapshots).

```bash
git clone https://github.com/nicolasramos/rlm-opencode.git
cd rlm-opencode
./install.sh          # copies plugin + kernel to ~/.config/opencode/
# restart opencode
```

Or manually:

```bash
cp plugin/rlm.ts ~/.config/opencode/plugins/rlm.ts
mkdir -p ~/.config/opencode/rlm-kernel
cp kernel/kernel.py ~/.config/opencode/rlm-kernel/kernel.py
```

**Works by default**: plugins in `~/.config/opencode/plugins/` auto-load at startup. All 13 tools are registered for every session and the RLM instructions are injected into the system prompt. No config changes needed.

Optional env vars:

- `RLM_KERNEL` — alternate path to `kernel.py`
- `RLM_KERNEL_PYTHON` — Python interpreter (default: `python3` on PATH)

State lives in `~/.config/opencode/rlm-state/` (kernel snapshots per session, context lake per project).

## Usage

### Persistent kernel

```text
> Store the first 5 primes in a variable, then double the last one.

⚙ ipython {"code": "primes = [2, 3, 5, 7, 11]"}
⚙ ipython {"code": "primes[-1] * 2"}
→ 22
```

The state survives across calls, compaction, and (with `rlm_snapshot`/`rlm_restore`) restarts.

### Background subagents

```text
> Review the auth flow in the background while I keep working.

⚙ rlm {"prompt": "Review the authentication flow for security issues", "name": "auth-reviewer"}
→ {"rlm_child_id": "ses_...", "name": "auth-reviewer", "status": "running"}

⚙ rlm_result {"child": "auth-reviewer"}
→ {"status": "completed", "text": "..."}
```

### Context lake (data that never enters the prompt)

```text
> Store the full build log in the lake, then find the failing test.

⚙ ipython {"code": "logs = open('build.log').read()"}          # 2MB in the kernel
⚙ rlm_store {"key": "build-log", "content": "logs"}            # 2MB in the lake, NOT in the prompt
⚙ rlm_search {"pattern": "FAILED|error"}                       # snippets only
→ 1. build-log (2,048,000 chars)
   …FAILED test_api_orders — AssertionError: expected 200…
```

## Keeping context out of the LLM — proof

The test battery (`tests/e2e_battery.mjs`) proves the big data never enters the prompt with three independent signals:

1. **Correctness** — the model answers questions that require the data.
2. **Tool inputs** — the `ipython`/`rlm_store` calls are small code cells (largest observed: **122 chars**); the data never appears in tool arguments.
3. **Tokens** — total input tokens stay at baseline (system prompt + tool definitions) instead of growing with the data.

| Scenario | Data | Answer | Largest tool input | Input tokens |
|---|---|---|---|---|
| Baseline (no data) | — | — | — | ~31K (system + tools) |
| 100K random numbers in kernel | ~700KB | sum correct | 100 chars | 387 |
| 50K log lines in kernel | ~2MB | needle `REQ-43210` found | 122 chars | 879 |
| 200KB in context lake | 200KB | needle `NEEDLE-7A3F` found | 806 chars | 1,374 |
| Subagent spawn + result | — | 17×23=391 | — | — |
| Snapshot + restore | — | 777 restored | — | — |
| Combined kernel+lake+subagent | 10K numbers | 42 + summary | 198 chars | — |

If the data had entered the prompt, input tokens would have grown by tens of thousands per turn. They stayed at **387–1,374** — the data lived in the kernel and the lake, and the model retrieved only what it needed.

## How it works

### Kernel protocol (`kernel/kernel.py`)

Newline-delimited JSON over stdio. Requests: `execute`, `interrupt`, `snapshot`, `restore`, `list_names`, `shutdown`. Events: `ready`, `stdout`, `stderr`, `result`, `error`, `names`, `done`. Cells compile with `ast.PyCF_ALLOW_TOP_LEVEL_AWAIT`; a trailing expression is evaluated and its repr returned. Output is capped (100KB stdout, 4K repr) so the model receives concise results and queries specific values with small cells.

### Subagents

`rlm` creates a child OpenCode session (`parentID`) and fires a prompt without awaiting it — the child processes in the background while the parent gets the admission handle immediately (RLM semantics). Results arrive via `rlm_result`. Recursion depth is limited to 2.

### Context lake

Per-project JSONL store. `rlm_store` writes entries; `rlm_search` (regex) and `rlm_find` (text) return keys + snippets; `rlm_get` loads a full entry (capped at 50KB); `rlm_forget` deletes. The `tool.execute.after` hook auto-captures any tool output >10KB under `auto:<tool>:<hash>` keys, so large results stay retrievable without re-running the tool.

## Security

The kernel executes model-generated Python with your OS permissions. It is a durable control environment, **not a security sandbox** — same trust model as prime-agent. Use an external sandbox for untrusted repositories.

## Tests

```bash
python3 tests/test_kernel.py        # 20/20 kernel protocol tests
node tests/e2e_battery.mjs          # E2E battery (needs a running opencode server + model)
```

## License

MIT