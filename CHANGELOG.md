# Changelog

## [1.7.0](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.6.2...v1.7.0) (2026-06-29)


### Features

* enrich Langfuse traces with user, session & tags (ADR-075) ([#10](https://github.com/leonmeijer/litellm_reasoning_proxy/issues/10)) ([52643dc](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/52643dce3625038f776a9e908b1b8348bb499f8b))
* inject attribution metadata into forwarded LiteLLM requests ([#7](https://github.com/leonmeijer/litellm_reasoning_proxy/issues/7)) ([a604127](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/a60412714246faf81e3cca6a38a64c114fbccf77))

## [1.6.2](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.6.1...v1.6.2) (2026-05-31)


### Bug Fixes

* fold inline system messages and cover agentic-fast for qwen backend ([986d5c2](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/986d5c243c6ab8cdd43848c7805f4665b991ec93))

## [1.6.1](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.6.0...v1.6.1) (2026-05-31)


### Bug Fixes

* fold system prompt into first user message for qwen and agentic-thinking models ([8091bbf](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/8091bbf3e91814776d8c3863468d029894f784fb))

## [1.6.0](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.5.0...v1.6.0) (2026-05-11)


### Features

* tool calling (function-calling) support across the Anthropic ↔ OpenAI bridge:
  - request side: forward `tools` schema (Anthropic `input_schema` → OpenAI `function.parameters`) and `tool_choice` (auto / any → required / none / specific tool)
  - request side: assistant message with `tool_use` content blocks → OpenAI `{content, tool_calls:[{id, function:{name, arguments}}]}`
  - request side: user message with `tool_result` content blocks → one `{role:"tool", tool_call_id, content}` message per result, plus a user text message for any remaining text
  - response side (streaming): convert OpenAI `tool_calls` deltas into Anthropic `content_block_start(tool_use)` + `input_json_delta(partial_json)` + `content_block_stop`, with proper index allocation across thinking / text / tool blocks
  - response side (non-streaming): aggregate tool calls into `tool_use` content blocks with parsed JSON `input`
  - `stop_reason` correctly resolves to `tool_use` when tool calls are present (or upstream returned `finish_reason: tool_calls`)
* drop the legacy `repairToolUseMessages` workaround — no longer needed now that the proxy emits canonical OpenAI `content + tool_calls` instead of forwarding mixed Anthropic blocks verbatim

## [1.5.0](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.4.0...v1.5.0) (2026-05-11)


### Features

* fold system prompt into first user message for `openai/gpt-5-*` models so ChatGPT-subscription backends (which reject `role:"system"` with "System messages are not allowed") become usable for agentic Claude Code clients
* also handle Anthropic-style array system prompts (`[{"type":"text","text":"…"}]`)

## [1.4.0](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.3.0...v1.4.0) (2026-05-11)


### Features

* route OpenAI streaming through reasoning aggregator ([3993733](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/3993733df7409edb196f2389b4a3c17988ebabac))

## [1.3.0](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.1.1...v1.3.0) (2026-04-30)


### Features

* surface reasoning/thinking across all 4 paths ([c2a6172](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/c2a6172349604a1a1b8bfdd1064e26e35130849e))

## [1.1.1](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.1.0...v1.1.1) (2026-04-25)


### Bug Fixes

* repair mixed text+tool_use assistant messages before forwarding ([2b063dc](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/2b063dc2245c9476e95f59cdd9a73ec062426516))
* route streaming through OpenAI endpoint to fix duplicate SSE events ([4318214](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/431821443c49121e551d67604924f0a6f25dfd3e))

## [1.1.0](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.0.1...v1.1.0) (2026-04-23)


### Features

* add per-request upstream target override via ?target= query param ([592e4e2](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/592e4e2c20e74f419a969e57f3536aee22ea720a))

## [1.0.1](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.0.0...v1.0.1) (2026-04-19)


### Bug Fixes

* clean up Containerfile — deduplicate root-ca.crt, use oven/bun base ([0a5eb71](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/0a5eb713ed9a94821fd439fda69eb2ab0f747054))

## [1.0.0] - 2026-04-19

### Features

- initial release of the LiteLLM reasoning proxy
- rewrite LiteLLM reasoning responses into Anthropic-compatible thinking and text blocks

### Documentation

- add deployment examples for Bun, Docker/Podman, and Kubernetes
