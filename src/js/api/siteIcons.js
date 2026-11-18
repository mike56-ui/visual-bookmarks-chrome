import { openDB } from 'idb';

const DATABASE = 'visual-bookmarks-site-icons';
const STORE = 'icons';
const LIMIT = 192;
export const MAX_ICON_BYTES = 128 * 1024;
let connection;

function connect() {
  if (!connection) {
    connection = openDB(DATABASE, 1, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: 'origin' });
        store.createIndex('updated', 'updated');
      },
      blocking() {
        connection?.then(db => db.close());
        connection = undefined;
      },
      terminated() {
        connection = undefined;
      }
    });
    connection.catch(() => {
      connection = undefined;
    });
  }
  return connection;
}

export function siteOrigin(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.origin : null;
  } catch {
    return null;
  }
}

export async function readSiteIcon(origin) {
  return (await connect()).get(STORE, origin);
}

export async function saveSiteIcon(record, current) {
  const db = await connect();
  if (!current()) return false;
  const transaction = db.transaction(STORE, 'readwrite');
  try {
    const previous = await transaction.store.get(record.origin);
    if (!current()) {
      await transaction.done;
      return false;
    }
    await transaction.store.put({ ...record, updated: Date.now() });
    let excess = (await transaction.store.count()) - LIMIT;
    if (excess > 0) {
      let cursor = await transaction.store.index('updated').openCursor();
      while (excess-- > 0 && cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
    }
    if (!current()) {
      transaction.abort();
      await transaction.done.catch(() => undefined);
      return false;
    }
    await transaction.done;
    return previous?.digest !== record.digest;
  } catch (error) {
    await transaction.done.catch(() => undefined);
    throw error;
  }
}
