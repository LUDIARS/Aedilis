# Aedilis AWS migration

## Runtime preparation

Production entry: `node dist/server/bootstrap.js`, invoked by Excubitor from the
repository root. Setup compiles the server with TypeScript NodeNext, rewrites
relative `.ts` imports, emits imported JSON, builds the browser bundles and prunes
development dependencies in the app and logging submodule. There is no production
tsx loader, watcher, npm wrapper or startup build. Default SQLite and facility
paths remain rooted in the checkout, independently of emitted module locations.
The catalog build command reuses `scripts/site/setup.mjs`, so deploy/reflect
restore the build toolchain before compiling and prune it again afterwards.

Compiler behavior reference:
[TypeScript relative import rewriting](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html#path-rewriting-for-relative-paths).

## Observed state — 2026-10-13

- Local main: `8e9c569`; implementation branch is based on this local main.
- Existing AWS peer: `ip-172-31-8-250`, Linux arm64, Node 25.8.2, approximately
  2 GiB memory. Excubitor federation reports it reachable with Cernere and GLAB
  running. Aedilis is absent from the peer's service inventory.
- Local builds and both existing typecheck configurations pass on Node 24.14.1.
  The compiled server includes `dist/server/meetings/settings.json`.
- Unit/integration/startup tests, Linux arm64 native SQLite loading, login,
  reservation mutations and AWS runtime stability have not been verified.
- The session has no `LICTOR_PORT`; Lictor task registration reports this missing
  prerequisite. No session identity is inferred and no local PR is submitted.
- The normal shell tool fails during environment initialization. A Node tool can
  read files and run local build commands. AWS CLI cannot reach the AWS sign-in
  token endpoint; existing Excubitor federation is reachable independently.
- The shared checkout contains unrelated untracked logs and task documents.
  They are not modified, staged or stashed by this implementation.

## Release gates

1. Resume in a Lictor-connected session. Register `[Ae]` and the actual worktree
   branch, verify repository binding, then submit the clean committed branch to
   Revisor's local PR endpoint. Wait for its tests/review/merge/release result.
   Do not push a task branch or deploy unreleased changes as a substitute.
2. Resolve AWS setup prerequisites via the current Excubitor peer catalog. The
   target must use its own main checkout and initialize the logging submodule.
   Native `better-sqlite3` must be installed/built on Linux arm64; Windows
   `node_modules` must never be copied. Validate the target's Node/runtime and
   available memory before enabling persistent startup.
3. Configure the AWS Cernere topology and Excubitor Vault issuer credentials.
   Excubitor issues per-launch Aedilis client credentials. Preserve the public
   audience and configure the allowed origin in Cernere. GLAB and Aedilis must
   receive the same `GLAB_AEDILIS_CONTEXT_SECRET` through Vault.
4. Resolve the catalog's Concordia dependency and `CONCORDIA_URL` for Discord
   respondent handoff. Concordia is absent from the observed AWS inventory.
   The current catalog enables handoff and startup validates its issuer URL;
   do not silently disable this feature or substitute a guessed endpoint.
5. Bootstrap through the existing AWS peer operation route with `start:false`:
   `{"target":{"kind":"service","code":"aedilis"},"action":"bootstrap","bootstrap":{"repository":"LUDIARS/Aedilis","start":false}}`.
   Keep the returned operation ID and confirm terminal success/steps; HTTP 202
   only means acceptance. Do not resend an operation with an unknown outcome.
6. Preserve existing reservations, meetings, attendance and photo assets before
   switching public traffic. The current `excubitor.bootstrap.json` export/import
   hooks explicitly reject migration as unsupported. Implement and review
   service-owned export/import first, including stopped SQLite/WAL consistency,
   attachment completeness, artifact hash/version/ownership, bounded safe
   extraction, collision rejection and failure recovery. Do not bootstrap an
   empty replacement and call it a successful migration.
7. Transfer the validated artifact to the existing AWS host through the approved
   Taildrop/Excubitor workflow. Import while stopped; retain source data and
   artifacts. Confirm restored record counts and attachment integrity.
8. Start from the AWS main checkout through Excubitor with the required testing
   claim/release. Check `/api/health`, Cernere login, existing reservation and
   meeting access, group booking authorization, public meeting pages and linked
   notification behavior. Confirm there is no watcher/tsx process and observe
   memory, errors and restart recovery. Successful builds alone are not runtime
   validation.
9. Switch the existing public route only after the restored target passes those
   checks. Preserve the old checkout/data for rollback. Do not run concurrent
   writers against independently migrated databases. After cutover, enable the
   agreed Excubitor startup policy and service-owned backups/restore checks.

## Current delivery status

Runtime implementation and local build/typecheck verification are prepared.
Revisor submission is blocked by missing session-sidecar identity. AWS setup,
data migration, public route cutover and production validation remain pending.

## Actio follow-up reconciliation — 2026-10-13

Read the live Actio task API; no task was created or updated by this check.

- `f69efb3d-cc3c-47d6-8183-d1844f7ba505`, project `Ae`,
  "Aedilis: AWS導入用bootstrapセットアップ": `done`. This is the earlier
  bootstrap prerequisite, not completion evidence for the new runtime change.
- `4c877dd6-78f1-45f8-95f6-84324916d0da`, project `Ex`,
  "AWSへAedilis・GLABをセットアップ・デプロイ": `open`. Its acceptance condition
  is AWS startup/health; it explicitly reserves existing-data migration and public
  URL cutover for separate confirmation. Its GLAB work is outside this session's
  human instruction for Aedilis and is not adopted here.
- No exact task link for the current "Aeを安定的に...tsxを使用しない軽量化" human
  instruction was supplied or found in the task list. Related tasks are not
  treated as an authoritative binding or additional execution permission.
- `LICTOR_PORT` remains absent in the current command environment. The prepared
  implementation branch is clean; local main still uses the old tsx/watch entry.
  No review is submitted, no review result is polled and no AWS operation is sent.

The migration/cutover checklist above describes future gates, not granted
permission. Retain existing data and public routing until any required confirmation
is obtained on a concrete prepared migration/cutover plan.
