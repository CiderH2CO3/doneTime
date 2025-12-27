const { test, expect } = require('@playwright/test');
const path = require('path');

// Helper to get the file:// URL for index.html
const getPageUrl = () => {
  const absolutePath = path.resolve('./index.html');
  return `file://${absolutePath}`;
};

test.describe('Application Fixes Verification', () => {
  let page;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    // Clear IndexedDB and localStorage before each test
    await page.goto(getPageUrl());
    await page.evaluate(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('doneTimeDB');
    });
    // Reload to apply cleared state
    await page.goto(getPageUrl());
    // Wait for the table to be ready after seeding defaults
    await page.waitForFunction(() => document.querySelector('#recentTable tbody tr'));
  });

  test.afterEach(async () => {
    await page.close();
  });

  test('1. should display Bootstrap gear icon in save settings button', async () => {
    // Navigate to the settings tab
    await page.click('button[data-tab="tab-settings"]');

    // Check if the button contains the Bootstrap icon
    const button = page.locator('#settingsSaveBtn');
    const icon = button.locator('i.bi-gear-fill');

    await expect(icon).toBeVisible();
    await expect(button).toContainText('設定を保存');
  });

  test('2. should correctly re-index order after deleting a suggestion', async () => {
    // Navigate to the suggestions tab
    await page.click('button[data-tab="table-recent"]');

    // Helper to add a task
    const addTask = async (taskName) => {
      await page.fill('#taskInput', taskName);
      await page.click('#saveBtn');
      // Wait for the success message to clear to avoid race conditions
      await expect(page.locator('#saveStatus')).toHaveText('保存しました');
      await expect(page.locator('#saveStatus')).toBeEmpty({ timeout: 2000 });
    };

    // Add a few suggestions
    await addTask('Task A');
    await addTask('Task B');
    await addTask('Task C');

    // Get the state of the suggestions table
    const getTableState = async () => {
        return await page.evaluate(() => {
            const table = window.jQuery('#recentTable').DataTable();
            return table.rows().data().toArray().map(row => row.text);
        });
    };

    // Initial state check (newest on top of unpinned)
    let texts = await getTableState();
    // Default items are '開始', '休憩' (pinned)
    expect(texts).toEqual(['開始', '休憩', 'Task C', 'Task B', 'Task A']);

    // Delete "Task B" (middle item)
    const rowToDelete = page.locator('#recentTable tbody tr', { hasText: 'Task B' });

    // Handle the confirmation dialog
    page.on('dialog', dialog => dialog.accept());

    await rowToDelete.locator('.btn-delete').click();

    // Wait for the table to re-render by asserting the row is no longer present
    await expect(rowToDelete).toHaveCount(0);

    // Final state check
    texts = await getTableState();
    expect(texts).toEqual(['開始', '休憩', 'Task C', 'Task A']);
  });

  test('3. should keep tags visible for old suggestions but limit autocomplete', async () => {
    // Set a lower limit for autocomplete for testing purposes
    const SUGGESTION_LIMIT = 2;
    await page.evaluate((limit) => {
        // Mock the buildOptionsFromRecent function to use a smaller limit
        const originalFunc = window.buildOptionsFromRecent;
        window.buildOptionsFromRecent = (recent) => originalFunc(recent, limit);
    }, SUGGESTION_LIMIT);

    // Helper to add a task and assign a tag
    const addTaskWithTag = async (taskName, tagName) => {
      // Add the task
      await page.fill('#taskInput', taskName);
      await page.click('#saveBtn');
      await expect(page.locator('#saveStatus')).toHaveText('保存しました');
      await expect(page.locator('#saveStatus')).toBeEmpty({ timeout: 2000 });

      // Navigate to suggestions tab to add tag
      await page.click('button[data-tab="table-recent"]');

      // Find the row and open the tag editor
      const row = page.locator(`#recentTable tbody tr:has-text("${taskName}")`);
      const tagCell = row.locator('td:nth-child(3)');
      await tagCell.dblclick();

      // Enter tag and save
      await page.fill('#tagEditInput', tagName);
      await page.click('#tagEditOk');

      // Go back to the main tab
      await page.click('button[data-tab="table-activities"]');
    };

    // Add more tasks than the limit
    await addTaskWithTag('Old Task 1', 'tag1');
    await addTaskWithTag('Old Task 2', 'tag2');
    await addTaskWithTag('New Task 1', 'tag3');
    await addTaskWithTag('New Task 2', 'tag4');

    // 1. Verify all tags are visible in the table
    await page.click('button[data-tab="table-recent"]');
    await expect(page.locator('#recentTable tbody tr:has-text("Old Task 1") .tag')).toHaveText('tag1');
    await expect(page.locator('#recentTable tbody tr:has-text("Old Task 2") .tag')).toHaveText('tag2');
    await expect(page.locator('#recentTable tbody tr:has-text("New Task 1") .tag')).toHaveText('tag3');
    await expect(page.locator('#recentTable tbody tr:has-text("New Task 2") .tag')).toHaveText('tag4');

    // 2. Verify autocomplete is limited
    const autocompleteOptions = await page.evaluate(() => {
        const options = Array.from(document.querySelectorAll('#taskOptions option'));
        return options.map(opt => opt.value);
    });

    // Pinned defaults + the 2 newest unpinned tasks
    expect(autocompleteOptions).toContain('開始');
    expect(autocompleteOptions).toContain('休憩');
    expect(autocompleteOptions).toContain('New Task 2');
    expect(autocompleteOptions).toContain('New Task 1');
    expect(autocompleteOptions).not.toContain('Old Task 2');
    expect(autocompleteOptions).not.toContain('Old Task 1');
    expect(autocompleteOptions.length).toBe(2 + SUGGESTION_LIMIT); // Pinned + limit

    await page.screenshot({ path: 'e2e/fixes-verification.png' });
  });
});
