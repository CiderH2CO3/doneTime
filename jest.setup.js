// Polyfill for structuredClone
require('core-js/stable/structured-clone');

// Mock window.confirm and window.alert to avoid blocking tests
global.confirm = jest.fn(() => true);
global.alert = jest.fn();

// --- DataTable Mock ---

const mockData = { text: 'mock task', pinned: false };
const mockDataTableApi = {};

const rowsApi = {
  add: jest.fn(() => mockDataTableApi),
  invalidate: jest.fn(() => mockDataTableApi),
  data: jest.fn(() => mockData),
};

const rowsFn = jest.fn(() => rowsApi);
rowsFn.add = rowsApi.add;

const buttonApi = {
  trigger: jest.fn(() => mockDataTableApi),
};

const tableApi = {
  body: jest.fn(() => ({
    addEventListener: jest.fn(),
    querySelector: jest.fn(),
    querySelectorAll: jest.fn(() => []),
  })),
};

const columnApi = {
    dataSrc: jest.fn()
};
const columnsApi = {
    adjust: jest.fn(() => mockDataTableApi),
    draw: jest.fn(() => mockDataTableApi)
};


Object.assign(mockDataTableApi, {
  clear: jest.fn(() => mockDataTableApi),
  draw: jest.fn(() => mockDataTableApi),
  search: jest.fn(() => mockDataTableApi),
  on: jest.fn(() => mockDataTableApi),
  rows: rowsFn,
  row: jest.fn(() => rowsApi),
  button: jest.fn(() => buttonApi),
  table: jest.fn(() => tableApi),
  column: jest.fn(() => columnApi),
  columns: jest.fn(() => columnsApi),
  data: () => [] // Add a default data method
});

global.DataTable = jest.fn(() => mockDataTableApi);
