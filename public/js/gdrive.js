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

/**
 * Signs in (if needed) and returns an access token. Must be called from a tap when no token is
 * saved, because Google opens a small sign-in window.
 */
export async function getToken(clientId, { interactive = true } = {}) {
  const saved = savedToken();
  if (saved) return saved;
  if (!interactive) return null;
  if (!clientId) throw new Error('Add your Google client ID first');
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { reject(new Error(resp.error_description || 'Google sign-in was cancelled')); return; }
        saveToken(resp.access_token, Number(resp.expires_in) || 3500);
        resolve(resp.access_token);
      },
      error_callback: (err) => reject(new Error(err?.type === 'popup_closed' ? 'Google sign-in was closed' : 'Google sign-in failed — check the client ID and that this address is allowed in Google Cloud')),
    });
    client.requestAccessToken({ prompt: '' });
  });
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
