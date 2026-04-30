# Changelog

## [1.2.0](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.1.1...v1.2.0) (2026-04-30)


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
