// IndexedDB adapter: the logbook lives on this device.
const DB_NAME = 'mileage-logbook';

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function idbAdapter() {
  const open = indexedDB.open(DB_NAME, 2);
  open.onupgradeneeded = (e) => {
    const db = open.result;
    if (e.oldVersion < 1) {
      db.createObjectStore('trips', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('reports', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('meta', { keyPath: 'key' });
    }
    if (e.oldVersion < 2) {
      db.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true }); // receipt images
    }
  };
  // Another tab still running an older version keeps the database open and blocks the upgrade.
  open.onblocked = () => {
    window.dispatchEvent(new CustomEvent('db-blocked'));
  };
  const db = await req(open);
  // If a newer version opens in another tab later, step aside so it can upgrade, then reload.
  db.onversionchange = () => {
    db.close();
    window.location.reload();
  };
  const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
  return {
    getAll: (name) => req(store(name).getAll()),
    get: (name, key) => req(store(name).get(key)),
    put: (name, value) => {
      const v = { ...value };
      if (v.id === undefined || v.id === null) delete v.id;
      return req(store(name, 'readwrite').put(v));
    },
    delete: (name, key) => req(store(name, 'readwrite').delete(key)),
    clear: (name) => req(store(name, 'readwrite').clear()),
  };
}
