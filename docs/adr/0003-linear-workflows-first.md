# ADR 0003: Linear Workflows First

## Status

Accepted

## Decision

The MVP supports ordered linear workflows. DAGs, loops and React Flow are deferred.

## Rationale

Idempotency, execution history and step handler boundaries are more important than visual graph complexity in the first production-shaped version.
