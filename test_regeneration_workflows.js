/**
 * Verification Test Suite: Same-Model vs. Alternative-Model Regeneration Workflows
 * Ensures:
 * 1. Same-model regeneration uses the provider & model of the active alternative in-place.
 * 2. Alternative-model regeneration adds a new alternative without mutating existing alternatives.
 * 3. Neither workflow throws ReferenceError (specifically getActiveAlternative is defined and works).
 * 4. Switching active alternative preserves all alternatives intact.
 * 5. Provider / model metadata is preserved throughout.
 */

import {
  createAlternativeRecord,
  normalizeAssistantMessage,
  addAlternativeToAssistantMessage,
  switchActiveAlternativeInMessage,
  updateActiveAlternativeInMessage,
  getActiveAlternative,
  getAlternativeMetrics
} from './src/services/alternativeResponseService.js';

let passed = 0;
let failed = 0;

function assert(condition, desc) {
  if (condition) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${desc}`);
    failed++;
  }
}

console.log('\n=== TEST SUITE: SAME-MODEL VS ALTERNATIVE-MODEL REGENERATION ===\n');

// ----------------------------------------------------------------------------
// Scenario 1: Initial Message Generation (Gemini)
// ----------------------------------------------------------------------------
console.log('Scenario 1: Initial conversation turn');
const userMessage = {
  id: 'user-turn-1',
  sender: 'user',
  content: 'Explain quantum computing in one sentence.'
};

const initialAssistantMessage = normalizeAssistantMessage(
  {
    id: 'gemini-100-assistant',
    sender: 'assistant',
    parentMessageId: userMessage.id,
    provider: 'gemini',
    modelUsed: 'gemini-3.1-flash-lite',
    content: 'Quantum computing leverages superposition and entanglement to solve specific problems exponentially faster.',
    responseTimeMs: 380,
    timestamp: '09:00 AM'
  },
  userMessage
);

assert(initialAssistantMessage.alternatives.length === 1, 'Initial message has 1 alternative');
assert(initialAssistantMessage.activeAlternativeId === initialAssistantMessage.alternatives[0].id, 'Active alternative is Alt 1');

// ----------------------------------------------------------------------------
// Scenario 2: Same-Model Regeneration Workflow
// ----------------------------------------------------------------------------
console.log('\nScenario 2: Same-Model Regeneration Workflow (Button: "Regenerate")');
// In ChatPage.jsx handleRegenerate:
// 1. Identify provider/model using getActiveAlternative
let caughtError = null;
let resolvedProvider = null;
let resolvedModel = null;
try {
  const normalizedTarget = normalizeAssistantMessage(initialAssistantMessage, userMessage);
  const activeAlt = getActiveAlternative(normalizedTarget);
  resolvedProvider = activeAlt?.provider || initialAssistantMessage.provider;
  resolvedModel = activeAlt?.modelUsed || initialAssistantMessage.modelUsed;
} catch (err) {
  caughtError = err;
}

assert(caughtError === null, 'handleRegenerate executes without ReferenceError');
assert(resolvedProvider === 'gemini', 'Same-model regeneration resolves original provider (gemini)');
assert(resolvedModel === 'gemini-3.1-flash-lite', 'Same-model regeneration resolves original model (gemini-3.1-flash-lite)');

// In-place update for streaming
const inPlaceStreaming = updateActiveAlternativeInMessage(initialAssistantMessage, {
  content: '',
  isStreaming: true,
  modelUsed: resolvedModel,
  provider: resolvedProvider,
  responseTimeMs: null
});

assert(inPlaceStreaming.alternatives.length === 1, 'No duplicate message or extra alternative created during same-model regeneration');
assert(inPlaceStreaming.isStreaming === true, 'Message marked as streaming');

// In-place finalization with newly generated content
const regeneratedContent = 'Quantum computers harness qubits that exist as 0 and 1 simultaneously to compute complex tasks rapidly.';
const inPlaceCompleted = updateActiveAlternativeInMessage(inPlaceStreaming, {
  content: regeneratedContent,
  isStreaming: false,
  responseTimeMs: 345,
  modelUsed: resolvedModel,
  provider: resolvedProvider
});

assert(inPlaceCompleted.alternatives.length === 1, 'Still exactly 1 alternative after same-model regeneration');
assert(inPlaceCompleted.content === regeneratedContent, 'Content updated in-place to regenerated text');
assert(inPlaceCompleted.provider === 'gemini', 'Provider remains Gemini');
assert(inPlaceCompleted.modelUsed === 'gemini-3.1-flash-lite', 'Model remains gemini-3.1-flash-lite');

// ----------------------------------------------------------------------------
// Scenario 3: Alternative-Model Regeneration Workflow (Button: "Another Model" -> Groq)
// ----------------------------------------------------------------------------
console.log('\nScenario 3: Alternative-Model Regeneration Workflow (Button: "Another Model" -> Groq)');
// In ChatPage.jsx handleGenerateAlternative:
const targetProvider = 'groq';
const chosenModel = 'openai/gpt-oss-120b';

const groqAltRecord = createAlternativeRecord({
  parentMessageId: userMessage.id,
  provider: targetProvider,
  modelUsed: chosenModel,
  content: '',
  isStreaming: true
});

const messageWithGroqAlt = addAlternativeToAssistantMessage(inPlaceCompleted, groqAltRecord);

assert(messageWithGroqAlt.alternatives.length === 2, 'Message now has 2 alternatives');
assert(messageWithGroqAlt.activeAlternativeId === groqAltRecord.id, 'Active alternative is newly added Groq alternative');
assert(messageWithGroqAlt.alternatives[0].content === regeneratedContent, 'Original Gemini response remains intact');
assert(messageWithGroqAlt.alternatives[0].provider === 'gemini', 'Alternative 1 provider is still Gemini');

// Stream chunks into active Groq alternative
const groqText = 'Groq speed: Quantum computing operates on probabilistic quantum bits that perform parallel calculations.';
const finalizedGroqMsg = updateActiveAlternativeInMessage(messageWithGroqAlt, {
  content: groqText,
  isStreaming: false,
  responseTimeMs: 95,
  modelUsed: chosenModel,
  provider: targetProvider
});

assert(finalizedGroqMsg.content === groqText, 'Root content shows Groq alternative');
assert(finalizedGroqMsg.provider === 'groq', 'Root provider is groq');
assert(finalizedGroqMsg.modelUsed === 'openai/gpt-oss-120b', 'Root modelUsed is Groq model');
assert(finalizedGroqMsg.alternatives[0].content === regeneratedContent, 'Alternative 1 (Gemini) remains unchanged');
assert(finalizedGroqMsg.alternatives[1].content === groqText, 'Alternative 2 (Groq) has new content');

// ----------------------------------------------------------------------------
// Scenario 4: Switching back to Alternative 1 & clicking Same-Model "Regenerate"
// ----------------------------------------------------------------------------
console.log('\nScenario 4: Same-Model regeneration on Alternative 1 preserves Alternative 2');
// User clicks previous arrow: < 1 of 2 >
const switchedBackToGemini = switchActiveAlternativeInMessage(finalizedGroqMsg, finalizedGroqMsg.alternatives[0].id);
assert(switchedBackToGemini.activeAlternativeId === finalizedGroqMsg.alternatives[0].id, 'Active alt switched back to Gemini');
assert(switchedBackToGemini.provider === 'gemini', 'Active provider projected as Gemini');

// Now user clicks same-model "Regenerate" button
const activeOnTurn = getActiveAlternative(switchedBackToGemini);
assert(activeOnTurn.provider === 'gemini', 'getActiveAlternative correctly identifies Gemini as active');
assert(activeOnTurn.modelUsed === 'gemini-3.1-flash-lite', 'getActiveAlternative identifies gemini-3.1-flash-lite as model');

// Regenerate Alternative 1 in place
const geminiV3Content = 'Quantum computing processes vast combinatorial spaces through quantum interference and entanglement.';
const updatedGeminiOnly = updateActiveAlternativeInMessage(switchedBackToGemini, {
  content: geminiV3Content,
  responseTimeMs: 310,
  provider: activeOnTurn.provider,
  modelUsed: activeOnTurn.modelUsed
});

assert(updatedGeminiOnly.alternatives.length === 2, 'Message still has exactly 2 alternatives');
assert(updatedGeminiOnly.alternatives[0].content === geminiV3Content, 'Alternative 1 updated with new text');
assert(updatedGeminiOnly.alternatives[1].content === groqText, 'Alternative 2 (Groq) completely preserved!');
assert(updatedGeminiOnly.alternatives[1].provider === 'groq', 'Alternative 2 provider is still Groq');

// ----------------------------------------------------------------------------
// Scenario 5: Generating a 3rd Alternative with OpenRouter & Cloudflare
// ----------------------------------------------------------------------------
console.log('\nScenario 5: 3rd Alternative Generation (OpenRouter)');
const openRouterAlt = createAlternativeRecord({
  parentMessageId: userMessage.id,
  provider: 'openrouter',
  modelUsed: 'openrouter/free',
  content: 'OpenRouter view: Quantum mechanics applied to computer science for computational supremacy.',
  responseTimeMs: 440
});

const messageWith3Alts = addAlternativeToAssistantMessage(updatedGeminiOnly, openRouterAlt);
assert(messageWith3Alts.alternatives.length === 3, 'Message has 3 alternatives');
assert(messageWith3Alts.activeAlternativeId === openRouterAlt.id, 'Active alternative is OpenRouter');
assert(messageWith3Alts.provider === 'openrouter', 'Root provider is openrouter');

const metrics = getAlternativeMetrics(messageWith3Alts);
assert(metrics.total === 3, 'Metrics total is 3');
assert(metrics.currentIndex === 2, 'Current index is 2 (3 of 3)');
assert(metrics.canGoPrevious === true, 'Can go previous');
assert(metrics.canGoNext === false, 'Cannot go next');

console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All regeneration workflow tests PASSED cleanly!\n');
}
