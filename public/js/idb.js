// IndexedDB adapter: the logbook lives on this device.
const DB_NAME = 'mileage-logbook';

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function idbAdapter() {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('trips', { keyPath: 'id', autoIncrement: true });
    db.createObjectStore('reports', { keyPath: 'id', autoIncrement: true });
    db.createObjectStore('meta', { keyPath: 'key' });
  };
  const db = await req(open);
  const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
  return {
    getAll: (name) => req(store(name).getAll()),
    put: (name, value) => {
      const v = { ...value };
      if (v.id === undefined || v.id === null) delete v.id;
      return req(store(name, 'readwrite').put(v));
    },
    delete: (name, key) => req(store(name, 'readwrite').delete(key)),
    clear: (name) => req(store(name, 'readwrite').clear()),
  };
}
