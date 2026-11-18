import { openDB, deleteDB } from 'idb';

export default class ImageDB {
  static DB_NAME = 'visual-bookmarks';
  static DB_VERSION = 1;
  static DB_STORE = 'images';
  static VISIT_DB = 'visual-bookmarks-visit-previews';
  static VISIT_STORE = 'visitPreviews';
  static VISIT_LIMIT = 192;
  static MAX_VISIT_BYTES = 192 * 1024;
  static #connections = new Map();

  // connect to IndexedDB database
  static #dbConnect(isVisit = false) {
    const name = isVisit ? this.VISIT_DB : this.DB_NAME;
    if (this.#connections.has(name)) return this.#connections.get(name);
    const forget = () => {
      if (this.#connections.get(name) === connection) this.#connections.delete(name);
    };
    const connection = openDB(name, this.DB_VERSION, {
      upgrade(db) {
        if (isVisit) {
          const previews = db.createObjectStore(ImageDB.VISIT_STORE, { keyPath: 'url' });
          previews.createIndex('updated', 'updated');
        } else {
          db.createObjectStore(ImageDB.DB_STORE, { keyPath: 'id', autoIncrement: true });
        }
      },
      blocking() {
        forget();
        connection.then(db => db.close());
      },
      terminated: forget
    });
    this.#connections.set(name, connection);
    connection.catch(forget);
    return connection;
  }

  static async deleteDB() {
    try {
      await Promise.all([this.DB_NAME, this.VISIT_DB].map(async name => {
        const connection = this.#connections.get(name);
        this.#connections.delete(name);
        if (connection) (await connection).close();
        await deleteDB(name);
      }));
      return true;
    } catch (error) {
      console.warn(error);
      return false;
    }
  }

  static async clear() {
    try {
      const [db, visitDb] = await Promise.all([this.#dbConnect(), this.#dbConnect(true)]);
      await Promise.all([db.clear(this.DB_STORE), visitDb.clear(this.VISIT_STORE)]);
      return true;
    } catch (error) {
      console.warn(error);
      return false;
    }
  }

  static async count() {
    try {
      const db = await this.#dbConnect();
      return await db.count(this.DB_STORE);
    } catch (error) {
      console.warn(error);
    }
  }

  static async add(data) {
    try {
      const db = await this.#dbConnect();
      const tx = db.transaction(this.DB_STORE, 'readwrite');

      const promises = data.map((image) => {
        return tx.store.add(image).then((e) => {
          return {
            id: e,
            ...image
          };
        });
      });

      const addedImages = await Promise.all(promises);
      await tx.done;
      return addedImages;
    } catch (error) {
      console.warn(error);
    }
  }

  static async get(id) {
    try {
      const db = await this.#dbConnect();

      return await db.get(this.DB_STORE, id);
    } catch (error) {
      console.warn(error);
    }
  }

  static async update(payload) {
    try {
      const db = await this.#dbConnect();

      return await db.put(this.DB_STORE, payload);
    } catch (error) {
      console.warn(error);
    }
  }

  static async delete(id) {
    try {
      const db = await this.#dbConnect();
      return await db.delete(this.DB_STORE, id);
    } catch (error) {
      console.warn(error);
    }
  }

  static async getAllByIds(ids) {
    try {
      const db = await this.#dbConnect();
      const store = db.transaction(this.DB_STORE).store;
      return (await Promise.all(ids.map(id => store.get(id)))).filter(Boolean);
    } catch (err) {
      console.warn(err);
      return [];
    }
  }

  static async getForBookmarks(bookmarks) {
    if (!bookmarks.length) return [];
    try {
      const [db, visitDb] = await Promise.all([this.#dbConnect(), this.#dbConnect(true)]);
      const images = db.transaction(this.DB_STORE).store;
      const previews = visitDb.transaction(this.VISIT_STORE).store;
      const byUrl = new Map();
      const records = await Promise.all(bookmarks.map(async({ id, url }) => {
        if (url && !byUrl.has(url)) byUrl.set(url, previews.get(url));
        const [image, visit] = await Promise.all([images.get(id), byUrl.get(url)]);
        const manual = image?.blob && (image.custom || !image.url || image.url === url) ? image : null;
        const useVisit = visit?.blob && !manual?.custom && (visit.updated > (manual?.updated ?? 0));
        const result = useVisit ? visit : manual;
        return result?.blob && { id, blob: result.blob, custom: result === manual && !!manual.custom };
      }));
      return records.filter(Boolean);
    } catch (error) {
      console.warn(error);
      return [];
    }
  }

  // Imported or user-supplied covers always win over captures, including concurrent updates.
  static async putManualThumbnail(id, url, blob) {
    const db = await this.#dbConnect();
    const tx = db.transaction(this.DB_STORE, 'readwrite');
    try {
      if ((await tx.store.get(id))?.custom) {
        await tx.done;
        return false;
      }
      await tx.store.put({ id, url, blob, custom: false, updated: Date.now() });
      await tx.done;
      return true;
    } catch (error) {
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  static async putVisitPreview(url, blob, current = () => true) {
    if (!blob.size || blob.size > this.MAX_VISIT_BYTES) return false;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
      .join(',');
    const db = await this.#dbConnect(true);
    if (!current()) return false;
    const tx = db.transaction(this.VISIT_STORE, 'readwrite');
    try {
      if ((await tx.store.get(url))?.digest === digest || !current()) {
        await tx.done;
        return false;
      }
      await tx.store.put({ url, blob, digest, updated: Date.now() });
      let excess = (await tx.store.count()) - this.VISIT_LIMIT;
      if (excess > 0) {
        let cursor = await tx.store.index('updated').openCursor();
        while (excess-- > 0 && cursor) {
          await cursor.delete();
          cursor = await cursor.continue();
        }
      }
      if (!current()) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return false;
      }
      await tx.done;
      return true;
    } catch (error) {
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  static async deleteVisitPreview(url) {
    const db = await this.#dbConnect(true);
    await db.delete(this.VISIT_STORE, url);
  }

  static async deleteMismatchedThumbnail(id, url) {
    const db = await this.#dbConnect();
    const tx = db.transaction(this.DB_STORE, 'readwrite');
    try {
      const image = await tx.store.get(id);
      if (image && !image.custom && image.url !== url) await tx.store.delete(id);
      await tx.done;
    } catch (error) {
      await tx.done.catch(() => undefined);
      throw error;
    }
  }
}
