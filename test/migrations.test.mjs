import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyMigrations, checksum, compatibilityProblems, destructiveReasons, loadMigrations, mergeSchema, withDatabaseLock } from '../scripts/migrate.mjs';

const emptyDiff = { newTables: [], removedTables: [], changedTables: [] };
async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'onyx-workspace-migrations-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, databaseIdentity: 'https://api.example.test/database', environment: 'staging', output: () => {} };
}
function database() {
  let schema = { entities: [] }; let publishes = 0;
  return { getSchema: async () => schema, diffSchema: async candidate => ({ ...emptyDiff, newTables: candidate.entities.filter(t => !schema.entities.find(r => r.name === t.name)).map(t => t.name) }), validateSchema: async () => ({ valid: true }), updateSchema: async value => { schema = value; publishes++; }, count: () => publishes, save: async () => {}, findById: async () => null, delete: async () => {} };
}

test('initial migration is durable, idempotent, and detects checksum tampering', async t => {
  const args = await fixture(t); const db = database(); const migrations = await loadMigrations('migrations');
  const first = await applyMigrations({ ...args, db, migrations });
  assert.equal(first.migrations[0].status, 'completed'); assert.equal(db.count(), 1);
  await applyMigrations({ ...args, db, migrations }); assert.equal(db.count(), 1);
  await assert.rejects(applyMigrations({ ...args, db, migrations: [{ ...migrations[0], checksum: 'tampered' }] }), /changed or disappeared/);
  const path = join(args.stateDir, checksum(args.databaseIdentity), `${checksum(args.environment)}.json`);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).migrations[0].checksum, migrations[0].checksum);
});

test('database lock serializes jobs across environments, then releases', async t => {
  const args = await fixture(t);
  await withDatabaseLock(args.stateDir, args.databaseIdentity, async () => {
    await assert.rejects(withDatabaseLock(args.stateDir, args.databaseIdentity, async () => {}), /lock is held/);
  });
  await withDatabaseLock(args.stateDir, args.databaseIdentity, async () => {});
});

test('partial failures require explicit retry and preserve completed steps', async t => {
  const args = await fixture(t); const db = database(); let attempts = 0;
  db.save = async () => { attempts++; if (attempts === 1) throw new Error('sensitive provider error'); };
  const migration = { id: '0002_seed', checksum: 'test-checksum', schema: { entities: [{ name: 'Example', attributes: [] }] }, operations: [{ kind: 'upsert', table: 'Example', id: 'fixed-id', record: { id: 'fixed-id' } }] };
  const options = { ...args, db, migrations: [migration], approved: new Set(['0002_seed:test-checksum']) };
  await assert.rejects(applyMigrations(options), /provider error/);
  await assert.rejects(applyMigrations(options), /explicitly retry/);
  const journal = await applyMigrations({ ...options, retryId: '0002_seed' });
  assert.equal(attempts, 2); assert.equal(db.count(), 1);
  assert.deepEqual(journal.migrations[0].completedSteps, ['schema', 'data:0']);
  assert.equal(journal.migrations[0].status, 'completed');
  assert.ok(!JSON.stringify(journal).includes('provider error'));
});

test('interrupted execution restores its journal without automatically repeating writes', async t => {
  const args = await fixture(t); const db = database(); const migrations = await loadMigrations('migrations');
  await applyMigrations({ ...args, db, migrations });
  const path = join(args.stateDir, checksum(args.databaseIdentity), `${checksum(args.environment)}.json`);
  const interrupted = JSON.parse(await readFile(path, 'utf8')); interrupted.migrations[0].status = 'running';
  await writeFile(path, JSON.stringify(interrupted));
  await assert.rejects(applyMigrations({ ...args, db, migrations }), /is running/);
  await applyMigrations({ ...args, db, migrations, retryId: migrations[0].id }); assert.equal(db.count(), 1);
});

