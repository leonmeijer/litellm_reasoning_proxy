# LiteLLM Reasoning Proxy

A lightweight proxy that transforms LiteLLM responses into exact Anthropic `/v1/messages` format — fixing the missing reasoning/thinking content problem that breaks Claude Code and other Anthropic SDK clients.

## The Problem

Reasoning models (GLM, DeepSeek, QwQ, etc.) return thinking tokens via a `reasoning_content` field that LiteLLM doesn't properly map to the Anthropic content block format. This causes:

- **Non-streaming**: `content: [{type: "text", text: ""}]` with reasoning lost in an unmapped field — Claude Code hangs waiting for actual content
- **Streaming**: `thinking_delta` events sent on a `type: "text"` content block instead of a proper `type: "thinking"` block — Claude Code rejects the mismatch

## What This Proxy Does

Sits between Claude Code (or any Anthropic SDK client) and LiteLLM. Passes API keys through unchanged. Transforms responses to match the exact Anthropic streaming and non-streaming format:

| LiteLLM Output                           | Anthropic Format (after proxy)                    |
|------------------------------------------|----------------------------------------------------|
| `content_block_start(type:"text", 0)`    | `content_block_start(type:"thinking", 0)`         |
| `thinking_delta` on index 0              | `thinking_delta` on index 0                       |
| `text_delta` on index 0                 | `content_block_stop(0)` → `content_block_start(type:"text", 1)` → `text_delta` on index 1 |
| `reasoning_content` at message level     | `content: [{type:"thinking",...}, {type:"text",...}]` |

Includes synthetic `signature_delta` events (required by Claude Code) emitted before `content_block_stop`, matching the real Anthropic API event order.

## Usage

```bash
# Run locally
UPSTREAM_URL=https://your-litellm-instance.example.com \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
DEBUG=1 \
bun run server.ts

# Point Claude Code at the proxy
ANTHROPIC_BASE_URL=http://localhost:8081
```

### Environment Variables

| Variable                       | Default                  | Description                                      |
|--------------------------------|--------------------------|--------------------------------------------------|
| `UPSTREAM_URL`                 | `http://localhost:4000`  | LiteLLM base URL                                 |
| `PORT`                         | `8081`                   | Proxy listen port                                |
| `DEBUG`                        | `0`                      | Set to `1` for verbose logging                   |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1`                      | Set to `0` to skip TLS verification (self-signed) |

API keys from incoming requests are forwarded as-is — no proxy-side key management needed.

## Docker

```bash
docker build -t reasoning-proxy .
docker run -e UPSTREAM_URL=https://litellm:4000 -p 8081:8081 reasoning-proxy
```

The container image includes a root CA certificate for internal PKI. Replace `root-ca.crt` with your own, or remove it from the Containerfile if not needed.

## How It Works

**Streaming path**: A stateful `StreamTransformer` class tracks the content block lifecycle. When LiteLLM opens a `type: "text"` block and sends `thinking_delta` events, the proxy rewrites it into a `type: "thinking"` block, closes it with a synthetic signature when the first `text_delta` arrives, then opens a proper `type: "text"` block at the next index.

**Non-streaming path**: Checks for `reasoning_content` at the message level or inside content blocks, and reconstructs the response with proper `thinking` + `text` content blocks.

Both paths produce output byte-compatible with the Anthropic `/v1/messages` API as consumed by Claude Code's `queryModel` loop.