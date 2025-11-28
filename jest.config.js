/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jsdom',
  collectCoverage: true,
  coverageReporters: ['json', 'lcov', 'text', 'clover', 'json-summary'],
  coverageDirectory: 'coverage',
  // Target app.js for coverage
  collectCoverageFrom: [
    'js/app.js',
  ],
  // Setup files to run before each test file
  setupFiles: [
    'fake-indexeddb/auto',
    './jest.setup.js'
  ],
};

module.exports = config;
