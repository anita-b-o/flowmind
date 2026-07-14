# ADR 0005: No LangChain or LlamaIndex in MVP

## Status

Accepted

## Decision

Use a small explicit provider abstraction in the AI service.

## Rationale

The MVP needs predictable schemas, prompts, costs and failure modes more than a broad orchestration framework.
