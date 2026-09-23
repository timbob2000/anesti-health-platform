import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { onyx } from '@onyx.dev/onyx-database';
import { onyxConfiguration, required } from '../server/config.mjs';

export const checksum = input => createHash('sha256').update(input).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
class MigrationError extends Error {}

export function mergeSchema(remote, desired, dropTables = []) {
  const names = new Set(desired.entities.map(entity => entity.name));
  return { revisionDescription: desired.revisionDescription || 'Workspace migration', entities: [
    ...(remote.entities || []).filter(entity => !names.has(entity.name) && !dropTables.includes(entity.name)), ...desired.entities,
  ] };
}

export function destructiveReasons(diff) {
  return [
    ...(diff.removedTables || []).map(name => `remove table ${name}`),
    ...(diff.changedTables || []).flatMap(table => [
      ...(table.attributes?.removed || []).map(name => `remove ${table.name}.${name}`),
      ...(table.attributes?.changed || []).filter(a => a.from.type !== a.to.type || (a.from.isNullable !== false && a.to.isNullable === false)).map(a => `incompatible attribute ${table.name}.${a.name}`),
      ...(table.attributes?.added || []).filter(a => a.isNullable === false).map(a => `required attribute ${table.name}.${a.name}`),
      ...(table.identifier ? [`change identifier ${table.name}`] : []),
      ...(table.partition ? [`change partition ${table.name}`] : []),
      ...(table.type ? [`change entity type ${table.name}`] : []),
      ...((table.triggers?.added?.length || table.triggers?.changed?.length || table.triggers?.removed?.length) ? [`change triggers ${table.name}`] : []),
    ]),
  ];
}

