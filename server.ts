/**
 * Reasoning Proxy — transforms LiteLLM responses into exact Anthropic /v1/messages format.
 *
 * Problem: LiteLLM puts thinking_delta events on a "text" content block (same index),
 * and non-streaming responses may have reasoning_content at message level instead of
 * a proper thinking content block. Claude Code expects:
 *   - thinking_delta → thinking content block (index N)
 *   - text_delta → text content block (index N+1)
 *   - Non-streaming: content: [{type:"thinking",...}, {type:"text",...}]
 */

const UPSTREAM = process.env.UPSTREAM_URL || "http://localhost:4000"
const PORT = parseInt(process.env.PORT || "8081", 10)
const LOG_DEBUG = process.env.DEBUG === "1"
const TLS_REJECT = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0"

function log(...args: unknown[]) {
  if (LOG_DEBUG) console.log("[reasoning-proxy]", ...args)
}

/** Common fetch options — disables TLS verify when NODE_TLS_REJECT_UNAUTHORIZED=0 */
const fetchOpts: RequestInit & { tls?: { rejectUnauthorized?: boolean } } = {
  tls: { rejectUnauthorized: TLS_REJECT },
} as unknown as RequestInit

// ─── Non-streaming response transform ───────────────────────────────────────

function transformNonStreamingResponse(body: Record<string, unknown>): Record<string, unknown> {
  // If reasoning_content exists at message level, convert to thinking block
  const reasoningContent = body.reasoning_content as string | undefined
  const content = body.content as Array<Record<string, unknown>> | undefined

  if (!reasoningContent && content) {
    // Check if any content block has reasoning_content
    const blockReasoning = content.find(b => b.reasoning_content) as Record<string, unknown> | undefined
    if (!blockReasoning) {
      log("passthrough: no reasoning_content found")
      return body
    }
  }

  const result = { ...body }
  const newContent: Array<Record<string, unknown>> = []

  // Add thinking block if reasoning exists
  if (reasoningContent) {
    newContent.push({
      type: "thinking",
      thinking: reasoningContent,
      signature: "ErQBCmIYATYBIAAqAgxkZWZhdWx0" + Buffer.from(String(Date.now())).toString("base64"),
    })
  }

  // Process existing content blocks
  if (content) {
    for (const block of content) {
      const blockReasoning = block.reasoning_content as string | undefined

      // Add thinking block from block-level reasoning_content
      if (blockReasoning) {
        newContent.push({
          type: "thinking",
          thinking: blockReasoning,
          signature: "ErQBCmIYATYBIAAqAgxkZWZhdWx0" + Buffer.from(String(Date.now())).toString("base64"),
        })
      }

      // Strip reasoning_content from block, keep as text
      const cleanBlock = { ...block }
      delete cleanBlock.reasoning_content

      // If text is empty but we have reasoning, the text might follow
      // Keep the text block as-is (even if empty) — Claude Code handles empty text blocks
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

// ─── Streaming SSE transform ─────────────────────────────────────────────────

interface SSEEvent {
  event: string
  data: string
}

function parseSSE(raw: string): SSEEvent[] {
  const events: SSEEvent[] = []
  const lines = raw.split("\n")
  let currentEvent = ""
  let currentData = ""

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim()
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6)
    } else if (line === "" && (currentEvent || currentData)) {
      events.push({ event: currentEvent, data: currentData })
      currentEvent = ""
      currentData = ""
    }
  }
  // Handle last event if no trailing newline
  if (currentEvent || currentData) {
    events.push({ event: currentEvent, data: currentData })
  }
  return events
}

function formatSSE(event: SSEEvent): string {
  // Fix SSE event name to match the data type (Anthropic expects event:<type> == data.type)
  let eventName = event.event
  try {
    const parsed = JSON.parse(event.data)
    if (parsed.type && parsed.type !== event.event) {
      eventName = parsed.type
    }
  } catch { /* keep original */ }
  return `event: ${eventName}\ndata: ${event.data}\n\n`
}

