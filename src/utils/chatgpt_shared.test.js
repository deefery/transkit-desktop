// Run with: node --test src/utils/chatgpt_shared.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPANIONS, appendUnique, buildDefaultConfig, hasServiceInstance, pickModel } from './chatgpt_shared.js';

test('pickModel: own override wins, then the shared default, then empty (auto)', () => {
    assert.equal(pickModel('gpt-x', { model: 'shared' }), 'gpt-x');
    assert.equal(pickModel('  gpt-x  ', { model: 'shared' }), 'gpt-x');
    assert.equal(pickModel('', { model: ' shared ' }), 'shared');
    assert.equal(pickModel(undefined, { model: 'shared' }), 'shared');
    assert.equal(pickModel('   ', null), '');
    assert.equal(pickModel(undefined, undefined), '');
    assert.equal(pickModel(null, { model: 42 }), '');
});

test('hasServiceInstance matches the service name before @, not substrings', () => {
    const list = ['google', 'chatgpt@abc123', 'transkit_cloud_ai'];
    assert.equal(hasServiceInstance(list, 'chatgpt'), true);
    assert.equal(hasServiceInstance(list, 'chatgpt_ai'), false);
    assert.equal(hasServiceInstance(['chatgpt_ai@x'], 'chatgpt'), false);
    assert.equal(hasServiceInstance(['chatgpt'], 'chatgpt'), true, 'legacy keys have no @id');
    assert.equal(hasServiceInstance(null, 'chatgpt'), false);
});

test('appendUnique never duplicates and tolerates a missing list', () => {
    assert.deepEqual(appendUnique(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(appendUnique(['a', 'b'], 'b'), ['a', 'b']);
    assert.deepEqual(appendUnique(null, 'b'), ['b']);
});

test('companions point at each other and at the right lists', () => {
    assert.equal(COMPANIONS.chatgpt.serviceName, 'chatgpt_ai');
    assert.equal(COMPANIONS.chatgpt.listKey, 'ai_service_list');
    assert.equal(COMPANIONS.chatgpt_ai.serviceName, 'chatgpt');
    assert.equal(COMPANIONS.chatgpt_ai.listKey, 'translate_service_list');
    // The fallback lists must keep the defaults the rest of the app assumes.
    assert.ok(COMPANIONS.chatgpt.defaultList.includes('transkit_cloud_ai'));
    assert.ok(COMPANIONS.chatgpt_ai.defaultList.includes('google'));
});

test('default configs follow the shared model and are independent copies', () => {
    const translate = buildDefaultConfig('chatgpt', 'ChatGPT Plan');
    assert.equal(translate.model, '');
    assert.equal(translate.instanceName, 'ChatGPT Plan');
    assert.equal(translate.stream, true);
    assert.equal(translate.promptList[0].role, 'system');
    translate.promptList[0].content = 'changed';
    assert.notEqual(buildDefaultConfig('chatgpt', 'x').promptList[0].content, 'changed');

    const ai = buildDefaultConfig('chatgpt_ai', 'ChatGPT Plan');
    assert.equal(ai.model, '');
    assert.match(ai.systemPrompt, /translation assistant/);
    assert.throws(() => buildDefaultConfig('openai', 'x'));
});
