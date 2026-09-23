export function required(env, key) {
  const value = env[key]?.trim();
  if (!value || value.startsWith('REPLACE_WITH_')) throw new Error(`Missing configuration: ${key}`);
  return value;
}

export function onyxConfiguration(env, migration = false) {
  if (env.ONYX_DEBUG === 'true') throw new Error('ONYX_DEBUG must be disabled to protect credentials.');
  return {
    baseUrl: env.ONYX_BASE_URL?.trim() || 'https://api.onyx.dev',
    databaseId: required(env, 'ONYX_DATABASE_ID'),
    apiKey: required(env, migration ? 'ONYX_MIGRATION_API_KEY' : env.ONYX_API_KEY ? 'ONYX_API_KEY' : 'ONYX_DATABASE_API_KEY'),
    apiSecret: required(env, migration ? 'ONYX_MIGRATION_API_SECRET' : env.ONYX_API_SECRET ? 'ONYX_API_SECRET' : 'ONYX_DATABASE_API_SECRET'),
    requestLoggingEnabled: false,
    responseLoggingEnabled: false,
  };
}

export function publicConfiguration(env) {
  return {
    firebase: {
      apiKey: required(env, env.FIREBASE_API_KEY ? 'FIREBASE_API_KEY' : 'FIREBASE_WEB_API_KEY'),
      projectId: required(env, 'FIREBASE_PROJECT_ID'),
      authDomain: required(env, 'FIREBASE_AUTH_DOMAIN'),
      appId: required(env, 'FIREBASE_APP_ID'),
    },
    providers: (env.FIREBASE_AUTH_PROVIDERS ?? 'password').split(',').map(x => x.trim() === 'google.com' ? 'google' : x.trim()).filter(x => ['password', 'google'].includes(x)),
    environment: env.WORKSPACE_ENVIRONMENT || 'development',
  };
}

export function firebaseAdminConfiguration(env, { cert, applicationDefault }) {
  const projectId = required(env, 'FIREBASE_PROJECT_ID');
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) {
    let account;
    try { account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be a valid service account document.'); }
    if (!account || account.type !== 'service_account' || account.project_id !== projectId ||
        typeof account.client_email !== 'string' || !account.client_email.endsWith('.gserviceaccount.com') ||
        typeof account.private_key !== 'string' || !account.private_key.includes('-----BEGIN PRIVATE KEY-----')) {
      throw new Error('Firebase service account must belong to FIREBASE_PROJECT_ID.');
    }
    return { projectId, credential: cert(account) };
  }
  if (env.FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS === 'true') return { projectId, credential: applicationDefault() };
  throw new Error('Bind FIREBASE_SERVICE_ACCOUNT_JSON or explicitly enable Firebase application default credentials.');
}
