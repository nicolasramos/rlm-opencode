# rlm-opencode

**RLM (Recursive Language Model) for OpenCode** — a persistent Python kernel, native background subagents, and a context lake that keeps large data **out of the LLM prompt**.

RLM is a research paradigm introduced by [Alex Zhang (October 2025)](https://alexzhang13.github.io/blog/2025/rlm/) and formalized in the paper [*Recursive Language Models* (arXiv:2512.24601)](https://arxiv.org/abs/2512.24601). This plugin implements that paradigm for OpenCode: the model keeps working state in a persistent Python kernel, spawns recursive subagents, and stores large context in an external lake it queries with tools — instead of stuffing everything into the prompt. Self-contained: no external runtime dependency.

Companion project: [rlm-pi](https://github.com/nicolasramos/rlm-pi) (the same RLM for PI). Both share the same kernel runtime and the same context-lake format, so state is portable between editors.

---

## Why RLM?

LLM agents degrade as context grows: cost rises linearly, performance drops ("context rot"), and every turn re-sends the same data. RLM treats context as **variables** instead of stuffing everything into the prompt:

```
Traditional:  Context (huge) → prompt → LLM → 💀 context rot, cost explosion
RLM:          Context → kernel / lake (external) → LLM calls tools to get only what it needs → ✅
```

The model keeps working state in a **persistent Python kernel** and large reference data in a **context lake**, then queries both with small tool calls. The big data **never enters the prompt**.

### When does RLM help most?

| Situation | Without RLM | With RLM |
|---|---|---|
| Logs, build output, CSV dumps (100KB–10MB) | Prompt overflow or huge token bills | Stored in kernel/lake; model queries snippets |
| Multi-step data pipelines (transform → analyze → report) | Every step re-reads and re-sends data | Variables survive in the kernel between steps |
| Long agent sessions (compaction) | State lost or re-summarized | Snapshot + variable summary injected at compaction |
| Local models with small context (1–8K) | **Cannot** process large data at all | Model writes code; kernel does the heavy lifting |
| Parallelizable review/analysis tasks | Serial, blocking | Background subagents with admission handles |

## Impact study: local models vs frontier models (measured 2026-09-06)

Same task in both modes — find `NEEDLE-7A3F` in a 5,000-line log file (~280 KB ≈ **130,000 tokens**):

- **Mode A (prompt)**: the data is injected into the LLM prompt.
- **Mode B (RLM)**: the model only writes a small Python snippet; the kernel executes it against the file.

| Model | Type | Mode A (data in prompt) | Mode B (RLM) |
|---|---|---|---|
| LFM2.5-1.2B (local) | small | ❌ **Prompt too long: 130,034 tok > 128K ctx** | ✅ **75 tok · 0.6s** |
| LFM2.5-2.6B (local) | small | ❌ **Prompt too long: 130,033 tok** | ✅ **73 tok · 4.3s** |
| LFM2.5-8B-A1B (local) | mid | ❌ **Prompt too long: 130,032 tok** | ✅ **72 tok · 3.7s** |
| Qwen3.6-35B-A3B (local) | large local | ❌ **OOM: memory guard aborted prefill (27.9 GB)** | ✅ (needs free RAM) |
| deepseek-v4-flash (cloud) | frontier | ✅ 125,106 tok · 7.4s | ✅ 387–1,374 tok |

**What this proves:**

1. **Small local models cannot process large data in the prompt** — not even a 128K-context server: the file exceeds the window. With RLM they succeed with **72–75 tokens in under 5 seconds**.
2. **Large local models cannot either** — the prefill of 130K tokens needs ~21–28 GB of KV cache + attention, which trips the memory guard.
3. **Frontier models can** (125,106 tokens, 7.4s) — but they pay **125,106 tokens per request**. With RLM the same task costs **387–1,374 tokens**: a **90–1,700× reduction**.
4. RLM is therefore **not an optional optimization for small local models — it is what makes them capable** of working with real data. The model becomes an orchestrator of code, not a reader of documents.

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

One kernel per OpenCode session, spawned lazily on first `ipython` use. Children get their own session → their own kernel. The context lake is per project directory, shared across sessions.

## Install

Requirements: OpenCode ≥ 1.18, Python 3.9+ (3.11+ recommended, stdlib only; `dill` optional for richer snapshots).

**Via npm** (published as `rlm-opencode`):

```bash
npm install -g rlm-opencode
rlm-opencode-install   # copies plugin + kernel to ~/.config/opencode/
# restart opencode
```

**Via git**:

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

## Usage — complete documentation

### 1. Persistent kernel (`ipython`)

The kernel is a durable CPython REPL. Everything you define survives across calls — variables, imports, functions, even the working directory.

**Basic state persistence:**

```text
> Store the first 5 primes in a variable, then double the last one.

⚙ ipython {"code": "primes = [2, 3, 5, 7, 11]"}
⚙ ipython {"code": "primes[-1] * 2"}
→ 22
```

**Shell access with `%%bash`:**

```text
⚙ ipython {"code": "%%bash\ngit log --oneline -5"}
→ 9d29dede2 feat: add HermesApp iOS scaffold
  772be82c7 auto-sync 2026-07-22 18:21
  ...
```

**Persistent working directory with `%cd`:**

```text
⚙ ipython {"code": "%cd /tmp/project"}
→ /tmp/project
⚙ ipython {"code": "import os; os.getcwd()"}
→ '/tmp/project'
```

**Top-level `await`:**

```text
⚙ ipython {"code": "import asyncio; await asyncio.sleep(0.1); 'done'"}
→ 'done'
```

**Output caps**: stdout is capped at 100KB and expression reprs at 4K chars, so the model receives concise results and queries specific values with small cells instead of dumping data into the conversation.

### 2. Background subagents (`rlm`, `rlm_list`, `rlm_result`, `rlm_delete`)

Spawn a child session that works in the background while you keep going. You get an admission handle immediately (RLM semantics); results arrive later.

```text
> Review the auth flow in the background while I keep working.

⚙ rlm {"prompt": "Review the authentication flow for security issues", "name": "auth-reviewer"}
→ {"rlm_child_id": "ses_...", "name": "auth-reviewer", "status": "running"}

⚙ rlm_list {}
→ [{"name": "auth-reviewer", "status": "running", "created": "..."}]

⚙ rlm_result {"child": "auth-reviewer"}
→ {"status": "completed", "text": "..."}

⚙ rlm_delete {"child": "auth-reviewer"}
→ {"deleted": true}
```

Children inherit the parent model and tools, get their own session (and their own kernel), and recursion depth is limited to 2.

### 3. Context lake (`rlm_store`, `rlm_get`, `rlm_search`, `rlm_find`, `rlm_stats`, `rlm_forget`)

Large data lives in a per-project JSONL store. The model stores it once and queries snippets on demand — the data **never enters the prompt**.

```text
> Store the full build log in the lake, then find the failing test.

⚙ ipython {"code": "logs = open('build.log').read()"}          # 2MB in the kernel
⚙ rlm_store {"key": "build-log", "content": "logs"}            # 2MB in the lake, NOT in the prompt
⚙ rlm_search {"pattern": "FAILED|error"}                       # snippets only
→ 1. build-log (2,048,000 chars)
   …FAILED test_api_orders — AssertionError: expected 200…

⚙ rlm_get {"key": "build-log"}                                 # full entry (capped 50KB)
⚙ rlm_find {"query": "AssertionError"}                         # text search
⚙ rlm_stats {}
→ {"entries": 12, "total_chars": 2_500_000, "file": "..."}
⚙ rlm_forget {"key": "build-log"}
→ {"deleted": true}
```

**From inside the kernel** — the `rlm_lake` module writes a kernel variable straight into the lake without any prompt round-trip:

```text
⚙ ipython {"code": "rlm_lake.store('biglogs', logs)"}          # 200KB → lake, 0 tokens spent
```

**Auto-capture**: any tool output larger than 10KB is automatically stored in the lake under `auto:<tool>:<hash>` keys, so large results stay retrievable without re-running the tool.

### 4. Snapshot / restore (`rlm_snapshot`, `rlm_restore`)

Persist the whole kernel namespace to disk and reload it later — survives compaction and restarts.

```text
⚙ ipython {"code": "primes = [2, 3, 5, 7, 11]"}
⚙ rlm_snapshot {"name": "session-1"}
→ {"snapshot": "session-1", "names": ["primes", ...]}

⚙ rlm_restore {"name": "session-1"}
→ {"restored": ["primes", ...]}
```

The `session.compacting` hook does this automatically: before compaction, the kernel is snapshotted and a summary of its variables is injected into the compaction prompt, so the model knows what state exists after the context is trimmed.

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

The kernel executes model-generated Python with your OS permissions. It is a durable control environment, **not a security sandbox** — same trust model as other RLM runtimes. Use an external sandbox for untrusted repositories.

## Tests

```bash
python3 tests/test_kernel.py        # 24/24 kernel protocol tests
node tests/e2e_battery.mjs          # E2E battery (needs a running opencode server + model)
```

## FAQ

**Does RLM replace the model's context window?** No — it complements it. The context window is reserved for reasoning and instructions; data lives in the kernel/lake.

**Does it work with any model?** Yes. RLM is model-agnostic: the model only needs basic tool-calling. It helps frontier models (token savings) and is *required* for small local models (they cannot fit large data in the prompt).

**What happens on compaction?** The kernel is snapshotted automatically and a summary of its variables is injected into the compaction prompt. After compaction, the model can restore or query the kernel/lake.

**Where does state live?** `~/.config/opencode/rlm-state/` — kernel snapshots per session, context lake per project (JSONL).

**Can I use it with my own Python environment?** Yes — set `RLM_KERNEL_PYTHON` to any interpreter (venv, conda, system).

**Is the data sent anywhere?** No. Everything runs locally: kernel, lake, and (with a local model) the LLM itself. Your data never leaves your machine.

## Publishing

### OpenCode

OpenCode plugins are published as **npm packages** and listed in the community ecosystem. There is no central "store" — the distribution paths are:

1. **npm** — `npm publish` (the repo ships a `package.json`; users install via the `plugin` array in `opencode.json`).
2. **Ecosystem page** — [opencode.ai/docs/ecosystem](https://opencode.ai/docs/ecosystem) lists community plugins (PR to the docs).
3. **Community lists** — [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) and [opencode.cafe](https://opencode.cafe).
4. **Local install** — copy `plugin/rlm.ts` to `~/.config/opencode/plugins/`.

### PI (pi-mono)

PI has a real plugin registry: **https://pi.dev/packages** (5,000+ packages). Extensions are npm packages installed under `~/.pi/agent/` or copied to `~/.pi/agent/extensions/`. The companion project [rlm-pi](https://github.com/nicolasramos/rlm-pi) contains the RLM port for PI (same kernel, same lake format).

## License

MIT