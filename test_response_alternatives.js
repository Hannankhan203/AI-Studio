/**
 * Verification Test Suite for Orvix Phase 1: Response Alternatives & Data Architecture
 * Tests data modeling, stable identifiers, multi-model alternatives,
 * non-destructive additions, navigation switching, legacy message normalization,
 * and persistence compatibility.
 */

import {
  generateAlternativeId,
  createAlternativeRecord,
  normalizeAssistantMessage,
  addAlternativeToAssistantMessage,
  switchActiveAlternativeInMessage,
  updateActiveAlternativeInMessage,
  updateAlternativeByIdInMessage,
  ensureConversationAlternatives,
  getAlternativeMetrics
} from './src/services/alternativeResponseService.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

console.log('\n=== RUNNING ORVIX RESPONSE ALTERNATIVES TEST SUITE ===\n');

// ----------------------------------------------------------------------------
// Test 1: Stable, Unique Alternative Identifiers
// ----------------------------------------------------------------------------
console.log('Test 1: Stable Alternative Identifiers');
const idGemini = generateAlternativeId('gemini');
const idGroq = generateAlternativeId('groq');
const idOpenRouter = generateAlternativeId('openrouter');

assert(idGemini.startsWith('alt-gemini-'), 'Generates provider-prefixed Gemini ID');
assert(idGroq.startsWith('alt-groq-'), 'Generates provider-prefixed Groq ID');
assert(idOpenRouter.startsWith('alt-openrouter-'), 'Generates provider-prefixed OpenRouter ID');
assert(idGemini !== idGroq, 'Generates distinct IDs for different calls');

// ----------------------------------------------------------------------------
// Test 2: Creating ResponseAlternative Record
// ----------------------------------------------------------------------------
console.log('\nTest 2: Creating Clean ResponseAlternative Record');
const altRecord = createAlternativeRecord({
  parentMessageId: 'user-msg-101',
  provider: 'gemini',
  modelUsed: 'Gemini 3.1 Flash Lite',
  content: 'Here is the Gemini explanation.',
  responseTimeMs: 342
});

assert(altRecord.id.startsWith('alt-gemini-'), 'Record has valid ID');
assert(altRecord.parentMessageId === 'user-msg-101', 'Linked to correct parent user message ID');
assert(altRecord.provider === 'gemini', 'Retains provider information');
assert(altRecord.modelUsed === 'Gemini 3.1 Flash Lite', 'Retains model information');
assert(altRecord.content === 'Here is the Gemini explanation.', 'Retains content');
assert(altRecord.responseTimeMs === 342, 'Retains measured response time');
assert(typeof altRecord.createdAt === 'number', 'Has millisecond createdAt timestamp');
assert(altRecord.isError === false, 'Default isError is false');

// ----------------------------------------------------------------------------
// Test 3: Normalizing Legacy Messages Without Alternatives Metadata
// ----------------------------------------------------------------------------
console.log('\nTest 3: Backward Compatibility - Legacy Message Normalization');
const userMsg1 = { id: 'user-001', sender: 'user', content: 'What is WebSockets?' };
const legacyAssistantMsg = {
  id: 'assistant-001',
  sender: 'assistant',
  content: 'WebSockets provide full-duplex communication channels over a single TCP connection.',
  provider: 'gemini',
  modelUsed: 'Gemini 3.1 Flash Lite',
  responseTimeMs: 410,
  timestamp: '10:30 AM'
};

const normalized = normalizeAssistantMessage(legacyAssistantMsg, userMsg1);

assert(normalized.parentMessageId === 'user-001', 'Resolves parentMessageId from preceding user message');
assert(Array.isArray(normalized.alternatives), 'Creates alternatives array');
assert(normalized.alternatives.length === 1, 'Wraps legacy message as Alternative 1');
assert(normalized.activeAlternativeId === normalized.alternatives[0].id, 'Sets activeAlternativeId to Alternative 1');
assert(normalized.alternatives[0].content === legacyAssistantMsg.content, 'Preserves original content in Alternative 1');
assert(normalized.alternatives[0].provider === 'gemini', 'Preserves original provider in Alternative 1');
assert(normalized.alternatives[0].responseTimeMs === 410, 'Preserves original response time');
assert(normalized.content === legacyAssistantMsg.content, 'Projects active content onto root message');

