import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInputMessage } from '../../src/utils/keys.js';
import { InputChannel } from '../../src/utils/InputChannel.js';

describe('Clipboard message parsing', () => {
  it('parses paste message', () => {
    const raw = JSON.stringify({ t: 'paste', text: 'Hello World' });
    const result = parseInputMessage(raw);
    assert.strictEqual(result.kind, 'paste');
    assert.strictEqual(result.text, 'Hello World');
  });

  it('parses copy message with cut=false', () => {
    const raw = JSON.stringify({ t: 'copy', cut: false });
    const result = parseInputMessage(raw);
    assert.strictEqual(result.kind, 'copy');
    assert.strictEqual(result.cut, false);
  });

  it('parses copy message with cut=true', () => {
    const raw = JSON.stringify({ t: 'copy', cut: true });
    const result = parseInputMessage(raw);
    assert.strictEqual(result.kind, 'copy');
    assert.strictEqual(result.cut, true);
  });

  it('handles missing text in paste message', () => {
    const raw = JSON.stringify({ t: 'paste' });
    const result = parseInputMessage(raw);
    assert.strictEqual(result.text, '');
  });

  it('handles missing cut in copy message', () => {
    const raw = JSON.stringify({ t: 'copy' });
    const result = parseInputMessage(raw);
    assert.strictEqual(result.cut, false);
  });
});

describe('InputChannel clipboard handling', () => {
  it('calls insertText on paste message', async () => {
    let insertTextCalled = false;
    let insertedText = null;

    const mockSession = {
      insertText: async (text) => {
        insertTextCalled = true;
        insertedText = text;
      },
      getViewport: () => ({ width: 1280, height: 800 })
    };

    const channel = new InputChannel({
      browserSession: mockSession
    });

    await channel.handle(Buffer.from(JSON.stringify({ t: 'paste', text: 'Hello' })));

    assert.strictEqual(insertTextCalled, true);
    assert.strictEqual(insertedText, 'Hello');
  });

  it('calls handleCopy on copy message', async () => {
    let handleCopyCalled = false;
    let cutValue = null;

    const mockSession = {
      handleCopy: async (cut) => {
        handleCopyCalled = true;
        cutValue = cut;
      },
      getViewport: () => ({ width: 1280, height: 800 })
    };

    const channel = new InputChannel({
      browserSession: mockSession
    });

    await channel.handle(Buffer.from(JSON.stringify({ t: 'copy', cut: true })));

    assert.strictEqual(handleCopyCalled, true);
    assert.strictEqual(cutValue, true);
  });
});
