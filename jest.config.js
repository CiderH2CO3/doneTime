/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jsdom',
  collectCoverage: true,
  coverageReporters: ['json', 'lcov', 'text', 'clover'],
  coverageDirectory: 'coverage',
  transform: {
    '^.+\\.js$': './jest-preprocess.js',
  },
  // Target app.js for coverage
  collectCoverageFrom: [
    'js/app.js',
  ],
};

module.exports = config;