export function compatibilityProblems(requiredSchema, actual) {
  return requiredSchema.entities.flatMap(expected => {
    const found = actual.entities.find(table => table.name === expected.name);
    if (!found) return [`Missing table ${expected.name}`];
    const issues = [];
    if (canonical(found.identifier) !== canonical(expected.identifier) || (found.partition || '') !== (expected.partition || '')) issues.push(`Identifier/partition mismatch for ${expected.name}`);
    for (const attribute of expected.attributes || []) {
      const remote = found.attributes?.find(a => a.name === attribute.name);
      if (!remote || remote.type !== attribute.type || (attribute.isNullable === false && remote.isNullable !== false)) issues.push(`Incompatible ${expected.name}.${attribute.name}`);
    }
    for (const added of found.attributes || []) {
      if (added.isNullable === false && !expected.attributes.some(a => a.name === added.name)) issues.push(`New required field ${expected.name}.${added.name} prevents old writes`);
    }
    // Changed triggers/resolvers can change semantics despite compatible columns.
    for (const field of ['triggers', 'resolvers']) if (canonical(found[field] || []) !== canonical(expected[field] || [])) issues.push(`Changed ${field} require review for ${expected.name}`);
    return issues;
  });
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(resolve(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function withDatabaseLock(stateDir, databaseIdentity, work) {
  const root = join(stateDir, checksum(databaseIdentity));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'database.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') throw new MigrationError('Database migration lock is held. Confirm the previous job has stopped before performing manual lock recovery.');
    throw error;
  }
  const owner = { token: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() };
  try { await atomicWrite(join(lock, 'owner.json'), owner); return await work(root); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function loadMigrations(directory) {
  const names = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.json$/.test(name)).sort();
  if (!names.length) throw new MigrationError('No ordered migrations were found.');
  const seen = new Set();
  const migrations = [];
  for (const name of names) {
    const raw = await readFile(join(directory, name), 'utf8');
    const entry = JSON.parse(raw);
    const sequence = name.slice(0, 4);
    if (entry.id !== name.slice(0, -5) || seen.has(sequence)) throw new MigrationError('Migration identifiers must be unique and match their filenames.');
    if (entry.schema && !Array.isArray(entry.schema.entities)) throw new MigrationError('Migration schema must contain entities.');
    if (entry.dropTables && (!Array.isArray(entry.dropTables) || !entry.dropTables.every(x => typeof x === 'string'))) throw new MigrationError('dropTables must contain table names.');
    for (const operation of entry.operations || []) {
      if (!['upsert', 'delete'].includes(operation.kind) || typeof operation.table !== 'string' || typeof operation.id !== 'string' || !operation.id) throw new MigrationError('Operations require kind upsert/delete, table, and a stable id.');
      if (operation.kind === 'upsert' && (!operation.record || operation.record.id !== operation.id)) throw new MigrationError('Upserts must include an explicit stable record.id.');
    }
    seen.add(sequence); migrations.push({ ...entry, checksum: checksum(raw) });
  }
  return migrations;
}

export async function applyMigrations({ db, migrations, stateDir, databaseIdentity, environment, retryId, approved = new Set(), output = console.log }) {
  return withDatabaseLock(stateDir, databaseIdentity, async root => {
    const journalPath = join(root, `${checksum(environment)}.json`);
    let journal;
    try { journal = JSON.parse(await readFile(journalPath, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      journal = { environment, databaseFingerprint: checksum(databaseIdentity), migrations: [] };
    }
    for (const recorded of journal.migrations) {
      const source = migrations.find(m => m.id === recorded.id);
      if (!source || source.checksum !== recorded.checksum) throw new MigrationError(`Applied migration source changed or disappeared: ${recorded.id}. Restore its original bytes.`);
    }
    const latestRecordedId = journal.migrations.at(-1)?.id;
    for (const migration of migrations) {
      let record = journal.migrations.find(m => m.id === migration.id);
      if (record?.status === 'completed') continue;
      if (!record && latestRecordedId && migration.id < latestRecordedId) throw new MigrationError('New migrations must be appended after all recorded migrations.');
      if (record && retryId !== migration.id) throw new MigrationError(`Migration ${migration.id} is ${record.status}. Inspect partial effects, then explicitly retry with --retry=${migration.id}.`);
      if (!record) {
        record = { id: migration.id, checksum: migration.checksum, status: 'pending', completedSteps: [], attempts: 0 };
        journal.migrations.push(record);
      }
      record.status = 'running'; record.startedAt = new Date().toISOString(); record.attempts += 1;
      await atomicWrite(journalPath, journal);
      try {
        const remote = await db.getSchema();
        const candidate = mergeSchema(remote, migration.schema || { entities: [] }, migration.dropTables);
        const diff = await db.diffSchema(candidate);
        const destructive = destructiveReasons(diff);
        if ((migration.operations || []).some(op => op.kind === 'delete')) destructive.push('delete data records');
        if ((migration.operations || []).some(op => op.kind === 'upsert')) destructive.push('overwrite data records');
        const approvalToken = `${migration.id}:${migration.checksum}`;
        if (destructive.length && !approved.has(approvalToken)) throw new MigrationError(`Destructive change requires explicit approval for ${environment}: --approve-destructive=${approvalToken}`);
        const validation = await db.validateSchema(candidate);
        if (validation.valid === false || validation.errors?.length) throw new MigrationError(`Schema validation failed for ${migration.id}. Run schema:validate to inspect the schema.`);
        const steps = [
          ...(migration.schema || migration.dropTables?.length ? [{ id: 'schema', run: async () => {
            // Detect a change between planning and publication. The API has no conditional schema write.
            if (canonical((await db.getSchema()).entities) !== canonical(remote.entities)) throw new MigrationError('Remote schema changed during migration. Review before retrying.');
            if (diff.newTables?.length || diff.removedTables?.length || diff.changedTables?.length) await db.updateSchema(candidate, { publish: true });
          } }] : []),
          ...(migration.operations || []).map((op, index) => ({ id: `data:${index}`, run: async () => {
            if (op.kind === 'upsert') await db.save(op.table, op.record);
            else if (await db.findById(op.table, op.id)) await db.delete(op.table, op.id);
          } })),
        ];
        for (const step of steps) {
          if (record.completedSteps.includes(step.id)) continue;
          record.activeStep = step.id; await atomicWrite(journalPath, journal);
          await step.run(); record.completedSteps.push(step.id); delete record.activeStep; await atomicWrite(journalPath, journal);
        }
        record.status = 'completed'; record.completedAt = new Date().toISOString(); delete record.failure;
        await atomicWrite(journalPath, journal); output(JSON.stringify({ id: record.id, checksum: record.checksum, status: record.status }));
      } catch (error) {
        record.status = 'failed'; record.failure = 'Step did not finish successfully; inspect schema/data before retrying.'; record.failedAt = new Date().toISOString();
        await atomicWrite(journalPath, journal);
        throw error;
      }
    }
    return journal;
  });
}

async function main() {
  const command = process.argv[2] || 'status';
  const config = onyxConfiguration(process.env, true);
  const db = onyx.init(config);
  const directory = resolve('migrations');
  const environment = required(process.env, 'WORKSPACE_ENVIRONMENT');
  const databaseIdentity = `${new URL(config.baseUrl).origin}/${config.databaseId}`;
  const desired = JSON.parse(await readFile('schema/onyx.schema.json', 'utf8'));
  if (['diff', 'validate', 'compatible'].includes(command)) {
    const remote = await db.getSchema();
    if (command === 'compatible') {
      const problems = compatibilityProblems(desired, remote); console.log(JSON.stringify({ compatible: problems.length === 0, problems }, null, 2));
      if (problems.length) process.exitCode = 1; return;
    }
    const candidate = mergeSchema(remote, desired);
    if (command === 'diff') {
      const diff = await db.diffSchema(candidate);
      const sources = await loadMigrations(directory);
      let journal = { migrations: [] };
      if (process.env.MIGRATION_STATE_DIR) {
        try { journal = JSON.parse(await readFile(join(resolve(process.env.MIGRATION_STATE_DIR), checksum(databaseIdentity), `${checksum(environment)}.json`), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      let planned = remote;
      const migrations = [];
      for (const source of sources) {
        const recorded = journal.migrations.find(entry => entry.id === source.id);
        if (recorded?.checksum && recorded.checksum !== source.checksum) throw new MigrationError(`Applied migration source changed: ${source.id}.`);
        const status = recorded?.status || 'pending';
        let destructive = [];
        if (status !== 'completed') {
          planned = mergeSchema(planned, source.schema || { entities: [] }, source.dropTables);
          destructive = destructiveReasons(await db.diffSchema(planned));
          if (source.operations?.some(op => op.kind === 'delete')) destructive.push('delete data records');
          if (source.operations?.some(op => op.kind === 'upsert')) destructive.push('overwrite data records');
        }
        migrations.push({ id: source.id, checksum: source.checksum, approvalToken: `${source.id}:${source.checksum}`, status, destructive });
      }
      console.log(JSON.stringify({ diff, destructive: destructiveReasons(diff), migrations }, null, 2));
    } else {
      const result = await db.validateSchema(candidate);
      // Server errors can contain source snippets; report only the outcome.
      console.log(JSON.stringify({ valid: result.valid !== false && !result.errors?.length, errorCount: result.errors?.length || 0 }));
      if (result.valid === false || result.errors?.length) process.exitCode = 1;
    }
    return;
  }
  const stateDir = resolve(required(process.env, 'MIGRATION_STATE_DIR'));
  if (command === 'status') {
    try { console.log(await readFile(join(stateDir, checksum(databaseIdentity), `${checksum(environment)}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; console.log(JSON.stringify({ environment, migrations: [] })); }
    return;
  }
  if (command !== 'apply') throw new MigrationError('Use diff, validate, compatible, status, or apply.');
  const migrations = await loadMigrations(directory);
  const finalSchema = migrations.reduce((schema, migration) => mergeSchema(schema, migration.schema || { entities: [] }, migration.dropTables), { entities: [] });
  const byName = entities => [...entities].sort((a, b) => a.name.localeCompare(b.name));
  if (canonical(byName(finalSchema.entities)) !== canonical(byName(desired.entities))) throw new MigrationError('schema/onyx.schema.json does not match the ordered migrations. Append a migration for every schema change.');
  const retryId = process.argv.find(arg => arg.startsWith('--retry='))?.slice('--retry='.length);
  const approved = new Set(process.argv.filter(arg => arg.startsWith('--approve-destructive=')).map(arg => arg.slice('--approve-destructive='.length)));
  await applyMigrations({ db, migrations, stateDir, databaseIdentity, environment, retryId, approved });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(error instanceof MigrationError ? error.message : 'Migration command failed. Check schema, access permissions, secret bindings, and database availability.');
  process.exitCode = 1;
});
