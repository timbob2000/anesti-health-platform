# Fieldnotes — an Onyx workspace application

A working private notebook with Firebase sign-in, server-authorized CRUD against Onyx, a responsive light/dark UI, container health checks, and ordered schema/data migrations. This is ordinary application source: change the UI and server through workspace tasks, review diffs, and publish a committed revision.

## Commands

Requires Node.js 22 or newer and npm. Run commands from the application root (also the configurable application directory for a monorepo).

```sh
npm ci
cp .env.example .env
# Fill placeholders with your environment configuration; keep .env out of Git.
npm run schema:diff
npm run schema:validate
npm run schema:publish
npm test
npm run dev
```

Open `http://localhost:3000`. The development server watches server files and rebuilds browser JavaScript/CSS. Refresh the preview after a successful rebuild; it does not inject a hot reload connection. For a production build:

```sh
npm run build
npm start
```

`npm run dev` serves the application UI even before Firebase and database bindings are configured. Sign-in and data endpoints remain unavailable until those bindings are ready. Its preview readiness checks the HTTP server so you can iterate on the UI independently of external services.

`GET /health/live` checks the HTTP process. In production (`npm start`), `GET /health/ready` also queries the notes table and returns 503 when Onyx is unavailable or the schema/credentials are incorrect; missing configuration prevents startup. Port defaults to 3000, with the server bound to `0.0.0.0`. `WORKSPACE_PREVIEW` is set only by the development command; do not enable it in deployed environments.

## Connect Onyx and Firebase

Choose an existing Onyx database or provision one through the supported Onyx administration workflow. Each workspace environment should have a separate database and separate application API key/secret. Supply `ONYX_BASE_URL` (defaults to `https://api.onyx.dev`), `ONYX_DATABASE_ID`, `ONYX_API_KEY`, and `ONYX_API_SECRET` at runtime. The SDK-style names `ONYX_DATABASE_API_KEY` and `ONYX_DATABASE_API_SECRET` are also accepted when the shorter aliases are absent. Give application credentials the minimum available read/write role; inject schema-manager credentials as `ONYX_MIGRATION_API_KEY` / `ONYX_MIGRATION_API_SECRET` only into migration jobs. These elevated credentials must not be given to running applications. The Onyx SDK is server-only.

Select a Firebase project and create a web app. Set the public `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY` (or `FIREBASE_WEB_API_KEY`), `FIREBASE_AUTH_DOMAIN`, and `FIREBASE_APP_ID` values. In Firebase Authentication, enable Email/Password and/or Google, matching `FIREBASE_AUTH_PROVIDERS=password,google.com` (`google` is also accepted).

For isolated workspace containers, have the Firebase/Google Cloud account owner create a dedicated service account for this application environment and grant only the Firebase Authentication access needed for token revocation verification. Where workload identity is unavailable, the owner can create its service-account JSON key and save the **complete document** as the encrypted environment secret `FIREBASE_SERVICE_ACCOUNT_JSON`. The server alone parses it through Firebase Admin's `cert()`; startup rejects a service account whose `project_id` differs from `FIREBASE_PROJECT_ID`. Rotate/revoke that key through the owning Google Cloud account and update the secret binding. Do not grant broad project-owner privileges to this account.

For a trusted deployment configured with workload identity or a secret-mounted credential file, leave `FIREBASE_SERVICE_ACCOUNT_JSON` empty and explicitly set `FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS=true`; the file path is named by `GOOGLE_APPLICATION_CREDENTIALS` when used. The application never attempts metadata/default credentials without that explicit setting. The private service account key must never enter source control, browser config, or an image.

Account-owner steps remain necessary unless an authorized provisioning integration performs them: enable authentication, configure Google's consent screen/support email when required, enable providers, grant the service identity Firebase Authentication access, and add each preview/deployed hostname to Firebase Authentication's authorized domains. Add localhost explicitly for local development if it is not authorized. Open the preview in a new tab if the browser blocks popup authentication or third-party storage inside an iframe. The environment editor cannot grant Google account permissions by itself.

The browser gets an ID token from the Firebase client SDK. The server verifies its signature, audience, issuer, expiration, and revocation with `getAuth().verifyIdToken(token, true)`. It ignores any user/owner identifier supplied by the browser. Every note query includes the verified UID; writes/deletes check ownership. Firebase authentication is separate from application authorization: ownership checks always apply, and `REQUIRE_WORKSPACE_ACCESS_CLAIM=true` additionally requires the `workspace_access` custom claim. Grant that claim using a trusted administrative process; users cannot grant it to themselves. By default any authenticated user of the configured Firebase project may create their own notes.