test('destructive production operations require migration-specific checksum approval', async t => {
  const args = await fixture(t); const db = database(); let deleted = 0;
  db.findById = async () => ({ id: 'note' }); db.delete = async () => { deleted++; };
  const migration = { id: '0003_delete', checksum: 'specific-checksum', operations: [{ kind: 'delete', table: 'WorkspaceNote', id: 'note' }] };
  const options = { ...args, environment: 'production', db, migrations: [migration] };
  await assert.rejects(applyMigrations(options), /explicit approval for production/); assert.equal(deleted, 0);
  await applyMigrations({ ...options, retryId: migration.id, approved: new Set([`${migration.id}:${migration.checksum}`]) }); assert.equal(deleted, 1);
});

test('schema merge preserves unrelated tables and compatibility blocks unsafe rollback', () => {
  const base = { entities: [{ name: 'Unrelated' }] }; const desired = { entities: [{ name: 'Note', identifier: { name: 'id' }, attributes: [{ name: 'body', type: 'String', isNullable: false }] }] };
  const merged = mergeSchema(base, desired); assert.deepEqual(merged.entities.map(t => t.name), ['Unrelated', 'Note']);
  assert.deepEqual(compatibilityProblems(desired, merged), []);
  const incompatible = structuredClone(merged); incompatible.entities[1].attributes.push({ name: 'newRequired', type: 'String', isNullable: false });
  assert.match(compatibilityProblems(desired, incompatible).join(' '), /prevents old writes/);
  assert.ok(destructiveReasons({ ...emptyDiff, changedTables: [{ name: 'Note', attributes: { removed: ['body'], changed: [] } }] }).includes('remove Note.body'));
});

test('schema review uses the real SDK and exposes checksummed approval before execution', async t => {
  const args = await fixture(t);
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    // SchemaRoutes returns an empty revision without entities when no schema exists yet.
    res.end(JSON.stringify({ databaseId: 'test', revisionDescription: '' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/migrate.mjs', 'diff'], {
    env: { ...process.env, WORKSPACE_ENVIRONMENT: 'test', ONYX_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ONYX_DATABASE_ID: 'test', ONYX_MIGRATION_API_KEY: 'test-key', ONYX_MIGRATION_API_SECRET: 'test-secret', MIGRATION_STATE_DIR: args.stateDir },
  });
  const review = JSON.parse(stdout);
  assert.deepEqual(review.diff.newTables, ['WorkspaceNote']);
  assert.equal(review.migrations[0].status, 'pending');
  assert.match(review.migrations[0].approvalToken, /^0001_create_notes:[a-f0-9]{64}$/);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.method === 'GET' && request.path === '/schemas/test'), 'Review must not publish schema or mutate data');
});

test('first migration publishes through the real SDK when the database has no schema definition', async t => {
  const args = await fixture(t);
  let schema = { databaseId: 'test', revisionDescription: '' }; let publications = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'PUT') { schema = JSON.parse(body); publications++; }
    res.end(JSON.stringify(req.method === 'POST' ? JSON.parse(body) : schema));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const environment = { ...process.env, WORKSPACE_ENVIRONMENT: 'development', ONYX_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ONYX_DATABASE_ID: 'test', ONYX_MIGRATION_API_KEY: 'test-key', ONYX_MIGRATION_API_SECRET: 'test-secret', MIGRATION_STATE_DIR: args.stateDir };
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/migrate.mjs', 'apply'], { env: environment });
  assert.equal(JSON.parse(stdout.trim()).status, 'completed');
  assert.equal(schema.entities[0].name, 'WorkspaceNote');
  assert.ok(requests.indexOf('POST /schemas/test/validate') < requests.indexOf('PUT /schemas/test?publish=true'));
  assert.equal(publications, 1);
  await promisify(execFile)(process.execPath, ['scripts/migrate.mjs', 'apply'], { env: environment });
  assert.equal(publications, 1, 'A reconnect/retry must not republish the completed first migration');
});
