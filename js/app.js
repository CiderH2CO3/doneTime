"use strict";

// Utility: date/time helpers
const nowIso = () => new Date().toISOString();
const fmtLocal = (iso) => new Date(iso).toLocaleString();
const msToHMS = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

// Utility: HTML escape
const escapeHtml = (str) => String(str)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

// Settings helpers (persisted in localStorage)
const SETTINGS_KEY = 'doneTime.settings';
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ticketUrlTemplate: '' };
    const parsed = JSON.parse(raw);
    return { ticketUrlTemplate: parsed.ticketUrlTemplate || '' };
  } catch {
    return { ticketUrlTemplate: '' };
  }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ticketUrlTemplate: s.ticketUrlTemplate || '' }));
}

// Linkify bug ticket IDs in a task string using settings
// Supported IDs: ABC-123 (project-style), or #123 (hash numeric)
function linkifyTask(text, settings) {
  const t = text == null ? '' : String(text);
  const tpl = (settings && settings.ticketUrlTemplate) || '';
  if (!tpl) return escapeHtml(t);

  // We will search both patterns; to avoid overlap, use a single regex with alternation
  const rx = /(#[0-9]+)|([A-Z][A-Z0-9]+-[0-9]+)/g;
  return escapeHtml(t).replace(rx, (m) => {
    let id = m;
    // If hash form, strip leading # for {id}
    if (m.startsWith('#')) {
      id = m.slice(1);
    }
    const href = tpl.replaceAll('{id}', encodeURIComponent(id));
    // show original matched text as link text
    const linkText = escapeHtml(m);
    // rel and target for safety
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
  });
}

// IndexedDB setup
const DB_NAME = 'doneTimeDB';
const DB_VERSION = 1;
const STORES = {
  activities: 'activities', // keyPath: endTime
  recent: 'recentInputs'    // keyPath: text
};

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORES.activities)) {
        const store = db.createObjectStore(STORES.activities, { keyPath: 'endTime' });
        store.createIndex('by_endTime', 'endTime', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.recent)) {
        const store = db.createObjectStore(STORES.recent, { keyPath: 'text' });
        store.createIndex('by_lastUsed', 'lastUsed', { unique: false });
        store.createIndex('by_pinned', 'pinned', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const res = fn(store, tx);

    // If the callback returned an IDBRequest, resolve with its .result value
    // instead of the raw request object.
    let resolvedFromRequest = false;
    let requestResult;
    if (res && typeof res === 'object' && 'onsuccess' in res && 'onerror' in res) {
      const req = res; // IDBRequest
      req.onsuccess = () => {
        resolvedFromRequest = true;
        requestResult = req.result;
      };
      req.onerror = () => {
        // Let the transaction error handler pick this up
      };
    }

    tx.oncomplete = () => {
      if (resolvedFromRequest) {
        resolve(requestResult);
      } else {
        resolve(res);
      }
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getLastActivity(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.activities, 'readonly');
    const store = tx.objectStore(STORES.activities);
    const index = store.index('by_endTime');
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      resolve(req.result ? req.result.value : null);
    };
    req.onerror = () => reject(req.error);
  });
}

async function getAllActivities(db) {
  return withStore(db, STORES.activities, 'readonly', (store) => store.getAll());
}

async function upsertRecent(db, text, opts = {}) {
  const rec = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.recent, 'readwrite');
    const store = tx.objectStore(STORES.recent);
    const getReq = store.get(text);
    getReq.onsuccess = () => {
      const exists = getReq.result;
      const next = {
        text,
        pinned: exists ? !!exists.pinned : false,
        lastUsed: Date.now(),
        ...opts,
      };
      store.put(next);
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
  return rec;
}

async function trimRecentUnpinned(db, keep = 30) {
  // Keep at most `keep` unpinned items by lastUsed desc
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.recent, 'readonly');
    const store = tx.objectStore(STORES.recent);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  const unpinned = all.filter(r => !r.pinned).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  if (unpinned.length <= keep) return;
  const toDelete = unpinned.slice(keep);
  await withStore(await openDB(), STORES.recent, 'readwrite', (store) => {
    toDelete.forEach(r => store.delete(r.text));
  });
}

