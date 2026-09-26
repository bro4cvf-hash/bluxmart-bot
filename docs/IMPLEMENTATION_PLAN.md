# BluxBot and BluxMart Implementation Plan

Date: 2026-09-24

## 1. Non-negotiable safety constraints

- Preserve `.env`, `data/guilds.json`, and `data/bot-config.json` unless the user explicitly requests a data change.
- Never run `/setup`, `/setup full`, `/setup status`, or `/setup clean`.
- Never run `setup.sh`, `auto-setup.ts`, destructive cleanup, guild recreation, or code that deletes managed resources during ordinary synchronization.
- Reuse persisted managed IDs. Create only missing resources and repair drift in place.
- Never print or commit tokens, passwords, hashes, cookies, Stripe secrets, or `.env` values.
- Do not contact Discord during tests. Use synthetic data and deterministic fakes.
- Keep only `/ping` registered unless the user explicitly requests another safe command.
- Do not hand-edit `dist`; regenerate it with `npm run build` after source changes.
- Run `npm run check` and `npm run build` before reporting source changes complete.
- Do not deploy or reload PM2 unless explicitly requested after verification.

## 2. Current baseline to preserve

The workspace changed during planning into a live-sync architecture. Preserve these existing improvements:

- `src/lib/guildSync.ts` is the sole incremental reconciler.
- `src/commands.ts` exposes only `/ping`.
- Existing managed IDs are reused; removed template entries are not automatically deleted.
- Dashboard/template changes trigger serialized live synchronization.
- `src/lib/transcript.ts` now produces bounded PDF output.
- `package-lock.json` includes Express and `pdf-lib`.

The workspace is not a Git repository. A secret-free pre-implementation archive must be created before edits. Git history is recommended later, but implementation must not depend on unavailable Git tooling.

## 3. Release objective

Produce a secure, testable, single-instance BluxBot deployment that:

1. preserves and repairs managed Discord resources in place;
2. exposes the admin dashboard only through a trusted boundary;
3. validates configuration and state at runtime;
4. prevents privilege escalation and unsafe resource adoption;
5. handles Discord, filesystem, and browser failures without unhandled rejections;
6. never deletes ticket evidence or unrelated Discord resources;
7. grants the existing non-Administrator Customer role after verified BluxMart/Stripe payment;
8. supports Discord OAuth identity, signed fulfillment requests, idempotency, and pending-member fulfillment;
9. builds and tests from a clean, reproducible toolchain.

## 4. Security and correctness priorities

### P0

- Rotate the Discord token that is present in the local `.env`; never display it.
- Bind the dashboard to `127.0.0.1` by default and fail closed in public mode without trusted TLS/proxy configuration.
- Remove spoofable forwarded-header trust from rate limiting and cookie security.
- Replace synchronous password derivation with bounded asynchronous work.
- Revoke peer sessions after credential changes.
- Reject privileged or invalid automatic roles; never fall back to the first template role.
- Use only persisted managed IDs. Name adoption requires explicit review.
- Do not let corrupt template/state data trigger default synchronization.
- Protect commerce fulfillment with HMAC, timestamp/replay controls, product allowlists, and idempotency.
- Never place `DISCORD_BOT_TOKEN` in BluxMart frontend code.

### P1

- Atomic, locked, validated JSON persistence with backups and corruption status.
- Read-only live drift auditing and accurate partial sync results.
- Complete Muted/readonly thread-permission masks.
- Safe ticket lifecycle, close authorization, transcript failure retention, and concurrency locks.
- Correct gateway intents and startup/readiness/shutdown lifecycle.
- Strict template and dashboard request validation.
- Optimistic revision/ETag handling for dashboard writes.
- Bounded transcript pagination, CDN allowlisting, redirects, byte limits, and total deadlines.
- Non-root, persistent, health-checked deployment artifacts.

## 5. BluxMart commerce design

### Customer flow

1. Buyer connects Discord through BluxMart OAuth.
2. BluxMart server exchanges the OAuth code and stores the Discord user ID against an internal order/session.
3. Buyer completes Stripe Checkout.
4. BluxMart verifies the signed Stripe webhook using the raw request body.
5. The webhook is inserted into an idempotent order/fulfillment store.
6. A private signed fulfillment request is sent to BluxBot.
7. BluxBot validates the event, maps the trusted Stripe product ID to the stable `customer` managed role key, resolves the current persisted role ID, and grants it idempotently.
8. If the buyer is not in the Discord guild, the order becomes `pending_member`; `guildMemberAdd` retries fulfillment automatically.
9. The buyer and administrator receive a safe success/pending status without exposing secrets.

### Order states

`pending_discord -> pending_payment -> paid -> fulfilled`

Additional states: `pending_member`, `failed`, `refunded`, and `revoked`.

### Fulfillment request

The bot-side private contract will include:

