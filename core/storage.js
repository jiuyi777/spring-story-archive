const DB_NAME = 'spring-story-archive';
const DB_VERSION = 3;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export function openArchiveStorage(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) throw new Error('此浏览器不支持 IndexedDB，春序档案无法保存。');
  const request = indexedDb.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('summaries')) {
      const store = database.createObjectStore('summaries', { keyPath: 'key' });
      store.createIndex('chatKey', 'chatKey', { unique: false });
    }
    if (!database.objectStoreNames.contains('rollups')) {
      database.createObjectStore('rollups', { keyPath: 'chatKey' });
    }
    if (!database.objectStoreNames.contains('checkpoints')) {
      const store = database.createObjectStore('checkpoints', { keyPath: 'key' });
      store.createIndex('chatKey', 'chatKey', { unique: false });
    }
    if (!database.objectStoreNames.contains('profiles')) {
      const store = database.createObjectStore('profiles', { keyPath: 'key' });
      store.createIndex('chatKey', 'chatKey', { unique: false });
    }
    if (!database.objectStoreNames.contains('npcs')) {
      const store = database.createObjectStore('npcs', { keyPath: 'id' });
      store.createIndex('chatKey', 'chatKey', { unique: false });
    }
    if (!database.objectStoreNames.contains('vectors')) {
      const store = database.createObjectStore('vectors', { keyPath: 'key' });
      store.createIndex('chatKey', 'chatKey', { unique: false });
    }
  };

  return requestResult(request).then((database) => createIndexedDbStorage(database));
}

function createIndexedDbStorage(database) {
  async function getAllForChat(storeName, chatKey) {
    const transaction = database.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const rows = store.indexNames.contains('chatKey')
      ? await requestResult(store.index('chatKey').getAll(chatKey))
      : (await requestResult(store.getAll())).filter((row) => row.chatKey === chatKey);
    await transactionDone(transaction);
    return rows;
  }

  async function put(storeName, value) {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(structuredClone(value));
    await transactionDone(transaction);
    return value;
  }

  async function remove(storeName, key) {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
  }

  return {
    listSummaries: (chatKey) => getAllForChat('summaries', chatKey),
    putSummary: (value) => put('summaries', value),
    deleteSummary: (key) => remove('summaries', key),
    listCheckpoints: (chatKey) => getAllForChat('checkpoints', chatKey),
    putCheckpoint: (value) => put('checkpoints', value),
    async getProfile(key) {
      const transaction = database.transaction('profiles', 'readonly');
      const value = await requestResult(transaction.objectStore('profiles').get(key));
      await transactionDone(transaction);
      return value ?? null;
    },
    putProfile: (value) => put('profiles', value),
    listNpcs: (chatKey) => getAllForChat('npcs', chatKey),
    putNpc: (value) => put('npcs', value),
    listVectors: (chatKey) => getAllForChat('vectors', chatKey),
    putVector: (value) => put('vectors', value),
    deleteVector: (key) => remove('vectors', key),
    async clearVectors(chatKey) {
      const rows = await getAllForChat('vectors', chatKey);
      const transaction = database.transaction('vectors', 'readwrite');
      const store = transaction.objectStore('vectors');
      for (const row of rows) store.delete(row.key);
      await transactionDone(transaction);
    },
    async getRollup(chatKey) {
      const transaction = database.transaction('rollups', 'readonly');
      const value = await requestResult(transaction.objectStore('rollups').get(chatKey));
      await transactionDone(transaction);
      return value ?? null;
    },
    putRollup: (value) => put('rollups', value),
    close: () => database.close(),
  };
}

export function createMemoryStorage() {
  const summaries = new Map();
  const checkpoints = new Map();
  const rollups = new Map();
  const profiles = new Map();
  const npcs = new Map();
  const vectors = new Map();
  return {
    async listSummaries(chatKey) {
      return [...summaries.values()].filter((row) => row.chatKey === chatKey).map((row) => structuredClone(row));
    },
    async putSummary(value) {
      summaries.set(value.key, structuredClone(value));
      return value;
    },
    async deleteSummary(key) {
      summaries.delete(key);
    },
    async listCheckpoints(chatKey) {
      return [...checkpoints.values()].filter((row) => row.chatKey === chatKey).map((row) => structuredClone(row));
    },
    async putCheckpoint(value) {
      checkpoints.set(value.key, structuredClone(value));
      return value;
    },
    async getProfile(key) {
      return structuredClone(profiles.get(key) ?? null);
    },
    async putProfile(value) {
      profiles.set(value.key, structuredClone(value));
      return value;
    },
    async listNpcs(chatKey) {
      return [...npcs.values()].filter((row) => row.chatKey === chatKey).map((row) => structuredClone(row));
    },
    async putNpc(value) {
      npcs.set(value.id, structuredClone(value));
      return value;
    },
    async listVectors(chatKey) {
      return [...vectors.values()].filter((row) => row.chatKey === chatKey).map((row) => structuredClone(row));
    },
    async putVector(value) {
      vectors.set(value.key, structuredClone(value));
      return value;
    },
    async deleteVector(key) {
      vectors.delete(key);
    },
    async clearVectors(chatKey) {
      for (const [key, row] of vectors) if (row.chatKey === chatKey) vectors.delete(key);
    },
    async getRollup(chatKey) {
      return structuredClone(rollups.get(chatKey) ?? null);
    },
    async putRollup(value) {
      rollups.set(value.chatKey, structuredClone(value));
      return value;
    },
    close() {},
  };
}