// ----------------------------------------------------------------------------
// Test 4: Generating Alternative Response (Preserving Original Response)
// ----------------------------------------------------------------------------
console.log('\nTest 4: Non-Destructive Alternative Generation');
const groqAlternativeData = {
  parentMessageId: 'user-001',
  provider: 'groq',
  modelUsed: 'Llama 3.3 70B',
  content: 'Groq explanation: WebSockets maintain an open socket for low-latency bidirectional messaging.',
  responseTimeMs: 145,
  timestamp: '10:31 AM'
};

const withGroqAlt = addAlternativeToAssistantMessage(normalized, groqAlternativeData);

assert(withGroqAlt.alternatives.length === 2, 'Message now has exactly 2 alternatives');
// CRITICAL: Original response MUST remain completely unchanged!
assert(withGroqAlt.alternatives[0].provider === 'gemini', 'Alternative 1 is still Gemini');
assert(withGroqAlt.alternatives[0].content === legacyAssistantMsg.content, 'Alternative 1 content is completely unchanged');
assert(withGroqAlt.alternatives[0].responseTimeMs === 410, 'Alternative 1 response time is unchanged');

// Verify Alternative 2 (Groq)
assert(withGroqAlt.alternatives[1].provider === 'groq', 'Alternative 2 is Groq');
assert(withGroqAlt.alternatives[1].modelUsed === 'Llama 3.3 70B', 'Alternative 2 has Groq model tag');
assert(withGroqAlt.alternatives[1].content === groqAlternativeData.content, 'Alternative 2 has Groq content');
assert(withGroqAlt.activeAlternativeId === withGroqAlt.alternatives[1].id, 'Active alternative is now Groq');
assert(withGroqAlt.content === groqAlternativeData.content, 'Root content reflects active Groq alternative');
assert(withGroqAlt.provider === 'groq', 'Root provider reflects active Groq alternative');

// ----------------------------------------------------------------------------
// Test 5: Adding a 3rd Alternative (OpenRouter / Mistral)
// ----------------------------------------------------------------------------
console.log('\nTest 5: Adding 3rd Alternative (OpenRouter)');
const openRouterAltData = {
  parentMessageId: 'user-001',
  provider: 'openrouter',
  modelUsed: 'Mistral 7B Instruct',
  content: 'Mistral summary: A WebSocket is a persistent protocol for instant live data exchange.',
  responseTimeMs: 520,
  timestamp: '10:32 AM'
};

const with3Alts = addAlternativeToAssistantMessage(withGroqAlt, openRouterAltData);

assert(with3Alts.alternatives.length === 3, 'Message now has exactly 3 alternatives');
assert(with3Alts.alternatives[0].provider === 'gemini', 'Alternative 1 is still Gemini');
assert(with3Alts.alternatives[1].provider === 'groq', 'Alternative 2 is still Groq');
assert(with3Alts.alternatives[2].provider === 'openrouter', 'Alternative 3 is OpenRouter/Mistral');
assert(with3Alts.activeAlternativeId === with3Alts.alternatives[2].id, 'Active alternative is now Alternative 3');

// ----------------------------------------------------------------------------
// Test 6: Switching Active Alternative
// ----------------------------------------------------------------------------
console.log('\nTest 6: Switching Active Alternative and Projection');
// Switch back to Gemini (Alternative 1)
const switchedToGemini = switchActiveAlternativeInMessage(with3Alts, with3Alts.alternatives[0].id);

assert(switchedToGemini.activeAlternativeId === with3Alts.alternatives[0].id, 'Active alternative is now Alternative 1');
assert(switchedToGemini.content === legacyAssistantMsg.content, 'Root content switched to Gemini');
assert(switchedToGemini.provider === 'gemini', 'Root provider switched to Gemini');
assert(switchedToGemini.responseTimeMs === 410, 'Root response time switched to Gemini');

// Switch to Groq (Alternative 2)
const switchedToGroq = switchActiveAlternativeInMessage(with3Alts, with3Alts.alternatives[1].id);

assert(switchedToGroq.activeAlternativeId === with3Alts.alternatives[1].id, 'Active alternative is now Alternative 2');
assert(switchedToGroq.content === groqAlternativeData.content, 'Root content switched to Groq');
assert(switchedToGroq.provider === 'groq', 'Root provider switched to Groq');
assert(switchedToGroq.responseTimeMs === 145, 'Root response time switched to Groq');

