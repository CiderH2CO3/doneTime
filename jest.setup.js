// Polyfill for structuredClone
require('core-js/stable/structured-clone');

// Mock window.confirm and window.alert to avoid blocking tests
global.confirm = jest.fn(() => true);
global.alert = jest.fn();
