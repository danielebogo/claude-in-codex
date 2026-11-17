import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCodexResults, waitForCodexResults, forgetCodexCalls, waitingCodexTurnsReferencedBy, waitingCodexTurns } from '../src/codexTools.js';
import { chatDelivery } from './fixtures/codex-delegation.js';

// Failure modes:
// - Matching call/thread IDs resume a waiting process from a different provider.
// - A mailbox delivery bypasses provider checks when a tool result is absent.
// - Filtering continuations accidentally hides foreign turns from cancellation.
test('tool results continue only a waiting turn owned by the requested native provider', () => {
  const claude = { threadId: 'shared-provider-thread' };
  const grok = { threadId: claude.threadId, provider: 'grok' };
  const claudeOutput = { type: 'function_call_output', call_id: 'provider-claude', output: 'Claude result' };
  const grokOutput = { type: 'custom_tool_call_output', call_id: 'provider-grok', output: 'Grok result' };
  waitForCodexResults([{ callId: claudeOutput.call_id, entry: { name: 'exec' } }], claude, 'ccb:v1:session:turn');
  waitForCodexResults([{ callId: grokOutput.call_id, entry: { name: 'exec' } }], grok, 'ccb:v2:grok:session:turn');
  try {
    assert.equal(findCodexResults([grokOutput], claude.threadId), null);
    assert.equal(findCodexResults([claudeOutput], claude.threadId, 'grok'), null);
    assert.equal(findCodexResults([claudeOutput], claude.threadId).turn, claude);
    assert.equal(findCodexResults([grokOutput], grok.threadId, 'grok').turn, grok);
    assert.deepEqual([...findCodexResults([claudeOutput, grokOutput], claude.threadId).outputs.keys()], [claudeOutput.call_id]);
    assert.deepEqual([...findCodexResults([claudeOutput, grokOutput], grok.threadId, 'grok').outputs.keys()], [grokOutput.call_id]);
    assert.deepEqual(waitingCodexTurns(claude.threadId), [claude, grok]);
    assert.deepEqual(waitingCodexTurnsReferencedBy([claudeOutput, grokOutput], claude.threadId), [claude, grok]);
  } finally {
    forgetCodexCalls([claudeOutput.call_id, grokOutput.call_id]);
  }
});

test('mailbox wakeups require the waiting native provider even with a matching call or marker', () => {
  for (const [provider, foreign] of [['claude', 'grok'], ['grok', 'claude']]) {
    const turn = { threadId: 'provider-mailbox', provider };
    const marker = { type: 'reasoning', encrypted_content: provider === 'claude' ? 'ccb:v1:session:mailbox' : 'ccb:v2:grok:session:mailbox' };
    const call = { type: 'function_call', call_id: 'provider-mailbox-call' };
    waitForCodexResults([{ callId: call.call_id, entry: { namespace: 'collaboration', name: 'wait_agent' } }], turn, marker.encrypted_content);
    try {
      for (const boundary of [marker, call]) {
        assert.equal(findCodexResults([boundary, chatDelivery], turn.threadId, foreign), null);
        assert.equal(findCodexResults([boundary, chatDelivery], turn.threadId, provider).turn, turn);
      }
    } finally {
      forgetCodexCalls([call.call_id]);
    }
  }
});

test('a chat delivery survives a later tool marker and is acknowledged only after delivery', () => {
  const turn = { threadId: 'chat-receiver', agentMessageIds: new Set() };
  const marker = { type: 'reasoning', encrypted_content: 'ccb:v1:session:later-call' };
  const call = { type: 'function_call', call_id: 'chat-result', name: 'request_user_input_async' };
  const output = { type: 'function_call_output', call_id: call.call_id, output: '{"accepted":true}' };
  waitForCodexResults([{ callId: call.call_id, entry: { name: call.name } }], turn, marker.encrypted_content);
  try {
    for (const input of [[marker, call, output, chatDelivery], [chatDelivery, marker, call, output], [marker, call, chatDelivery, output]]) {
      const result = findCodexResults(input, turn.threadId);
      assert.equal(result.outputs.get(call.call_id), output.output);
      assert.ok(result.userText.includes(chatDelivery.output));
      assert.deepEqual(result.agentMessageIds, [chatDelivery.id]);
      assert.equal(turn.agentMessageIds.size, 0, 'finding a delivery must not mark it received before the native reply');
    }
    turn.agentMessageIds.add(chatDelivery.id);
    const replay = findCodexResults([marker, call, output, chatDelivery], turn.threadId);
    assert.equal(replay.userText, '');
    assert.deepEqual(replay.agentMessageIds, []);
    assert.equal(findCodexResults([marker, call, output, chatDelivery], 'another-thread'), null);
  } finally {
    forgetCodexCalls([call.call_id]);
  }
});

