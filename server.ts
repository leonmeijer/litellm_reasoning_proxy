import { existsSync } from "node:fs"

/**
 * Reasoning Proxy — translates between Anthropic and OpenAI formats while
 * preserving reasoning/thinking output that LiteLLM otherwise drops.
 *
 * Endpoints handled:
 *   POST /v1/messages              (Anthropic) — both streaming and non-streaming
 *   POST /v1/chat/completions      (OpenAI)    — both streaming and non-streaming
 *
 * For every request the proxy talks to LiteLLM's /v1/chat/completions with
 * stream=true and re-assembles the response in the format the client asked
 * for. This guarantees `reasoning_content` (OpenAI) / `thinking` blocks
 * (Anthropic) are surfaced even though LiteLLM drops them in non-streamed
 * responses.
 */

const TARGET_QUERY_PARAM = "target"
const UPSTREAM = normalizeUpstream(process.env.UPSTREAM_URL || "http://localhost:4000")
const UPSTREAM_CA_FILE = process.env.UPSTREAM_CA_FILE ?? "/app/root-ca.crt"
const PORT = parseInt(process.env.PORT || "8081", 10)
const LOG_DEBUG = process.env.DEBUG === "1"
const TLS_REJECT = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0"

function log(...args: unknown[]) {
  if (LOG_DEBUG) console.log("[reasoning-proxy]", ...args)
}

