// Run with: node --test src/utils/chatgpt.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatGPTError, describeChatGPTError, fillPlaceholders, splitPromptList, toChatGPTError } from './chatgpt.js';

test('splitPromptList moves system text to instructions and keeps the rest as input', () => {
    const { instructions, input } = splitPromptList([
        { role: 'system', content: 'Be a translator.' },
        { role: 'user', content: 'Translate: hi' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '   ' },
        { role: 'developer', content: 'Extra rule.' },
    ]);
    assert.equal(instructions, 'Be a translator.\n\nExtra rule.');
    assert.deepEqual(input, [
        { role: 'user', content: 'Translate: hi' },
        { role: 'assistant', content: 'ok' },
    ]);
});

test('splitPromptList tolerates missing or malformed lists', () => {
    assert.deepEqual(splitPromptList(undefined), { instructions: '', input: [] });
    assert.deepEqual(splitPromptList([null, { role: 'user' }, { role: 'tool', content: 'x' }]), {
        instructions: '',
        input: [{ role: 'user', content: 'x' }],
    });
});

test('fillPlaceholders substitutes in one pass and never re-expands user text', () => {
    const values = { text: 'costs $to $& $1 $$', to: 'French', from: 'English', detect: 'English' };
    assert.equal(
        fillPlaceholders('Translate $from into $to:\n$text', values),
        'Translate English into French:\ncosts $to $& $1 $$'
    );
});

test('fillPlaceholders leaves unknown placeholders alone', () => {
    assert.equal(fillPlaceholders('$text and $other', { text: 'a' }), 'a and $other');
    assert.equal(fillPlaceholders('no values $text', {}), 'no values $text');
});

test('toChatGPTError understands serialized Rust errors and plain strings', () => {
    const fromRust = toChatGPTError({ code: 'reauth_required', message: 'Sign in again.', retryable: false });
    assert.ok(fromRust instanceof ChatGPTError);
    assert.equal(fromRust.code, 'reauth_required');
    assert.equal(fromRust.message, 'Sign in again.');

    const fromString = toChatGPTError('invalid args');
    assert.equal(fromString.code, 'unknown');
    assert.equal(fromString.message, 'invalid args');

    assert.equal(toChatGPTError(fromRust), fromRust);
});

test('describeChatGPTError includes code and request id when known', () => {
    assert.equal(describeChatGPTError({ code: 'x', message: 'Boom' }), 'Boom (x)');
    assert.equal(describeChatGPTError({ code: 'x', message: 'Boom', requestId: 'req_1' }), 'Boom (x, req_1)');
});
