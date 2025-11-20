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
  const rx = /(#[0-9]+)|([A-Z][A-Z0-9_]*-[0-9]+)/g;
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
  recent: 'recentInputs'    // keyPath: 'text'
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

async function deleteRecent(db, text) {
  if (!text) return false;
  await withStore(db, STORES.recent, 'readwrite', (store) => store.delete(text));
  return true;
}

// On new task, update order: unpinned go to top of unpinned list.
async function updateRecentOrderForNewTask(db, task) {
  const allRecent = await getRecentAll(db);
  const existing = allRecent.find(r => r.text === task);

  // If the item is already pinned, just update its lastUsed time and don't change order.
  if (existing && existing.pinned) {
    existing.lastUsed = Date.now();
    await withStore(db, STORES.recent, 'readwrite', store => store.put(existing));
    return allRecent;
  }

  // Handle unpinned items: move or add to the top of the unpinned list.
  const pinnedItems = allRecent.filter(r => r.pinned);
  pinnedItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const unpinnedItems = allRecent.filter(r => !r.pinned && r.text !== task);
  unpinnedItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const newItem = {
    text: task,
    pinned: false,
    lastUsed: Date.now(),
    tags: existing ? existing.tags : (recentTagsMap.get(task) || []),
  };
  unpinnedItems.unshift(newItem);

  const reorderedRecent = [...pinnedItems, ...unpinnedItems];
  reorderedRecent.forEach((item, index) => {
    item.order = index;
  });

  await withStore(db, STORES.recent, 'readwrite', store => {
    reorderedRecent.forEach(item => store.put(item));
  });

  return reorderedRecent;
}

// On pin toggle, update order.
async function updateRecentOrderForPinToggle(db, task, newPinnedState) {
  const allRecent = await getRecentAll(db);
  const itemToUpdate = allRecent.find(r => r.text === task);

  // This should not happen if called from UI, but as a fallback...
  if (!itemToUpdate) {
    await upsertRecent(db, task, { pinned: newPinnedState });
    // Re-fetch and re-sort everything from scratch as a safe but slow fallback
    const items = await getRecentAll(db);
    return sortRecentItems(items);
  }

  // Set the new state
  itemToUpdate.pinned = newPinnedState;

  // Separate lists, EXCLUDING the item being moved
  const pinnedItems = allRecent.filter(r => r.pinned && r.text !== task);
  pinnedItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const unpinnedItems = allRecent.filter(r => !r.pinned && r.text !== task);
  unpinnedItems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (newPinnedState) {
    // Pinning: add to the end of pinned list
    pinnedItems.push(itemToUpdate);
  } else {
    // Unpinning: add to the start of unpinned list
    unpinnedItems.unshift(itemToUpdate);
  }

  const reorderedRecent = [...pinnedItems, ...unpinnedItems];
  reorderedRecent.forEach((item, index) => {
    item.order = index;
  });

  await withStore(db, STORES.recent, 'readwrite', store => {
    reorderedRecent.forEach(item => store.put(item));
  });

  return reorderedRecent;
}

// グローバル宣言
let recentTable;
let recentTagsMap = new Map();
let activitiesMaster = [];

// Seed default pinned suggestions (one-time)
const SEEDED_FLAG = 'doneTime.seededPinnedDefaults.v5'; // バージョンを更新
async function seedPinnedDefaults(db) {
  try {
    if (localStorage.getItem(SEEDED_FLAG)) return;
    const defaults = [
      { text: '開始', pinned: true, lastUsed: Date.now(), tags: ['集計対象外'], order: 0 },
      { text: '休憩', pinned: true, lastUsed: Date.now(), tags: ['集計対象外'], order: 1 }
    ];
    await withStore(db, STORES.recent, 'readwrite', (store) => {
      defaults.forEach((item) => {
        const getReq = store.get(item.text);
        getReq.onsuccess = () => {
          const exists = getReq.result;
          // 常に order を含むように上書き
          store.put({ ...exists, ...item });
        };
      });
    });
    localStorage.setItem(SEEDED_FLAG, '1');
  } catch (e) {
    console.warn('Failed to seed default pinned suggestions', e);
  }
}

// Sorts recent items: pinned first, then unpinned.
// Within each group, sorting is based on the 'order' property.
function sortRecentItems(items) {
  if (!Array.isArray(items)) return [];
  const pinned = items.filter(it => it.pinned);
  const unpinned = items.filter(it => !it.pinned);

  // sort by order, then by lastUsed desc as a fallback
  const sortByOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || (b.lastUsed || 0) - (a.lastUsed || 0);
  pinned.sort(sortByOrder);
  unpinned.sort(sortByOrder);

  return [...pinned, ...unpinned];
}

// Update buildOptionsFromRecent to respect the order property
function buildOptionsFromRecent(recent) {
  const sortedRecent = sortRecentItems(recent);
  const frag = document.createDocumentFragment();
  const seen = new Set();
  sortedRecent.forEach(r => {
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

// タグ表示用HTML（タグクリックで検索）
function renderTags(tags) {
  if (!tags || !tags.length) return '';
  return tags.map(t => `<span class="tag tag-searchable" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join(' ');
}

// recentのタグMap
function getRecentTagsMap(recent) {
  const map = new Map();
  for (const r of recent) {
    if (r.text && Array.isArray(r.tags)) {
      map.set(r.text, r.tags);
    }
  }
  return map;
}

// 直近履歴からユニークなタグ一覧を取得
function getAllTagCandidates(recent) {
  const tagSet = new Set();
  for (const r of recent) {
    if (Array.isArray(r.tags)) {
      r.tags.forEach(t => tagSet.add(t));
    }
  }
  return Array.from(tagSet).filter(Boolean);
}

document.addEventListener('DOMContentLoaded', async () => {
  const db = await openDB();

  // 1. デフォルト候補を必ず先に投入
  await seedPinnedDefaults(db);

  // 2. recentTable の初期化
  recentTable = new DataTable('#recentTable', {
    data: [],
    columns: [
      {
        title: 'ピン',
        data: 'pinned',
        orderable: false,
        render: (d) => `
          <i class="bi ${d ? 'bi-pin-fill' : 'bi-pin'} pin-icon" style="cursor: pointer; font-size: 1.2em;"></i>
        `
      },
      { title: '直近の作業入力内容', data: 'text', orderable: false },
      {
        title: 'タグ',
        data: 'tags',
        orderable: false,
        render: renderTags
      },
      {
        title: '操作',
        data: null,
        orderable: false,
        render: () => `
          <button class="btn-delete" title="この入力候補を削除" style="padding:4px 8px; border:1px solid #b91c1c; color:#fecaca; background:#7f1d1d; border-radius:6px; cursor:pointer;">
            <i class="bi bi-trash"></i> 削除
          </button>
        `
      },
    ],
    paging: false
  });

  // Enable drag-and-drop sorting
  // Initialize this right after table creation, before the first draw.
  enableDragAndDropSorting(recentTable, db);

  // 3. 入力候補データ取得・描画
  let recent = await getRecentAll(db);
  recentTagsMap = getRecentTagsMap(recent);
  const sortedRecent = sortRecentItems(recent);
  recentTable.clear().rows.add(sortedRecent).draw();
  buildOptionsFromRecent(sortedRecent);

  // 4. activitiesMaster の初期化
  const acts = await getAllActivities(db);
  activitiesMaster = Array.isArray(acts) ? acts.slice() : [];

  // State for activities master list (for filtering / grouping)
  // let activitiesMaster = []; ← この行を削除

  // Settings state
  let settings = loadSettings();
  // CSVエクスポートは DataTables Buttons を使用するため、個別保持は不要

  // UI要素取得
  const filterDateFromInput = document.getElementById('filterDateFrom');
  const filterDateToInput = document.getElementById('filterDateTo');
  const groupToggle = document.getElementById('groupToggle');
  const clearFilterBtn = document.getElementById('clearFilterBtn');
  const manualAddBtn = document.getElementById('manualAddBtn');

  // Modal elements
  const modalEl = document.getElementById('activityModal');
  const modalTitle = document.getElementById('activityModalTitle');
  const modalTask = document.getElementById('modalTask');
  const modalStart = document.getElementById('modalStart');
  const modalEnd = document.getElementById('modalEnd');
  const modalError = document.getElementById('modalError');
  const modalCancel = document.getElementById('modalCancel');
  const modalSave = document.getElementById('modalSave');

  // datetime-local helpers
  const toLocalInputValue = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day}T${hh}:${mm}`;
  };
  const fromLocalInputValue = (v) => {
    if (!v) return '';
    const d = new Date(v);
    return d.toISOString();
  };

  // Activities DB helpers
  async function deleteActivityByEnd(db, endTime) {
    if (!endTime) return false;
    await withStore(db, STORES.activities, 'readwrite', (store) => store.delete(endTime));
    return true;
  }
  async function getActivityByEnd(db, endTime) {
    if (!endTime) return null;
    return withStore(db, STORES.activities, 'readonly', (store) => store.get(endTime));
  }

  // Modal state
  let editing = false;
  let originalEndTime = null;
  function openModal({ title, task = '', startTime = '', endTime = '' }, isEdit = false) {
    editing = !!isEdit;
    originalEndTime = isEdit ? endTime : null;
    if (modalTitle) modalTitle.textContent = title || (isEdit ? 'アクティビティ編集' : 'アクティビティ追加');
    if (modalTask) modalTask.value = task || '';
    if (modalStart) modalStart.value = startTime ? toLocalInputValue(startTime) : '';
    if (modalEnd) modalEnd.value = endTime ? toLocalInputValue(endTime) : '';
    if (modalError) modalError.textContent = '';
    if (modalEl) {
      modalEl.style.display = 'flex';
    }
    setTimeout(() => modalTask && modalTask.focus(), 0);
  }
  function closeModal() {
    if (modalEl) modalEl.style.display = 'none';
    editing = false;
    originalEndTime = null;
  }

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
    const fromYMD = (filterDateFromInput && filterDateFromInput.value) ? filterDateFromInput.value : '';
    const toYMD = (filterDateToInput && filterDateToInput.value) ? filterDateToInput.value : '';
    const doGroup = !!(groupToggle && groupToggle.checked);
    let rows = [];

    const filtered = (fromYMD || toYMD)
      ? activitiesMaster.filter(a => {
          const d = toLocalYMD(a.endTime);
          if (fromYMD && d < fromYMD) return false;
          if (toYMD && d > toYMD) return false;
          return true;
        })
      : activitiesMaster.slice();

    // 「集計対象外」タグ付きの作業内容を「作業別に集計」の時は除外
    const filtered2 = doGroup
      ? filtered.filter(a => {
          const tags = recentTagsMap.get(a.task) || [];
          return !tags.includes('集計対象外');
        })
      : filtered;

    if (doGroup) {
      const map = new Map();
      for (const a of filtered2) {
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
      rows = filtered2.map(a => ({
        ...a,
        duration: buildDuration(a.startTime, a.endTime)
      }));
    }

    // Sort by endTime asc (古い完了日が上になるように)
    rows.sort((a, b) => a.endTime.localeCompare(b.endTime));
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
          return d == null ? '' : String(d);
        }
      },
      { title: '開始時刻', data: 'startTime', render: (d) => fmtLocal(d) },
      { title: '完了時刻', data: 'endTime', render: (d) => fmtLocal(d) },
      { title: '作業時間', data: 'duration' },
      {
        title: 'タグ',
        data: 'task',
        orderable: false,
        render: (task) => {
          const tags = recentTagsMap.get(task) || [];
          return renderTags(tags);
        }
      },
      {
        title: '操作',
        data: null,
        orderable: false,
        render: (row) => {
          const disabled = (groupToggle && groupToggle.checked);
          const dis = disabled ? 'disabled' : '';
          const hint = disabled ? '（作業別に集計中は編集できません）' : '';
          return `
            <div style="display:flex; gap:6px;">
              <button class="btn-edit" ${dis} title="編集${hint}" style="padding:4px 8px; border:1px solid #1d4ed8; color:#dbeafe; background:#1e3a8a; border-radius:6px; cursor:pointer;">
                <i class="bi bi-pencil"></i> 編集
              </button>
              <button class="btn-delete" ${dis} title="削除${hint}" style="padding:4px 8px; border:1px solid #b91c1c; color:#fecaca; background:#7f1d1d; border-radius:6px; cursor:pointer;">
                <i class="bi bi-trash"></i> 削除
              </button>
            </div>`;
        }
      }
    ],
    // 初期並び替え: 完了時刻の古い順（asc）
    order: [[2, 'asc']],
    // 表示数を無制限にする（ページングを無効化）
    paging: false,
    // DataTables v2 layout API: Buttons を有効化（ツールバーはCSSで非表示にする）
    layout: {
      topStart: {
        buttons: [
          {
            extend: 'csvHtml5',
            text: 'CSV',
            bom: true,
            exportOptions: {
              // 表示されている列を出力
              columns: [0, 1, 2, 3, 4],
              // HTML（リンク）をプレーンテキスト化
              format: {
                body: function (data) {
                  if (data == null) return '';
                  const s = String(data);
                  // タグ除去してテキスト化
                  return s.replace(/<[^>]*>/g, '');
                }
              }
            },
            // ファイル名（timestamp付き）
            filename: function () {
              const ts = new Date();
              const y = ts.getFullYear();
              const m = String(ts.getMonth() + 1).padStart(2, '0');
              const d = String(ts.getDate()).padStart(2, '0');
              const hh = String(ts.getHours()).padStart(2, '0');
              const mm = String(ts.getMinutes()).padStart(2, '0');
              const ss = String(ts.getSeconds()).padStart(2, '0');
              const mode = (groupToggle && groupToggle.checked) ? 'grouped' : 'detail';
              return `activities_${mode}_${y}${m}${d}_${hh}${mm}${ss}`;
            }
          }
        ]
      }
    }
  });

  // Initialize drag-and-drop sorting for recentTable
  function enableDragAndDropSorting(table, db) {
    const tbody = table.table().body();

    tbody.addEventListener('dragstart', (e) => {
      const row = e.target.closest('tr');
      if (row) {
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.rowIndex);
      }
    });

    tbody.addEventListener('dragover', (e) => {
      e.preventDefault();
      const draggingRow = tbody.querySelector('.dragging');
      const targetRow = e.target.closest('tr');
      if (!draggingRow || !targetRow || draggingRow === targetRow) {
        return;
      }
      const draggingData = table.row(draggingRow).data();
      const targetData = table.row(targetRow).data();

      // Prevent dragging between pinned and unpinned sections
      if (draggingData.pinned !== targetData.pinned) {
        e.dataTransfer.dropEffect = 'none'; // Disallow drop
        return;
      }
      e.dataTransfer.dropEffect = 'move';

      const draggingIndex = draggingRow.rowIndex;
      const targetIndex = targetRow.rowIndex;
      if (draggingIndex < targetIndex) {
        tbody.insertBefore(draggingRow, targetRow.nextSibling);
      } else {
        tbody.insertBefore(draggingRow, targetRow);
      }
    });

    tbody.addEventListener('dragend', async () => {
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const updatedData = rows.map((row) => table.row(row).data());

      // Update order property for each item based on its new DOM position
      updatedData.forEach((item, index) => {
        item.order = index;
      });

      // Save the updated order to the database
      await withStore(db, STORES.recent, 'readwrite', (store) => {
        updatedData.forEach((item) => store.put(item));
      });

      // Update the datalist options, ensuring it's sorted correctly
      const allRecent = await getRecentAll(db);
      const sorted = sortRecentItems(allRecent);
      buildOptionsFromRecent(sorted);

      // Remove dragging class
      rows.forEach((row) => row.classList.remove('dragging'));
    });

    // Add draggable attribute to rows
    table.on('draw', () => {
      Array.from(tbody.querySelectorAll('tr')).forEach((row) => {
        row.setAttribute('draggable', true);
      });
    });
  }

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
  document.querySelector('#recentTable').addEventListener('click', async (e) => {
    const pinIcon = e.target.closest('.pin-icon');
    if (pinIcon) {
      const tr = pinIcon.closest('tr');
      const row = recentTable.row(tr);
      const data = row.data();
      const newPinnedState = !data.pinned;
      const updatedRecent = await updateRecentOrderForPinToggle(db, data.text, newPinnedState);
      recentTable.clear().rows.add(updatedRecent).draw(false);
      buildOptionsFromRecent(updatedRecent);
      return;
    }

    const btn = e.target.closest('.btn-delete');
    if (btn) {
      const tr = btn.closest('tr');
      const row = recentTable.row(tr);
      const data = row.data();
      const text = data && data.text;
      if (!text) return;
      const ok = confirm(`「${text}」を入力候補から削除しますか？`);
      if (!ok) return;
      await deleteRecent(db, text);
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

    // 新しいタスクの並び順を更新し、UIに反映
    const updatedRecent = await updateRecentOrderForNewTask(db, task);
    await trimRecentUnpinned(db, 30);
    const finalRecent = await getRecentAll(db); // trimming後再取得
    recentTagsMap = getRecentTagsMap(finalRecent);
    const sortedFinal = sortRecentItems(finalRecent);
    recentTable.clear().rows.add(sortedFinal).draw(false);
    buildOptionsFromRecent(sortedFinal);

    // UI feedback
    saveStatus.textContent = '保存しました';
    setTimeout(() => saveStatus.textContent = '', 1500);
    // 入力欄をクリアして意図しない二重入力を防止
    taskInput.value = '';
    taskInput.focus();
  }

  saveBtn.addEventListener('click', saveTask);
  // IME 変換確定 Enter と保存 Enter を分離するためのフラグ
  let isComposing = false;
  taskInput.addEventListener('compositionstart', () => { isComposing = true; });
  taskInput.addEventListener('compositionend', () => { isComposing = false; });
  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (isComposing) {
        // 変換中のEnterは保存しない
        return;
      }
      saveTask();
    }
  });

  // Wire filter/group controls
  if (filterDateFromInput) {
    filterDateFromInput.addEventListener('change', () => {
      // Auto-fill "to" with same day when empty to emulate one-day filter quickly
      if (filterDateFromInput.value && !filterDateToInput.value) {
        filterDateToInput.value = filterDateFromInput.value;
      }
      renderActivities();
    });
  }
  if (filterDateToInput) {
    filterDateToInput.addEventListener('change', renderActivities);
  }
  if (groupToggle) {
    groupToggle.addEventListener('change', renderActivities);
  }
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      if (filterDateFromInput) filterDateFromInput.value = '';
      if (filterDateToInput) filterDateToInput.value = '';
      // 併せて「作業別に集計」もオフにする
      if (groupToggle) groupToggle.checked = false;
      renderActivities();
    });
  }

  const downloadBtn = document.getElementById('downloadCsvBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      // DataTables Buttons の CSV ボタンを発火
      activitiesTable.button('.buttons-csv').trigger();
    });
  }

  // Manual add button
  if (manualAddBtn) {
    manualAddBtn.addEventListener('click', async () => {
      if (groupToggle && groupToggle.checked) {
        alert('「作業別に集計」をオフにすると編集・追加できます。');
        return;
      }
      const last = await getLastActivity(db);
      const now = nowIso();
      const start = last ? last.endTime : now;
      openModal({ title: 'アクティビティ追加', task: '', startTime: start, endTime: now }, false);
    });
  }

  // Modal buttons
  if (modalCancel) modalCancel.addEventListener('click', closeModal);
  if (modalEl) modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeModal();
  });
  if (modalSave) {
    modalSave.innerHTML = '<i class="bi bi-save"></i> 保存';
    modalSave.addEventListener('click', async () => {
      const task = (modalTask && modalTask.value || '').trim();
      const startIso = fromLocalInputValue(modalStart && modalStart.value);
      const endIso = fromLocalInputValue(modalEnd && modalEnd.value);
      if (!task) {
        if (modalError) modalError.textContent = '作業内容を入力してください';
        return;
      }
      if (!startIso || !endIso) {
        if (modalError) modalError.textContent = '開始・完了時刻を入力してください';
        return;
      }
      if (new Date(endIso) < new Date(startIso)) {
        if (modalError) modalError.textContent = '開始時刻は完了時刻より前である必要があります';
        return;
      }

      // Check endTime uniqueness (key)
      const dup = activitiesMaster.find(a => a.endTime === endIso);
      if (!editing) {
        if (dup) {
          if (modalError) modalError.textContent = '同じ完了時刻の行が既に存在します（完了時刻を変更してください）';
          return;
        }
        const activity = { task, startTime: startIso, endTime: endIso };
        await withStore(db, STORES.activities, 'readwrite', (store) => store.put(activity));
        activitiesMaster.push(activity);
        // 新しいタスクの並び順を更新
        const updatedRecent = await updateRecentOrderForNewTask(db, task);
        await trimRecentUnpinned(db, 30);
        const finalRecent = await getRecentAll(db);
        recentTagsMap = getRecentTagsMap(finalRecent);
        const sortedFinal = sortRecentItems(finalRecent);
        recentTable.clear().rows.add(sortedFinal).draw(false);
        buildOptionsFromRecent(sortedFinal);
      } else {
        // editing
        const original = originalEndTime;
        if (endIso !== original && dup) {
          if (modalError) modalError.textContent = '同じ完了時刻の行が既に存在します（完了時刻を変更してください）';
          return;
        }
        // Remove old if key changed
        if (original && endIso !== original) {
          await deleteActivityByEnd(db, original);
          activitiesMaster = activitiesMaster.filter(a => a.endTime !== original);
        }
        const activity = { task, startTime: startIso, endTime: endIso };
        await withStore(db, STORES.activities, 'readwrite', (store) => store.put(activity));
        // Update master (replace or add)
        const idx = activitiesMaster.findIndex(a => a.endTime === endIso);
        if (idx >= 0) activitiesMaster[idx] = activity; else activitiesMaster.push(activity);
        // 既存のタグを維持して recent を更新
        const updatedRecent = await updateRecentOrderForNewTask(db, task);
        await trimRecentUnpinned(db, 30);
        const finalRecent = await getRecentAll(db);
        recentTagsMap = getRecentTagsMap(finalRecent);
        const sortedFinal = sortRecentItems(finalRecent);
        recentTable.clear().rows.add(sortedFinal).draw(false);
        buildOptionsFromRecent(sortedFinal);
      }

      closeModal();
      renderActivities();
    });
  }

  // Edit/Delete handlers on activities table
  document.querySelector('#activitiesTable').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.btn-edit');
    const delBtn = e.target.closest('.btn-delete');
    if (!editBtn && !delBtn) return;
    if (groupToggle && groupToggle.checked) {
      alert('「作業別に集計」をオフにすると編集・削除できます。');
      return;
    }
    const tr = (editBtn || delBtn).closest('tr');
    const row = activitiesTable.row(tr);
    const data = row.data();
    if (!data) return;
    if (editBtn) {
      openModal({ title: 'アクティビティ編集', task: data.task, startTime: data.startTime, endTime: data.endTime }, true);
      return;
    }
    if (delBtn) {
      const ok = confirm('この行を削除しますか？');
      if (!ok) return;
      await deleteActivityByEnd(db, data.endTime);
      activitiesMaster = activitiesMaster.filter(a => a.endTime !== data.endTime);
      // 削除した行の直後の作業の開始時刻を調整
      try {
        // prev: 削除行より前で最も遅い endTime の行
        const prev = activitiesMaster
          .filter(a => a.endTime < data.endTime)
          .sort((a, b) => b.endTime.localeCompare(a.endTime))[0];
        // next: startTime が削除行の endTime と一致する行（直後想定）
        const next = activitiesMaster.find(a => a.startTime === data.endTime);
        if (prev && next) {
          const newStart = prev.endTime;
          if (new Date(next.endTime) >= new Date(newStart) && next.startTime !== newStart) {
            next.startTime = newStart;
            await withStore(db, STORES.activities, 'readwrite', (store) => store.put({ task: next.task, startTime: next.startTime, endTime: next.endTime }));
          }
        }
      } catch (err) {
        console.warn('startTime 調整中にエラー:', err);
      }
      renderActivities();
    }
  });

  // タグ編集UI（タグ列ダブルクリックで編集、候補も選択可）
  document.querySelector('#recentTable').addEventListener('dblclick', async (e) => {
    const td = e.target.closest('td');
    if (!td) return;
    const colIdx = td.cellIndex;
    if (colIdx !== 2) return;
    const tr = td.closest('tr');
    if (!tr) return;
    const row = recentTable.row(tr);
    const data = row.data();
    if (!data) return;

    // 直近履歴からタグ候補を取得
    const allRecent = await getRecentAll(await openDB());
    const tagCandidates = getAllTagCandidates(allRecent);

    // 編集用ダイアログ生成
    const currentTags = Array.isArray(data.tags) ? data.tags : [];
    const modal = document.createElement('div');
    modal.style = `
      position:fixed; inset:0; z-index:2000; background:rgba(0,0,0,0.25); display:flex; align-items:center; justify-content:center;
    `;
    modal.innerHTML = `
      <div style="background:#1e293b; color:#e5e7eb; border-radius:10px; padding:18px 18px 12px 18px; min-width:320px; box-shadow:0 8px 32px #0008;">
        <div style="font-weight:600; margin-bottom:8px;">タグ編集</div>
        <input id="tagEditInput" type="text" style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0c1428;color:#e5e7eb;" placeholder="カンマ区切りで入力" value="${currentTags.join(',')}" />
        <div style="margin:10px 0 4px 0; font-size:0.95em;">タグ候補:</div>
        <div id="tagCandidateList" style="display:flex; flex-wrap:wrap; gap:6px 8px; margin-bottom:10px;">
          ${tagCandidates.map(t => `<span class="tag tag-candidate" style="cursor:pointer;user-select:none;background:#334155;color:#a7f3d0;padding:2px 8px;border-radius:6px;">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button id="tagEditCancel" style="padding:6px 14px;border-radius:6px;border:1px solid #334155;background:#0c1428;color:#e5e7eb;">キャンセル</button>
          <button id="tagEditOk" style="padding:6px 14px;border-radius:6px;border:1px solid #22c55e;background:#22c55e;color:#062813;font-weight:700;">保存</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const input = modal.querySelector('#tagEditInput');
    let isComposing = false;

    // 候補クリックで追加
    modal.querySelectorAll('.tag-candidate').forEach(el => {
      el.addEventListener('click', () => {
        const val = input.value.trim();
        const tags = val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
        const tag = el.textContent;
        if (!tags.includes(tag)) tags.push(tag);
        input.value = tags.join(',');
      });
    });

    // 保存処理
    const saveTags = async () => {
      const tags = input.value.split(',').map(s => s.trim()).filter(Boolean);
      data.tags = tags;
      await withStore(await openDB(), STORES.recent, 'readwrite', (store) => store.put(data));
      // テーブル・入力候補・タグMap・アクティビティテーブルを更新
      const updated = await getRecentAll(await openDB());
      recentTagsMap = getRecentTagsMap(updated);
      recentTable.clear().rows.add(updated).draw(false);
      buildOptionsFromRecent(updated);
      renderActivities();
      document.body.removeChild(modal);
    };

    // 保存ボタン
    modal.querySelector('#tagEditOk').addEventListener('click', saveTags);

    // キャンセルボタン
    modal.querySelector('#tagEditCancel').addEventListener('click', () => {
      document.body.removeChild(modal);
    });

    // ESCキーで閉じる
    modal.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        document.body.removeChild(modal);
      }
    });

    // IME変換確定後のEnterキーで保存
    input.addEventListener('compositionstart', () => { isComposing = true; });
    input.addEventListener('compositionend', () => { isComposing = false; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !isComposing) {
        saveTags();
      }
    });

    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });

  // テーブルのタグ列に対するカスタムレンダラー
  function tagCellRenderer(task) {
    const tags = recentTagsMap.get(task) || [];
    return renderTags(tags);
  }
  // activitiesTable のタグ列にカスタムレンダラーを適用
  activitiesTable.on('init', () => {
    const taskCol = activitiesTable.column('task:name');
    if (taskCol) {
      taskCol.dataSrc = (row) => {
        return tagCellRenderer(row.task);
      };
      // 列の再描画
      activitiesTable.columns.adjust().draw();
    }
  });

  // タグクリックで「Search」に自動入力＆検索
  document.addEventListener('click', (e) => {
    const tagEl = e.target.closest('.tag-searchable');
    if (tagEl && tagEl.dataset && tagEl.dataset.tag) {
      // DataTables v2 APIで検索
      if (activitiesTable && typeof activitiesTable.search === 'function') {
        activitiesTable.search(tagEl.dataset.tag).draw();
      }
    }
  });

  // DataTablesのdraw時に検索欄へ値を反映（同期用）
  activitiesTable.on('draw', function() {
    const searchVal = activitiesTable.search();
    const dtSearchInput = document.querySelector('#activitiesTable_filter input[type="search"], #activitiesTable_filter input[type="text"]');
    if (dtSearchInput && searchVal !== undefined) {
      dtSearchInput.value = searchVal;
    }
  });

  // 最後に初回描画
  renderActivities();
});