/**
 * State machine for stream transformation.
 *
 * LiteLLM sends: content_block_start(index:0, type:"text") → thinking_delta(0) → text_delta(0) → content_block_stop(0)
 * We need:      content_block_start(index:0, type:"thinking") → thinking_delta(0) → content_block_stop(0)
 *               content_block_start(index:1, type:"text") → text_delta(1) → content_block_stop(1)
 */
class StreamTransformer {
  private hasSeenThinking = false
  private hasSeenTextAfterThinking = false
  private thinkingContentBlockStarted = false
  private textContentBlockStarted = false
  private pendingSignature = false

  transform(event: SSEEvent): SSEEvent[] {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return [event] // passthrough malformed
    }

    const type = parsed.type as string

    // message_start — passthrough but fix model name if needed
    if (type === "message_start") {
      return [event]
    }

    // ping — passthrough
    if (type === "ping") {
      return [event]
    }

    // content_block_start — the key transformation point
    if (type === "content_block_start") {
      const block = parsed.content_block as Record<string, unknown>
      const index = parsed.index as number
      const blockType = block?.type as string

      // If this is a "text" block but the first deltas might be thinking_deltas,
      // we need to split it into thinking + text blocks
      if (blockType === "text") {
        // We'll emit the thinking block start now and defer the text block start
        this.thinkingContentBlockStarted = true

        const out: SSEEvent[] = []

        // Emit thinking content_block_start at index 0
        out.push({
          event: event.event,
          data: JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "thinking",
              thinking: "",
              signature: "",
            },
          }),
        })

        return out
      }

      return [event]
    }

    // content_block_delta — remap thinking_delta/text_delta to correct indices
    if (type === "content_block_delta") {
      const delta = parsed.delta as Record<string, unknown>
      const index = parsed.index as number
      const deltaType = delta?.type as string

      if (deltaType === "thinking_delta") {
        this.hasSeenThinking = true

        // Ensure thinking block is started
        const out: SSEEvent[] = []

        if (this.thinkingContentBlockStarted) {
          // Thinking block already started in content_block_start handler
        }

        // Emit thinking_delta at index 0
        out.push({
          event: event.event,
          data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "thinking_delta",
              thinking: delta.thinking as string,
            },
          }),
        })

        return out
      }

      if (deltaType === "text_delta") {
        const out: SSEEvent[] = []

        // If we were in thinking mode, close it and open text block
        if (this.thinkingContentBlockStarted && !this.textContentBlockStarted) {
          // Emit signature_delta BEFORE closing the thinking block
          out.push({
            event: event.event,
            data: JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "signature_delta",
                signature: "ErQBCmIYATYBIAAqAgxkZWZhdWx0" + Buffer.from(String(Date.now())).toString("base64"),
              },
            }),
          })

          // Now close thinking block
          out.push({
            event: event.event,
            data: JSON.stringify({
              type: "content_block_stop",
              index: 0,
            }),
          })

          // Start text block at index 1
          out.push({
            event: event.event,
            data: JSON.stringify({
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "text",
                text: "",
              },
            }),
          })

          this.textContentBlockStarted = true
          this.hasSeenTextAfterThinking = true
        }

        // Emit text_delta at index 1 (or original index if no thinking happened)
        const targetIndex = this.hasSeenTextAfterThinking ? 1 : index
        out.push({
          event: event.event,
          data: JSON.stringify({
            type: "content_block_delta",
            index: targetIndex,
            delta: {
              type: "text_delta",
              text: delta.text as string,
            },
          }),
        })

        return out
      }

      // Other delta types (signature_delta, input_json_delta) — passthrough
      return [event]
    }

    // content_block_stop
    if (type === "content_block_stop") {
      const out: SSEEvent[] = []

      if (this.thinkingContentBlockStarted && !this.textContentBlockStarted) {
        // Only thinking happened, no text — signature first, then close thinking
        out.push({
          event: event.event,
          data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "signature_delta",
              signature: "ErQBCmIYATYBIAAqAgxkZWZhdWx0" + Buffer.from(String(Date.now())).toString("base64"),
            },
          }),
        })

        // Close thinking block
        out.push({
          event: event.event,
          data: JSON.stringify({
            type: "content_block_stop",
            index: 0,
          }),
        })

        // Start and immediately close empty text block
        out.push({
          event: event.event,
          data: JSON.stringify({
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          }),
        })
        out.push({
          event: event.event,
          data: JSON.stringify({
            type: "content_block_stop",
            index: 1,
          }),
        })

        this.textContentBlockStarted = true
      } else if (this.textContentBlockStarted) {
        // Close the text block
        out.push({
          event: event.event,
          data: JSON.stringify({
            type: "content_block_stop",
            index: 1,
          }),
        })
      } else {
        // No transformation happened — passthrough
        return [event]
      }

      return out
    }

    // message_delta — fix usage if thinking tokens were consumed
    if (type === "message_delta") {
      return [event]
    }

    // message_stop — passthrough
    if (type === "message_stop") {
      return [event]
    }

    return [event]
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", upstream: UPSTREAM }), {
        headers: { "content-type": "application/json" },
      })
    }

    // Only handle /v1/messages POST
    if (url.pathname !== "/v1/messages" && url.pathname !== "/v1/messages/") {
      // Proxy everything else transparently
      return proxyRequest(req, url)
    }

    if (req.method !== "POST") {
      return proxyRequest(req, url)
    }

    log(`${req.method} ${url.pathname}`)

    // Read the request body
    const body = await req.json()

    const isStreaming = body.stream === true
    log(`streaming=${isStreaming}, model=${body.model}`)

    // Build upstream URL
    const upstreamUrl = `${UPSTREAM}${url.pathname}`

    // Forward headers (strip host, add required)
    const headers: Record<string, string> = {}
    for (const [key, value] of req.headers.entries()) {
      const lower = key.toLowerCase()
      if (lower === "host" || lower === "content-length") continue
      headers[key] = value
    }
    headers["content-type"] = "application/json"

    if (isStreaming) {
      return handleStreaming(upstreamUrl, headers, body)
    } else {
      return handleNonStreaming(upstreamUrl, headers, body)
    }
  },
})

