// 扩展自己的 IndexedDB：后台和笔记本页面共用
(() => {
  let opening;
  function open() {
    return opening ||= new Promise((res, rej) => {
      const r = indexedDB.open('bilinotes', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('marks', { keyPath: 'id' }).createIndex('session', 'sessionId');
        db.createObjectStore('subs', { keyPath: 'sessionId' });
        db.createObjectStore('kv');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const store = async (name, mode = 'readonly') => (await open()).transaction(name, mode).objectStore(name);
  globalThis.BN_db = {
    get: async (s, k) => req((await store(s)).get(k)),
    put: async (s, v, k) => req(k === undefined ? (await store(s, 'readwrite')).put(v) : (await store(s, 'readwrite')).put(v, k)),
    del: async (s, k) => req((await store(s, 'readwrite')).delete(k)),
    all: async s => req((await store(s)).getAll()),
    marksOf: async sid => req((await store('marks')).index('session').getAll(sid)),
    countOf: async sid => req((await store('marks')).index('session').count(sid)),
    async update(s, k, fn) { const v = await this.get(s, k); if (!v) return null; fn(v); await this.put(s, v); return v; },
    async deleteSession(sid) {
      const keys = await req((await store('marks')).index('session').getAllKeys(sid));
      for (const k of keys) await this.del('marks', k);
      await this.del('subs', sid);
      await this.del('sessions', sid);
    }
  };
})();
