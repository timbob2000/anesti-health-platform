import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createHandler } from '../server/app.mjs';
import { onyxConfiguration, publicConfiguration, firebaseAdminConfiguration } from '../server/config.mjs';

const env = {
  FIREBASE_WEB_API_KEY: 'public-web-key', FIREBASE_PROJECT_ID: 'example-project',
  FIREBASE_AUTH_DOMAIN: 'example-project.firebaseapp.com', FIREBASE_APP_ID: 'public-app-id',
  ONYX_DATABASE_API_SECRET: 'server-secret-never-return', GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/private.json',
  APP_ORIGIN: 'https://app.example.test', PREVIEW_PARENT_ORIGIN: 'https://admin.example.test',
};
async function fixture(t, changes = {}) {
  const records = new Map();
  const logs = []; const queryConditions = [];
  const db = {
    from: () => {
      let owner;
      const builder = { where: condition => { queryConditions.push(condition.toCondition()); owner = condition.toCondition().criteria.value; return builder; }, orderBy: () => builder, limit: () => builder, list: async () => Array.from(records.values()).filter(n => !owner || n.ownerId === owner) };
      return builder;
    },
    save: async (_table, note) => records.set(note.id, note),
    findById: async (_table, id) => records.get(id),
    delete: async (_table, id) => records.delete(id),
    ...changes.db,
  };
  const server = createServer(createHandler({ db, env: { ...env, ...changes.env }, verifyToken: async token => { if (!['alice', 'bob'].includes(token)) throw new Error('sensitive-sdk-error'); return { uid: token }; }, log: value => logs.push(value) }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path = '', { token = 'alice', method = 'GET', body, headers = {} } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path.startsWith('/health') || path === '/api/config' ? path : `/api/notes${path}`}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { request, records, logs, queryConditions };
}

test('authenticated CRUD prevents access to another owner and mass assignment', async t => {
  const { request, queryConditions } = await fixture(t);
  const create = await request('', { method: 'POST', body: { title: 'First idea', body: 'A note' } });
  assert.equal(create.status, 201); const { note } = await create.json();
  assert.equal(note.ownerId, 'alice');
  assert.equal((await request(`/${note.id}`, { token: 'bob', method: 'PUT', body: { title: 'Stolen', body: '' } })).status, 404);
  assert.equal((await request(`/${note.id}`, { token: 'bob', method: 'DELETE' })).status, 404);
  assert.deepEqual((await (await request('', { token: 'bob' })).json()).notes, []);
  assert.equal(queryConditions.at(-1).criteria.value, 'bob');
  assert.equal((await request('', { method: 'POST', body: { title: 'Bad', body: '', ownerId: 'bob' } })).status, 400);
  const updated = await request(`/${note.id}`, { method: 'PUT', body: { title: 'Revised', body: 'Updated body' } });
  assert.equal((await updated.json()).note.title, 'Revised');
  assert.equal((await request(`/${note.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await request()).json()).notes, []);
});

test('missing, invalid, wrong-origin, and unauthorized identities are denied', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('', { token: null })).status, 401);
  assert.equal((await request('', { token: 'expired' })).status, 401);
  assert.equal((await request('', { headers: { origin: 'https://hostile.example' } })).status, 403);
  const restricted = await fixture(t, { env: { REQUIRE_WORKSPACE_ACCESS_CLAIM: 'true' } });
  assert.equal((await restricted.request()).status, 403);
});

test('public configuration and SDK errors never expose privileged credentials', async t => {
  const { request, logs } = await fixture(t, { db: { save: async () => { throw new Error(env.ONYX_DATABASE_API_SECRET); } } });
  const config = await (await request('/api/config')).text();
  assert.ok(!config.includes('server-secret')); assert.ok(!config.includes('/run/secrets'));
  const response = await request('', { method: 'POST', body: { title: 'Valid title', body: '' } });
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes(env.ONYX_DATABASE_API_SECRET));
  assert.ok(!logs.join('').includes(env.ONYX_DATABASE_API_SECRET));
  assert.ok(!logs.join('').includes('alice'));
  assert.deepEqual(Object.keys(publicConfiguration(env)).sort(), ['environment', 'firebase', 'providers']);
  assert.throws(() => onyxConfiguration({ ONYX_DEBUG: 'true' }), /disabled/);
});

test('health and embedded preview headers enforce readiness and explicit parent origin', async t => {
  const { request } = await fixture(t);
  const response = await request('/health/ready');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors https:\/\/admin.example.test/);
  const failing = await fixture(t, { db: { from: () => { throw new Error('database down'); } } });
  assert.equal((await failing.request('/health/ready')).status, 503);
  assert.equal((await failing.request('/health/live')).status, 200);
});

test('unfinished preview configuration serves health without authorizing data access', async t => {
  let databaseCalls = 0;
  const { request } = await fixture(t, {
    env: { WORKSPACE_PREVIEW: 'true', FIREBASE_PROJECT_ID: '' },
    db: { from: () => { databaseCalls++; throw new Error('must not reach the database'); } },
  });
  assert.deepEqual(await (await request('/health/ready')).json(), { status: 'preview', servicesReady: false });
  assert.equal((await request('/api/config')).status, 503);
  assert.equal((await request('', { token: null })).status, 401);
  assert.equal((await request()).status, 503);
  assert.equal(databaseCalls, 0);
  assert.throws(() => createHandler({ env: {} }), /Missing configuration/);
});

test('real server starts without credentials only for development previews', { timeout: 10000 }, async t => {
  const start = preview => spawn(process.execPath, [new URL('../server/index.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: '0', ...(preview ? { WORKSPACE_PREVIEW: 'true' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const production = start(false);
  t.after(() => production.kill());
  assert.equal((await once(production, 'exit'))[0], 1);
  const preview = start(true);
  t.after(() => preview.kill());
  const lines = createInterface({ input: preview.stdout });
  let port;
  for await (const line of lines) {
    const event = JSON.parse(line);
    if (event.event === 'server_started') { port = event.port; break; }
  }
  assert.ok(port > 0, 'The preview must actually listen for HTTP requests');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`)).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/notes`)).status, 401);
});

test('Firebase server credentials require an explicit binding and matching project', () => {
  const account = { type: 'service_account', project_id: 'example-project', client_email: 'app@example-project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nexample-only\n-----END PRIVATE KEY-----' };
  let adcCalls = 0;
  const sdk = { cert: input => ({ account: input }), applicationDefault: () => { adcCalls++; return 'adc'; } };
  assert.throws(() => firebaseAdminConfiguration(env, sdk), /Bind FIREBASE_SERVICE_ACCOUNT_JSON/);
  assert.equal(adcCalls, 0);
  const configured = firebaseAdminConfiguration({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account) }, sdk);
  assert.equal(configured.projectId, env.FIREBASE_PROJECT_ID);
  assert.deepEqual(configured.credential.account, account);
  assert.throws(() => firebaseAdminConfiguration({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...account, project_id: 'other-project' }) }, sdk), /must belong/);
  assert.throws(() => firebaseAdminConfiguration({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: 'invalid-private-data' }, sdk), /valid service account/);
  assert.equal(firebaseAdminConfiguration({ ...env, FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS: 'true' }, sdk).credential, 'adc');
  const publicConfig = publicConfiguration({ ...env, FIREBASE_API_KEY: 'public-alias', FIREBASE_AUTH_PROVIDERS: 'password,google.com', FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account) });
  assert.deepEqual(publicConfig.providers, ['password', 'google']);
  assert.deepEqual(publicConfiguration({ ...env, FIREBASE_AUTH_PROVIDERS: '' }).providers, []);
  assert.deepEqual(publicConfiguration({ ...env, FIREBASE_AUTH_PROVIDERS: undefined }).providers, ['password']);
  assert.equal(publicConfig.firebase.apiKey, 'public-alias');
  assert.ok(!JSON.stringify(publicConfig).includes('PRIVATE KEY'));
});
