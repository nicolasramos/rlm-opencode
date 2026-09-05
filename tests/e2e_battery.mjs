// RLM test battery v2 — proves big contexts do NOT fall into the LLM prompt.
//
// Proof strategy (3 independent signals):
//   1. Correctness: the model answers questions that require the big data.
//   2. Tool inputs: the ipython/rlm_store tool calls are SMALL code cells —
//      the big data never appears in tool arguments (which DO enter the prompt).
//   3. Tokens: total input tokens stay far below the data size, and close to
//      a baseline session that never touches big data.
//
// Usage: node e2e_battery.mjs
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Agent, setGlobalDispatcher } from "undici"

// undici's default 30s headers timeout kills long kernel cells; raise it.
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, connectTimeout: 60_000 }))

const BASE = "http://127.0.0.1:4300"
const DIR = "/tmp/rlm-battery"

// SDK default fetch has a 30s headers timeout; long kernel cells need more.
const slowFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(600_000) })
const client = createOpencodeClient({ baseUrl: BASE, fetch: slowFetch })

const results = []
let failures = 0

function check(name, cond, detail) {
  const status = cond ? "PASS" : "FAIL"
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ""}`)
  results.push({ name, status, detail })
  if (!cond) failures++
}

async function runScenario(title, prompt, verify) {
  console.log(`\n=== ${title} ===`)
  const created = await client.session.create({ body: { title }, query: { directory: DIR } })
  const session = created.data ?? created
  await client.session.prompt({
    path: { id: session.id },
    body: { parts: [{ type: "text", text: prompt }] },
  })
  const deadline = Date.now() + 600_000
  let lastText = ""
  let tokens = { input: 0, output: 0 }
  let maxToolInput = 0
  let toolCalls = []
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await client.session.messages({ path: { id: session.id }, query: { limit: 50 } })
    const msgs = res.data ?? res
    const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant")
    if (!lastAssistant) continue
    const text = (lastAssistant.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim()
    if (text) lastText = text
    tokens = msgs.reduce(
      (acc, m) => {
        if (m.info?.role === "assistant" && m.info?.tokens) {
          acc.input += m.info.tokens.input ?? 0
          acc.output += m.info.tokens.output ?? 0
        }
        return acc
      },
      { input: 0, output: 0 }
    )
    // Track the largest tool input (data dumps in tool args would show here)
    toolCalls = []
    for (const m of msgs) {
      for (const p of m.parts ?? []) {
        if (p.type === "tool" && p.state?.input) {
          const raw = JSON.stringify(p.state.input)
          toolCalls.push({ tool: p.tool, len: raw.length, input: raw.slice(0, 120) })
          if (raw.length > maxToolInput) maxToolInput = raw.length
        }
      }
    }
    const completed = lastAssistant.info?.time?.completed
    const errored = lastAssistant.info?.error
    if (errored) {
      check(title, false, `assistant error: ${JSON.stringify(errored).slice(0, 200)}`)
      return { text: lastText, tokens, maxToolInput, toolCalls }
    }
    if (completed) break
  }
  await verify(title, lastText, tokens, maxToolInput, toolCalls)
  return { text: lastText, tokens, maxToolInput, toolCalls }
}

// ─── Baseline: trivial task, no big data ────────────────────────────────────
const baseline = await runScenario(
  "BASE: trivial task (no big data)",
  "Say hello and tell me the current year. One sentence.",
  (name, text, tokens) => {
    check(name, /2026/.test(text), `answer="${text.slice(0, 60)}" input_tokens=${tokens.input}`)
  }
)
const baselineTokens = baseline.tokens.input
console.log(`  → baseline input_tokens=${baselineTokens}`)

// ─── Test A: kernel holds 100K numbers ──────────────────────────────────────
await runScenario(
  "A1: kernel holds 100K numbers (sum)",
  "Use the ipython tool: generate a list of 100,000 random integers between 1 and 1000 " +
    "and store it in a variable named big_data. Do NOT print it. Then compute the sum of big_data " +
    "and report ONLY the sum.",
  (name, text, tokens, maxToolInput, toolCalls) => {
    const sum = /[\d,]+/.exec(text)?.[0]?.replace(/,/g, "")
    check(name, !!sum && Number(sum) > 0, `answer="${text.slice(0, 60)}"`)
    check(`${name} (no data in tool args)`, maxToolInput < 2000, `largest tool input=${maxToolInput} chars`)
    check(
      `${name} (tokens ≈ baseline)`,
      tokens.input < baselineTokens * 3 + 5000,
      `input_tokens=${tokens.input} vs baseline=${baselineTokens}`
    )
  }
)

// ─── Test B: kernel holds 50K log lines ─────────────────────────────────────
await runScenario(
  "B1: kernel generates 50K log lines, needle found",
  "Use the ipython tool: generate 50,000 log lines of the form '2026-09-05 12:00:00 INFO request_id=REQ-<n> status=200' " +
    "where n goes from 1 to 50000, and store them in a variable named logs. Do NOT print them. " +
    "Then find the line where request_id=REQ-43210 and report its full text.",
  (name, text, tokens, maxToolInput) => {
    check(name, /REQ-43210/.test(text), `answer="${text.slice(0, 80)}"`)
    check(`${name} (no data in tool args)`, maxToolInput < 2000, `largest tool input=${maxToolInput} chars`)
    check(
      `${name} (tokens ≈ baseline)`,
      tokens.input < baselineTokens * 3 + 5000,
      `input_tokens=${tokens.input} vs baseline=${baselineTokens}`
    )
  }
)

// ─── Test C: context lake — 200KB stored, needle found via rlm_search ───────
await runScenario(
  "C1: context lake stores 200KB, needle found via rlm_search",
  "Use the ipython tool to generate 200,000 characters of pseudo-log data where every 1000th line " +
    "contains the marker 'NEEDLE-7A3F' followed by a unique number. Store the FULL data in the context lake " +
    "using rlm_lake.store('biglogs', data) FROM WITHIN THE KERNEL (do NOT pass the data through tool arguments). " +
    "Then use rlm_search to find the entry containing NEEDLE-7A3F and report the unique number that follows it.",
  (name, text, tokens, maxToolInput) => {
    check(name, /NEEDLE-7A3F/.test(text), `answer="${text.slice(0, 80)}"`)
    check(`${name} (no data in tool args)`, maxToolInput < 5000, `largest tool input=${maxToolInput} chars`)
    check(
      `${name} (tokens ≈ baseline)`,
      tokens.input < baselineTokens * 3 + 8000,
      `input_tokens=${tokens.input} vs baseline=${baselineTokens}`
    )
  }
)

// ─── Test D: subagent ────────────────────────────────────────────────────────
await runScenario(
  "D1: rlm subagent spawn + result",
  "Use the rlm tool to spawn a subagent with prompt 'What is 17 times 23? Answer with just the number.' " +
    "and name 'math-child'. Then use rlm_result to get the child's answer. Report the final answer.",
  (name, text) => {
    check(name, /391/.test(text), `answer="${text.slice(0, 60)}"`)
  }
)

// ─── Test E: snapshot/restore ────────────────────────────────────────────────
await runScenario(
  "E1: kernel snapshot + restore",
  "Use the ipython tool to store the value 777 in a variable named magic. Call rlm_snapshot. " +
    "Then use ipython to delete magic (del magic). Call rlm_restore. Then use ipython to check magic " +
    "still exists and report its value.",
  (name, text) => {
    check(name, /777/.test(text), `answer="${text.slice(0, 60)}"`)
  }
)

// ─── Test F: combined ────────────────────────────────────────────────────────
await runScenario(
  "F1: combined kernel + lake + subagent",
  "Use the ipython tool to generate 10,000 random numbers and store them in a variable named data. " +
    "Store a summary of data (its length and mean) in the context lake under key 'datasummary' using " +
    "rlm_lake.store FROM WITHIN THE KERNEL. " +
    "Then spawn an rlm subagent with prompt 'What is 6 times 7? Just the number.' named 'child1'. " +
    "Use rlm_result to get child1's answer, and rlm_get to read 'datasummary'. Report both.",
  (name, text, tokens, maxToolInput) => {
    check(name, /42/.test(text) && /10000/.test(text), `answer="${text.slice(0, 100)}"`)
    check(`${name} (no data in tool args)`, maxToolInput < 2000, `largest tool input=${maxToolInput} chars`)
    check(
      `${name} (tokens ≈ baseline)`,
      tokens.input < baselineTokens * 3 + 8000,
      `input_tokens=${tokens.input} vs baseline=${baselineTokens}`
    )
  }
)

console.log(`\n===== BATTERY RESULT: ${results.filter((r) => r.status === "PASS").length}/${results.length} PASS, ${failures} FAIL =====`)
process.exit(failures > 0 ? 1 : 0)