/**
 * rlm — RLM (Recursive Language Model) plugin for OpenCode
 *
 * Ports the core ideas of Prime Agent's RLM runtime to OpenCode:
 *
 *   1. Persistent Python kernel — the `ipython` tool executes code in a
 *      durable CPython REPL subprocess. Variables, imports, functions and
 *      results survive across tool calls, so the model keeps working state
 *      in the kernel instead of re-reading files or re-sending data through
 *      the LLM context on every turn ("no saturar").
 *   2. Subagents as native calls — the `rlm` tool spawns a background child
 *      session and returns an admission handle immediately; results arrive
 *      later via `rlm_result`. Children inherit the parent model and tools.
 *   3. State outliving turns — `rlm_snapshot` / `rlm_restore` persist the
 *      kernel namespace to disk; the compaction hook snapshots automatically
 *      and injects a summary of kernel variables into the compaction prompt.
 *
 * The kernel is a self-contained Python runtime (kernel/kernel.py) speaking
 * newline-delimited JSON over stdio — no dependency on prime-agent.
 *
 * Install: copy this file to ~/.config/opencode/plugins/rlm.ts and
 * kernel/kernel.py to ~/.config/opencode/rlm-kernel/kernel.py
 * (or set RLM_KERNEL to the kernel.py path).
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { homedir } from "os"
import path from "path"

// ─── Configuration ───────────────────────────────────────────────────────────

const RLM_MAX_DEPTH = 2            // root → child → grandchild
const DEFAULT_TIMEOUT = 120        // seconds per ipython cell
const HARD_TIMEOUT = 300_000       // ms; JS-side backstop for a hung kernel
const MAX_CHILDREN_PER_SESSION = 8

function kernelPath(): string {
  if (process.env.RLM_KERNEL) return process.env.RLM_KERNEL
  const candidates = [
    path.join(homedir(), ".config", "opencode", "rlm-kernel", "kernel.py"),
    path.join(import.meta.dir, "..", "rlm-kernel", "kernel.py"),
    path.join(import.meta.dir, "kernel.py"),
  ]
  for (const c of candidates) {
    try {
      if (Bun.file(c).exists()) return c
    } catch {}
  }
  return candidates[0]
}

function pythonBin(): string {
  if (process.env.RLM_KERNEL_PYTHON) return process.env.RLM_KERNEL_PYTHON
  const candidates = ["python3", "/opt/homebrew/bin/python3.11", "/usr/local/bin/python3", "/usr/bin/python3"]
  for (const c of candidates) {
    try {
      const r = Bun.spawnSync([c, "--version"], { stdout: "ignore", stderr: "ignore" })
      if (r.exitCode === 0) return c
    } catch {}
  }
  return "python3"
}

function stateDirFor(sessionID: string): string {
  return path.join(homedir(), ".config", "opencode", "rlm-state", sessionID)
}

function unwrap<T>(res: any): T {
  return (res?.data ?? res) as T
}

// ─── Kernel process (JSON-lines over stdio) ─────────────────────────────────

interface PendingRequest {
  resolve: (ev: any) => void
  reject: (err: Error) => void
  stdout: string[]
  stderr: string[]
  timer: ReturnType<typeof setTimeout>
}

class Kernel {
  private proc: import("bun").Subprocess
  private buffer = ""
  private pending = new Map<string, PendingRequest>()
  private nextId = 0
  private stderrTail: string[] = []
  private closed = false
  readonly sessionID: string
  readonly directory: string
  readonly ready: Promise<void>

  constructor(python: string, kernelFile: string, sessionID: string, directory: string) {
    this.sessionID = sessionID
    this.directory = directory
    this.proc = Bun.spawn([python, kernelFile], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: directory,
    })
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("kernel did not announce ready")), 10_000)
      this.onReady = () => {
        clearTimeout(timer)
        resolve()
      }
      this.onExit = (err: Error) => {
        clearTimeout(timer)
        reject(err)
      }
    })
    this.readLoop()
    this.readStderr()
  }

  private onReady: (() => void) | null = null
  private onExit: ((err: Error) => void) | null = null

  private readLoop() {
    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()
    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          this.buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, idx)
            this.buffer = this.buffer.slice(idx + 1)
            if (line.trim()) this.handleLine(line)
          }
        }
      } catch {}
      this.failAll(new Error("kernel process exited"))
      this.onExit?.(new Error("kernel process exited"))
      this.onExit = null
    }
    pump()
  }

  private readStderr() {
    const reader = this.proc.stderr.getReader()
    const decoder = new TextDecoder()
    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          this.stderrTail.push(text)
          if (this.stderrTail.length > 20) this.stderrTail.shift()
        }
      } catch {}
    }
    pump()
  }

  private handleLine(line: string) {
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (ev.event === "ready") {
      this.onReady?.()
      this.onReady = null
      return
    }
    if (ev.event === "stdout" || ev.event === "stderr") {
      const p = this.pending.get(ev.id)
      if (p) (ev.event === "stdout" ? p.stdout : p.stderr).push(ev.text ?? "")
      return
    }
    if (ev.event === "result" || ev.event === "error" || ev.event === "names") {
      const p = this.pending.get(ev.id)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(ev.id)
        p.resolve({ ...ev, stdout: p.stdout.join(""), stderr: p.stderr.join("") })
      }
    }
  }

  private failAll(err: Error) {
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private request(type: string, payload: Record<string, unknown> = {}, timeoutMs = HARD_TIMEOUT): Promise<any> {
    if (this.closed) return Promise.reject(new Error("kernel is not running"))
    const id = `k${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.send({ id, type: "interrupt" })
        reject(new Error(`kernel request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, stdout: [], stderr: [], timer })
      this.send({ id, type, ...payload })
    })
  }

  private send(req: Record<string, unknown>) {
    try {
      this.proc.stdin.write(JSON.stringify(req) + "\n")
    } catch (err) {
      this.failAll(err instanceof Error ? err : new Error(String(err)))
    }
  }

  async execute(code: string, timeout = DEFAULT_TIMEOUT): Promise<any> {
    const ev = await this.request("execute", { code, timeout })
    return {
      ok: ev.event === "result" && ev.ok !== false,
      result: ev.event === "result" ? ev : null,
      error: ev.event === "error" ? ev : null,
      stdout: ev.stdout ?? "",
      stderr: ev.stderr ?? "",
    }
  }

  async listNames(): Promise<any[]> {
    const ev = await this.request("list_names")
    return ev.names ?? []
  }

  async snapshot(file: string): Promise<any> {
    return this.request("snapshot", { path: file })
  }

  async restore(file: string): Promise<any> {
    return this.request("restore", { path: file })
  }

  async shutdown() {
    if (this.closed) return
    try {
      this.send({ id: `k${++this.nextId}`, type: "shutdown" })
      await Bun.sleep(300)
    } catch {}
    try {
      this.proc.kill()
    } catch {}
    this.closed = true
  }

  stderrTailText(): string {
    return this.stderrTail.join("").slice(-2000)
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const RLM_INSTRUCTIONS = `## RLM Programming Model (persistent Python kernel)

You have an RLM-style persistent Python kernel via the \`ipython\` tool:

- State (variables, imports, functions, parsed results) SURVIVES across tool calls. Keep working state in the kernel instead of re-reading files or re-sending data into context on every turn.
- Use \`%%bash\` cells for shell commands; \`%cd <dir>\` changes the kernel's working directory persistently.
- Output is capped and concise on purpose: query specific values with small cells instead of dumping large data into the conversation.
- After heavy data work, call \`rlm_snapshot\` so the state survives compaction; after a compaction, call \`rlm_restore\` to reload it.

Subagents (RLM children):

- \`rlm\` spawns a background subagent and returns an admission handle immediately — do NOT wait for it. Continue your work; check results later with \`rlm_result\`.
- \`rlm_list\` shows the children of the current session; \`rlm_delete\` removes one.
- Children inherit your model, tools and skills. Recursion depth is limited to 2.`

export const Rlm: Plugin = async ({ client, directory }) => {
  const kernels = new Map<string, Kernel>()
  const children = new Map<string, any[]>()   // sessionID -> child entries
  const parents = new Map<string, string>()   // sessionID -> parentID

  function depthOf(sessionID: string): number {
    let depth = 1
    let cur = sessionID
    const seen = new Set<string>()
    while (cur && parents.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      cur = parents.get(cur)!
      depth++
    }
    return depth
  }

  async function getKernel(sessionID: string, cwd: string): Promise<Kernel> {
    let k = kernels.get(sessionID)
    if (k) return k
    k = new Kernel(pythonBin(), kernelPath(), sessionID, cwd)
    kernels.set(sessionID, k)
    try {
      await k.ready
    } catch (err) {
      kernels.delete(sessionID)
      throw new Error(
        `RLM kernel failed to start (python=${pythonBin()}, kernel=${kernelPath()}): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `stderr: ${k.stderrTailText() || "(empty)"}`
      )
    }
    return k
  }

  function cleanupSession(sessionID: string) {
    const k = kernels.get(sessionID)
    if (k) {
      k.shutdown().catch(() => {})
      kernels.delete(sessionID)
    }
    children.delete(sessionID)
    parents.delete(sessionID)
  }

  function registerChild(sessionID: string, entry: any) {
    const list = children.get(sessionID) ?? []
    list.push(entry)
    children.set(sessionID, list)
  }

  function findChild(sessionID: string, selector: string): any | undefined {
    const list = children.get(sessionID) ?? []
    const clean = (s: string) => s.trim().replace(/^['"]+|['"]+$/g, "")
    const target = clean(selector)
    return (
      list.find((c) => c.rlm_child_id === target) ??
      list.find((c) => clean(c.name) === target) ??
      list.find((c) => clean(c.session_name) === target) ??
      list.find((c) => clean(c.name).includes(target) || target.includes(clean(c.name)))
    )
  }

  function formatExecute(res: any): string {
    if (res.error) {
      const tb = (res.error.traceback ?? []).join("").trim()
      return `Error (${res.error.ename}): ${res.error.evalue}${tb ? `\n${tb}` : ""}`
    }
    const parts: string[] = []
    if (res.stdout) parts.push(res.stdout.trimEnd())
    if (res.result?.repr) parts.push(`→ ${res.result.repr}`)
    return parts.join("\n") || "(no output)"
  }

  return {
    tool: {
      ipython: tool({
        description:
          "Execute Python code in a persistent kernel. Variables, imports, functions and results survive across calls. " +
          "Use %%bash for shell commands and %cd to change the kernel's working directory. " +
          "Output is capped and concise: query specific values with small cells instead of dumping data.",
        args: {
          code: tool.schema.string().describe("Python code to execute in the persistent kernel"),
          timeout: tool.schema
            .number()
            .optional()
            .describe("Max seconds before the cell is interrupted (default 120)"),
        },
        async execute(args, context) {
          const kernel = await getKernel(context.sessionID, context.directory)
          const res = await kernel.execute(args.code, args.timeout ?? DEFAULT_TIMEOUT)
          return formatExecute(res)
        },
      }),

      rlm: tool({
        description:
          "Spawn a background subagent (RLM child) and return an admission handle immediately. " +
          "The child runs independently with its own context; results arrive later via rlm_result. " +
          "Children inherit the parent model, tools and skills. Depth is limited to 2.",
        args: {
          prompt: tool.schema.string().describe("Task for the subagent"),
          name: tool.schema.string().optional().describe("Readable child session name"),
          model: tool.schema
            .string()
            .optional()
            .describe("Exact provider/model selector for the child (default: inherit parent)"),
        },
        async execute(args, context) {
          const depth = depthOf(context.sessionID)
          if (depth >= RLM_MAX_DEPTH) {
            return `Cannot spawn RLM child: recursion depth limit (${RLM_MAX_DEPTH}) reached for this session.`
          }
          const list = children.get(context.sessionID) ?? []
          if (list.length >= MAX_CHILDREN_PER_SESSION) {
            return `Cannot spawn RLM child: session already has ${MAX_CHILDREN_PER_SESSION} children. Delete one with rlm_delete first.`
          }
          const title = (args.name ?? args.prompt.slice(0, 60))
            .trim()
            .replace(/^['"]+|['"]+$/g, "")
            .slice(0, 80)
          const created = await client.session.create({
            body: { parentID: context.sessionID, title },
            query: { directory: context.directory },
          })
          const child = unwrap<any>(created)
          const childId = child.id
          const promptBody: any = {
            parts: [{ type: "text", text: args.prompt }],
          }
          if (args.model) {
            const [providerID, modelID] = args.model.split("/")
            if (providerID && modelID) promptBody.model = { providerID, modelID }
          }
          // Fire-and-forget: the child processes in the background while we
          // return the admission handle immediately (RLM semantics). Do NOT
          // use noReply:true — that adds the message as context only and the
          // child session never runs.
          client.session
            .prompt({ path: { id: childId }, body: promptBody })
            .catch((err: unknown) => {
              console.error("[rlm] child prompt failed:", err)
            })
          const entry = {
            rlm_child_id: childId,
            name: title,
            session_name: title,
            session_dir: context.directory,
            model: args.model ?? "inherit",
            status: "running",
            created: Date.now(),
          }
          registerChild(context.sessionID, entry)
          return JSON.stringify({
            rlm_child_id: childId,
            name: title,
            session_dir: context.directory,
            model: args.model ?? "inherit",
            status: "running",
          })
        },
      }),

      rlm_list: tool({
        description: "List the RLM children (subagents) spawned by the current session.",
        args: {},
        async execute(_args, context) {
          const list = children.get(context.sessionID) ?? []
          if (list.length === 0) return "No RLM children in this session."
          return list
            .map(
              (c, i) =>
                `${i + 1}. ${c.name} — ${c.rlm_child_id} — ${c.status} — model: ${c.model}`
            )
            .join("\n")
        },
      }),

      rlm_result: tool({
        description:
          "Get the result of a previously spawned RLM child (by child id or name). " +
          "Returns {status: running|completed|error, text} — call again later if still running.",
        args: {
          child: tool.schema.string().describe("RLM child id or name from rlm_list"),
        },
        async execute(args, context) {
          const child = findChild(context.sessionID, args.child)
          if (!child) {
            return `No RLM child found for selector "${args.child}". Use rlm_list to see children of this session.`
          }
          const res = await client.session.messages({
            path: { id: child.rlm_child_id },
            query: { limit: 20 },
          })
          const msgs = unwrap<any[]>(res) ?? []
          const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant")
          if (!lastAssistant) {
            return JSON.stringify({ status: "running", detail: "no assistant message yet" })
          }
          const info = lastAssistant.info ?? {}
          if (info.error) {
            return JSON.stringify({
              status: "error",
              error: info.error?.data?.message ?? JSON.stringify(info.error),
            })
          }
          const text = (lastAssistant.parts ?? [])
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text ?? "")
            .join("\n")
            .trim()
          const completed = !!info.time?.completed
          return JSON.stringify({ status: completed ? "completed" : "running", text })
        },
      }),

      rlm_delete: tool({
        description: "Delete a spawned RLM child (by child id or name). Cancels its session.",
        args: {
          child: tool.schema.string().describe("RLM child id or name from rlm_list"),
        },
        async execute(args, context) {
          const child = findChild(context.sessionID, args.child)
          if (!child) {
            return `No RLM child found for selector "${args.child}".`
          }
          try {
            await client.session.delete({ path: { id: child.rlm_child_id } })
          } catch (err) {
            return `Failed to delete child session: ${err instanceof Error ? err.message : String(err)}`
          }
          const list = children.get(context.sessionID) ?? []
          children.set(
            context.sessionID,
            list.filter((c) => c.rlm_child_id !== child.rlm_child_id)
          )
          return `Deleted RLM child ${child.name} (${child.rlm_child_id}).`
        },
      }),

      rlm_snapshot: tool({
        description:
          "Snapshot the persistent kernel state (variables, imports, functions) to disk. " +
          "Use before compaction or when you want to persist working state.",
        args: {},
        async execute(_args, context) {
          const kernel = kernels.get(context.sessionID)
          if (!kernel) return "No kernel state to snapshot (ipython not used yet)."
          const file = path.join(stateDirFor(context.sessionID), "kernel-state.pkl")
          const ev = await kernel.snapshot(file)
          if (ev.event === "error") {
            return `Snapshot failed: ${ev.evalue}`
          }
          return `Snapshot saved to ${file} — ${ev.names?.length ?? 0} variables (${ev.bytes ?? 0} bytes).`
        },
      }),

      rlm_restore: tool({
        description:
          "Restore the persistent kernel state from the last snapshot. " +
          "Call after a compaction or a fresh session to reload working variables.",
        args: {},
        async execute(_args, context) {
          const file = path.join(stateDirFor(context.sessionID), "kernel-state.pkl")
          if (!Bun.file(file).exists()) {
            return `No snapshot found at ${file}. Use rlm_snapshot first.`
          }
          const kernel = await getKernel(context.sessionID, context.directory)
          const ev = await kernel.restore(file)
          if (ev.event === "error") {
            return `Restore failed: ${ev.evalue}`
          }
          return `Restored ${ev.names?.length ?? 0} variables from ${file}.`
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = (event.properties as any)?.info
        if (info?.id && info?.parentID) parents.set(info.id, info.parentID)
      }
      if (event.type === "session.deleted") {
        const info = (event.properties as any)?.info
        if (info?.id) cleanupSession(info.id)
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const kernel = kernels.get(input.sessionID)
      if (!kernel) return
      try {
        const names = await kernel.listNames()
        const file = path.join(stateDirFor(input.sessionID), "kernel-state.pkl")
        await kernel.snapshot(file)
        if (names.length > 0) {
          const lines = names
            .slice(0, 40)
            .map((n: any) => `- ${n.name} (${n.type}): ${n.repr}`)
          output.context.push(
            `## RLM kernel state\n` +
              `This session has a persistent Python kernel (ipython tool). ` +
              `Current variables:\n${lines.join("\n")}\n` +
              `The full state was snapshotted to ${file}. ` +
              `Use the ipython tool to inspect or continue working with this state; ` +
              `call rlm_restore if the kernel was restarted.`
          )
        }
      } catch {
        // Best-effort: compaction must never fail because of the kernel.
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(RLM_INSTRUCTIONS)
    },

    dispose: async () => {
      for (const k of kernels.values()) {
        await k.shutdown().catch(() => {})
      }
      kernels.clear()
    },
  }
}

export default Rlm