// ----------------------------------------------------------------------------
// Test 7: Alternative Navigation Metrics
// ----------------------------------------------------------------------------
console.log('\nTest 7: Navigation Metrics');
const metricsGemini = getAlternativeMetrics(switchedToGemini);
assert(metricsGemini.total === 3, 'Total alternatives is 3');
assert(metricsGemini.currentIndex === 0, 'Current index on Gemini is 0 (1 of 3)');
assert(metricsGemini.canGoPrevious === false, 'Cannot go previous on first alternative');
assert(metricsGemini.canGoNext === true, 'Can go next on first alternative');

const metricsGroq = getAlternativeMetrics(switchedToGroq);
assert(metricsGroq.currentIndex === 1, 'Current index on Groq is 1 (2 of 3)');
assert(metricsGroq.canGoPrevious === true, 'Can go previous on middle alternative');
assert(metricsGroq.canGoNext === true, 'Can go next on middle alternative');

const metricsMistral = getAlternativeMetrics(with3Alts);
assert(metricsMistral.currentIndex === 2, 'Current index on Mistral is 2 (3 of 3)');
assert(metricsMistral.canGoPrevious === true, 'Can go previous on last alternative');
assert(metricsMistral.canGoNext === false, 'Cannot go next on last alternative');

// ----------------------------------------------------------------------------
// Test 8: In-place Streaming Updates
// ----------------------------------------------------------------------------
console.log('\nTest 8: Streaming Updates On Active Alternative');
const streamingUpdate = updateActiveAlternativeInMessage(switchedToGroq, {
  content: 'Groq explanation: updated with streaming chunk.',
  modelUsed: 'Llama 3.3 70B',
  responseTimeMs: 160
});

assert(streamingUpdate.content === 'Groq explanation: updated with streaming chunk.', 'Active content updated');
assert(streamingUpdate.alternatives[1].content === 'Groq explanation: updated with streaming chunk.', 'Alternative 2 content updated');
assert(streamingUpdate.alternatives[0].content === legacyAssistantMsg.content, 'Alternative 1 (Gemini) remains untouched');
assert(streamingUpdate.alternatives[2].content === openRouterAltData.content, 'Alternative 3 (Mistral) remains untouched');

// ----------------------------------------------------------------------------
// Test 9: Conversation-Wide Normalization
// ----------------------------------------------------------------------------
console.log('\nTest 9: Full Conversation Normalization');
const rawConversation = [
  { id: 'u1', sender: 'user', content: 'Prompt 1' },
  { id: 'a1', sender: 'assistant', content: 'Response 1', provider: 'gemini' },
  { id: 'u2', sender: 'user', content: 'Prompt 2' },
  { id: 'a2', sender: 'assistant', content: 'Response 2', provider: 'groq' }
];

const normalizedConvo = ensureConversationAlternatives(rawConversation);

assert(normalizedConvo[1].parentMessageId === 'u1', 'a1 linked to preceding user message u1');
assert(normalizedConvo[1].alternatives.length === 1, 'a1 has alternatives array');
assert(normalizedConvo[3].parentMessageId === 'u2', 'a2 linked to preceding user message u2');
assert(normalizedConvo[3].alternatives.length === 1, 'a2 has alternatives array');

// ----------------------------------------------------------------------------
// Test 10: JSON Serialization & Guest Storage Roundtrip
// ----------------------------------------------------------------------------
console.log('\nTest 10: Serialization & Storage Roundtrip');
const serialized = JSON.stringify(with3Alts);
const restored = JSON.parse(serialized);

assert(Array.isArray(restored.alternatives) && restored.alternatives.length === 3, 'Restores 3 alternatives from JSON');
assert(restored.activeAlternativeId === with3Alts.activeAlternativeId, 'Preserves activeAlternativeId');
assert(restored.parentMessageId === 'user-001', 'Preserves parentMessageId');
assert(restored.alternatives[0].provider === 'gemini', 'Preserves alternative 1');
assert(restored.alternatives[1].provider === 'groq', 'Preserves alternative 2');
assert(restored.alternatives[2].provider === 'openrouter', 'Preserves alternative 3');

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All response alternative architecture tests PASSED successfully!\n');
}