function normalizeUpstream(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function resolveUpstream(url: URL): string {
  const target = url.searchParams.get(TARGET_QUERY_PARAM)?.trim()
  if (!target) return UPSTREAM

  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    throw new Error(`invalid ${TARGET_QUERY_PARAM} query parameter: expected absolute http(s) URL`)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid ${TARGET_QUERY_PARAM} query parameter: only http(s) URLs are supported`)
  }

  return normalizeUpstream(parsed.toString())
}

function buildUpstreamUrl(upstream: string, pathname: string, search: URLSearchParams): string {
  const cleaned = new URLSearchParams(search)
  cleaned.delete(TARGET_QUERY_PARAM)
  const qs = cleaned.size > 0 ? `?${cleaned.toString()}` : ""
  return `${upstream}${pathname}${qs}`
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  })
}

type FetchTlsOptions = {
  rejectUnauthorized?: boolean
  ca?: ReturnType<typeof Bun.file>[]
}

const fetchTls: FetchTlsOptions = {
  rejectUnauthorized: TLS_REJECT,
}

if (TLS_REJECT && UPSTREAM_CA_FILE && existsSync(UPSTREAM_CA_FILE)) {
  fetchTls.ca = [Bun.file(UPSTREAM_CA_FILE)]
  log("using upstream CA file", UPSTREAM_CA_FILE)
} else if (TLS_REJECT && UPSTREAM_CA_FILE) {
  log("upstream CA file not found, falling back to Bun defaults", UPSTREAM_CA_FILE)
}

const fetchOpts: RequestInit & { tls?: FetchTlsOptions } = {
  tls: fetchTls,
} as RequestInit & { tls?: FetchTlsOptions }

// ─── Anthropic → OpenAI request conversion ─────────────────────────────────

interface AnthropicMessage {
  role: string
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>
}

// Models whose LiteLLM backend rejects role:"system" messages (e.g.
// chatgpt-sub via /responses for openai/gpt-5-*: "System messages are not
// allowed"). For these we fold the system prompt into the first user
// message so agentic clients like Claude Code work.
const NO_SYSTEM_ROLE = /^openai\/gpt-5-/

function extractSystemText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined
  if (Array.isArray(value)) {
    const joined = (value as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
    return joined || undefined
  }
  return undefined
}

type OpenAIMsg = {
  role: string
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

function extractText(blocks: Array<Record<string, unknown>>): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => (b.text as string | undefined) ?? "")
    .join("\n")
}

function toolResultContent(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (Array.isArray(raw)) {
    return (raw as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text")
      .map((b) => (b.text as string | undefined) ?? "")
      .join("\n")
  }
  return JSON.stringify(raw ?? "")
}

function anthropicToOpenAI(
  body: Record<string, unknown>,
  apiKey: string,
): { body: Record<string, unknown>; headers: Record<string, string> } {
  const messages = body.messages as AnthropicMessage[]
  const system = extractSystemText(body.system)
  const modelName = (body.model as string) ?? ""
  const stripsSystem = NO_SYSTEM_ROLE.test(modelName)

  const openaiMessages: Array<OpenAIMsg> = []
  let pendingSystem = stripsSystem ? system : undefined

  if (system && !stripsSystem) {
    openaiMessages.push({ role: "system", content: system })
  }

  for (const msg of messages) {
    // Assistant: may carry tool_use blocks → emit OpenAI tool_calls
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<Record<string, unknown>>
      const text = extractText(blocks)
      const toolUses = blocks.filter((b) => b.type === "tool_use")
      const m: OpenAIMsg = { role: "assistant" }
      if (text) m.content = text
      if (toolUses.length > 0) {
        m.tool_calls = toolUses.map((tu) => ({
          id: (tu.id as string) ?? `call_${crypto.randomUUID()}`,
          type: "function" as const,
          function: {
            name: (tu.name as string) ?? "",
            arguments: JSON.stringify(tu.input ?? {}),
          },
        }))
      }
      if (m.content === undefined && !m.tool_calls) continue
      openaiMessages.push(m)
      continue
    }

    // User: may carry tool_result blocks → emit one role:tool per result,
    // plus a single user message for any text afterwards.
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<Record<string, unknown>>
      for (const b of blocks) {
        if (b.type !== "tool_result") continue
        openaiMessages.push({
          role: "tool",
          tool_call_id: (b.tool_use_id as string) ?? "",
          content: toolResultContent(b.content),
        })
      }
      const text = extractText(blocks)
      if (text || pendingSystem) {
        let content = text
        if (pendingSystem) {
          content = content ? `${pendingSystem}\n\n${content}` : pendingSystem
          pendingSystem = undefined
        }
        openaiMessages.push({ role: "user", content })
      }
      continue
    }

    // Plain string / unknown shape.
    let content: string
    if (typeof msg.content === "string") {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      content = extractText(msg.content as Array<Record<string, unknown>>)
    } else {
      content = String(msg.content)
    }

    if (pendingSystem && msg.role === "user") {
      content = `${pendingSystem}\n\n${content}`
      pendingSystem = undefined
    }

    openaiMessages.push({ role: msg.role, content })
  }

  if (pendingSystem) {
    openaiMessages.unshift({ role: "user", content: pendingSystem })
  }

  const openaiBody: Record<string, unknown> = {
    model: body.model,
    messages: openaiMessages,
    stream: true, // always stream upstream so we can capture reasoning_content
    max_tokens: body.max_tokens ?? 4096,
  }

  if (body.temperature !== undefined) openaiBody.temperature = body.temperature
  if (body.top_p !== undefined) openaiBody.top_p = body.top_p
  if (body.stop_sequences) openaiBody.stop = body.stop_sequences

  // Tools schema: Anthropic → OpenAI function-calling.
  if (Array.isArray(body.tools)) {
    const tools = (body.tools as Array<Record<string, unknown>>)
      .map((t) => ({
        type: "function" as const,
        function: {
          name: (t.name as string) ?? "",
          description: (t.description as string) ?? "",
          parameters:
            (t.input_schema as Record<string, unknown>) ?? {
              type: "object",
              properties: {},
            },
        },
      }))
      .filter((t) => t.function.name)
    if (tools.length > 0) openaiBody.tools = tools
  }

  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice as unknown
    if (typeof tc === "string") {
      openaiBody.tool_choice = tc === "any" ? "required" : tc
    } else if (tc && typeof tc === "object") {
      const obj = tc as Record<string, unknown>
      if (obj.type === "tool" && typeof obj.name === "string") {
        openaiBody.tool_choice = {
          type: "function",
          function: { name: obj.name },
        }
      } else if (obj.type === "auto") {
        openaiBody.tool_choice = "auto"
      } else if (obj.type === "any") {
        openaiBody.tool_choice = "required"
      } else if (obj.type === "none") {
        openaiBody.tool_choice = "none"
      }
    }
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  }

  return { body: openaiBody, headers }
}

// ─── Streaming chunk parser shared between Anthropic and OpenAI outputs ───

interface ParsedToolCallDelta {
  index: number
  id?: string
  name?: string
  argumentsDelta?: string
}

interface ParsedDelta {
  reasoning?: string
  content?: string
  toolCalls?: ParsedToolCallDelta[]
  finishReason?: string | null
  id?: string
  model?: string
  usage?: Record<string, unknown>
}

function parseOpenAIChunk(line: string): { done: boolean; delta?: ParsedDelta } {
  if (!line.startsWith("data: ")) return { done: false }
  const payload = line.slice(6).trim()
  if (payload === "[DONE]") return { done: true }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { done: false }
  }

  const choices = parsed.choices as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0] as Record<string, unknown> | undefined
  const delta = (choice?.delta as Record<string, unknown> | undefined) ?? {}

  // LiteLLM may surface reasoning under several keys depending on provider:
  //   - reasoning_content (LiteLLM canonical for OpenAI-format streams)
  //   - thinking          (Ollama native passthrough)
  //   - reasoning         (some Anthropic-flavored providers)
  const reasoning =
    (delta.reasoning_content as string | undefined) ??
    (delta.thinking as string | undefined) ??
    (delta.reasoning as string | undefined)

  let toolCalls: ParsedToolCallDelta[] | undefined
  const rawToolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined
  if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
    toolCalls = rawToolCalls.map((tc) => {
      const fn = (tc.function as Record<string, unknown> | undefined) ?? {}
      return {
        index: (tc.index as number) ?? 0,
        id: tc.id as string | undefined,
        name: fn.name as string | undefined,
        argumentsDelta: fn.arguments as string | undefined,
      }
    })
  }

  return {
    done: false,
    delta: {
      reasoning,
      content: delta.content as string | undefined,
      toolCalls,
      finishReason: choice?.finish_reason as string | null | undefined,
      id: parsed.id as string | undefined,
      model: parsed.model as string | undefined,
      usage: parsed.usage as Record<string, unknown> | undefined,
    },
  }
}

// ─── OpenAI streaming → Anthropic SSE ───────────────────────────────────────

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

interface ToolCallState {
  anthropicIndex: number
  id: string
  name: string
  argsBuffer: string
  open: boolean
}

class OpenAIToAnthropicStream {
  private sentMessageStart = false
  private thinkingOpen = false
  private thinkingIndex = -1
  private textOpen = false
  private textIndex = -1
  private finished = false
  private nextAnthropicIndex = 0
  private toolCallStates = new Map<number, ToolCallState>()
  private requestModel: string
  private upstreamId = ""
  private inputTokens = 0
  private outputTokens = 0

  // Accumulated state, exposed so non-streaming handlers can build a single
  // Anthropic message from the same parser.
  accumulatedThinking = ""
  accumulatedText = ""
  sawReasoning = false
  finalFinishReason: string | null = null
  upstreamUsageEmitted = false

  constructor(requestModel: string) {
    this.requestModel = requestModel
  }

  private allocateIndex(): number {
    return this.nextAnthropicIndex++
  }

  private closeTextBlockIfOpen(): string[] {
    if (!this.textOpen) return []
    const out = [
      formatSSE(
        "content_block_stop",
        JSON.stringify({ type: "content_block_stop", index: this.textIndex }),
      ),
    ]
    this.textOpen = false
    return out
  }

  ingest(line: string): string[] {
    if (this.finished) return []
    const { done, delta } = parseOpenAIChunk(line)
    if (done) return this.finish()
    if (!delta) return []

    const out: string[] = []

    if (delta.id && !this.upstreamId) this.upstreamId = delta.id
    if (delta.usage) {
      const u = delta.usage as Record<string, number>
      if (typeof u.prompt_tokens === "number") this.inputTokens = u.prompt_tokens
      if (typeof u.completion_tokens === "number") this.outputTokens = u.completion_tokens
    }

    if (!this.sentMessageStart) {
      out.push(this.emitMessageStart())
    }

    if (delta.reasoning) {
      this.sawReasoning = true
      this.accumulatedThinking += delta.reasoning
      if (!this.thinkingOpen) {
        this.thinkingIndex = this.allocateIndex()
        out.push(
          formatSSE(
            "content_block_start",
            JSON.stringify({
              type: "content_block_start",
              index: this.thinkingIndex,
              content_block: { type: "thinking", thinking: "" },
            }),
          ),
        )
        this.thinkingOpen = true
      }
      out.push(
        formatSSE(
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: this.thinkingIndex,
            delta: { type: "thinking_delta", thinking: delta.reasoning },
          }),
        ),
      )
    }

    if (delta.content) {
      // Closing the thinking block before emitting any text matches the
      // Anthropic SSE contract: text_delta belongs on its own block.
      if (this.thinkingOpen && !this.textOpen) {
        out.push(...this.closeThinkingBlock())
      }
      this.accumulatedText += delta.content
      if (!this.textOpen) {
        this.textIndex = this.allocateIndex()
        out.push(
          formatSSE(
            "content_block_start",
            JSON.stringify({
              type: "content_block_start",
              index: this.textIndex,
              content_block: { type: "text", text: "" },
            }),
          ),
        )
        this.textOpen = true
      }
      out.push(
        formatSSE(
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: this.textIndex,
            delta: { type: "text_delta", text: delta.content },
          }),
        ),
      )
    }

    if (delta.toolCalls && delta.toolCalls.length > 0) {
      // Close any open text/thinking block before opening tool_use blocks —
      // Anthropic content blocks are sequential, not interleaved.
      if (this.thinkingOpen) out.push(...this.closeThinkingBlock())
      out.push(...this.closeTextBlockIfOpen())

      for (const tc of delta.toolCalls) {
        let entry = this.toolCallStates.get(tc.index)
        if (!entry) {
          entry = {
            anthropicIndex: this.allocateIndex(),
            id: tc.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
            name: tc.name ?? "",
            argsBuffer: "",
            open: false,
          }
          this.toolCallStates.set(tc.index, entry)
        } else {
          if (tc.id && !entry.id.length) entry.id = tc.id
          if (tc.name && !entry.name.length) entry.name = tc.name
        }

        if (!entry.open) {
          out.push(
            formatSSE(
              "content_block_start",
              JSON.stringify({
                type: "content_block_start",
                index: entry.anthropicIndex,
                content_block: {
                  type: "tool_use",
                  id: entry.id,
                  name: entry.name,
                  input: {},
                },
              }),
            ),
          )
          entry.open = true
        }

        if (tc.argumentsDelta) {
          entry.argsBuffer += tc.argumentsDelta
          out.push(
            formatSSE(
              "content_block_delta",
              JSON.stringify({
                type: "content_block_delta",
                index: entry.anthropicIndex,
                delta: { type: "input_json_delta", partial_json: tc.argumentsDelta },
              }),
            ),
          )
        }
      }
    }

    if (delta.finishReason) {
      this.finalFinishReason = delta.finishReason
      out.push(...this.finish(delta.finishReason))
    }

    return out
  }

  private emitMessageStart(): string {
    this.sentMessageStart = true
    const id = this.upstreamId || `msg_${crypto.randomUUID()}`
    return formatSSE(
      "message_start",
      JSON.stringify({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model: this.requestModel,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.inputTokens,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    )
  }

  private closeThinkingBlock(): string[] {
    if (!this.thinkingOpen) return []
    const out: string[] = []
    // Anthropic SDK validates a signature_delta before each content_block_stop
    // on a thinking block. We cannot mint a valid HMAC, so emit an empty
    // signature — clients that don't re-submit the block back to Anthropic
    // accept this fine.
    out.push(
      formatSSE(
        "content_block_delta",
        JSON.stringify({
          type: "content_block_delta",
          index: this.thinkingIndex,
          delta: { type: "signature_delta", signature: "" },
        }),
      ),
    )
    out.push(
      formatSSE(
        "content_block_stop",
        JSON.stringify({ type: "content_block_stop", index: this.thinkingIndex }),
      ),
    )
    this.thinkingOpen = false
    return out
  }

  private resolveStopReason(): string {
    if (this.toolCallStates.size > 0 || this.finalFinishReason === "tool_calls") {
      return "tool_use"
    }
    if (this.finalFinishReason === "length") return "max_tokens"
    return "end_turn"
  }

  finish(reason?: string): string[] {
    if (this.finished) return []
    this.finished = true
    if (reason) this.finalFinishReason = reason

    const out: string[] = []

    if (!this.sentMessageStart) out.push(this.emitMessageStart())

    if (this.thinkingOpen) {
      out.push(...this.closeThinkingBlock())
    }

    if (
      !this.textOpen &&
      !this.sawReasoning &&
      this.toolCallStates.size === 0
    ) {
      // Empty response — give clients an empty text block so parsers don't trip.
      this.textIndex = this.allocateIndex()
      out.push(
        formatSSE(
          "content_block_start",
          JSON.stringify({
            type: "content_block_start",
            index: this.textIndex,
            content_block: { type: "text", text: "" },
          }),
        ),
      )
      this.textOpen = true
    }

    out.push(...this.closeTextBlockIfOpen())

    for (const entry of this.toolCallStates.values()) {
      if (entry.open) {
        out.push(
          formatSSE(
            "content_block_stop",
            JSON.stringify({ type: "content_block_stop", index: entry.anthropicIndex }),
          ),
        )
        entry.open = false
      }
    }

    out.push(
      formatSSE(
        "message_delta",
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: this.resolveStopReason(), stop_sequence: null },
          usage: { output_tokens: this.outputTokens },
        }),
      ),
    )
    out.push(formatSSE("message_stop", JSON.stringify({ type: "message_stop" })))

    return out
  }

  buildAnthropicMessage(): Record<string, unknown> {
    const content: Array<Record<string, unknown>> = []
    if (this.sawReasoning) {
      content.push({
        type: "thinking",
        thinking: this.accumulatedThinking,
        signature: "",
      })
    }
    if (this.accumulatedText) {
      content.push({ type: "text", text: this.accumulatedText })
    }
    // Emit tool_use blocks in the order they were seen (by openai index).
    const orderedTools = Array.from(this.toolCallStates.entries()).sort(
      (a, b) => a[0] - b[0],
    )
    for (const [, entry] of orderedTools) {
      let input: unknown = {}
      if (entry.argsBuffer) {
        try {
          input = JSON.parse(entry.argsBuffer)
        } catch {
          input = { _raw: entry.argsBuffer }
        }
      }
      content.push({
        type: "tool_use",
        id: entry.id,
        name: entry.name,
        input,
      })
    }
    if (content.length === 0) {
      content.push({ type: "text", text: "" })
    }

    return {
      id: this.upstreamId || `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model: this.requestModel,
      content,
      stop_reason: this.resolveStopReason(),
      stop_sequence: null,
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        total_tokens: this.inputTokens + this.outputTokens,
      },
    }
  }

  buildOpenAICompletion(): Record<string, unknown> {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: this.accumulatedText,
    }
    if (this.sawReasoning) {
      // Surface reasoning under both the LiteLLM canonical name and the
      // OpenAI o1-style `reasoning` key so any client convention works.
      message.reasoning_content = this.accumulatedThinking
      message.reasoning = this.accumulatedThinking
    }
    return {
      id: this.upstreamId || `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.requestModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: this.finalFinishReason ?? "stop",
        },
      ],
      usage: {
        prompt_tokens: this.inputTokens,
        completion_tokens: this.outputTokens,
        total_tokens: this.inputTokens + this.outputTokens,
      },
    }
  }

  // Streaming OpenAI SSE → normalized OpenAI SSE. Pass-through preserves any
  // unknown delta fields (tool_calls, role, refusal, …) and only normalizes
  // reasoning so it surfaces under both `reasoning_content` and `reasoning`.
  // The aggregator also guarantees a final finish_reason chunk + [DONE].
  ingestAsOpenAISSE(line: string): string[] {
    if (this.finished) return []
    if (!line.startsWith("data: ")) return []
    const payload = line.slice(6).trim()
    if (payload === "[DONE]") return this.finishAsOpenAISSE()

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload)
    } catch {
      return []
    }

    const choices = parsed.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0] as Record<string, unknown> | undefined
    const delta = (choice?.delta as Record<string, unknown> | undefined) ?? {}

    if (parsed.id && !this.upstreamId) this.upstreamId = parsed.id as string
    if (parsed.model) this.requestModel = parsed.model as string
    if (parsed.usage) {
      const u = parsed.usage as Record<string, number>
      if (typeof u.prompt_tokens === "number") this.inputTokens = u.prompt_tokens
      if (typeof u.completion_tokens === "number") this.outputTokens = u.completion_tokens
    }

    const reasoning =
      (delta.reasoning_content as string | undefined) ??
      (delta.thinking as string | undefined) ??
      (delta.reasoning as string | undefined)

    if (reasoning) {
      this.sawReasoning = true
      this.accumulatedThinking += reasoning
    }
    if (delta.content) {
      this.accumulatedText += delta.content as string
    }
    if (choice?.finish_reason) {
      this.finalFinishReason = choice.finish_reason as string
    }

    const normalizedDelta: Record<string, unknown> = { ...delta }
    if (reasoning !== undefined) {
      normalizedDelta.reasoning_content = reasoning
      normalizedDelta.reasoning = reasoning
    }

    const reEmitted: Record<string, unknown> = { ...parsed }
    if (choice) {
      reEmitted.choices = [{ ...choice, delta: normalizedDelta }]
    }
    if (parsed.usage) this.upstreamUsageEmitted = true

    // Do NOT call finishAsOpenAISSE on finish_reason: OpenAI streams may
    // emit a trailing usage chunk between finish_reason and [DONE]. Wait
    // for upstream [DONE] (or stream-close in the consumer).
    return [`data: ${JSON.stringify(reEmitted)}\n\n`]
  }

  finishAsOpenAISSE(): string[] {
    if (this.finished) return []
    this.finished = true
    const out: string[] = []

    if (!this.finalFinishReason) {
      out.push(
        `data: ${JSON.stringify({
          id: this.upstreamId || `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: this.requestModel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      )
    }

    if (!this.upstreamUsageEmitted && (this.inputTokens > 0 || this.outputTokens > 0)) {
      out.push(
        `data: ${JSON.stringify({
          id: this.upstreamId || `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: this.requestModel,
          choices: [],
          usage: {
            prompt_tokens: this.inputTokens,
            completion_tokens: this.outputTokens,
            total_tokens: this.inputTokens + this.outputTokens,
          },
        })}\n\n`,
      )
    }

    out.push("data: [DONE]\n\n")
    return out
  }
}

// ─── Stream consumption helper ──────────────────────────────────────────────

async function consumeStream(
  upstreamResp: Response,
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  const reader = upstreamResp.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lastNewline = buffer.lastIndexOf("\n")
    if (lastNewline === -1) continue
    const complete = buffer.slice(0, lastNewline + 1)
    buffer = buffer.slice(lastNewline + 1)
    for (const line of complete.split("\n")) {
      const trimmed = line.trim()
      if (trimmed) await onLine(trimmed)
    }
  }

  if (buffer.trim()) await onLine(buffer.trim())
}

// ─── Common upstream call ───────────────────────────────────────────────────

async function callUpstreamStream(
  url: URL,
  upstream: string,
  openaiBody: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(upstream, "/v1/chat/completions", url.searchParams)
  log("upstream stream call:", upstreamUrl, "model=", openaiBody.model)
  return fetch(upstreamUrl, {
    ...fetchOpts,
    method: "POST",
    headers,
    body: JSON.stringify(openaiBody),
  })
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    let upstream: string

    try {
      upstream = resolveUpstream(url)
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "invalid target URL")
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", upstream }), {
        headers: { "content-type": "application/json" },
      })
    }

    if (req.method === "POST") {
      if (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/") {
        return handleAnthropicMessages(req, url, upstream)
      }
      if (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/chat/completions/") {
        return handleOpenAIChat(req, url, upstream)
      }
    }

    return proxyRequest(req, url, upstream)
  },
})

