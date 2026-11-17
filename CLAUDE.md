# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

All stages 2.1–2.5 are implemented and approved by the user (2.5 on 2026-11-15): contracts/policy, pure rules engine, PostgreSQL persistence/idempotency/reservations/concurrency, authenticated HTTP interface, and packaging/operation with the final §9.4 e2e regression (`docs/notas/regressao-final.md`). Nothing is deployed: deployment needs explicit user approval plus the ADR-0011 deploy items (accepted 2026-11-15: O2 dedicated encrypted overlay; `RISK_HTTP_BIND_SCOPE` implemented), the ADR-0012 backup job (implemented, reviewed and approved 2026-11-16, see `docs/notas/adr-0012-implementacao.md`; nothing applied in production, deploy items U3–U16 still open) and the open operational values listed in that report. ADRs 0013–0018 (Strategy Engine boundary, Proposto) cite SPEC v1.1.0 §16 (versioned 2026-11-17; §1–15 unchanged from v1.0.0); the user decided on 2026-11-16 that the Strategy Engine is a separate project, and its draft contracts/skills live in `../openclaw-strategy-engine/`. Stage notes live in `docs/notas/`.

- `docs/SPEC_OPENCLAW_RISK_ENGINE.md` — the source of truth (SPEC-TRADING-RISK-001). Read it fully before changing anything.
- `docs/adr/0001…0010` — Architecture Decision Records, all in status **Proposto** (not accepted). `docs/adr/TEMPLATE.md` is the format for new ones.
- `README-ADR.md` — ADR catalog and governance rules.
- `migrations/` — versioned SQL (immutable once applied; the runner rejects changed checksums).

Docs and operational logs are in Portuguese; technical identifiers (types, fields, codes) are in English.

## What this project is

A deterministic risk-authorization component that sits between the OpenClaw trading agents (seven agents that *propose* trades) and a future paper-trading executor. It returns `ALLOW_PAPER` or `BLOCK` with structured violation codes. It is **paper-trading only**: `ALLOW_PAPER` never authorizes a real order, and no LLM output influences the decision.

## Non-negotiable rules

- **Fail-closed**: any missing data, dependency failure, rule exception, DB error, unresolved concurrency, stale timestamp, FX/scale problem → no authorization. A rule that throws must never be treated as "no violations".
- **No real execution path**: no exchange/broker credentials, not even as optional env vars; reject any `environment !== PAPER` and any real account.
- **Decimals only** for money/quantities (e.g. `decimal.js`, PostgreSQL `NUMERIC`); never JS `number` for financial decisions. Reject exponential notation and disallowed scale.
- **Don't invent values**: no default monetary limits, no numeric SLAs, no retention periods, no answers to open decisions D-01…D-10 (spec §12). Use explicit test fixtures instead.
- **Don't touch other systems**: do not modify `openclaw-trading_openclaw`, `pixel-agents_web`, `pixel-events_receiver`, the production PostgreSQL/Redis, Traefik, or create Swarm services without explicit approval. Never put risk logic in `/opt/pixel-agents-trading` or the receiver, and never use the `pixel-events` observability channel to carry proposals.
- Identity comes from the authenticated connection; a payload `agentId` that differs from it is rejected.
- To change an accepted ADR, create a new ADR and mark the old one `Substituído por ADR-XXXX` — don't rewrite its history. Never set an ADR to `Aceito` without explicit approval (approver is still "a definir").
- `ALLOW_PAPER` requires `violations=[]`, a `reservationId`, `authorizationExpiresAt` and a persisted reservation; `BLOCK` never carries an active reservation. Transport errors (auth 401/403, contract 400/422, idempotency 409, infra 503) are distinct from domain `BLOCK`, but none yields authorization.
- The agent's `referencePrice` is never the market price; use trusted bid/ask from the context. Contract times must satisfy `createdAt <= now < expiresAt`.
- Architectural checks expected by the ADRs: no network/DB calls from `src/domain` or `src/rules`; no `pixel-agents`/`pixel-events` imports anywhere in the import graph; policy hash = SHA-256 of a documented canonical JSON.

## Target architecture (spec §6)

Stack: Node.js 22+, TypeScript 5 strict, Vitest, PostgreSQL 14 (dedicated `openclaw_risk` DB and least-privilege user on the existing instance). Proposed deploy path `/opt/openclaw-risk-engine`.

