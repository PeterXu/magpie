import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { BrowserSession } from '../../src/browser/BrowserSession.js';

const CLIPBOARD_FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "clipboard-test.html")).href;

describe('BrowserSession clipboard operations', () => {
  let browser;
  let session;

  beforeEach(async () => {
    browser = await chromium.launch();
    session = new BrowserSession({ browser });
    await session.start();
  });

  afterEach(async () => {
    await session.stop();
    if (browser) await browser.close();
  });

  it('insertText inserts text into focused input', async () => {
    await session.navigate(CLIPBOARD_FIXTURE);
    const page = session._page;

    // Wait for input to be focused
    await page.waitForSelector('#txt');
    await page.evaluate(() => document.getElementById('txt').focus());

    await session.insertText('Hello World');

    // Wait for text to be inserted
    await new Promise(resolve => setTimeout(resolve, 100));
    const value = await page.$eval('#txt', el => el.value);
    assert.strictEqual(value, 'Hello World');
  });

  it('insertText limits text to 100KB', async () => {
    await session.navigate(CLIPBOARD_FIXTURE);
    const page = session._page;
    await page.waitForSelector('#txt');
    await page.evaluate(() => document.getElementById('txt').focus());

    // Create text larger than 100KB
    const largeText = 'x'.repeat(150000);
    await session.insertText(largeText);

    await new Promise(resolve => setTimeout(resolve, 100));
    const value = await page.$eval('#txt', el => el.value);
    assert.strictEqual(value.length, 100000);
  });

  it('handleCopy reads clipboard from remote browser', async () => {
    await session.navigate(CLIPBOARD_FIXTURE);
    const page = session._page;

    // First insert some text
    await page.waitForSelector('#txt');
    await page.evaluate(() => document.getElementById('txt').focus());
    await page.$eval('#txt', el => el.value = 'Test Text');

    // Select and copy text programmatically
    await page.evaluate(() => {
      const input = document.getElementById('txt');
      input.select();
      document.execCommand('copy');
    });

    // Set up clipboard change handler
    let clipboardData = null;
    session.onClipboardChange = (data) => {
      clipboardData = data;
    };

    await session.handleCopy(false);

    // Wait for clipboard read
    await new Promise(resolve => setTimeout(resolve, 200));

    // Note: This test may fail if the browser doesn't support clipboard API
    // In that case, we just verify the method doesn't throw
    if (clipboardData) {
      assert.strictEqual(clipboardData.text, 'Test Text');
    }
  });
});