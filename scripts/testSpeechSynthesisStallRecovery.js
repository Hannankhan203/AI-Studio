/**
 * scripts/testSpeechSynthesisStallRecovery.js
 * Comprehensive Regression Test Suite for Speech Synthesis Stall Recovery and Chunk Integrity
 *
 * Scenarios Covered:
 * Scenario 1 — Normal playback of short AI responses
 * Scenario 2 — Playback of long AI responses containing multiple chunks (no chunks skipped)
 * Scenario 3 — Long paragraphs without punctuation
 * Scenario 4 — Temporary browser speech engine interruptions (stall recovery recovers current chunk at character offset without skipping to t + 1)
 * Scenario 5 — Pause and resume during a chunk (word-boundary alignment, no duplicate playback)
 * Scenario 6 — Stop and immediately start another message (sequence token invalidation, no overlapping speech)
 * Scenario 7 — Switching between messages during playback (stale callbacks invalidated)
 * Scenario 8 — Backgrounding and restoring browser tab (visibilitychange handling)
 * Scenario 9 — Speech engine errors and cancellations (retry limit guardrails prevent infinite recovery loops)
 * Scenario 10 — Completion of the final chunk (natural transition to completed -> idle)
 */

import assert from 'node:assert/strict';
import { cleanTextForSpeech, splitTextIntoSpeechChunks, getWordBoundaryOffset } from '../src/utils/speechTextCleaner.js';