Moderate hexagonal layering:
- `src/domain/` — pure contracts (`TradeProposalV1`, `RiskPolicyV1`, `RiskContextV1`, `RiskDecisionV1`, `RiskViolationV1`, `InstrumentSpec`) and value objects (`DecimalAmount`, `Price`, `UtcInstant`). No DB, LLM, or Pixel Agents imports.
- `src/rules/` — one `RiskRule` per check (Strategy), each a pure `evaluate({proposal, policy, context, instrument}) → readonly RiskViolationV1[]`. Evaluated in a fixed order: contract/agent/account → policy → freshness → instrument → market → stop-loss → size/notional → per-trade risk → cash/margin → gross exposure (open + pending reservations + new, no buy/sell netting) → daily loss → reservation.
- `src/application/` — use cases (`EvaluateTradeRisk`, `ReserveRiskCapacity`, `ReleaseRiskReservation`, `ConsumePaperAuthorization`) plus ports (repositories, `MarketDataProvider`, `InstrumentCatalog`, `TransactionManager`, `AuthenticatedAgentContext`, injectable `Clock`).
- `src/infrastructure/` — Postgres adapters/migrations, market data, logging, config. `src/interfaces/` — CLI first; HTTP only when integration needs it.

Transactional flow (spec §7.2): in a single transaction, check idempotency on `(accountId, idempotencyKey)` (same canonical hash → return original decision; different hash → conflict), take a per-account row lock, load the immutable policy plus snapshots, evaluate, then persist decision + reservation + audit (+ optional outbox) **before** `COMMIT`. Never return or publish `ALLOW_PAPER` before a successful commit. Proposal lifecycle: `RECEIVED → BLOCKED | AUTHORIZED_PAPER → CONSUMED | EXPIRED | RELEASED`.

Policies are versioned, immutable, and hashed; changes create new versions. Every decision is bound to account, agent, proposal id/hash, policy version/hash, `marketDataAsOf`, and `snapshotVersion`.

Avoid: mutable singletons holding risk state, in-memory locks as a distributed guarantee, `Math.random()` for IDs, and logging tokens, credentials, raw prompts, or full agent responses.

## Commands

The spec's acceptance criteria require these scripts:

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration   # starts a disposable postgres:14 container (127.0.0.1:55432, tmpfs) and removes it after
npm run test:db -- up|down # manage that container manually; tests refuse any DB that is not local and named *_test
npx vitest run path/to/file.test.ts -t "test name"   # single test
```

Planned test dirs: `tests/{unit,contract,integration,concurrency,fixtures}`. Required unit scenarios UT-001…UT-020 are listed in spec §9.1.

## Delivery phases (spec §10)

Work is staged 2.1 → 2.5, with full end-to-end regression (spec §9.4) **only at the final milestone**. Each stage runs only its relevant local tests and **stops for user review** before the next one starts; never begin a stage without explicit approval. Spec §14 has the original implementation prompt.

## Agent team

Agent teams are enabled in `.claude/settings.json`. Teammates do **not** inherit the leader's conversation — they only see this file, the spec/ADRs and the leader's prompt, so every rule above applies to them too.

Roles live in `.claude/agents/` (the other files there are generic, project-agnostic agents):

| Role | Edits | Purpose |
|---|---|---|
| `arquiteto` | nothing | Plans one stage: contracts, small tasks with owner/files/dependencies, open decisions touched |
| `dominio` | `src/domain/`, `src/rules/` | Pure contracts, decimal value objects, risk rules |
| `backend` | `src/application/`, `src/infrastructure/`, `src/interfaces/`, `src/index.ts`, `migrations/`, `scripts/` | Use cases, ports, Postgres adapters, migrations, CLI/HTTP |
| `tester` | `tests/` | Unit/contract/integration/concurrency tests; reports bugs to the owner, never fixes production code |
| `revisor` | nothing | Fail-closed, financial correctness, concurrency and spec/ADR review with severities |

Team rules:
- One owner per file; ask the owner by message instead of editing outside your area.
- Every change ships with tests; a `TaskCompleted` hook blocks completion while `npm run typecheck` or `npm run test:unit` fails.
- No commits (there is no git repo yet); the leader consolidates and reports to the user.
- The leader does not implement while teammates work, and stops the team at the stage boundary.
- Never answer open decisions D-01…D-10, invent monetary limits/SLAs/retention, or touch production systems — escalate to the leader, who asks the user.

