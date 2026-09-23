import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';

const $ = id => document.getElementById(id);
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

try {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Configure Firebase and Onyx for this environment to start the application.');
  const config = await response.json(); auth = getAuth(initializeApp(config.firebase)); $('environment').textContent = config.environment;
  $('signin-form').hidden = !config.providers.includes('password'); $('google').hidden = !config.providers.includes('google');
  $('signin-form').onsubmit = async event => { event.preventDefault(); notify(''); try { const form = event.currentTarget; await signInWithEmailAndPassword(auth, form.elements.email.value, form.elements.password.value); form.reset(); } catch (error) { notify(safeError(error)); } };
  $('signup').onclick = async () => { const form = $('signin-form'); if (!form.reportValidity()) return; try { await createUserWithEmailAndPassword(auth, form.elements.email.value, form.elements.password.value); form.reset(); } catch (error) { notify(safeError(error)); } };
  $('google').onclick = async () => { try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (error) { notify(safeError(error)); } };
  $('signout').onclick = () => signOut(auth).catch(error => notify(safeError(error)));
  onAuthStateChanged(auth, async user => {
    $('signin').hidden = !!user; $('notebook').hidden = !user; $('signout').hidden = !user; $('notes').replaceChildren(); resetEditor(); notify('');
    if (user) { $('identity').textContent = user.email || 'Signed in'; try { await refresh(); } catch (error) { notify(safeError(error)); } }
  });
} catch (error) { notify(safeError(error)); $('signin').hidden = true; }
