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

async function deleteRecent(db, text) {
  if (!text) return false;
  await withStore(db, STORES.recent, 'readwrite', (store) => store.delete(text));
  return true;
}

// Seed default pinned suggestions (one-time)
const SEEDED_FLAG = 'doneTime.seededPinnedDefaults.v1';
async function seedPinnedDefaults(db) {
  try {
    if (localStorage.getItem(SEEDED_FLAG)) return;
    const defaults = ['開始', '休憩'];
    await withStore(db, STORES.recent, 'readwrite', (store) => {
      defaults.forEach((text) => {
        const getReq = store.get(text);
        getReq.onsuccess = () => {
          const exists = getReq.result;
          if (!exists) {
            store.put({ text, pinned: true, lastUsed: Date.now() });
          }
        };
        // onerror: ignore, transaction will handle
      });
    });
    localStorage.setItem(SEEDED_FLAG, '1');
  } catch (e) {
    // fail silently; feature is non-critical
    console.warn('Failed to seed default pinned suggestions', e);
  }
}

// Update buildOptionsFromRecent to respect the order property
function buildOptionsFromRecent(recent) {
  const sortedRecent = [...recent]
    .sort((a, b) => a.order - b.order || b.pinned - a.pinned); // Sort by order, then by pinned
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

document.addEventListener('DOMContentLoaded', async () => {
  const db = await openDB();

  // State for activities master list (for filtering / grouping)
  let activitiesMaster = [];
  // Settings state
  let settings = loadSettings();
  // CSVエクスポートは DataTables Buttons を使用するため、個別保持は不要

  // UI elements for filter/group
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

    // Apply date filter (by endTime local date) - supports range
    const filtered = (fromYMD || toYMD)
      ? activitiesMaster.filter(a => {
          const d = toLocalYMD(a.endTime);
          if (fromYMD && d < fromYMD) return false;
          if (toYMD && d > toYMD) return false;
          return true;
        })
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
          // for sort/search use raw text
          return d == null ? '' : String(d);
        }
      },
      { title: '開始時刻', data: 'startTime', render: (d) => fmtLocal(d) },
      { title: '完了時刻', data: 'endTime', render: (d) => fmtLocal(d) },
      { title: '作業時間', data: 'duration' },
      {
        title: '操作',
        data: null,
        orderable: false,
        render: (row /*, type */) => {
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
              columns: [0, 1, 2, 3],
              // HTML（リンク）をプレーンテキスト化
              format: {
                body: function (data/*, row, column, node */) {
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

  const recentTable = new DataTable('#recentTable', {
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
      if (draggingRow && targetRow && draggingRow !== targetRow) {
        const draggingIndex = draggingRow.rowIndex;
        const targetIndex = targetRow.rowIndex;
        if (draggingIndex < targetIndex) {
          tbody.insertBefore(draggingRow, targetRow.nextSibling);
        } else {
          tbody.insertBefore(draggingRow, targetRow);
        }
      }
    });

    tbody.addEventListener('dragend', async () => {
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const updatedOrder = rows.map((row) => table.row(row).data());
      updatedOrder.forEach((item, index) => {
        item.order = index; // Update order property
      });

      // Save the updated order to the database
      await withStore(db, STORES.recent, 'readwrite', (store) => {
        updatedOrder.forEach((item) => store.put(item));
      });

      // Update the datalist options
      buildOptionsFromRecent(updatedOrder);

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

  // Enable drag-and-drop sorting
  enableDragAndDropSorting(recentTable, db);

  // Populate initial data
  const recent = await getRecentAll(db);
  recentTable.clear().rows.add(recent).draw();
  buildOptionsFromRecent(recent);

  // Ensure default pinned suggestions exist (one-time)
  await seedPinnedDefaults(db);
  const acts = await getAllActivities(db);
  activitiesMaster = Array.isArray(acts) ? acts.slice() : [];
  renderActivities();

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
      await setPinned(db, data.text, newPinnedState);
      const updated = await getRecentAll(db);
      recentTable.clear().rows.add(updated).draw(false);
      buildOptionsFromRecent(updated);
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

    // Update recent inputs
    await upsertRecent(db, task);
    await trimRecentUnpinned(db, 30);
    const updatedRecent = await getRecentAll(db);
    recentTable.clear().rows.add(updatedRecent).draw(false);
    buildOptionsFromRecent(updatedRecent);

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
        // recent 更新
        await upsertRecent(db, task);
        await trimRecentUnpinned(db, 30);
        const updatedRecent = await getRecentAll(db);
        recentTable.clear().rows.add(updatedRecent).draw(false);
        buildOptionsFromRecent(updatedRecent);
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
});