test('a tool-shaped chat delivery can wake a lone collaboration wait', () => {
  const turn = { threadId: 'chat-wait', agentMessageIds: new Set() };
  const marker = { type: 'reasoning', encrypted_content: 'ccb:v1:session:chat-wait' };
  const entry = { namespace: 'collaboration', name: 'wait_agent' };
  waitForCodexResults([{ callId: 'chat-wait', entry }], turn, marker.encrypted_content);
  try {
    const result = findCodexResults([marker, chatDelivery], turn.threadId);
    assert.equal(result.turn, turn);
    assert.ok(result.userText.includes(chatDelivery.output));
    assert.match(result.outputs.get('chat-wait'), /not a user cancellation/);
    turn.agentMessageIds.add(chatDelivery.id);
    assert.equal(findCodexResults([marker, chatDelivery], turn.threadId), null, 'a replayed delivery must not wake a later wait');
  } finally {
    forgetCodexCalls(['chat-wait']);
  }
});

test('a mailbox delivery wakes Claude waiting on Codex wait_agent without a false user cancellation', () => {
  const turn = { threadId: 'parent' };
  const entry = { namespace: 'collaboration', name: 'wait_agent' };
  const marker = { type: 'reasoning', encrypted_content: 'ccb:v1:session:pending-wait' };
  waitForCodexResults([{ callId: 'pending-wait', entry }], turn, marker.encrypted_content);
  const wait = { type: 'function_call', call_id: 'pending-wait', namespace: 'collaboration', name: 'wait_agent' };
  const message = { type: 'agent_message', author: '/root/child', recipient: '/root', content: [{ type: 'input_text', text: 'Child finished: apricot' }] };
  try {
    const result = findCodexResults([wait, message]);
    assert.equal(result.turn, turn);
    assert.match(result.outputs.get('pending-wait'), /not a user cancellation/);
    assert.match(result.userText, /Codex agent message from \/root\/child to \/root:\nChild finished: apricot/);
    const preempted = findCodexResults([marker, message], 'parent');
    assert.equal(preempted.turn, turn, 'Codex removes the wait call when a ready mailbox reply preempts it');
    assert.match(preempted.outputs.get('pending-wait'), /not a user cancellation/);
    assert.match(preempted.userText, /Child finished: apricot/);
    assert.equal(findCodexResults([marker, message], 'fork'), null, 'an inherited marker must not resume a different thread');
    assert.equal(findCodexResults([message, marker]), null, 'historical mailbox content must not wake a pending wait');
    for (const text of ['Stop now.', '<turn_aborted>User stopped</turn_aborted>']) {
      for (const boundary of [wait, marker]) assert.equal(findCodexResults([boundary, message, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }]), null, 'a human stop or new request keeps the existing cancellation path');
    }
    waitForCodexResults([{ callId: 'pending-wait', entry: { ...entry, name: 'spawn_agent' } }], turn, marker.encrypted_content);
    assert.equal(findCodexResults([{ ...wait, name: 'spawn_agent' }, message]), null, 'do not invent results for other pending tools');
    assert.equal(findCodexResults([marker, message]), null, 'a marker does not make a non-wait tool resumable without results');
    waitForCodexResults([{ callId: 'pending-wait', entry }], turn, marker.encrypted_content);
    assert.equal(findCodexResults([wait, message, { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }]), null, 'a new human image must not be mistaken for mailbox-only delivery');
    assert.equal(findCodexResults([wait]), null);
    waitForCodexResults([{ callId: 'parallel-tool', entry: { namespace: 'functions', name: 'exec' } }], turn, marker.encrypted_content);
    assert.equal(findCodexResults([marker, message]), null, 'do not manufacture the missing result of a parallel tool');
  } finally {
    forgetCodexCalls(['pending-wait', 'parallel-tool']);
  }
});