async function setPinned(db, text, pinned) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.recent, 'readwrite');
    const store = tx.objectStore(STORES.recent);
    const req = store.get(text);
    req.onsuccess = () => {
      const rec = req.result || { text, pinned: !!pinned, lastUsed: Date.now() };
      rec.pinned = !!pinned;
      store.put(rec);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function getRecentAll(db) {
  return withStore(db, STORES.recent, 'readonly', (store) => store.getAll());
}

function buildOptionsFromRecent(recent) {
  const pinned = recent.filter(r => r.pinned).sort((a, b) => a.text.localeCompare(b.text));
  const unpinned = recent.filter(r => !r.pinned).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  const list = [...pinned, ...unpinned];
  const frag = document.createDocumentFragment();
  const seen = new Set();
  list.forEach(r => {
    if (seen.has(r.text)) return;
    seen.add(r.text);
    const opt = document.createElement('option');
    opt.value = r.text;
    frag.appendChild(opt);
  });
  const datalist = document.getElementById('taskOptions');
  datalist.innerHTML = '';
  datalist.appendChild(frag);
}

function buildDuration(startIso, endIso) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return msToHMS(ms);
}

document.addEventListener('DOMContentLoaded', async () => {
  const db = await openDB();

  // State for activities master list (for filtering / grouping)
  let activitiesMaster = [];
  // Settings state
  let settings = loadSettings();

  // UI elements for filter/group
  const filterDateInput = document.getElementById('filterDate');
  const groupToggle = document.getElementById('groupToggle');
  const clearFilterBtn = document.getElementById('clearFilterBtn');

  // Helper: YYYY-MM-DD (local) from ISO string
  const toLocalYMD = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Render activities with current filter/grouping settings
  function renderActivities() {
    const filterYMD = (filterDateInput && filterDateInput.value) ? filterDateInput.value : '';
    const doGroup = !!(groupToggle && groupToggle.checked);
    let rows = [];

    // Apply date filter (by endTime local date)
    const filtered = filterYMD
      ? activitiesMaster.filter(a => toLocalYMD(a.endTime) === filterYMD)
      : activitiesMaster.slice();

    if (doGroup) {
      const map = new Map();
      for (const a of filtered) {
        const key = a.task || '';
        const cur = map.get(key) || {
          task: key,
          startTime: a.startTime,
          endTime: a.endTime,
          _durationMs: 0
        };
        // min start, max end
        if (a.startTime < cur.startTime) cur.startTime = a.startTime;
        if (a.endTime > cur.endTime) cur.endTime = a.endTime;
        cur._durationMs += Math.max(0, new Date(a.endTime) - new Date(a.startTime));
        map.set(key, cur);
      }
      rows = Array.from(map.values()).map(r => ({
        task: r.task,
        startTime: r.startTime,
        endTime: r.endTime,
        duration: msToHMS(r._durationMs)
      }));
    } else {
      rows = filtered.map(a => ({
        ...a,
        duration: buildDuration(a.startTime, a.endTime)
      }));
    }

    // Sort by endTime desc
    rows.sort((a, b) => b.endTime.localeCompare(a.endTime));
    activitiesTable.clear().rows.add(rows).draw(false);
  }

  // Tabs behavior
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => {
        if (p.id === target) {
          p.style.display = '';
          p.classList.add('active');
        } else {
          p.style.display = 'none';
          p.classList.remove('active');
        }
      });
    });
  });

  // DataTables initialization
  const activitiesTable = new DataTable('#activitiesTable', {
    data: [],
    columns: [
      {
        title: '作業内容',
        data: 'task',
        render: (d, type) => {
          if (type === 'display') return linkifyTask(d, settings);
          // for sort/search use raw text
          return d == null ? '' : String(d);
        }
      },
      { title: '開始時刻', data: 'startTime', render: (d) => fmtLocal(d) },
      { title: '完了時刻', data: 'endTime', render: (d) => fmtLocal(d) },
      { title: '作業時間', data: 'duration' },
    ],
    order: [[2, 'desc']],
    pageLength: 10
  });

  const recentTable = new DataTable('#recentTable', {
    data: [],
    columns: [
      { title: 'ピン', data: 'pinned', render: (d) => `<input type="checkbox" ${d ? 'checked' : ''}>`, orderable: false },
      { title: '直近の作業入力内容', data: 'text' },
    ],
    order: [[0, 'desc']],
    pageLength: 10
  });

  // Populate initial data
  const acts = await getAllActivities(db);
  activitiesMaster = Array.isArray(acts) ? acts.slice() : [];
  renderActivities();

  const recent = await getRecentAll(db);
  recentTable.clear().rows.add(recent).draw();
  buildOptionsFromRecent(recent);

  // Settings UI wiring
  const ticketUrlTemplateInput = document.getElementById('ticketUrlTemplate');
  const settingsSaveBtn = document.getElementById('settingsSaveBtn');
  const settingsSaveStatus = document.getElementById('settingsSaveStatus');
  if (ticketUrlTemplateInput) {
    ticketUrlTemplateInput.value = settings.ticketUrlTemplate || '';
  }
  if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener('click', () => {
      const next = {
        ticketUrlTemplate: (ticketUrlTemplateInput && ticketUrlTemplateInput.value || '').trim()
      };
      settings = next;
      saveSettings(settings);
      // Re-render activities to apply linkification immediately
      activitiesTable.rows().invalidate().draw(false);
      if (settingsSaveStatus) {
        settingsSaveStatus.textContent = '保存しました';
        setTimeout(() => settingsSaveStatus.textContent = '', 1500);
      }
    });
  }

  // Handle pin toggle in recentTable
  document.querySelector('#recentTable').addEventListener('change', async (e) => {
    const target = e.target;
    if (target && target.type === 'checkbox') {
      // Find row data
      const tr = target.closest('tr');
      const row = recentTable.row(tr);
      const data = row.data();
      await setPinned(db, data.text, target.checked);
      // If unpinned, enforce trimming
      if (!target.checked) {
        await trimRecentUnpinned(db, 30);
      }
      const updated = await getRecentAll(db);
      recentTable.clear().rows.add(updated).draw(false);
      buildOptionsFromRecent(updated);
    }
  });

  // Save button logic
  const taskInput = document.getElementById('taskInput');
  const saveBtn = document.getElementById('saveBtn');
  const saveStatus = document.getElementById('saveStatus');

  // Bring immediate attention to the task input
  if (taskInput) {
    // Focus after current call stack to ensure styles are applied
    setTimeout(() => {
      taskInput.focus();
      taskInput.select();
    }, 0);
  }

  async function saveTask() {
    const task = (taskInput.value || '').trim();
    if (!task) {
      saveStatus.textContent = '作業内容を入力してください';
      setTimeout(() => saveStatus.textContent = '', 1500);
      return;
    }

    const last = await getLastActivity(db);
    const endTime = nowIso();
    const startTime = last ? last.endTime : endTime;
    const activity = { task, startTime, endTime };

    await withStore(db, STORES.activities, 'readwrite', (store) => store.put(activity));

    // Update master list and re-render table
    activitiesMaster.push(activity);
    renderActivities();

    // Update recent inputs
    await upsertRecent(db, task);
    await trimRecentUnpinned(db, 30);
    const updatedRecent = await getRecentAll(db);
    recentTable.clear().rows.add(updatedRecent).draw(false);
    buildOptionsFromRecent(updatedRecent);

    // UI feedback
    saveStatus.textContent = '保存しました';
    setTimeout(() => saveStatus.textContent = '', 1500);
    taskInput.select();
  }

  saveBtn.addEventListener('click', saveTask);
  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveTask();
    }
  });

  // Wire filter/group controls
  if (filterDateInput) {
    filterDateInput.addEventListener('change', renderActivities);
  }
  if (groupToggle) {
    groupToggle.addEventListener('change', renderActivities);
  }
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      if (filterDateInput) filterDateInput.value = '';
      // 併せて「作業別に集計」もオフにする
      if (groupToggle) groupToggle.checked = false;
      renderActivities();
    });
  }
});
