import { createServer } from 'node:http';
import { onyx } from '@onyx.dev/onyx-database';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createHandler } from './app.mjs';
import { onyxConfiguration, firebaseAdminConfiguration, publicConfiguration } from './config.mjs';

try {
  if (process.env.NODE_ENV === 'production' && process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Firebase emulator is forbidden in production');
  let db, verifyToken;
  try {
    // Validate all settings before creating clients. Development can still serve
    // the UI while an environment's database and sign-in bindings are unfinished.
    publicConfiguration(process.env);
    const databaseConfig = onyxConfiguration(process.env);
    const firebaseConfig = firebaseAdminConfiguration(process.env, { cert, applicationDefault });
    const app = initializeApp(firebaseConfig);
    db = onyx.init(databaseConfig);
    verifyToken = token => getAuth(app).verifyIdToken(token, true);
  } catch (error) {
    if (process.env.WORKSPACE_PREVIEW !== 'true') throw error;
    console.log(JSON.stringify({ event: 'preview_started_without_application_services' }));
  }
  const server = createServer(createHandler({ db, verifyToken }));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(JSON.stringify({ event: 'server_started', port: server.address().port })));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
} catch {
  console.error('Startup failed. Verify runtime configuration and secret bindings.');
  process.exitCode = 1;
}
