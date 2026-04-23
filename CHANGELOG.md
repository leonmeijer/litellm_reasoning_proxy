# Changelog

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
