export interface PersistedBucketMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  addedAt: number;
}

const META_KEY = 'stabledaw.mediaBucket.meta.v1';
const DB_NAME = 'stabledaw-media-bucket';
const DB_VERSION = 1;
const BLOB_STORE = 'bucketBlobs';

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

export const loadBucketMeta = (): PersistedBucketMeta[] => {
  try {
    const raw = window.localStorage.getItem(META_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedBucketMeta[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) =>
      item &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.mimeType === 'string' &&
      typeof item.size === 'number' &&
      typeof item.addedAt === 'number',
    );
  } catch {
    return [];
  }
};

export const saveBucketMeta = (items: PersistedBucketMeta[]): void => {
  window.localStorage.setItem(META_KEY, JSON.stringify(items));
};

export const getBucketBlob = async (id: string): Promise<Blob | null> => {
  const db = await openDb();
  try {
    const tx = db.transaction(BLOB_STORE, 'readonly');
    const store = tx.objectStore(BLOB_STORE);
    const req = store.get(id);
    const value = await new Promise<Blob | null>((resolve, reject) => {
      req.onsuccess = () => {
        const result = req.result;
        resolve(result instanceof Blob ? result : null);
      };
      req.onerror = () => reject(req.error ?? new Error('Failed to load bucket blob'));
    });
    await txDone(tx);
    return value;
  } finally {
    db.close();
  }
};

export const putBucketBlob = async (id: string, blob: Blob): Promise<void> => {
  const db = await openDb();
  try {
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    tx.objectStore(BLOB_STORE).put(blob, id);
    await txDone(tx);
  } finally {
    db.close();
  }
};

export const deleteBucketBlob = async (id: string): Promise<void> => {
  const db = await openDb();
  try {
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    tx.objectStore(BLOB_STORE).delete(id);
    await txDone(tx);
  } finally {
    db.close();
  }
};

export const clearBucketBlobs = async (): Promise<void> => {
  const db = await openDb();
  try {
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    tx.objectStore(BLOB_STORE).clear();
    await txDone(tx);
  } finally {
    db.close();
  }
};
