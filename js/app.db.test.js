// Import the functions to be tested
const {
  openDB,
  withStore,
  getLastActivity,
  getAllActivities,
  upsertRecent,
  trimRecentUnpinned,
  setPinned,
  getRecentAll,
  deleteRecent,
  updateRecentOrderForNewTask,
  updateRecentOrderForPinToggle,
  seedPinnedDefaults,
  deleteActivityByEnd,
  getActivityByEnd,
  STORES,
  SEEDED_FLAG
} = require('./app.js');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');

// Reset the database before each test
beforeEach(() => {
  global.indexedDB = new FDBFactory();
  localStorage.clear();
});

describe('IndexedDB Data Layer', () => {

  test('openDB should create object stores on upgrade', async () => {
    const db = await openDB();
    expect(db.objectStoreNames.contains(STORES.activities)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.recent)).toBe(true);
    db.close();
  });

  test('withStore should perform operations', async () => {
    const db = await openDB();
    const activity = { task: 'Test', startTime: '2025-01-01T00:00:00.000Z', endTime: '2025-01-01T01:00:00.000Z' };

    await withStore(db, STORES.activities, 'readwrite', (store) => {
      store.put(activity);
    });

    const result = await withStore(db, STORES.activities, 'readonly', (store) => {
      return store.get(activity.endTime);
    });

    expect(result).toEqual(activity);
    db.close();
  });

  test('getLastActivity should return the most recent activity', async () => {
    const db = await openDB();
    const activity1 = { task: 'Test 1', startTime: '2025-01-01T00:00:00.000Z', endTime: '2025-01-01T01:00:00.000Z' };
    const activity2 = { task: 'Test 2', startTime: '2025-01-01T01:00:00.000Z', endTime: '2025-01-01T02:00:00.000Z' };

    await withStore(db, STORES.activities, 'readwrite', (store) => {
      store.put(activity1);
      store.put(activity2);
    });

    const last = await getLastActivity(db);
    expect(last).toEqual(activity2);
    db.close();
  });

  test('getAllActivities should return all activities', async () => {
    const db = await openDB();
    const activity1 = { task: 'Test 1', endTime: '2025-01-01T01:00:00.000Z' };
    const activity2 = { task: 'Test 2', endTime: '2025-01-01T02:00:00.000Z' };

    await withStore(db, STORES.activities, 'readwrite', (store) => {
      store.put(activity1);
      store.put(activity2);
    });

    const all = await getAllActivities(db);
    expect(all).toHaveLength(2);
    expect(all.map(a => a.task)).toContain('Test 1');
    db.close();
  });

  test('upsertRecent should add or update a recent item', async () => {
    const db = await openDB();
    await upsertRecent(db, 'Task A');
    let recents = await getRecentAll(db);
    expect(recents[0].text).toBe('Task A');

    await upsertRecent(db, 'Task A', { pinned: true });
    recents = await getRecentAll(db);
    expect(recents[0].pinned).toBe(true);
    db.close();
  });

  test('trimRecentUnpinned should keep the most recent N unpinned items', async () => {
    const db = await openDB();
    // Insert more than `keep` items
    for (let i = 0; i < 5; i++) {
        await upsertRecent(db, `Task ${i}`, { lastUsed: Date.now() + i * 1000 });
    }
    await upsertRecent(db, 'Pinned Task', { pinned: true });

    await trimRecentUnpinned(db, 2); // Keep 2

    const recents = await getRecentAll(db);
    const unpinned = recents.filter(r => !r.pinned);

    expect(recents.length).toBe(3); // 2 unpinned + 1 pinned
    expect(unpinned.length).toBe(2);
    expect(unpinned.map(r => r.text)).toContain('Task 4');
    expect(unpinned.map(r => r.text)).toContain('Task 3');
    db.close();
  });

  test('setPinned should update the pinned status of a recent item', async () => {
    const db = await openDB();
    await upsertRecent(db, 'Task B');
    await setPinned(db, 'Task B', true);
    let recent = await withStore(db, STORES.recent, 'readonly', store => store.get('Task B'));
    expect(recent.pinned).toBe(true);

    await setPinned(db, 'Task B', false);
    recent = await withStore(db, STORES.recent, 'readonly', store => store.get('Task B'));
    expect(recent.pinned).toBe(false);
    db.close();
  });

  test('deleteRecent should remove an item from recent inputs', async () => {
    const db = await openDB();
    await upsertRecent(db, 'Task C');

    let deleted = await deleteRecent(db, 'Task C');
    expect(deleted).toBe(true);

    const recents = await getRecentAll(db);
    expect(recents).toHaveLength(0);

    deleted = await deleteRecent(db, null);
    expect(deleted).toBe(false);

    db.close();
  });

  test('updateRecentOrderForNewTask should correctly reorder items', async () => {
    const db = await openDB();
    const recentTagsMap = new Map();
    await upsertRecent(db, 'Pinned', { pinned: true, order: 0 });
    await upsertRecent(db, 'Unpinned 1', { pinned: false, order: 1 });

    // Test adding a new unpinned task
    await updateRecentOrderForNewTask(db, 'New Task', recentTagsMap);
    let recents = await getRecentAll(db);
    let sorted = recents.sort((a,b) => a.order - b.order);

    expect(sorted.length).toBe(3);
    expect(sorted[0].text).toBe('Pinned');
    expect(sorted[1].text).toBe('New Task');
    expect(sorted[2].text).toBe('Unpinned 1');

    // Test updating an existing pinned task (should not change order)
    await updateRecentOrderForNewTask(db, 'Pinned', recentTagsMap);
    recents = await getRecentAll(db);
    sorted = recents.sort((a,b) => a.order - b.order);
    expect(sorted[0].text).toBe('Pinned');

    db.close();
  });

  test('updateRecentOrderForPinToggle should reorder correctly', async () => {
    const db = await openDB();
    await upsertRecent(db, 'Item 1', { pinned: false, order: 0 });
    await upsertRecent(db, 'Item 2', { pinned: false, order: 1 });

    // Pin 'Item 2'
    await updateRecentOrderForPinToggle(db, 'Item 2', true);
    let recents = await getRecentAll(db);
    let sorted = recents.sort((a,b) => a.order - b.order);

    expect(sorted[0].text).toBe('Item 2');
    expect(sorted[0].pinned).toBe(true);
    expect(sorted[1].text).toBe('Item 1');

    // Unpin 'Item 2'
    await updateRecentOrderForPinToggle(db, 'Item 2', false);
    recents = await getRecentAll(db);
    sorted = recents.sort((a,b) => a.order - b.order);
    expect(sorted[0].text).toBe('Item 2');
    expect(sorted[0].pinned).toBe(false);

    // Test pinning a non-existent item
    await updateRecentOrderForPinToggle(db, 'New Item', true);
    recents = await getRecentAll(db);
    const newItem = recents.find(r => r.text === 'New Item');
    expect(newItem).toBeDefined();
    expect(newItem.pinned).toBe(true);

    db.close();
  });

  test('seedPinnedDefaults should add default items only once', async () => {
    const db = await openDB();

    await seedPinnedDefaults(db);
    let recents = await getRecentAll(db);
    expect(recents.length).toBeGreaterThan(0);
    expect(localStorage.getItem(SEEDED_FLAG)).toBe('1');

    // Try to seed again
    await seedPinnedDefaults(db);
    let finalRecents = await getRecentAll(db);
    expect(finalRecents.length).toBe(recents.length);

    db.close();
  });

  test('deleteActivityByEnd and getActivityByEnd should work correctly', async () => {
      const db = await openDB();
      const endTime = '2025-01-01T01:00:00.000Z';
      const activity = { task: 'Test', startTime: '2025-01-01T00:00:00.000Z', endTime };

      await withStore(db, STORES.activities, 'readwrite', (store) => store.put(activity));

      let fetched = await getActivityByEnd(db, endTime);
      expect(fetched).toEqual(activity);

      let deleted = await deleteActivityByEnd(db, endTime);
      expect(deleted).toBe(true);

      fetched = await getActivityByEnd(db, endTime);
      expect(fetched).toBeUndefined(); // .get() returns undefined for no match

      deleted = await deleteActivityByEnd(db, null);
      expect(deleted).toBe(false);

      db.close();
  });
});
