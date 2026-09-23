import { initializeApp } from 'firebase/app';
import symbolSnapshot from './symbols.json';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';

const $ = id => document.getElementById(id);
function renderSymbols() {
  const query = $('symbol-search').value.trim().toLowerCase();
  const symbols = symbolSnapshot.symbols.filter(symbol => symbol.toLowerCase().includes(query));
  $('symbol-list').replaceChildren(...symbols.map(symbol => {
    const item = document.createElement('li');
    item.textContent = symbol;
    return item;
  }));
  $('symbol-count').textContent = `${symbolSnapshot.symbols.length} symbols`;
  $('symbols-status').textContent = symbols.length ? `${symbols.length} symbol${symbols.length === 1 ? '' : 's'} shown` : 'No symbols match your search.';
}
$('symbol-search').addEventListener('input', renderSymbols);
$('symbols-source').textContent = `Database snapshot · ${new Date(symbolSnapshot.asOf).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
renderSymbols();
let auth, editingId = null;
const notify = message => { $('status').textContent = message; $('status').hidden = !message; };
const safeError = error => error.code?.startsWith('auth/') ? 'Sign-in was unsuccessful. Check your details and enabled sign-in provider.' : error.message || 'Something went wrong. Please try again.';
try { document.documentElement.dataset.theme = localStorage.getItem('theme') || ''; } catch { /* Storage may be blocked in an embedded preview. */ }
$('theme').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', dark ? 'light' : 'dark'); } catch { /* Theme remains available in this tab. */ }
};

async function api(path, method = 'GET', body) {
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(`/api/notes${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}
function resetEditor() {
  editingId = null; $('note-form').reset(); $('editor-heading').textContent = 'Capture a thought'; $('save').textContent = 'Save note'; $('cancel').hidden = true;
}
function action(text, run, danger = false) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.className = danger ? 'subtle danger' : 'subtle';
  button.onclick = async () => { button.disabled = true; try { await run(); } catch (error) { notify(safeError(error)); } finally { button.disabled = false; } };
  return button;
}
async function refresh() {
  const userId = auth.currentUser?.uid;
  const { notes } = await api('');
  if (auth.currentUser?.uid !== userId) return;
  $('notes').replaceChildren(); $('empty').hidden = notes.length > 0; $('count').textContent = `${notes.length}${notes.length === 100 ? '+' : ''} note${notes.length === 1 ? '' : 's'}`;
  for (const note of notes) {
    const card = document.createElement('article'); card.className = 'panel note';
    const title = document.createElement('h3'); title.textContent = note.title;
    const body = document.createElement('p'); body.textContent = note.body;
    const meta = document.createElement('div'); meta.className = 'note-meta';
    const date = document.createElement('span'); date.textContent = new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const actions = document.createElement('div');
    actions.append(action('Edit', () => { editingId = note.id; $('note-form').elements.title.value = note.title; $('note-form').elements.body.value = note.body; $('editor-heading').textContent = 'Edit your note'; $('save').textContent = 'Save changes'; $('cancel').hidden = false; $('note-form').elements.title.focus(); }), action('Delete', async () => { if (!confirm('Permanently delete this note?')) return; await api(`/${note.id}`, 'DELETE'); if (editingId === note.id) resetEditor(); await refresh(); }, true));
    meta.append(date, actions); card.append(title, body, meta); $('notes').append(card);
  }
}
$('cancel').onclick = resetEditor;
$('note-form').onsubmit = async event => {
  event.preventDefault(); $('save').disabled = true; notify('');
  try { const form = event.currentTarget; await api(editingId ? `/${editingId}` : '', editingId ? 'PUT' : 'POST', { title: form.elements.title.value, body: form.elements.body.value }); resetEditor(); await refresh(); }
  catch (error) { notify(safeError(error)); } finally { $('save').disabled = false; }
};

const authNotice = message => { $('auth-status').textContent = message; $('auth-status').hidden = !message; };
const authControls = [...$('signin-form').querySelectorAll('input, button'), $('google')];
function setAuthBusy(busy) {
  for (const control of authControls) control.disabled = busy;
  $('signin').setAttribute('aria-busy', String(busy));
}
$('toggle-password').onclick = () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('toggle-password').textContent = show ? 'Hide password' : 'Show password';
  $('toggle-password').setAttribute('aria-pressed', String(show));
};
async function authenticate(run, message) {
  setAuthBusy(true); authNotice(message);
  try { await run(); $('signin-form').reset(); authNotice(''); }
  catch { authNotice('Sign-in was unsuccessful. Check your details and try again.'); }
  finally { setAuthBusy(false); $('password').type = 'password'; $('toggle-password').textContent = 'Show password'; $('toggle-password').setAttribute('aria-pressed', 'false'); }
}
// Prevent accidental form navigation while configuration is loading or unavailable.
$('signin-form').onsubmit = event => event.preventDefault();
setAuthBusy(true);
try {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Sign-in is not configured yet. Please try again once setup is complete.');
  const config = await response.json(); auth = getAuth(initializeApp(config.firebase)); $('environment').textContent = config.environment;
  const passwordEnabled = config.providers.includes('password');
  const googleEnabled = config.providers.includes('google');
  $('signin-form').hidden = !passwordEnabled; $('google').hidden = !googleEnabled;
  $('auth-divider').hidden = !(passwordEnabled && googleEnabled);
  setAuthBusy(false); authNotice(passwordEnabled || googleEnabled ? '' : 'No sign-in provider is available. Contact the workspace owner.');
  $('signin-form').onsubmit = event => {
    event.preventDefault(); const form = event.currentTarget;
    authenticate(() => signInWithEmailAndPassword(auth, form.elements.email.value.trim(), form.elements.password.value), 'Signing you in…');
  };
  $('signup').onclick = () => {
    const form = $('signin-form'); if (!form.reportValidity()) return;
    if (form.elements.password.value.length < 6) { authNotice('Choose a password with at least 6 characters to create an account.'); form.elements.password.focus(); return; }
    authenticate(() => createUserWithEmailAndPassword(auth, form.elements.email.value.trim(), form.elements.password.value), 'Creating your account…');
  };
  $('google').onclick = () => authenticate(() => signInWithPopup(auth, new GoogleAuthProvider()), 'Connecting to Google…');
  $('signout').onclick = () => signOut(auth).catch(error => notify(safeError(error)));
  onAuthStateChanged(auth, async user => {
    $('login-layout').hidden = !!user; $('notebook').hidden = !user; $('signout').hidden = !user; $('notes').replaceChildren(); resetEditor(); notify('');
    if (user) { $('identity').textContent = user.email || 'Signed in'; notify('Loading your notes…'); try { await refresh(); notify(''); } catch (error) { notify(safeError(error)); } }
  });
} catch { authNotice('Sign-in is currently unavailable. The workspace owner may need to finish Firebase setup. Refresh to try again.'); setAuthBusy(true); $('signin').setAttribute('aria-busy', 'false'); }
