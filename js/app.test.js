// At the top of your test file, import the functions.
// Thanks to the Jest transformer, this will now work correctly for app.js
const { msToHMS, escapeHtml, linkifyTask, loadSettings } = require('./app.js');

describe('msToHMS', () => {
  test('should convert milliseconds to HH:MM:SS format', () => {
    expect(msToHMS(0)).toBe('00:00:00');
    expect(msToHMS(1000)).toBe('00:00:01');
    expect(msToHMS(60000)).toBe('00:01:00');
    expect(msToHMS(3600000)).toBe('01:00:00');
    expect(msToHMS(3661000)).toBe('01:01:01');
    expect(msToHMS(-1000)).toBe('00:00:00');
  });
});

describe('escapeHtml', () => {
  test('should escape special HTML characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapeHtml("it's a trap & stuff")).toBe('it&#039;s a trap &amp; stuff');
    expect(escapeHtml('no special chars')).toBe('no special chars');
  });
});

describe('linkifyTask', () => {
  const settings = { ticketUrlTemplate: 'https://example.com/tickets/{id}' };

  test('should not linkify without a URL template', () => {
    expect(linkifyTask('Fix bug ABC-123', {}))
      .toBe('Fix bug ABC-123');
  });

  test('should linkify project-style ticket IDs', () => {
    const text = 'This commit fixes ABC-123 and XYZ-456.';
    const expected = 'This commit fixes <a href="https://example.com/tickets/ABC-123" target="_blank" rel="noopener noreferrer">ABC-123</a> and <a href="https://example.com/tickets/XYZ-456" target="_blank" rel="noopener noreferrer">XYZ-456</a>.';
    expect(linkifyTask(text, settings)).toBe(expected);
  });

  test('should linkify hash-style ticket IDs', () => {
    const text = 'Related to ticket #1234.';
    const expected = 'Related to ticket <a href="https://example.com/tickets/1234" target="_blank" rel="noopener noreferrer">#1234</a>.';
    expect(linkifyTask(text, settings)).toBe(expected);
  });

  test('should handle a mix of ticket ID styles', () => {
    const text = 'Task #987 is blocked by PROJ-001.';
    const expected = 'Task <a href="https://example.com/tickets/987" target="_blank" rel="noopener noreferrer">#987</a> is blocked by <a href="https://example.com/tickets/PROJ-001" target="_blank" rel="noopener noreferrer">PROJ-001</a>.';
    expect(linkifyTask(text, settings)).toBe(expected);
  });

  test('should escape other HTML content in the string', () => {
    const text = '<important> task #123';
    const expected = '&lt;important&gt; task <a href="https://example.com/tickets/123" target="_blank" rel="noopener noreferrer">#123</a>';
    expect(linkifyTask(text, settings)).toBe(expected);
  });
});

describe('loadSettings', () => {
  // Mock localStorage for this test suite
  const localStorageMock = (() => {
    let store = {};
    return {
      getItem(key) {
        return store[key] || null;
      },
      setItem(key, value) {
        store[key] = value.toString();
      },
      clear() {
        store = {};
      }
    };
  })();

  beforeAll(() => {
    Object.defineProperty(window, 'localStorage', { value: localStorageMock });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  test('should return default settings if localStorage is empty', () => {
    const settings = loadSettings();
    expect(settings).toEqual({ ticketUrlTemplate: '' });
  });

  test('should load settings from localStorage if present', () => {
    const storedSettings = { ticketUrlTemplate: 'http://jira.com/{id}' };
    window.localStorage.setItem('doneTime.settings', JSON.stringify(storedSettings));
    const settings = loadSettings();
    expect(settings).toEqual(storedSettings);
  });

  test('should handle invalid JSON in localStorage gracefully', () => {
    window.localStorage.setItem('doneTime.settings', 'this is not json');
    const settings = loadSettings();
    expect(settings).toEqual({ ticketUrlTemplate: '' });
  });
});
