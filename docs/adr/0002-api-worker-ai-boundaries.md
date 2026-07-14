# ADR 0002: API, Worker and AI Service Boundaries

## Status

Accepted

## Decision

Keep public HTTP responsibilities in NestJS API, workflow execution in a separate NestJS worker process, and LLM prompts/provider calls in FastAPI.

## Rationale

The split demonstrates production boundaries without prematurely introducing many microservices.