async function proxyRequest(req: Request, url: URL): Promise<Response> {
  const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`
  const headers: Record<string, string> = {}
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase()
    if (lower === "host" || lower === "content-length") continue
    headers[key] = value
  }

  const body = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined

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

async function handleNonStreaming(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  const upstreamResp = await fetch(upstreamUrl, {
    ...fetchOpts,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  const respBody = await upstreamResp.json() as Record<string, unknown>
  log("upstream response keys:", Object.keys(respBody).join(", "))

  const transformed = transformNonStreamingResponse(respBody)

  return new Response(JSON.stringify(transformed), {
    status: upstreamResp.status,
    headers: { "content-type": "application/json" },
  })
}

function handleStreaming(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Response {
  const transformer = new StreamTransformer()

  // Create a TransformStream to process SSE events
  const { readable, writable } = new TransformStream()

  // Process the upstream response asynchronously
  ;(async () => {
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    try {
      const upstreamResp = await fetch(upstreamUrl, {
        ...fetchOpts,
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })

      if (!upstreamResp.ok) {
        // Error response — passthrough
        const errBody = await upstreamResp.text()
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

        // Process complete SSE events from buffer
        const events = parseSSE(buffer)
        // Keep incomplete trailing data in buffer
        const lastDoubleNewline = buffer.lastIndexOf("\n\n")
        if (lastDoubleNewline !== -1) {
          buffer = buffer.slice(lastDoubleNewline + 2)
        }

        for (const event of events) {
          const transformed = transformer.transform(event)
          for (const t of transformed) {
            await writer.write(encoder.encode(formatSSE(t)))
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const events = parseSSE(buffer)
        for (const event of events) {
          const transformed = transformer.transform(event)
          for (const t of transformed) {
            await writer.write(encoder.encode(formatSSE(t)))
          }
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