async function proxyRequest(req: Request, url: URL, upstream: string): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(upstream, url.pathname, url.searchParams)
  const headers: Record<string, string> = {}
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase()
    if (lower === "host" || lower === "content-length") continue
    headers[key] = value
  }

  const body =
    req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined

  const upstreamResp = await fetch(upstreamUrl, {
    ...fetchOpts,
    method: req.method,
    headers,
    body,
  })

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: upstreamResp.headers,
  })
}

// ─── Anthropic /v1/messages handler ─────────────────────────────────────────

async function handleAnthropicMessages(
  req: Request,
  url: URL,
  upstream: string,
): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>
  const isStreaming = body.stream === true

  const apiKey =
    req.headers.get("x-api-key") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    ""

  log(`anthropic ${isStreaming ? "stream" : "non-stream"} model=${body.model}`)

  const { body: openaiBody, headers } = anthropicToOpenAI(body, apiKey)
  const upstreamResp = await callUpstreamStream(url, upstream, openaiBody, headers)

  if (!upstreamResp.ok) {
    const errBody = await upstreamResp.text()
    log("upstream error:", upstreamResp.status, errBody)
    return new Response(errBody, {
      status: upstreamResp.status,
      headers: { "content-type": upstreamResp.headers.get("content-type") || "application/json" },
    })
  }

  const converter = new OpenAIToAnthropicStream((body.model as string) || "unknown")

  if (isStreaming) {
    const { readable, writable } = new TransformStream()
    const encoder = new TextEncoder()
    ;(async () => {
      const writer = writable.getWriter()
      try {
        await consumeStream(upstreamResp, async (line) => {
          for (const evt of converter.ingest(line)) {
            await writer.write(encoder.encode(evt))
          }
        })
        for (const evt of converter.finish()) {
          await writer.write(encoder.encode(evt))
        }
      } catch (err) {
        log("stream error:", err)
      } finally {
        try {
          await writer.close()
        } catch {
          // already closed
        }
      }
    })()

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }

  // Non-streaming: drain stream, build single Anthropic message.
  await consumeStream(upstreamResp, (line) => converter.ingest(line))
  converter.finish()
  return new Response(JSON.stringify(converter.buildAnthropicMessage()), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

// ─── OpenAI /v1/chat/completions handler ───────────────────────────────────

async function handleOpenAIChat(
  req: Request,
  url: URL,
  upstream: string,
): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>
  const isStreaming = body.stream === true

  log(`openai ${isStreaming ? "stream" : "non-stream"} model=${body.model}`)

  // Always stream upstream so we can recover reasoning_content and finalize
  // cleanly even when LiteLLM's non-stream aggregator strips it (1.83.14 bug
  // with chatgpt-subs and other providers that bridge /responses → /chat).
  const apiKey =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.headers.get("x-api-key") ||
    ""

  const openaiBody = { ...body, stream: true }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  }

  const upstreamResp = await callUpstreamStream(url, upstream, openaiBody, headers)
  if (!upstreamResp.ok) {
    const errBody = await upstreamResp.text()
    return new Response(errBody, {
      status: upstreamResp.status,
      headers: { "content-type": upstreamResp.headers.get("content-type") || "application/json" },
    })
  }

  const converter = new OpenAIToAnthropicStream((body.model as string) || "unknown")

  if (isStreaming) {
    const { readable, writable } = new TransformStream()
    const encoder = new TextEncoder()
    ;(async () => {
      const writer = writable.getWriter()
      try {
        await consumeStream(upstreamResp, async (line) => {
          for (const evt of converter.ingestAsOpenAISSE(line)) {
            await writer.write(encoder.encode(evt))
          }
        })
        for (const evt of converter.finishAsOpenAISSE()) {
          await writer.write(encoder.encode(evt))
        }
      } catch (err) {
        log("stream error:", err)
      } finally {
        try {
          await writer.close()
        } catch {
          // already closed
        }
      }
    })()

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }

  // Non-streaming: drain stream, build single OpenAI completion.
  await consumeStream(upstreamResp, (line) => converter.ingest(line))
  converter.finish()

  return new Response(JSON.stringify(converter.buildOpenAICompletion()), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

console.log(`Reasoning proxy listening on :${PORT} → ${UPSTREAM}`)
