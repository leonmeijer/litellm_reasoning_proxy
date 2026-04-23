import { existsSync } from "node:fs"

/**
 * Reasoning Proxy — sits between Claude Code and LiteLLM.
 *
 * Claude Code sends Anthropic /v1/messages requests. LiteLLM's Anthropic
 * streaming has bugs (duplicate message_start, empty thinking blocks without
 * valid signatures). This proxy:
 *   1. Forwards the request to LiteLLM's /v1/chat/completions (OpenAI format)
 *   2. Transforms the OpenAI streaming response back to Anthropic format
 *   3. Maps reasoning_content → thinking content blocks (stripped by default
 *      since we cannot produce valid Anthropic signatures)
 *
 * Non-streaming /v1/messages requests are proxied directly (LiteLLM handles
 * those correctly).
 */

const TARGET_QUERY_PARAM = "target"
const UPSTREAM = normalizeUpstream(process.env.UPSTREAM_URL || "http://localhost:4000")
const UPSTREAM_CA_FILE = process.env.UPSTREAM_CA_FILE ?? "/app/root-ca.crt"
const PORT = parseInt(process.env.PORT || "8081", 10)
const LOG_DEBUG = process.env.DEBUG === "1"
const TLS_REJECT = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0"
const EMIT_THINKING = process.env.EMIT_THINKING === "1"

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
    stream: body.stream ?? false,
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

// ─── Non-streaming response transform (Anthropic passthrough) ───────────────

function transformNonStreamingResponse(body: Record<string, unknown>): Record<string, unknown> {
  const reasoningContent = body.reasoning_content as string | undefined
  const content = body.content as Array<Record<string, unknown>> | undefined

  if (!reasoningContent && content) {
    const blockReasoning = content.find((b) => b.reasoning_content) as
      | Record<string, unknown>
      | undefined
    if (!blockReasoning) {
      log("passthrough: no reasoning_content found")
      return body
    }
  }

  const result = { ...body }
  const newContent: Array<Record<string, unknown>> = []

  if (content) {
    for (const block of content) {
      const cleanBlock = { ...block }
      delete cleanBlock.reasoning_content
      if (cleanBlock.type === "text") {
        newContent.push(cleanBlock)
      }
    }
  }

  if (newContent.length > 0) {
    result.content = newContent
  }
  delete result.reasoning_content

  log("transformed non-streaming response")
  return result
}

// ─── OpenAI streaming → Anthropic SSE ───────────────────────────────────────

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

class OpenAIToAnthropicStream {
  private sentMessageStart = false
  private sentTextBlockStart = false
  private finished = false
  private requestModel: string

  constructor(requestModel: string) {
    this.requestModel = requestModel
  }

  processChunk(line: string): string[] {
    if (this.finished) return []
    if (!line.startsWith("data: ")) return []
    const payload = line.slice(6).trim()
    if (payload === "[DONE]") return this.finish()

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload)
    } catch {
      return []
    }

    const out: string[] = []

    if (!this.sentMessageStart) {
      const id = (parsed.id as string) || `msg_${crypto.randomUUID()}`
      out.push(
        formatSSE(
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
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
          }),
        ),
      )
      this.sentMessageStart = true
    }

    const choices = parsed.choices as Array<Record<string, unknown>> | undefined
    if (!choices || choices.length === 0) return out

    const choice = choices[0]
    const delta = choice.delta as Record<string, unknown> | undefined
    const finishReason = choice.finish_reason as string | null

    if (delta) {
      const content = delta.content as string | undefined

      if (content) {
        if (!this.sentTextBlockStart) {
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
          this.sentTextBlockStart = true
        }

        out.push(
          formatSSE(
            "content_block_delta",
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: content },
            }),
          ),
        )
      }
    }

    if (finishReason) {
      out.push(...this.finish(finishReason))
    }

    return out
  }

  private finish(reason?: string): string[] {
    if (this.finished) return []
    this.finished = true

    const out: string[] = []

    if (!this.sentTextBlockStart) {
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
      this.sentTextBlockStart = true
    }

    out.push(
      formatSSE(
        "content_block_stop",
        JSON.stringify({ type: "content_block_stop", index: 0 }),
      ),
    )

    const stopReason = reason === "length" ? "max_tokens" : "end_turn"
    out.push(
      formatSSE(
        "message_delta",
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 0 },
        }),
      ),
    )

    out.push(formatSSE("message_stop", JSON.stringify({ type: "message_stop" })))

    return out
  }
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

    // Only transform /v1/messages POST — everything else is proxied
    if (
      (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/") &&
      req.method === "POST"
    ) {
      return handleMessages(req, url, upstream)
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

async function handleMessages(
  req: Request,
  url: URL,
  upstream: string,
): Promise<Response> {
  const body = await req.json()
  const isStreaming = body.stream === true

  log(`${req.method} /v1/messages streaming=${isStreaming} model=${body.model}`)

  // Extract API key from request headers
  const apiKey =
    req.headers.get("x-api-key") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    ""

  if (isStreaming) {
    return handleStreamingViaOpenAI(body, url, upstream, apiKey)
  }

  // Non-streaming: proxy to /v1/messages (works fine in LiteLLM)
  const upstreamUrl = buildUpstreamUrl(upstream, "/v1/messages", url.searchParams)
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

  const respBody = (await upstreamResp.json()) as Record<string, unknown>
  log("upstream response keys:", Object.keys(respBody).join(", "))

  const transformed = transformNonStreamingResponse(respBody)

  return new Response(JSON.stringify(transformed), {
    status: upstreamResp.status,
    headers: { "content-type": "application/json" },
  })
}

function handleStreamingViaOpenAI(
  anthropicBody: Record<string, unknown>,
  url: URL,
  upstream: string,
  apiKey: string,
): Response {
  const { readable, writable } = new TransformStream()
  const converter = new OpenAIToAnthropicStream((anthropicBody.model as string) || "unknown")

  ;(async () => {
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    try {
      const { body: openaiBody, headers } = anthropicToOpenAI(anthropicBody, apiKey)
      openaiBody.stream = true

      const upstreamUrl = buildUpstreamUrl(
        upstream,
        "/v1/chat/completions",
        url.searchParams,
      )

      log("streaming via OpenAI endpoint:", upstreamUrl)

      const upstreamResp = await fetch(upstreamUrl, {
        ...fetchOpts,
        method: "POST",
        headers,
        body: JSON.stringify(openaiBody),
      })

      if (!upstreamResp.ok) {
        const errBody = await upstreamResp.text()
        log("upstream error:", upstreamResp.status, errBody)
        await writer.write(encoder.encode(errBody))
        await writer.close()
        return
      }

      const reader = upstreamResp.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process only complete lines (terminated by \n)
        const lastNewline = buffer.lastIndexOf("\n")
        if (lastNewline === -1) continue

        const complete = buffer.slice(0, lastNewline + 1)
        buffer = buffer.slice(lastNewline + 1)

        const lines = complete.split("\n")
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          const events = converter.processChunk(trimmed)
          for (const evt of events) {
            await writer.write(encoder.encode(evt))
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const events = converter.processChunk(buffer.trim())
        for (const evt of events) {
          await writer.write(encoder.encode(evt))
        }
      }
    } catch (err) {
      log("stream error:", err)
    } finally {
      await writer.close()
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

console.log(`Reasoning proxy listening on :${PORT} → ${UPSTREAM}`)
if (EMIT_THINKING) console.log("  EMIT_THINKING=1 (thinking blocks will be logged)")
