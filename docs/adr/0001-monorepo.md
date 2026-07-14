# ADR 0001: pnpm and Turborepo Monorepo

## Status

Accepted

## Decision

Use a pnpm workspace with Turborepo for task orchestration.

## Rationale

This keeps web, API, worker, AI service and shared packages in one repository while preserving clear deployable boundaries.