- unique event/order ID;
- Discord user ID;
- trusted Stripe product ID or configured product key;
- issued timestamp;
- request nonce;
- HMAC signature over the canonical raw body and timestamp.

The bot must reject unknown products, stale timestamps, reused nonces, malformed IDs, cross-guild targets, and attempts to grant privileged roles.

### BluxMart-side requirements

- Use Stripe Checkout Sessions created server-side.
- Verify Stripe webhook signatures against the unmodified body.
- Store Stripe event IDs uniquely and acknowledge duplicate events safely.
- Never fulfill from a browser success URL.
- Use an internal order/claim token for purchases completed before Discord linking.
- Keep the bot token outside the website; use a private fulfillment API or authenticated job queue.
- Do not remove roles automatically on refund unless separately approved and audited.

The BluxMart GitHub repository URL is required before website-side implementation.

## 6. Twenty implementation agents and exclusive ownership

### Wave 0 — foundations (parallel)

| Agent | Exclusive ownership | Deliverable |
|---|---|---|
| A01 Toolchain/CI | `package.json`, `package-lock.json`, `tsconfig*.json`, `.github/**`, `scripts/ci/**` | Reproducible supported Node runtime, clean install/build/check/test scripts, test framework, no unrelated major upgrades. Sole dependency/lock writer. |
| A02 Contracts | `src/contracts/**`, `tests/contracts/**` | Stable role/category/channel keys, typed API errors, persistence revisions, Discord operation results, commerce fulfillment contract, compatibility aliases. |
| A03 Runtime config | `src/config.ts`, `.env.example`, `tests/config/**` | Strict env parsing, dashboard host/public/trusted-proxy settings, guild allowlist, commerce settings, stable `DATA_DIR`, no secret logging. |
| A11 Discord primitives | `src/lib/discord/**`, `tests/discord/**` | Bounded retry/reconciliation primitives, per-key operation coordinator, typed Discord ports, safe timeout/cancellation support. |
| A15 Transcript | `src/lib/transcript.ts`, `tests/transcript/**` | Safe PDF pagination, role mention resolution, Discord CDN allowlist, redirect/byte/time/image budgets, deterministic output, failure preservation tests. |

### Wave 1 — state, configuration, and commands (parallel after A01-A03 contracts)

| Agent | Exclusive ownership | Deliverable |
|---|---|---|
| A04 Persistence | `src/store.ts`, `src/lib/persistence/**`, `tests/persistence/repository/**` | Atomic same-directory writes, lock/serialization, revisions, backups, typed errors, safe object keys, compatibility wrappers. |
| A05 Migrations | `src/lib/migrations/**`, `tests/persistence/migration/**`, `scripts/data-*.cjs` | Idempotent legacy-data interpretation, backup/restore validation, no automatic Discord deletion or resource adoption. |
| A06 Templates | `src/botConfig.ts`, `src/lib/template/**`, `tests/template/**` | Total runtime validation/normalization, safe defaults, strict write validation, corrupt-state failure, required operational keys, unchanged valid templates. |
| A07 Auth/security | `src/auth.ts`, `src/hash-password.ts`, `src/lib/security/**`, `tests/security/**` | Async bounded scrypt, strict hash parameters, absolute sessions, peer-session revocation, bounded rate limiter, atomic admin storage, password policy consistency. |
| A16 Commands/deployer | `src/commands.ts`, `src/deploy-commands.ts`, `src/lib/discord/commandDeployer.ts`, `tests/commands/**` | Keep only `/ping`, one testable command-deployment path, safe guild/global deployment, command payload tests. |

### Wave 2 — dashboard, sync, and interactions (parallel after Wave 1)

| Agent | Exclusive ownership | Deliverable |
|---|---|---|
| A08 Dashboard backend | `src/dashboard.ts`, `src/dashboard/http/**`, `src/dashboard/routes/**` except commerce module | App/server factory, async error boundary, safe cookies, trusted proxy, CSRF logout, no-store, structured errors, live mapping validation, revisions, health/readiness integration. |
| A09 Dashboard frontend | `dashboard/public/**`, `tests/dashboard-web/**` | Request sequencing/timeouts, structured error handling, revision conflicts, safe dirty state, loading/retry states, accessible labels/alerts, DOM-safe rendering, responsive fixes without redesign. |
| A10 Live sync | `src/lib/guildSync.ts`, `tests/sync/**` | Managed-ID-only reconciliation, explicit first-time adoption refusal, complete permission masks, panel message tracking, accurate partial results, allowlist behavior, no destructive cleanup. |
| A12 Ticket creation | `src/features/tickets/create/**`, `tests/features/ticket-create/**` | Source/ticket validation, safe category, per-user lock, durable idempotency, configured access tier, three-ticket enforcement, compensated initialization. |
| A14 Members/reviews | `src/features/members/**`, `src/features/reviews/**`, `tests/features/members/**`, `tests/features/reviews/**` | Safe Member role only, queue/deduplication, correct intents, managed Customer-role authorization, bounded review input, no public review fallback. |