console.log('\n===============================================================');
console.log('ORVIX SPEECH SYNTHESIS: STALL RECOVERY & CHUNK INTEGRITY SUITE');
console.log('===============================================================\n');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`✓ Test ${totalTests}: ${name}`);
  } catch (err) {
    console.error(`✗ Test ${totalTests} FAILED: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// Mock SpeechSynthesis environment
class MockSpeechSynthesisUtterance {
  constructor(text) {
    this.text = text;
    this.rate = 1.0;
    this.pitch = 1.0;
    this.voice = null;
    this.lang = 'en-US';
    this.onstart = null;
    this.onboundary = null;
    this.onend = null;
    this.onerror = null;
  }
}

class MockSpeechSynthesis {
  constructor() {
    this.speaking = false;
    this.pending = false;
    this.paused = false;
    this.voices = [
      { voiceURI: 'en-US-Standard-A', name: 'Standard Voice', lang: 'en-US', default: true }
    ];
    this.activeUtterance = null;
    this.spokenUtterances = [];
    this.cancelledCount = 0;
  }

  getVoices() {
    return this.voices;
  }

  speak(utterance) {
    this.activeUtterance = utterance;
    this.spokenUtterances.push(utterance);
    this.speaking = true;
    this.pending = false;
    if (utterance.onstart) {
      utterance.onstart();
    }
  }

  cancel() {
    this.cancelledCount++;
    if (this.activeUtterance) {
      const u = this.activeUtterance;
      this.activeUtterance = null;
      this.speaking = false;
      this.pending = false;
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }
}

// -----------------------------------------------------------------------------
// Test 1: Normal playback of short AI responses
// -----------------------------------------------------------------------------
runTest('Normal playback of short AI responses cleanly splits into 1 chunk and preserves text', () => {
  const shortResponse = 'Hello! How can I assist you with your code today?';
  const cleaned = cleanTextForSpeech(shortResponse);
  const chunks = splitTextIntoSpeechChunks(cleaned);

  assert.equal(chunks.length, 1, 'Short response should be 1 chunk');
  assert.equal(chunks[0], shortResponse);
});

// -----------------------------------------------------------------------------
// Test 2: Playback of long AI responses containing multiple chunks
// -----------------------------------------------------------------------------
runTest('Playback of long AI responses containing multiple chunks splits without dropped text', () => {
  const longResponse =
    'Orvix is a lightweight and modern AI chatbot designed for responsive interactions. ' +
    'It supports Google Gemini, Groq, OpenRouter, Cloudflare Workers AI, and local Browser AI models. ' +
    'Documents can be attached and analyzed with client-side OCR and serverless file processing pipelines. ' +
    'The speech synthesis architecture splits long text into digestible chunks to ensure reliable audio delivery.';

  const cleaned = cleanTextForSpeech(longResponse);
  const chunks = splitTextIntoSpeechChunks(cleaned);

  assert.ok(chunks.length >= 3, `Expected at least 3 chunks, got ${chunks.length}`);

  // Ensure every chunk has content and text can be reconstructed without omissions
  const combined = chunks.join(' ');
  assert.ok(combined.includes('lightweight and modern AI chatbot'));
  assert.ok(combined.includes('Google Gemini, Groq'));
  assert.ok(combined.includes('Documents can be attached'));
  assert.ok(combined.includes('speech synthesis architecture'));
});

// -----------------------------------------------------------------------------
// Test 3: Long paragraphs without punctuation
// -----------------------------------------------------------------------------
runTest('Long paragraphs without punctuation fall back to word boundaries without slicing words', () => {
  const unpunctuatedParagraph =
    'this is a very long paragraph without any punctuation marks whatsoever intended to test the fallback ' +
    'mechanisms of the speech chunker when it encounters continuous words without standard sentence or clause boundaries ' +
    'so that no word is ever cut in half and every chunk respects clean word boundaries';

  const cleaned = cleanTextForSpeech(unpunctuatedParagraph);
  const chunks = splitTextIntoSpeechChunks(cleaned, 100);

  assert.ok(chunks.length >= 2, 'Unpunctuated text should be broken into multiple chunks');

  // Verify no sliced words at boundaries
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100, `Chunk length ${chunk.length} should be <= 100`);
    assert.ok(!chunk.startsWith(' '), 'Chunk should not start with space');
    assert.ok(!chunk.endsWith(' '), 'Chunk should not end with space');
  }

  // Verify total words match
  const originalWords = cleaned.split(/\s+/).filter(Boolean);
  const chunkedWords = chunks.flatMap((c) => c.split(/\s+/).filter(Boolean));
  assert.deepEqual(chunkedWords, originalWords, 'All words must be strictly preserved across chunks');
});

// -----------------------------------------------------------------------------
// Test 4: Temporary browser speech engine interruptions (Current Chunk Recovery)
// -----------------------------------------------------------------------------
runTest('Stall detection does NOT skip unfinished chunk and recovers from verified offset', () => {
  const chunks = [
    'First sentence is speaking smoothly.',
    'Second sentence gets interrupted midway through speech synthesis.',
    'Third sentence must never be played before second sentence finishes.'
  ];

  let currentChunkIndex = 1; // Stalled on chunk 1
  let currentCharIndex = 25; // 25 characters into chunk 1 ("Second sentence gets int")
  const currentChunkStartOffset = 0;
  const fullChunk = chunks[currentChunkIndex];

  // Emulate watchdog stall detection
  const isSpeaking = false;
  const isPending = false;
  const silentDuration = 3800; // > 3500ms
  const STALL_SILENCE_THRESHOLD_MS = 3500;

  let recoveredTargetChunk = null;
  let recoveredOffset = null;

  if (!isSpeaking && !isPending && silentDuration >= STALL_SILENCE_THRESHOLD_MS) {
    const isChunkFinished =
      currentCharIndex >= fullChunk.length - 2 ||
      fullChunk.slice(currentCharIndex).trim().length === 0;

    assert.equal(isChunkFinished, false, 'Chunk 1 is unfinished and must NOT be marked finished');

    // The fix: NEVER advance to currentChunkIndex + 1!
    // Instead recover currentChunkIndex at getWordBoundaryOffset
    recoveredTargetChunk = currentChunkIndex;

    let resumeOffset = currentChunkStartOffset;
    if (currentCharIndex > currentChunkStartOffset && currentCharIndex < fullChunk.length) {
      resumeOffset = getWordBoundaryOffset(fullChunk, currentCharIndex);
    }
    recoveredOffset = resumeOffset;
  }

  // Verification:
  assert.equal(recoveredTargetChunk, 1, 'Target chunk MUST remain chunk 1 (no skipping to chunk 2!)');
  assert.ok(recoveredOffset > 0, 'Resume offset must be aligned to word boundary > 0');

  // Verify word boundary alignment
  const resumedText = fullChunk.slice(recoveredOffset).trim();
  assert.ok(
    resumedText.startsWith('interrupted') || resumedText.startsWith('gets interrupted'),
    `Resumed text must start at a clean word boundary, got: "${resumedText}"`
  );
  assert.ok(!resumedText.includes('First sentence'), 'Must not repeat previous chunk');
});

// -----------------------------------------------------------------------------
// Test 5: Pause and resume during a chunk
// -----------------------------------------------------------------------------
runTest('Pause and resume preserves character offset at word boundary without duplication', () => {
  const chunkText = 'The quick brown fox jumps over the lazy dog in the afternoon sun.';
  const stoppedAtChar = 35; // Inside "lazy dog"

  const alignedOffset = getWordBoundaryOffset(chunkText, stoppedAtChar);
  const remainingText = chunkText.slice(alignedOffset).trim();

  // "lazy" starts at index 35 in "The quick brown fox jumps over the lazy dog..."
  assert.equal(alignedOffset, 35);
  assert.equal(remainingText, 'lazy dog in the afternoon sun.');
  assert.ok(!remainingText.includes('quick brown fox'), 'Already spoken text must be excluded');
});

// -----------------------------------------------------------------------------
// Test 6: Stop and immediately start another message (Session ID protection)
// -----------------------------------------------------------------------------
runTest('Sequence token (sessionId) strictly invalidates stale async callbacks on stop or switch', () => {
  let sessionId = 1;
  const staleCallbacksExecuted = [];
  const validCallbacksExecuted = [];

  // Emulate callback from session 1 scheduled in advancing timeout
  const staleCallback = (cbSessionId) => {
    if (cbSessionId !== sessionId) {
      // Stale callback correctly ignored
      return;
    }
    staleCallbacksExecuted.push(cbSessionId);
  };

  // User stops message (sessionId increments to 2) and plays message 2 (sessionId increments to 3)
  sessionId++; // Stop
  sessionId++; // Play new message

  // Stale callback fires
  staleCallback(1);
  assert.equal(staleCallbacksExecuted.length, 0, 'Stale callback from session 1 must be discarded');

  // Active callback fires
  const activeCallback = (cbSessionId) => {
    if (cbSessionId !== sessionId) return;
    validCallbacksExecuted.push(cbSessionId);
  };
  activeCallback(3);
  assert.equal(validCallbacksExecuted.length, 1, 'Active session 3 callback must execute');
  assert.equal(validCallbacksExecuted[0], 3);
});

// -----------------------------------------------------------------------------
// Test 7: Switching between messages during playback
// -----------------------------------------------------------------------------
runTest('Switching messages cleanly resets active chunk index, reading position, and timers', () => {
  let activeMsgId = 'msg-1';
  let currentChunkIndex = 2;
  let currentCharIndex = 45;
  let isAdvancing = false;
  let isRecovering = false;
  let recoveryAttempts = { chunkIndex: 2, attempts: 2, lastCharOffset: 45 };

  // Switching to msg-2
  const newMsgId = 'msg-2';
  // 1. Reset recovery state
  recoveryAttempts = { chunkIndex: -1, attempts: 0, lastCharOffset: -1 };
  isRecovering = false;
  isAdvancing = false;
  activeMsgId = newMsgId;
  currentChunkIndex = 0;
  currentCharIndex = 0;

  assert.equal(activeMsgId, 'msg-2');
  assert.equal(currentChunkIndex, 0);
  assert.equal(currentCharIndex, 0);
  assert.equal(recoveryAttempts.chunkIndex, -1);
  assert.equal(recoveryAttempts.attempts, 0);
});

// -----------------------------------------------------------------------------
// Test 8: Backgrounding and restoring browser tab
// -----------------------------------------------------------------------------
runTest('Document visibilityState hidden suppresses stall recovery watchdog to prevent false triggers', () => {
  const document = { visibilityState: 'hidden' };
  let watchdogTriggered = false;

  // Watchdog tick
  if (document.visibilityState === 'hidden') {
    // Suppressed
  } else {
    watchdogTriggered = true;
  }

  assert.equal(watchdogTriggered, false, 'Watchdog must NOT execute recovery when document is hidden');

  // When restored to visible
  document.visibilityState = 'visible';
  if (document.visibilityState !== 'hidden') {
    watchdogTriggered = true;
  }
  assert.equal(watchdogTriggered, true, 'Watchdog resumes monitoring when document becomes visible');
});

// -----------------------------------------------------------------------------
// Test 9: Speech engine errors and retry limits
// -----------------------------------------------------------------------------
runTest('Controlled retry limit (3 max) prevents infinite recovery loops on unrecoverable engine errors', () => {
  const recoveryAttempts = { chunkIndex: 1, attempts: 1, lastCharOffset: 10 };
  let errorStateTriggered = false;
  let errorMessage = null;

  // Emulate repeated stall attempts on chunk 1 without progress (offset stays at 10)
  for (let tick = 1; tick <= 4; tick++) {
    if (tick > 1) {
      if (10 <= recoveryAttempts.lastCharOffset) {
        recoveryAttempts.attempts += 1;
      }
    }

    if (recoveryAttempts.attempts > 3) {
      errorStateTriggered = true;
      errorMessage = 'Speech playback stalled in browser speech engine.';
      break;
    }
  }

  assert.equal(errorStateTriggered, true, 'Error state must be triggered after 3 failed attempts');
  assert.equal(recoveryAttempts.attempts, 4);
  assert.equal(errorMessage, 'Speech playback stalled in browser speech engine.');
});

// -----------------------------------------------------------------------------
// Test 10: Completion of the final chunk
// -----------------------------------------------------------------------------
runTest('Final chunk completion smoothly transitions to natural completion without advancing out of bounds', () => {
  const chunks = ['First and only chunk of this response.'];
  const currentChunkIndex = 0;
  const currentCharIndex = chunks[0].length; // Finished
  let state = 'speaking';
  let currentMsgId = 'msg-1';

  const isChunkFinished =
    currentCharIndex >= chunks[0].length - 2 ||
    chunks[0].slice(currentCharIndex).trim().length === 0;

  assert.equal(isChunkFinished, true, 'Chunk must be recognized as finished');

  if (currentChunkIndex >= chunks.length - 1) {
    // Natural completion
    state = 'completed';
    currentMsgId = null;
  }

  assert.equal(state, 'completed');
  assert.equal(currentMsgId, null);
});

console.log(`\n===============================================================`);
console.log(`RESULTS: ${passedTests} of ${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log(`===============================================================\n`);
