// Google Drive backup. Uses Google's sign-in for websites (Google Identity Services) to get a
// short-lived access token with the "drive.file" permission: the app can only see and change
// files it created itself, nothing else in the person's Drive.
//
// The backup lives at  My Drive / Mileage Logbook backups / mileage-backup.zip  and each backup
// replaces the previous one.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'Mileage Logbook backups';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const TOKEN_KEY = 'gdriveToken';

let gisPromise = null;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = Object.assign(document.createElement('script'), { src: GIS_SRC, async: true });
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not reach Google — check your internet connection')); };
      document.head.append(s);
    });
  }
  return gisPromise;
}

// The access token lasts about an hour; it's kept so a reopen within the hour needs no sign-in.
function savedToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    return t && t.expires > Date.now() + 60_000 ? t.token : null;
  } catch {
    return null;
  }
}

function saveToken(token, seconds) {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expires: Date.now() + seconds * 1000 })); } catch { /* ignore */ }
}

export const hasToken = () => Boolean(savedToken());

export function forgetToken() {
  const token = savedToken();
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  if (token) window.google?.accounts?.oauth2?.revoke?.(token, () => {});
}

/** Starts loading Google's sign-in code early, so a tap can open the sign-in window instantly. */
export function preloadGoogle() {
  loadGis().catch(() => {});
}

const SIGNIN_ERRORS = {
  popup_closed: 'Google sign-in was closed',
  popup_failed_to_open: 'The Google sign-in window was blocked — use "Sign in another way"',
};

/**
 * Signs in (if needed) and returns an access token. When no token is saved this must run straight
 * from a tap: iPhone Safari only allows the sign-in window to open immediately after a tap, so
 * nothing is awaited before it opens (Google's code is preloaded with preloadGoogle()).
 */
export function getToken(clientId, { interactive = true } = {}) {
  const saved = savedToken();
  if (saved) return Promise.resolve(saved);
  if (!interactive) return Promise.resolve(null);
  if (!clientId) return Promise.reject(new Error('Add your Google client ID first'));
  if (!window.google?.accounts?.oauth2) {
    preloadGoogle();
    return Promise.reject(new Error('Connecting to Google… tap again in a moment'));
  }
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { reject(new Error(resp.error_description || `Google sign-in failed (${resp.error})`)); return; }
        saveToken(resp.access_token, Number(resp.expires_in) || 3500);
        resolve(resp.access_token);
      },
      error_callback: (err) => reject(new Error(SIGNIN_ERRORS[err?.type] || `Google sign-in failed (${err?.type || 'unknown'})`)),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

// ---- "Sign in another way": a full-page Google sign-in (no pop-up window) ----
// Google sends the person back to the app with the token in the address (#access_token=…).
// The app's address must be listed under "Authorised redirect URIs" in Google Cloud.
const REDIRECT_KEY = 'gdriveRedirect';

export const redirectUri = () => `${window.location.origin}${window.location.pathname}`;

export function signInWithRedirect(clientId, action) {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { localStorage.setItem(REDIRECT_KEY, JSON.stringify({ state, action })); } catch { /* ignore */ }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** On start-up: picks up the token after a full-page sign-in. Returns the action to continue, or null. */
export function takeRedirectToken() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (!hash.has('access_token') && !hash.has('error')) return null;
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(REDIRECT_KEY) || 'null'); localStorage.removeItem(REDIRECT_KEY); } catch { /* ignore */ }
  window.history.replaceState(null, '', window.location.pathname);
  if (!pending || hash.get('state') !== pending.state) return null; // not a sign-in this app started
  if (hash.has('error')) return { error: hash.get('error') };
  saveToken(hash.get('access_token'), Number(hash.get('expires_in')) || 3500);
  return { action: pending.action };
}

async function api(token, url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (res.status === 401) {
    forgetToken();
    throw new Error('Google sign-in expired — tap again to reconnect');
  }
  if (!res.ok) throw new Error(`Google Drive error (${res.status})`);
  return res;
}

const q = (s) => encodeURIComponent(s);

async function findFolder(token) {
  const query = `name='${FOLDER}' and mimeType='${FOLDER_TYPE}' and trashed=false`;
  const res = await api(token, `${API}?q=${q(query)}&fields=files(id)&spaces=drive`);
  return (await res.json()).files?.[0]?.id || null;
}

async function ensureFolder(token) {
  const existing = await findFolder(token);
  if (existing) return existing;
  const res = await api(token, `${API}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: FOLDER_TYPE }),
  });
  return (await res.json()).id;
}

async function findBackup(token, name, folderId) {
  const query = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const res = await api(token, `${API}?q=${q(query)}&fields=files(id,modifiedTime,size)&orderBy=modifiedTime desc&spaces=drive`);
  return (await res.json()).files?.[0] || null;
}

/** Uploads the backup file, replacing the previous one. Returns { id, modifiedTime }. */
export async function uploadBackup(token, file) {
  const folderId = await ensureFolder(token);
  const existing = await findBackup(token, file.name, folderId);
  if (existing) {
    const res = await api(token, `${UPLOAD}/${existing.id}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { 'Content-Type': file.type || 'application/zip' },
      body: file,
    });
    return res.json();
  }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: file.name, parents: [folderId] })], { type: 'application/json' }));
  form.append('file', file);
  const res = await api(token, `${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', body: form });
  return res.json();
}

/** Downloads the backup from Drive as a File, or null if there isn't one. */
export async function downloadBackup(token, name) {
  const folderId = await findFolder(token);
  if (!folderId) return null;
  const found = await findBackup(token, name, folderId);
  if (!found) return null;
  const res = await api(token, `${API}/${found.id}?alt=media`);
  return { file: new File([await res.blob()], name, { type: 'application/zip' }), modifiedTime: found.modifiedTime };
}