Public Firebase web configuration is intentionally returned from `/api/config`. It does not grant privileged server access. All other configuration and credential values remain server-side. SDK request logging is disabled; `ONYX_DEBUG=true` prevents startup. Errors contain a request identifier, and logs record that identifier/status without tokens, request bodies, or provider exception text.

Official Firebase integration references: [server token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [web authentication](https://firebase.google.com/docs/auth/web/start), and [Admin SDK credentials](https://firebase.google.com/docs/admin/setup).

## Onyx schema and agent tools

`schema/onyx.schema.json` is the current schema contract. Onyx uses JSON schema definitions, not SQL DDL or Prisma. The API schema format is `{ "revisionDescription": "...", "entities": [...] }`. Each entity contains `name`, `type`, `identifier`, `attributes`, `indexes`, `resolvers`, and `triggers`. An attribute uses `name`, a case-sensitive type such as `String`, `Boolean`, `Int`, `Long`, `Double`, or `Timestamp`, and `isNullable`. Identifiers use `generator: "None"`, `"Sequence"`, or `"UUID"`. This project generates note IDs with `crypto.randomUUID()` and uses `None` to preserve those values. `ownerId` and `updatedAt` have ordinary `DEFAULT` indexes.

The Onyx admin JSON editor also uses `tables` in some exported/editor documents. That is not the SDK input used here: keep `entities` in these files. Do not paste serialized `entityText` or UI state into application schemas. Resolver/trigger bodies, when added, use the repository's Onyx server scripting conventions (Kotlin-like expressions), not browser JavaScript; validate through the real schema API before publication. The starter needs no resolvers or triggers.

Agents can use these actual `@onyx.dev/onyx-database@2.8.1` methods from a server-side script with injected credentials:

```js
import { onyx, eq } from '@onyx.dev/onyx-database';
import { onyxConfiguration } from './server/config.mjs';
const db = onyx.init(onyxConfiguration(process.env));
const schema = await db.getSchema();
const ownNotes = await db.from('WorkspaceNote')
  .where(eq('ownerId', authorizedUserId)).limit(25).list();
```

`db.getSchema()`, `db.diffSchema(candidate)`, `db.validateSchema(candidate)`, and `db.updateSchema(candidate, { publish: true })` provide inspection, diff, validation, and publication. `db.save`, `db.findById`, and `db.delete` are used for data operations. These are the SDK methods implemented by the repository, and scripts do not invent REST endpoints. Schema commands merge application-owned entities into the existing schema, preserving unrelated tables. Review name collisions before applying a starter to a shared database.

The application does not contain account provisioning credentials. Database/key provisioning and revocation are control-plane actions through existing Onyx administration services, subject to the current user's permissions and supported roles. The installed SDK has no credential-scoping or database-provisioning API; do not fabricate one. Runtime agents must receive restricted tools/credentials from the workspace execution service. Do not put privileged secret values into task prompts.

## Ordered migrations and recovery

`migrations/0001_create_notes.json` is an immutable, ordered migration. Commit both the current schema and a new migration file for every change. Use filenames `NNNN_description.json`; never modify/delete an applied migration. The runner hashes the exact file bytes with SHA-256 and refuses checksum drift or inserted out-of-order migration IDs. `npm run schema:publish` and `npm run migrate` run the same checksummed migration path; a changed current schema without a corresponding migration is rejected.

```sh
npm run schema:diff
npm run schema:validate
npm run migrate
npm run migrate:status
```

A migration may include a schema snapshot of its owned entities, an explicit `dropTables` list, and ordered `operations`. Supported data operations are `{ "kind": "upsert", "table": "Example", "id": "stable-id", "record": { "id": "stable-id", "value": "new value" } }` and `{ "kind": "delete", "table": "Example", "id": "stable-id" }`. The bounded starter runner deliberately supports only stable-ID operations; custom transformations require an explicitly reviewed extension with its own idempotence/recovery strategy. Do not use these operations with non-idempotent triggers.

Set `MIGRATION_STATE_DIR` to persistent POSIX storage shared by **every migration runner targeting the same database**, including different workspaces/environments. The orchestrator must mount the same volume with compatible UID permissions. A private container volume cannot provide the required coordination. The runner refuses to operate without this path. It takes an atomic per-database lock and stores an atomic, fsynced per-environment journal with IDs, checksums, status, attempts, completed steps, active step, and failure timestamps. Back up the journal with the database. Do not clone it to a new database as though its migrations had already run.

Production destructive changes require explicit, migration-specific checksum approval. The same guard also protects other environments. Removals, incompatible attributes, new required attributes on an existing table, identifier/partition changes, trigger changes, and data writes/deletes are treated as potentially destructive. `npm run schema:diff` includes a `migrations` array with each ID, checksum, status, approval token, and destructive changes so the UI can present review before execution. After reviewing the schema diff, data effects, environment, and backup, an authorized operator can run:

```sh
npm run migrate -- --retry=0002_reviewed_change --approve-destructive=0002_reviewed_change:REPLACE_WITH_PRINTED_SHA256
```

The approval belongs to the specific migration bytes, not a reusable global environment flag. The control plane must restrict who can approve/run a production job and record that actor. The CLI itself does not grant a user production permissions.

On a failure the migration is marked failed, later migrations stop, and already-completed steps remain recorded. A timeout or crash can leave uncertain effects: Onyx does not provide a transaction covering the schema and all data writes. Inspect the actual database before retrying. Retry with `--retry=ID` resumes unfinished stable-ID operations without repeating steps already journaled. A step may have succeeded remotely before its completion was recorded, so replay must remain idempotent. A data delete is safe to retry only for the originally reviewed record; restoring deleted data requires a backup or new forward migration.

A process crash leaves `database.lock` in the fingerprinted database directory, preventing another runner from taking over silently. Inspect its `owner.json`, confirm the original job/container has stopped, and have an authorized operator remove that exact lock directory before retrying. Never delete a live lock or automatically expire it. The runner also compares the remote schema immediately before publication. There is no conditional schema-write/CAS endpoint in the installed SDK, so all schema writers must use the same lock/maintenance process; edits from the admin schema page bypass this lock and must not run concurrently.

## Deployment and promotion

The workspace orchestrator performs container operations; this application does not access the admin host or Docker socket. The container contract is:

| Setting | Value |
| --- | --- |
| Install | `npm ci` |
| Development | `npm run dev` |
| Build | `npm run build` |
| Start | `npm start` |
| Application port | `3000` |
| Readiness | `/health/ready` |
| Liveness | `/health/live` |
| Dockerfile | `Dockerfile` |
| Application persistent files | None; notes live in Onyx |
| Migration state | Shared persistent volume at `MIGRATION_STATE_DIR` |

For a local Docker-capable development machine or isolated build worker:

```sh
npm test
docker build --tag fieldnotes:local .
docker run --rm --publish 3000:3000 --env-file .env \
  --mount type=bind,src=/absolute/path/firebase-service-account.json,dst=/run/secrets/firebase-service-account.json,readonly \
  fieldnotes:local
```

Do not run that Docker command inside the admin service. Use the authenticated workspace runtime for shared deployments, with separate build, preview, and application workloads; configured CPU/memory/storage limits; isolated origins; and no host credentials. Inject only application runtime variables into application containers; exclude migration credentials. The development checkout must be on persistent workspace storage. The Docker image uses a non-root user and the lockfile. Production build infrastructure should pin approved base-image digests and record the resulting immutable image digest.

Publishing should require a clean committed revision, tag that revision, build once, inject environment configuration, apply migrations as a separate authorized job, then start the replacement and test `/health/ready` before traffic switches. Keep the prior deployment if any stage fails. Runtime public configuration allows promotion of the same image digest from staging to production without rebuilding. Use each environment's own database, Firebase project/configuration, scoped secrets, origin, and ingress. Do not copy production database contents when cloning environments unless explicitly requested and authorized.

Set `APP_ORIGIN` to the exact public preview or deployed origin. `PREVIEW_PARENT_ORIGIN` is the admin application's origin when embedding the preview; keep the preview on a separate origin and let the authenticated runtime gateway protect access. The application CSP allows only the specified admin parent to embed it. Idle shutdown, DNS records, certificate issuance/status, ingress authorization, deployment logs/metrics, and secret mounts are supplied by the orchestration service, not this container.

Before rolling back an application image, run its own schema contract against the target database:

```sh
npm run schema:compatible
```

Run this command from the old image/revision with that environment's schema read credentials. It checks required tables/columns, types, nullability, identifiers/partitions, new required fields, and changed trigger/resolver semantics. Block rollback when the check fails and obtain a reviewed compatibility plan. Restoring code, rolling back an application image, and reversing a database migration are separate operations. This starter never automatically runs down migrations or assumes lost data is recoverable.

## Validation and limits

`npm test` exercises ownership CRUD, denied access, public-config allowlisting, secret redaction, health failures, journal durability, checksum drift, lock exclusion, interrupted execution, explicit retries, destructive approval, and rollback compatibility without touching cloud accounts. `npm run build` compiles the real Firebase browser SDK. These checks use injected database/auth adapters; a live Onyx database, Firebase project, authenticated runtime, secret bindings, and deployment ingress are required to prove the full hosted workflow. Run a staging acceptance test with two separate Firebase users, verify one cannot read/edit/delete the other's note, then test a failed readiness check without switching production traffic.

No fake project provisioning, database transaction API, distributed database lock API, DNS configuration, automatic credential grant, or migration rollback endpoint is included. The README names the infrastructure and owner permissions required instead of reporting those steps as complete.
