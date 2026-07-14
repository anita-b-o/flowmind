# ADR 0004: BullMQ and Redis for MVP Queueing

## Status

Accepted

## Decision

Use BullMQ on Redis for the first asynchronous execution engine.

## Rationale

BullMQ integrates well with NestJS, supports retries/backoff and is simpler than Kafka or Kubernetes-native workflow engines for this MVP.
