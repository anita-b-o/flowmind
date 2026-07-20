# RC1 production dependency audit

Audit command: `pnpm audit --prod --audit-level=moderate`.

## `file-type` — GHSA-5v7r-6r5c-r473 and GHSA-j47w-4g3g-c36v

- Chain: NestJS core/common, including the BullMQ Nest adapter, to the optional file inspection dependency.
- Reachability: Flowmind exposes JSON webhook bodies and does not expose file uploads or invoke `file-type` against tenant-controlled ASF/ZIP input. The vulnerable parsers are not part of a request path.
- Fix: `21.3.2`. RC1 pins this patched compatible transitive version and validates Nest/API/Worker builds and tests.
- Decision: override/upgrade. This removes latent risk without changing a public contract.

## `postcss` — GHSA-qx2v-qp2m-jg93

- Chain: Web to Next.js to PostCSS.
- Reachability: build-time CSS processing; Flowmind does not stringify tenant-authored CSS. It is not a production request parser, but compromised/generated CSS could affect the built artifact.
- Fix: `8.5.10` or newer, compatible within the PostCSS 8 line.
- Decision: override/upgrade and rebuild Web.

## `@nestjs/core` — GHSA-36xv-jgw5-4q75

- Chain: direct API/Worker NestJS 10 and the Nest BullMQ adapter.
- Reachability: the advisory concerns downstream reflection of attacker-controlled decorator metadata. Flowmind's controllers and providers are compiled application code; users cannot register decorators, modules, providers or metadata. Production Swagger is disabled unless explicitly enabled, validation strips unknown fields, and errors are normalized.
- Fix: only NestJS `11.1.18` or newer. That is a framework-major migration affecting the API, Worker and adapters.
- Decision: documented acceptance for RC1. Do not force a Nest 11 migration during reliability validation; track it as a post-RC compatibility upgrade. Reassess immediately if dynamic user-defined Nest metadata or plugin loading is introduced.

The release gate remains zero HIGH/CRITICAL. Any remaining MODERATE must match this documented, reproducible output.
