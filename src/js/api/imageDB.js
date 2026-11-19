import { openDB, deleteDB } from 'idb';

export default class ImageDB {
  static DB_NAME = 'visual-bookmarks';
  static DB_VERSION = 1;
  static DB_STORE = 'images';
  static VISIT_DB = 'visual-bookmarks-visit-previews';
  static VISIT_STORE = 'visitPreviews';
  static MAX_VISIT_BYTES = 192 * 1024;
  static #connections = new Map();
  static #latestSamples = new Map();

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

  static #preferredPreview(image, visit, url) {
    const manual = image?.blob?.size && (image.custom || !image.url || image.url === url) ? image : null;
    if (!visit?.blob?.size || manual?.custom) return manual;
    if (!manual) return visit;
    // A shared first image fills empty cards. Later captures use the time the pixels were sampled.
    if (visit.fillMissing) return manual;
    if (Number.isFinite(visit.capturedAt) && Number.isFinite(manual.capturedAt)) {
      return visit.capturedAt > manual.capturedAt ? visit : manual;
    }
    return visit.updated > (manual.updated ?? 0) ? visit : manual;
  }

  static async readBookmarkPreviews(bookmarks) {
    const hiddenIds = new Set();
    if (!bookmarks.length) return { records: [], hiddenIds, complete: true };
    const read = async(keys, isVisit) => {
      if (!keys.length) return new Map();
      const db = await this.#dbConnect(isVisit);
      const store = db.transaction(isVisit ? this.VISIT_STORE : this.DB_STORE).store;
      return new Map(await Promise.all(keys.map(async key => [key, await store.get(key)])));
    };
    const urls = [...new Set(bookmarks.map(({ url }) => url).filter(Boolean))];
    const [images, previews] = await Promise.allSettled([
      read(bookmarks.map(({ id }) => id), false), read(urls, true)
    ]);
    if (images.status === 'rejected' && previews.status === 'rejected') throw images.reason;
    const records = [];
    for (const { id, url } of bookmarks) {
      const image = images.value?.get(id);
      if (image?.url === url && Number.isFinite(image?.hiddenAt)) {
        hiddenIds.add(id);
        continue;
      }
      const visit = previews.value?.get(url);
      const result = this.#preferredPreview(image, visit, url);
      if (!result?.blob) continue;
      const useVisit = result === visit;
      const revision = result.digest ?? ((useVisit ? 'visit:' : 'bookmark:')
        + (result.revision ?? result.updated ?? 'legacy'));
      records.push({
        id, blob: result.blob, revision, custom: !useVisit && !!result.custom,
        source: useVisit ? 'visit' : 'bookmark'
      });
    }
    return { records, hiddenIds, complete: images.status === 'fulfilled' && previews.status === 'fulfilled' };
  }

  static async getForBookmarks(bookmarks) {
    try {
      return (await this.readBookmarkPreviews(bookmarks)).records;
    } catch (error) {
      console.warn(error);
      return [];
    }
  }

  static async latestLegacyCapture(bookmarks) {
    const urls = new Map(bookmarks.map(({ id, url }) => [id, url]));
    const records = await this.getAllByIds([...urls.keys()]);
    return records.reduce((latest, item) => {
      if (!item.blob?.size || item.custom || (item.url && item.url !== urls.get(item.id))) return latest;
      return Math.max(latest, Number.isFinite(item.updated) ? item.updated : 0);
    }, 0);
  }

  static async clearBookmarkPreview(id, url) {
    const db = await this.#dbConnect();
    // A single card can hide a shared image without removing it from other bookmarks.
    await db.put(this.DB_STORE, { id, url, hiddenAt: Date.now() });
  }

  static async putBookmarkPreview({ id, url }, blob, current = () => true, capturedAt = Date.now()) {
    if (!blob.size || blob.size > this.MAX_VISIT_BYTES || !current()) return 'stopped';
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).join(',');
    const visit = await this.#dbConnect(true).then(db => db.get(this.VISIT_STORE, url)).catch(() => undefined);
    const db = await this.#dbConnect();
    if (!current()) return 'stopped';
    const tx = db.transaction(this.DB_STORE, 'readwrite');
    try {
      const previous = await tx.store.get(id);
      const sameBookmark = previous?.url === url;
      const wasCleared = sameBookmark && Number.isFinite(previous.hiddenAt);
      if (previous?.custom) {
        await tx.done;
        return 'protected';
      }
      if (!current() || (sameBookmark && previous.capturedAt > capturedAt)
        || (wasCleared && previous.hiddenAt >= capturedAt)) {
        await tx.done;
        return 'stopped';
      }
      const displayed = wasCleared ? null : this.#preferredPreview(previous, visit, url);
      if (displayed === visit && !visit?.fillMissing && visit?.capturedAt > capturedAt) {
        await tx.done;
        return 'stopped';
      }
      if (displayed?.digest === digest) {
        await tx.done;
        return 'unchanged';
      }
      await tx.store.put({ id, url, blob, digest, capturedAt, updated: Math.max(Date.now(), visit?.updated ?? 0) });
      if (!current()) {
        tx.abort();
        await tx.done.catch(() => undefined);
        return 'stopped';
      }
      await tx.done;
      return 'updated';
    } catch (error) {
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  static async putVisitPreview(url, blob, current = () => true, legacyTimestamp = 0, capturedAt = Date.now(),
    { fillMissing = false } = {}) {
    if (!blob.size || blob.size > this.MAX_VISIT_BYTES || !current()
      || (!fillMissing && (this.#latestSamples.get(url) ?? 0) > capturedAt)) return false;
    if (!fillMissing) {
      // An explicit refresh should take precedence over any initial capture in progress.
      this.#latestSamples.delete(url);
      this.#latestSamples.set(url, capturedAt);
      if (this.#latestSamples.size > 512) this.#latestSamples.delete(this.#latestSamples.keys().next().value);
    }
    const canSave = () => current() && (fillMissing || (this.#latestSamples.get(url) ?? 0) <= capturedAt);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
      .join(',');
    const db = await this.#dbConnect(true);
    if (!canSave()) return false;
    const tx = db.transaction(this.VISIT_STORE, 'readwrite');
    try {
      const previous = await tx.store.get(url);
      const newerManual = !previous?.fillMissing && previous?.capturedAt > capturedAt;
      const sameManual = !previous?.fillMissing && previous?.digest === digest && previous.updated > legacyTimestamp;
      if ((fillMissing ? previous?.blob?.size : newerManual || sameManual) || !canSave()) {
        await tx.done;
        return false;
      }
      await tx.store.put({ url, blob, digest, capturedAt, updated: Math.max(Date.now(), legacyTimestamp + 1),
        ...(fillMissing && { fillMissing: true }) });
      if (!canSave()) {
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

  static async getVisitPreviewUrls() {
    const db = await this.#dbConnect(true);
    return db.getAllKeys(this.VISIT_STORE);
  }

  static async deleteVisitPreview(url, current) {
    const db = await this.#dbConnect(true);
    if (!current) {
      await db.delete(this.VISIT_STORE, url);
      return true;
    }
    if (!current()) return false;
    const tx = db.transaction(this.VISIT_STORE, 'readwrite');
    try {
      await tx.store.delete(url);
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
