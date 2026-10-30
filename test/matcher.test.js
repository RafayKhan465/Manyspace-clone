import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsKeyword, equalsKeyword, pickAutomation, validateAutomation } from '../src/matcher.js';

const base = { enabled: true, triggerType: 'comment', mediaIds: [], matchMode: 'keywords', keywords: [] };

test('keyword matching is whole-word and case/accent insensitive', () => {
  assert.ok(containsKeyword('LINK please!!', 'link'));
  assert.ok(containsKeyword('can I get the línk?', 'link'));
  assert.ok(containsKeyword('send the free guide pls', 'free guide'));
  assert.ok(!containsKeyword('blinking lights', 'link'));
  assert.ok(!containsKeyword('', 'link'));
});

test('emoji keywords use substring matching', () => {
  assert.ok(containsKeyword('🔥🔥🔥', '🔥'));
  assert.ok(!containsKeyword('nice', '🔥'));
});

test('exact matching ignores punctuation and case only', () => {
  assert.ok(equalsKeyword('  Guide! ', 'guide'));
  assert.ok(!equalsKeyword('guide please', 'guide'));
});

test('pickAutomation prefers post-specific, then keyword, rules', () => {
  const catchAll = { ...base, id: 'any', matchMode: 'any' };
  const global = { ...base, id: 'global', keywords: ['link'] };
  const specific = { ...base, id: 'specific', keywords: ['link'], mediaIds: ['m1'] };
  const list = [catchAll, global, specific];
  assert.equal(pickAutomation(list, { type: 'comment', text: 'link', mediaId: 'm1' }).id, 'specific');
  assert.equal(pickAutomation(list, { type: 'comment', text: 'link', mediaId: 'm2' }).id, 'global');
  assert.equal(pickAutomation(list, { type: 'comment', text: 'wow', mediaId: 'm2' }).id, 'any');
  assert.equal(pickAutomation([global], { type: 'comment', text: 'wow', mediaId: 'm2' }), null);
});

test('disabled automations and other trigger types never match', () => {
  const off = { ...base, enabled: false, matchMode: 'any' };
  const dm = { ...base, triggerType: 'dm', matchMode: 'any' };
  assert.equal(pickAutomation([off, dm], { type: 'comment', text: 'hi' }), null);
  assert.equal(pickAutomation([off, dm], { type: 'dm', text: 'hi' }), dm);
});

test('validateAutomation cleans input and reports problems', () => {
  const ok = validateAutomation({
    name: ' Guide ',
    keywords: [' guide ', 'GUIDE', '', 'guide '],
    dmText: 'Here you go',
    buttonTitle: 'Open',
    buttonUrl: 'https://example.com',
    publicReplies: ['Sent!', ' '],
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.automation.name, 'Guide');
  assert.deepEqual(ok.automation.keywords, ['guide', 'GUIDE']);
  assert.deepEqual(ok.automation.publicReplies, ['Sent!']);

  const bad = validateAutomation({ name: '', keywords: [], dmText: '', buttonTitle: 'x', buttonUrl: 'http://insecure' });
  assert.equal(bad.errors.length, 4);
});