### Wave 3 — close, commerce, release (after required Wave 2 contracts)

| Agent | Exclusive ownership | Deliverable |
|---|---|---|
| A13 Ticket close | `src/features/tickets/close/**`, `tests/features/ticket-close/**` | Managed-topic authorization, per-ticket lock, full bounded archive, delete only after durable logging, retry/force policy, no evidence loss. |
| A17 Commerce fulfillment | `src/commerce/**`, `src/dashboard/commerceRoutes.ts`, `tests/commerce/**` | HMAC request verification, timestamp/nonce replay defense, Stripe product allowlist, Customer-key role resolution, idempotent grant, pending-member fulfillment service, audit-safe results. |
| A20 Release engineering | `Dockerfile`, `.dockerignore`, `setup.sh`, `README.md`, `docs/**` except this plan, `scripts/release/**`, `.github/workflows/release.yml` | Sanitized artifacts, no live data/secrets, non-root image, persistent data mount, health checks, Node version gate, backup/restore/runbook, no setup/clean deployment path. |

### Wave 4 — final integration (after all implementation agents)

| Agent | Exclusive ownership | Deliverable |
|---|---|---|
| A18 Bootstrap/lifecycle | `src/index.ts`, `src/app.ts`, `src/bootstrap.ts`, `src/discord/registerEvents.ts`, `tests/bootstrap/**` | Thin composition root, correct intents, commerce route registration, event wiring, startup/readiness/degraded states, graceful bounded shutdown, no import-time side effects. |
| A19 Integration/QA | `tests/integration/**`, `tests/fixtures/**`, `tests/helpers/**`, `scripts/smoke/**` | End-to-end mocked dashboard, persistence races, live sync, interactions, commerce, transcript, lifecycle, and artifact tests; real Discord excluded. |

## 7. Dependency and merge order

1. A01, A02, A03
2. A11, A15
3. A04, A05, A06, A07, A16
4. A08, A09, A10, A12, A14
5. A13, A17, A20
6. A18
7. A19
8. Final independent review and release decision

A02 contracts freeze before dependent agents edit consumers. A01 is the only agent allowed to edit dependency manifests or the lockfile. A08 is the only dashboard server owner. A10 is the only live reconciler owner. No agent edits real `.env` or JSON data.

## 8. Verification gates

### Gate 0 — baseline

- Secret-free rollback archive exists.
- Current source and generated output are inventoried.
- No live Discord operation is used.

### Gate 1 — reproducibility

- Clean `npm ci` succeeds.
- `npm run check` passes.
- `npm run build` passes.
- Clean build contains no obsolete setup modules.
- No dependency or type errors are hidden by stale `dist`.

### Gate 2 — focused tests

- Contracts and migrations pass.
- Persistence concurrency/crash tests pass.
- Template/auth/dashboard tests pass.
- Discord fakes prove no duplicate resources and no false success.
- Transcript SSRF/size/failure tests pass.
- Commerce HMAC/replay/idempotency tests pass.

### Gate 3 — integration

- Dashboard app starts and stops on ephemeral ports.
- No async Express rejection is unhandled.
- Revisions prevent stale writes.
- Dashboard mappings survive live sync.
- First-time name collisions do not mutate unmanaged resources.
- Commerce grants only the persisted Customer role.
- Paid non-member fulfillment resumes on guild join.
- Ticket close never deletes after failed history/PDF/log delivery.

### Gate 4 — release artifacts

- Docker/runtime artifacts contain no `.env`, runtime JSON, ZIP archives, source secrets, or development compiler.
- Runtime is non-root and state is on a persistent mount.
- Health/readiness and graceful shutdown are documented.
- Release archive contains current dashboard source/assets and excludes operational state.
- No setup/clean command or destructive routine is reintroduced.

## 9. BluxMart repository integration gate

Before A17 can be connected to the real website:

- obtain the GitHub repository URL and confirm access;
- inspect the existing framework, database, Stripe SDK, authentication/session system, and deployment;
- identify the exact Stripe Product/Price IDs for purchases that grant Customer;
- define the internal fulfillment authentication/queue mechanism;
- implement Stripe webhook handling in the website repository;
- test with Stripe test mode and a test Discord user/role before enabling live mode.

## 10. Definition of done

- All 20 implementation agents have completed scoped tasks.
- No two agents concurrently owned the same source file.
- Existing valid data and managed IDs are preserved.
- No setup/clean command is registered or executed.
- No real Discord, Stripe live event, or production credential is used in tests.
- The current Discord token is rotated by the user.
- `npm run check` and `npm run build` pass from a clean dependency install.
- Dashboard, sync, ticket, member, review, transcript, and commerce tests pass.
- Remaining deployment-only or external-verification work is explicitly documented.
