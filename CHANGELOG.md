# Changelog

## [1.0.1](https://github.com/leonmeijer/litellm_reasoning_proxy/compare/v1.0.0...v1.0.1) (2026-04-19)


### Bug Fixes

* clean up Containerfile — deduplicate root-ca.crt, use oven/bun base ([0a5eb71](https://github.com/leonmeijer/litellm_reasoning_proxy/commit/0a5eb713ed9a94821fd439fda69eb2ab0f747054))

## [1.0.0] - 2026-04-19

### Features

- initial release of the LiteLLM reasoning proxy
- rewrite LiteLLM reasoning responses into Anthropic-compatible thinking and text blocks

### Documentation

- add deployment examples for Bun, Docker/Podman, and Kubernetes