test('tool continuations keep new text and image pixels on either side of the tool result', () => {
  const turn = { threadId: 'image-thread' };
  const marker = { type: 'reasoning', encrypted_content: 'ccb:v1:session:image-turn' };
  const call = { type: 'custom_tool_call', call_id: 'image-call', name: 'exec' };
  const output = { type: 'custom_tool_call_output', call_id: call.call_id, output: 'finished' };
  const historical = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Old request' }, { type: 'input_image', image_url: 'data:image/png;base64,OLD' }] };
  const current = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check this screenshot instead.' }, { type: 'input_image', image_url: 'data:image/png;base64,NEW' }] };
  waitForCodexResults([{ callId: call.call_id, entry: { name: 'exec' } }], turn, marker.encrypted_content);
  try {
    for (const arrivals of [[current, output], [output, current]]) {
      const result = findCodexResults([historical, marker, call, ...arrivals], turn.threadId);
      assert.equal(result.userText, 'Check this screenshot instead.');
      assert.deepEqual(result.userAttachments, [{ type: 'image', mimeType: 'image/png', data: 'NEW' }]);
      assert.equal(result.outputs.get(call.call_id), 'finished');
    }
    const delta = findCodexResults([output, current], turn.threadId);
    assert.equal(delta.userText, 'Check this screenshot instead.');
    assert.deepEqual(delta.userAttachments, [{ type: 'image', mimeType: 'image/png', data: 'NEW' }]);
    const imageOnly = findCodexResults([marker, call, output, { ...current, content: current.content.slice(1) }], turn.threadId);
    assert.equal(imageOnly.userText, '');
    assert.deepEqual(imageOnly.userAttachments, [{ type: 'image', mimeType: 'image/png', data: 'NEW' }]);
    assert.equal(findCodexResults([marker, call, current], turn.threadId), null, 'a new image without a result still cancels the waiting turn');
    assert.equal(findCodexResults([marker, call, output, current], 'another-thread'), null);
  } finally {
    forgetCodexCalls([call.call_id]);
  }
});

test('a model switch matches only the waiting turn whose pending call or marker continues in that same chat', () => {
  const main = { threadId: 'main-chat' };
  const other = { threadId: 'other-chat' };
  waitForCodexResults([{ callId: 'main-call', entry: { name: 'exec' } }], main, 'ccb:v1:main-session:handoff');
  waitForCodexResults([{ callId: 'other-call', entry: { name: 'exec' } }], other, 'ccb:v1:other-session:handoff');
  try {
    const call = { type: 'custom_tool_call', call_id: 'main-call', name: 'exec' };
    const marker = { type: 'reasoning', encrypted_content: 'ccb:v1:main-session:handoff' };
    const aborted = { type: 'custom_tool_call_output', call_id: 'main-call', output: 'aborted' };
    assert.deepEqual(waitingCodexTurnsReferencedBy([call, aborted], 'main-chat'), [main]);
    assert.deepEqual(waitingCodexTurnsReferencedBy([marker], 'main-chat'), [main], 'the marker identifies the pending turn when Codex drops the call');
    assert.deepEqual(waitingCodexTurnsReferencedBy([call, marker], 'other-chat'), [], 'a side chat inheriting this history must not stop the parent');
    assert.deepEqual(waitingCodexTurnsReferencedBy([{ type: 'message', role: 'user', content: [] }], 'main-chat'), [], 'a call that shares the thread ID but not the pending call is left alone');
    assert.deepEqual(waitingCodexTurnsReferencedBy([call], null), []);
    assert.deepEqual(waitingCodexTurns('main-chat'), [main]);
  } finally {
    forgetCodexCalls(['main-call', 'other-call']);
  }
});
