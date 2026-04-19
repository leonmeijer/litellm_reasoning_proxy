# LiteLLM Reasoning Proxy

A lightweight Bun HTTP proxy that fixes LiteLLM's broken reasoning-token mapping for Anthropic API clients like Claude Code.

When reasoning models (GLM-4, GLM-5, DeepSeek-R1, QwQ, etc.) are served through LiteLLM, their thinking/reasoning tokens are either dropped or sent in the wrong content block format. This proxy transparently rewrites those responses into the exact format the Anthropic SDK expects — no code changes required on the client side.

## The Problem

LiteLLM [intentionally separates](https://docs.litellm.ai/docs/reasoning_content) reasoning output into a `reasoning_content` field rather than mapping it into standard Anthropic content blocks. This causes two distinct failures:

### Non-streaming

LiteLLM returns reasoning in an unmapped field while the text content is empty:

```json
{
  "content": [{"type": "text", "text": ""}],
  "reasoning_content": "The user asked 2+2 which equals 4...",
  "usage": {"output_tokens": 80}
}
```

Anthropic SDK clients see an empty text block and hang waiting for content. The 80 reasoning tokens are lost.

### Streaming

LiteLLM sends `thinking_delta` events on a `type: "text"` content block — the same index as regular text:

```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Four"}}
```

The Anthropic SDK expects `thinking_delta` on a `type: "thinking"` block and `text_delta` on a separate `type: "text"` block. Mismatched types cause parsing errors or silent data loss.

### Related LiteLLM issues

- [reasoning_content missing from response](https://github.com/BerriAI/litellm/issues/8193)
- [reasoning_content tokens not counted](https://github.com/BerriAI/litellm/issues/10691)
- [wrapper does not surface reasoning_content](https://github.com/BerriAI/litellm/issues/8987)

## What This Proxy Does

Sits between your Anthropic API client and LiteLLM. Passes requests and API keys through unchanged. Rewrites only the response to match the Anthropic `/v1/messages` format:

| LiteLLM sends                                         | Proxy outputs (Anthropic format)                                        |
|-------------------------------------------------------|-------------------------------------------------------------------------|
| `content_block_start(type:"text", index:0)`           | `content_block_start(type:"thinking", index:0)`                        |
| `thinking_delta` on index 0                           | `thinking_delta` on index 0                                            |
| First `text_delta` on index 0                         | `signature_delta(0)` → `content_block_stop(0)` → `content_block_start(type:"text", 1)` → `text_delta` on index 1 |
| Non-streaming: `reasoning_content` at message level   | `content: [{type:"thinking",...}, {type:"text",...}]`                 |

Synthetic `signature_delta` events are emitted before each `content_block_stop` on thinking blocks, matching the real Anthropic API event order that Claude Code validates against.

### Verified against the real Anthropic API

The proxy output was compared byte-for-byte against a real Anthropic Sonnet 4 streaming response with extended thinking enabled. The SSE event sequence is identical:

```
Anthropic API                    Proxy output
─────────────────────────────    ─────────────────────────────
content_block_start(thinking)    content_block_start(thinking)     ✓
thinking_delta                   thinking_delta                    ✓
signature_delta                  signature_delta                  ✓
content_block_stop               content_block_stop                ✓
content_block_start(text)        content_block_start(text)         ✓
text_delta                       text_delta                        ✓
content_block_stop               content_block_stop                ✓
```

## Quick Start

### Native (Bun)

```bash
# Install Bun if you haven't
curl -fsSL https://bun.sh/install | bash

# Clone and run
git clone https://github.com/leonmeijer/litellm_reasoning_proxy.git
cd litellm_reasoning_proxy

UPSTREAM_URL=https://litellm.your-domain.com \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
bun run server.ts
```

Point your Anthropic client at the proxy:

```bash
# Claude Code
ANTHROPIC_BASE_URL=http://localhost:8081 claude

# Or set it persistently in your shell
export ANTHROPIC_BASE_URL=http://localhost:8081
```

### Pre-built image (GHCR)

```bash
docker pull ghcr.io/leonmeijer/litellm-reasoning-proxy:latest
docker run -d \
  -e UPSTREAM_URL=https://litellm.your-domain.com \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  -p 8081:8081 \
  ghcr.io/leonmeijer/litellm-reasoning-proxy:latest
```

### Docker / Podman

```bash
# Required because the Containerfile uses Docker Hardened Images
docker login dhi.io

docker build -f Containerfile -t reasoning-proxy .
docker run -d \
  -e UPSTREAM_URL=https://litellm.your-domain.com \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  -p 8081:8081 \
  reasoning-proxy
```

Then set `ANTHROPIC_BASE_URL=http://localhost:8081` on the client.

### Kubernetes sidecar

Deploy as a sidecar container in the same pod as your AI agent. The agent talks to the proxy on `localhost`, and the proxy forwards to LiteLLM:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-agent
spec:
  containers:
    - name: agent
      image: my-agent-image
      env:
        - name: ANTHROPIC_BASE_URL
          value: http://localhost:8081
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: litellm-credentials
              key: api-key
    - name: reasoning-proxy
      image: ghcr.io/leonmeijer/litellm-reasoning-proxy:latest
      ports:
        - containerPort: 8081
      env:
        - name: UPSTREAM_URL
          value: https://litellm.internal:4000
        - name: NODE_TLS_REJECT_UNAUTHORIZED
          value: "0"
```

### Standalone Deployment

Run as its own service and point multiple agents at it:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: reasoning-proxy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: reasoning-proxy
  template:
    metadata:
      labels:
        app: reasoning-proxy
    spec:
      containers:
        - name: proxy
          image: ghcr.io/leonmeijer/litellm-reasoning-proxy:latest
          ports:
            - containerPort: 8081
          env:
            - name: UPSTREAM_URL
              value: https://litellm.internal:4000
---
apiVersion: v1
kind: Service
metadata:
  name: reasoning-proxy
spec:
  selector:
    app: reasoning-proxy
  ports:
    - port: 8081
      targetPort: 8081
```

Then in your agent's config: `ANTHROPIC_BASE_URL=http://reasoning-proxy:8081`

## Configuration

All configuration is via environment variables. No config files, no key management.

| Variable                         | Default                  | Description                                                    |
|----------------------------------|--------------------------|----------------------------------------------------------------|
| `UPSTREAM_URL`                   | `http://localhost:4000`  | LiteLLM base URL (no trailing slash)                          |
| `UPSTREAM_CA_FILE`               | `/app/root-ca.crt`       | PEM file used as the custom upstream CA bundle; set to empty to disable it |
| `PORT`                           | `8081`                   | Proxy listen port                                              |
| `DEBUG`                          | `0`                      | Set to `1` to log every request and transformation            |
| `NODE_TLS_REJECT_UNAUTHORIZED`   | `1`                      | Set to `0` to skip TLS verification (self-signed certs)       |

API keys from incoming `x-api-key` and `Authorization` headers are forwarded to LiteLLM as-is. The proxy never stores or manages credentials.

## How It Works

### Streaming path

A stateful `StreamTransformer` processes SSE events in order:

1. LiteLLM opens a `type: "text"` content block at index 0
2. The proxy rewrites it to `type: "thinking"` at index 0
3. `thinking_delta` events pass through at index 0 unchanged
4. When the first `text_delta` arrives, the proxy:
   - Emits a synthetic `signature_delta` on index 0
   - Closes the thinking block (`content_block_stop`, index 0)
   - Opens a new `type: "text"` block at index 1
   - Forwards the `text_delta` on index 1
5. Subsequent `text_delta` events continue on index 1
6. `content_block_stop` closes index 1

### Non-streaming path

Checks for `reasoning_content` at the message level or inside content blocks, then reconstructs the response:

```json
// Before (LiteLLM)
{
  "content": [{"type": "text", "text": ""}],
  "reasoning_content": "Let me think..."
}

// After (proxy)
{
  "content": [
    {"type": "thinking", "thinking": "Let me think...", "signature": "..."},
    {"type": "text", "text": ""}
  ]
}
```

### Passthrough behavior

If a response contains no `reasoning_content` and no `thinking_delta` events (e.g. non-reasoning models like `claude-sonnet` without thinking, or `gpt-4o`), the proxy passes everything through unchanged. Zero overhead for models that already work correctly.

## TLS and Custom CA Certificates

For environments with internal PKI (self-signed or private CA), the proxy supports two approaches:

1. **Skip verification**: Set `NODE_TLS_REJECT_UNAUTHORIZED=0` (recommended for dev/internal networks)
2. **Custom CA**: Replace `root-ca.crt` in the repository or point `UPSTREAM_CA_FILE` at another PEM file. The proxy passes that certificate to Bun's upstream TLS config directly, so the runtime no longer depends on `update-ca-certificates`.

If your upstream uses the default public CA bundle only, set `UPSTREAM_CA_FILE=` to disable the custom CA file and fall back to Bun's built-in trust store.

## Health Check

```
GET /health
```

Returns:

```json
{"status": "ok", "upstream": "https://litellm.your-domain.com"}
```

Useful for Kubernetes liveness/readiness probes.

## Requirements

- [Bun](https://bun.sh) runtime (v1.0+)
- A running LiteLLM instance with at least one reasoning model configured

## GitHub Releases and Images

The repository now includes GitHub Actions workflows for Docker image publication and releases:

- `build-and-publish.yml` publishes `ghcr.io/leonmeijer/litellm-reasoning-proxy`
- `release.yml` creates a manual release and bootstrap tag
- `release-please.yml` automates changelog and subsequent releases after the first `v*` tag exists

CI expects these repository secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

The first release is bootstrapped manually from the GitHub Actions UI by running `Create Release` with version `1.0.0`.

## License

MIT
