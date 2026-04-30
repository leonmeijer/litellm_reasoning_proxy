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

function anthropicToOpenAI(
  body: Record<string, unknown>,
  apiKey: string,
): { body: Record<string, unknown>; headers: Record<string, string> } {
  const messages = body.messages as AnthropicMessage[]
  const system = body.system as string | undefined

  const openaiMessages: Array<{ role: string; content: string }> = []

  if (system) {
    openaiMessages.push({ role: "system", content: system })
  }

  for (const msg of messages) {
    let content: string
    if (typeof msg.content === "string") {
      content = msg.content
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
    } else {
      content = String(msg.content)
    }
    openaiMessages.push({ role: msg.role, content })
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

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  }

  return { body: openaiBody, headers }
}

// ─── Streaming chunk parser shared between Anthropic and OpenAI outputs ───

interface ParsedDelta {
  reasoning?: string
  content?: string
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

  return {
    done: false,
    delta: {
      reasoning,
      content: delta.content as string | undefined,
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

class OpenAIToAnthropicStream {
  private sentMessageStart = false
  private thinkingOpen = false
  private textOpen = false
  private textIndex = 0
  private finished = false
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

  constructor(requestModel: string) {
    this.requestModel = requestModel
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
        out.push(
          formatSSE(
            "content_block_start",
            JSON.stringify({
              type: "content_block_start",
              index: 0,
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
            index: 0,
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
        this.textIndex = 1
      }
      this.accumulatedText += delta.content
      if (!this.textOpen) {
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
          index: 0,
          delta: { type: "signature_delta", signature: "" },
        }),
      ),
    )
    out.push(
      formatSSE(
        "content_block_stop",
        JSON.stringify({ type: "content_block_stop", index: 0 }),
      ),
    )
    this.thinkingOpen = false
    return out
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

    if (!this.textOpen && !this.sawReasoning) {
      // Empty response — give clients an empty text block so parsers don't trip.
      out.push(
        formatSSE(
          "content_block_start",
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
        ),
      )
      this.textOpen = true
      this.textIndex = 0
    }

    if (this.textOpen) {
      out.push(
        formatSSE(
          "content_block_stop",
          JSON.stringify({ type: "content_block_stop", index: this.textIndex }),
        ),
      )
      this.textOpen = false
    }

    const stopReason = this.finalFinishReason === "length" ? "max_tokens" : "end_turn"
    out.push(
      formatSSE(
        "message_delta",
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
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
    content.push({ type: "text", text: this.accumulatedText })

    return {
      id: this.upstreamId || `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model: this.requestModel,
      content,
      stop_reason: this.finalFinishReason === "length" ? "max_tokens" : "end_turn",
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

// ─── Request repair: fix mixed text+tool_use in assistant messages ──────────
// LiteLLM fails to transform assistant messages that contain both text and
// tool_use content blocks when converting from Anthropic to OpenAI format.

function repairToolUseMessages(body: Record<string, unknown>): void {
  const messages = body.messages as Array<Record<string, unknown>> | undefined
  if (!messages) return

  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const content = msg.content as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(content)) continue
    const hasToolUse = content.some((b) => b.type === "tool_use")
    const hasText = content.some((b) => b.type === "text")
    if (!hasToolUse || !hasText) continue
    msg.content = content.filter((b) => b.type !== "text")
    log("repaired mixed text+tool_use in assistant message")
  }
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
  repairToolUseMessages(body)
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

  // For streaming OpenAI clients we just forward — LiteLLM already emits
  // reasoning_content correctly there. Cheap path, no transformation overhead.
  if (isStreaming) {
    return proxyRequestWithBody(req, url, upstream, "/v1/chat/completions", body)
  }

  // Non-streaming: drive an internal stream so we can recover reasoning_content
  // and surface it on the response message. Without this the upstream silently
  // strips the reasoning trace.
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
  await consumeStream(upstreamResp, (line) => converter.ingest(line))
  converter.finish()

  return new Response(JSON.stringify(converter.buildOpenAICompletion()), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

async function proxyRequestWithBody(
  req: Request,
  url: URL,
  upstream: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(upstream, pathname, url.searchParams)
  const headers: Record<string, string> = {}
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase()
    if (lower === "host" || lower === "content-length") continue
    headers[key] = value
  }
  headers["content-type"] = "application/json"

  const upstreamResp = await fetch(upstreamUrl, {
    ...fetchOpts,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: upstreamResp.headers,
  })
}

console.log(`Reasoning proxy listening on :${PORT} → ${UPSTREAM}`)
