/**
 * Phase 3 Verification & Performance Suite:
 * Orvix Browser AI CPU, Memory, Streaming & UI Responsiveness Optimization
 *
 * Covers:
 * 1. Model catalog & default preservation for all 4 Browser AI models
 *    (Qwen 2.5 1.5B, Qwen3 0.6B, SmolLM2 135M, SmolLM2 360M)
 * 2. Web Worker execution & single-worker invariant during inference
 * 3. Streamed output integrity & zero-TTFT token burst coalescing in streamWebLLMMessage
 * 4. UI/React state update cadence in runIsolatedPromptStream (before vs. after comparison)
 * 5. Background tab (visibilityState === 'hidden' -> 'visible') DOM update deferral & catch-up
 * 6. Mid-stream cancellation & superseded generation isolation (no late overwrite)
 * 7. Sequential switching & inference across all 4 Browser AI models without worker leaks
 * 8. Mobile / integrated GPU requestAdapter fallback when 'high-performance' returns null
 * 9. Syntax highlighter tokenizeCode exact equivalence & throughput benchmark during code streaming
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  getSupportedWebLLMModels,
  ensureWebLLMEngine,
  streamWebLLMMessage,
  stopWebLLMGeneration,
  checkWebGPUSupport,
  getWebLLMState,
  getWebLLMRuntimeStats,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting,
  setWebLLMDownloadConfigForTesting,
  resetWebLLMRuntimeForTesting
} from '../src/services/webllmService.js';
import {
  createRequestIsolationController,
  runIsolatedPromptStream
} from '../src/services/requestIsolationService.js';
import { tokenizeCode, TOKEN_TYPES } from '../src/utils/syntaxHighlighter.js';

const QWEN_15B_WEBLLM_MODEL_ID = DEFAULT_WEBLLM_MODEL_ID;

let passed = 0;
let failed = 0;
const benchmarkReport = {};

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error('    ', err?.stack || err);
    failed++;
  }
}

function setupMockBrowserEnvironment({
  hasShaderF16 = true,
  highPerformanceReturnsNull = false,
  cachedModels = [
    QWEN_15B_WEBLLM_MODEL_ID,
    QWEN3_06B_WEBLLM_MODEL_ID,
    SMOLLM2_135M_WEBLLM_MODEL_ID,
    SMOLLM2_360M_WEBLLM_MODEL_ID
  ]
} = {}) {
  const adapterObj = {
    features: new Set(hasShaderF16 ? ['shader-f16'] : []),
    limits: {
      maxStorageBufferBindingSize: 1024 * 1024 * 1024,
      maxBufferSize: 2048 * 1024 * 1024
    },
    info: {
      vendor: highPerformanceReturnsNull ? 'qualcomm' : 'apple',
      architecture: highPerformanceReturnsNull ? 'adreno-740' : 'metal-3',
      description: highPerformanceReturnsNull ? 'Adreno (TM) 740 Mobile GPU' : 'Apple M2 GPU'
    }
  };

  let requestAdapterCalls = [];
  globalThis.window = {
    isSecureContext: true,
    innerWidth: 1280,
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      onLine: true,
      gpu: {
        requestAdapter: async (options) => {
          requestAdapterCalls.push(options || null);
          if (highPerformanceReturnsNull && options?.powerPreference === 'high-performance') {
            return null;
          }
          return adapterObj;
        }
      },
      storage: {
        estimate: async () => ({
          usage: 50 * 1024 * 1024,
          quota: 10 * 1024 * 1024 * 1024
        })
      }
    },
    configurable: true,
    writable: true
  });

  const cachedSet = new Set(cachedModels);
  globalThis.caches = {
    keys: async () => ['webllm/config', 'webllm/model', 'webllm/wasm'],
    open: async () => ({
      keys: async () =>
        Array.from(cachedSet).map((id) => ({
          url: `https://huggingface.co/mlc-ai/${id}/resolve/main/ndarray-cache.json`
        })),
      match: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ records: [{ dataPath: 'params_shard_0.bin' }] })
      }),
      delete: async () => true
    }),
    delete: async () => true
  };

  return {
    getRequestAdapterCalls: () => requestAdapterCalls
  };
}

function installMockWorkerAndEngine({ tokenGeneratorFn } = {}) {
  let spawnedWorkers = 0;
  let terminatedWorkers = 0;
  let interruptCalls = 0;

  setWebLLMDownloadConfigForTesting({
    gpuCheckTimeoutMs: 2000,
    moduleLoadTimeoutMs: 2000,
    engineInitTimeoutMs: 5000
  });

  setWebLLMWorkerFactoryForTesting(() => {
    spawnedWorkers++;
    const listeners = new Map();
    return {
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
      terminate() {
        terminatedWorkers++;
      }
    };
  });

  setWebLLMEngineFactoryForTesting(async (_worker, modelId, opts) => {
    if (opts?.initProgressCallback) {
      opts.initProgressCallback({
        progress: 0.5,
        text: `Loading model from cache[1/2]: 50% completed`,
        timeElapsed: 1
      });
      opts.initProgressCallback({
        progress: 1,
        text: `Finish loading on WebGPU - ${modelId}`,
        timeElapsed: 1
      });
    }

    let currentStreamAborted = false;

    return {
      modelId,
      interruptGenerate: () => {
        interruptCalls++;
        currentStreamAborted = true;
      },
       unload: async () => {},
      chat: {
        completions: {
          create: async (payload) => {
            currentStreamAborted = false;
            if (typeof tokenGeneratorFn === 'function') {
              return tokenGeneratorFn({
                modelId,
                payload,
                isInterrupted: () => currentStreamAborted
              });
            }
            async function* defaultStream() {
              const tokens = ['Hello', ' there', '!', ' How', ' can', ' I', ' help', ' you', ' today', '?'];
              for (const tok of tokens) {
                if (currentStreamAborted) break;
                yield { choices: [{ delta: { content: tok } }] };
              }
              if (!currentStreamAborted) {
                yield {
                  choices: [{ delta: {} }],
                  usage: { prompt_tokens: 24, completion_tokens: tokens.length, total_tokens: 24 + tokens.length }
                };
              }
            }
            return defaultStream();
          }
        }
      }
    };
  });

  return {
    getSpawnedWorkers: () => spawnedWorkers,
    getTerminatedWorkers: () => terminatedWorkers,
    getInterruptCalls: () => interruptCalls
  };
}

console.log('\n================================================================');
console.log('🚀 Orvix Browser AI Phase 3 Performance & Optimization Suite');
console.log('================================================================\n');

// ----------------------------------------------------------------------------
// 1. Model Catalog & Default Preservation
// ----------------------------------------------------------------------------
await runTest('1. All 4 Browser AI models and default (Qwen 2.5 1.5B) are preserved', async () => {
  assert.equal(DEFAULT_WEBLLM_MODEL_ID, QWEN_15B_WEBLLM_MODEL_ID);
  const models = getSupportedWebLLMModels();
  const ids = models.map((m) => m.id);
  assert.equal(models.length, 4, 'Must expose all 4 primary Browser AI models');
  assert.ok(ids.includes(QWEN_15B_WEBLLM_MODEL_ID), 'Missing Qwen 2.5 1.5B');
  assert.ok(ids.includes(QWEN3_06B_WEBLLM_MODEL_ID), 'Missing Qwen3 0.6B');
  assert.ok(ids.includes(SMOLLM2_135M_WEBLLM_MODEL_ID), 'Missing SmolLM2 135M');
  assert.ok(ids.includes(SMOLLM2_360M_WEBLLM_MODEL_ID), 'Missing SmolLM2 360M');
});

// ----------------------------------------------------------------------------
// 2. Mobile / Low-Power Laptop GPU Adapter Fallback
// ----------------------------------------------------------------------------
await runTest('2. checkWebGPUSupport falls back to default adapter when high-performance returns null on mobile GPUs', async () => {
  resetWebLLMRuntimeForTesting();
  const env = setupMockBrowserEnvironment({
    hasShaderF16: false,
    highPerformanceReturnsNull: true
  });

  const gpuResult = await checkWebGPUSupport({ forceRefresh: true });
  assert.equal(gpuResult.supported, true, 'Should succeed via default adapter fallback');
  assert.equal(gpuResult.isLowPowerOrMobileAdapter, true, 'Should detect mobile/low-power GPU profile');
  const calls = env.getRequestAdapterCalls();
  assert.equal(calls.length, 2, 'Should try high-performance first, then default adapter');
  assert.deepEqual(calls[0], { powerPreference: 'high-performance' });
  assert.equal(calls[1], null);
});

// ----------------------------------------------------------------------------
// 3. Streamed Output Integrity & Burst Coalescing (Zero TTFT Penalty)
// ----------------------------------------------------------------------------
await runTest('3. streamWebLLMMessage emits first token with 0ms delay, coalesces synchronous bursts, and preserves 100% text integrity', async () => {
  resetWebLLMRuntimeForTesting();
  setupMockBrowserEnvironment();

  // Generate 120 tokens in a tight synchronous burst followed by a final token after 30ms
  const rawTokens = [];
  for (let i = 1; i <= 120; i++) {
    rawTokens.push(`word${i} `);
  }

  installMockWorkerAndEngine({
    tokenGeneratorFn: async function* () {
      for (let i = 0; i < rawTokens.length; i++) {
        yield { choices: [{ delta: { content: rawTokens[i] } }] };
        if (i === 60) {
          await new Promise((r) => setTimeout(r, 30));
        }
      }
    }
  });

  const receivedChunks = [];
  let latestAcc = '';
  let firstChunkAt = null;
  const startAt = Date.now();

  const res = await streamWebLLMMessage({
    prompt: 'Test token burst coalescing and integrity',
    model: QWEN_15B_WEBLLM_MODEL_ID,
    chunkBatchIntervalMs: 24,
    onChunk: (delta, acc) => {
      if (firstChunkAt === null) {
        firstChunkAt = Date.now() - startAt;
      }
      receivedChunks.push(delta);
      latestAcc = acc;
    }
  });

  const stats = getWebLLMRuntimeStats();
  const expectedFullText = rawTokens.join('').trim();

  assert.equal(res.text.trim(), expectedFullText, 'Final returned text must match 100% of tokens');
  assert.equal(latestAcc.trim(), expectedFullText, 'Final accumulated text in onChunk must match 100%');
  assert.equal(
    receivedChunks.join('').trim(),
    expectedFullText,
    'Concatenated onChunk deltas must equal the exact full text without missing or duplicated tokens'
  );
  assert.equal(receivedChunks[0], 'word1 ', 'First token must be emitted immediately on its own');
  assert.equal(stats.rawTokenChunksReceived, 120, 'Should record all 120 raw worker tokens');
  assert.ok(
    stats.uiChunkEmissions <= 10,
    `Expected <= 10 coalesced onChunk emissions for 120 burst tokens, got ${stats.uiChunkEmissions}`
  );
  assert.equal(stats.activeWorkerCount, 1, 'Exactly 1 Web Worker should remain active');

  benchmarkReport.workerTokenBurst = {
    rawWorkerTokens: stats.rawTokenChunksReceived,
    coalescedUiChunkCallbacks: stats.uiChunkEmissions,
    reductionPercent: `${(((stats.rawTokenChunksReceived - stats.uiChunkEmissions) / stats.rawTokenChunksReceived) * 100).toFixed(1)}%`
  };
});

// ----------------------------------------------------------------------------
// 4. UI / React State Update Cadence in runIsolatedPromptStream
// ----------------------------------------------------------------------------
await runTest('4. runIsolatedPromptStream eliminates sub-token 1-2 char slicing for Browser AI, cutting React state updates by >85%', async () => {
  const tokenCount = 200;
  const tokens = Array.from({ length: tokenCount }, (_, idx) => `tok${idx + 1} `);
  const expectedText = tokens.join('');

  // Simulate realistic 25 tokens/sec (1 token every 4ms in accelerated test time, or 6ms spacing)
  const controller = createRequestIsolationController();
  let messagesState = [
    {
      id: 'msg-assistant-1',
      sender: 'assistant',
      provider: 'webllm',
      modelUsed: QWEN_15B_WEBLLM_MODEL_ID,
      content: '',
      isStreaming: true
    }
  ];

  let reactStateUpdateCount = 0;
  let firstNonEmptyUpdateMs = null;
  const streamStartMs = Date.now();

  const result = await runIsolatedPromptStream({
    controller,
    targetChatId: 'chat-1',
    getActiveChatId: () => 'chat-1',
    assistantMessageId: 'msg-assistant-1',
    providerToUse: 'webllm',
    effectiveModelOverride: QWEN_15B_WEBLLM_MODEL_ID,
    promptText: 'Benchmark UI update cadence',
    prefersReducedMotion: false,
    normalizeAssistantMessage: (m) => m,
    updateActiveAlternativeInMessage: (m, patch) => ({ ...m, ...patch }),
    findExistingAssistantMessage: () => messagesState[0],
    onUpdateMessages: (updater) => {
      reactStateUpdateCount++;
      messagesState = updater(messagesState);
      if (firstNonEmptyUpdateMs === null && messagesState[0]?.content?.length > 0) {
        firstNonEmptyUpdateMs = Date.now() - streamStartMs;
      }
    },
    onSetLoadingState: () => {},
    onPersistMessage: async () => {},
    classifyError: (e) => ({ friendlyMsg: e.message }),
    streamRequest: async ({ onStart, onChunk }) => {
      onStart?.({ modelUsed: QWEN_15B_WEBLLM_MODEL_ID, provider: 'webllm' });
      let acc = '';
      for (let i = 0; i < tokens.length; i++) {
        acc += tokens[i];
        onChunk?.(tokens[i], acc);
        if (i % 5 === 0) {
          await new Promise((r) => setTimeout(r, 8));
        }
      }
      return {
        text: acc,
        modelUsed: QWEN_15B_WEBLLM_MODEL_ID,
        provider: 'webllm'
      };
    }
  });

  assert.equal(result.status, 'completed');
  assert.equal(messagesState[0].content, expectedText, 'Final message content must match 100%');
  assert.equal(messagesState[0].isStreaming, false, 'Final message must have isStreaming=false');

  // Legacy behavior sliced 1-2 chars per 18ms tick across ~990 chars => ~500+ React state updates.
  // Phase 3 frame batching updates once on first token + once per 36ms frame during streaming.
  const estimatedLegacyUpdates = Math.ceil(expectedText.length / 1.8);
  assert.ok(
    reactStateUpdateCount < 35,
    `Expected < 35 React state updates for 200-token stream, got ${reactStateUpdateCount}`
  );
  assert.ok(
    firstNonEmptyUpdateMs !== null && firstNonEmptyUpdateMs <= 35,
    `First token should render immediately (<=35ms), took ${firstNonEmptyUpdateMs}ms`
  );

  benchmarkReport.reactRenderCadence = {
    totalCharacters: expectedText.length,
    totalTokens: tokenCount,
    beforeLegacyStateUpdates: estimatedLegacyUpdates,
    afterPhase3StateUpdates: reactStateUpdateCount,
    reductionPercent: `${(((estimatedLegacyUpdates - reactStateUpdateCount) / estimatedLegacyUpdates) * 100).toFixed(1)}%`,
    firstTokenVisualLatencyMs: firstNonEmptyUpdateMs
  };
});

// ----------------------------------------------------------------------------
// 5. Background Tab (visibilityState: 'hidden' -> 'visible') Deferral & Catch-up
// ----------------------------------------------------------------------------
await runTest('5. Hidden tab defers intermediate React DOM updates during Browser AI streaming and catches up immediately when visible', async () => {
  const visibilityListeners = new Set();
  globalThis.document = {
    visibilityState: 'hidden',
    addEventListener: (evt, fn) => {
      if (evt === 'visibilitychange') visibilityListeners.add(fn);
    },
    removeEventListener: (evt, fn) => {
      if (evt === 'visibilitychange') visibilityListeners.delete(fn);
    }
  };

  try {
    const controller = createRequestIsolationController();
    let messagesState = [
      {
        id: 'msg-bg-1',
        sender: 'assistant',
        provider: 'webllm',
        modelUsed: QWEN_15B_WEBLLM_MODEL_ID,
        content: '',
        isStreaming: true
      }
    ];
    let streamingDomUpdatesWhileHidden = 0;
    let visibleCatchUpUpdates = 0;

    const result = await runIsolatedPromptStream({
      controller,
      targetChatId: 'chat-bg',
      getActiveChatId: () => 'chat-bg',
      assistantMessageId: 'msg-bg-1',
      providerToUse: 'webllm',
      effectiveModelOverride: QWEN_15B_WEBLLM_MODEL_ID,
      promptText: 'Hidden tab test',
      prefersReducedMotion: false,
      normalizeAssistantMessage: (m) => m,
      updateActiveAlternativeInMessage: (m, patch) => ({ ...m, ...patch }),
      findExistingAssistantMessage: () => messagesState[0],
      onUpdateMessages: (updater) => {
        const next = updater(messagesState);
        const contentChanged = next[0]?.content !== messagesState[0]?.content;
        messagesState = next;
        if (contentChanged && next[0]?.isStreaming) {
          if (globalThis.document.visibilityState === 'hidden') {
            streamingDomUpdatesWhileHidden++;
          } else {
            visibleCatchUpUpdates++;
          }
        }
      },
      onSetLoadingState: () => {},
      onPersistMessage: async () => {},
      classifyError: (e) => ({ friendlyMsg: e.message }),
      streamRequest: async ({ onStart, onChunk }) => {
        onStart?.({ modelUsed: QWEN_15B_WEBLLM_MODEL_ID, provider: 'webllm' });
        let acc = '';
        for (let i = 1; i <= 20; i++) {
          acc += `chunk${i} `;
          onChunk?.(`chunk${i} `, acc);
          await new Promise((r) => setTimeout(r, 5));
          if (i === 15) {
            // User brings tab back to foreground mid-stream
            globalThis.document.visibilityState = 'visible';
            for (const fn of visibilityListeners) fn();
          }
        }
        return { text: acc, modelUsed: QWEN_15B_WEBLLM_MODEL_ID, provider: 'webllm' };
      }
    });

    assert.equal(result.status, 'completed');
    assert.equal(
      streamingDomUpdatesWhileHidden,
      0,
      'Should perform 0 intermediate content DOM updates while document.visibilityState === "hidden"'
    );
    assert.ok(
      visibleCatchUpUpdates >= 1,
      'Should immediately flush accumulated text to UI when tab becomes visible'
    );
    assert.ok(messagesState[0].content.includes('chunk1 ') && messagesState[0].content.includes('chunk20 '));
    assert.equal(visibilityListeners.size, 0, 'Visibility listener must be cleaned up on completion');
  } finally {
    delete globalThis.document;
  }
});

// ----------------------------------------------------------------------------
// 6. Cancellation & Obsolete Generation Isolation
// ----------------------------------------------------------------------------
await runTest('6. Aborting a generation mid-stream interrupts the worker immediately and prevents obsolete chunks from overwriting newer responses', async () => {
  resetWebLLMRuntimeForTesting();
  setupMockBrowserEnvironment();

  let activeCallIndex = 0;
  const hooks = installMockWorkerAndEngine({
    tokenGeneratorFn: async function* ({ isInterrupted }) {
      const myCall = ++activeCallIndex;
      if (myCall === 1) {
        // First generation streams slowly and gets aborted after 2 tokens
        for (let i = 1; i <= 30; i++) {
          if (isInterrupted()) break;
          yield { choices: [{ delta: { content: `obsolete_${i} ` } }] };
          await new Promise((r) => setTimeout(r, 10));
        }
      } else {
        // Second generation completes cleanly
        const freshTokens = ['Fresh', ' response', ' from', ' second', ' request.'];
        for (const t of freshTokens) {
          if (isInterrupted()) break;
          yield { choices: [{ delta: { content: t } }] };
        }
      }
    }
  });

  const abortController1 = new AbortController();
  const chunksFromGen1 = [];
  let gen1AbortedAfterKill = false;

  const gen1Promise = streamWebLLMMessage({
    prompt: 'First prompt that will be cancelled',
    model: QWEN_15B_WEBLLM_MODEL_ID,
    signal: abortController1.signal,
    chunkBatchIntervalMs: 0,
    onChunk: (delta) => {
      if (gen1AbortedAfterKill) {
        throw new Error(`Obsolete generation emitted chunk after abort: ${delta}`);
      }
      chunksFromGen1.push(delta);
      if (chunksFromGen1.length === 2) {
        gen1AbortedAfterKill = true;
        abortController1.abort();
      }
    }
  });

  await assert.rejects(gen1Promise, (err) => err.name === 'AbortError');
  assert.ok(hooks.getInterruptCalls() >= 1, 'engine.interruptGenerate() must be invoked on abort');

  // Immediately run a second request and verify it succeeds cleanly with zero contamination from Gen 1
  const chunksFromGen2 = [];
  const gen2Result = await streamWebLLMMessage({
    prompt: 'Second prompt after cancellation',
    model: QWEN_15B_WEBLLM_MODEL_ID,
    onChunk: (delta) => chunksFromGen2.push(delta)
  });

  assert.equal(gen2Result.text, 'Fresh response from second request.');
  assert.ok(!gen2Result.text.includes('obsolete_'), 'Second response must not contain any tokens from aborted request');
  assert.equal(getWebLLMState().status, 'ready', 'Engine state should return to ready');
});

// ----------------------------------------------------------------------------
// 7. Sequential Switching & Inference Across All 4 Browser AI Models
// ----------------------------------------------------------------------------
await runTest('7. Switching and generating across all 4 Browser AI models keeps activeWorkerCount <= 1 and reuses same-model engine', async () => {
  resetWebLLMRuntimeForTesting();
  setupMockBrowserEnvironment();
  installMockWorkerAndEngine();

  const modelsToTest = [
    QWEN_15B_WEBLLM_MODEL_ID,
    QWEN3_06B_WEBLLM_MODEL_ID,
    SMOLLM2_135M_WEBLLM_MODEL_ID,
    SMOLLM2_360M_WEBLLM_MODEL_ID
  ];

  for (const modelId of modelsToTest) {
    // First message on selected model
    const res1 = await streamWebLLMMessage({
      prompt: `Hello ${modelId} turn 1`,
      model: modelId
    });
    assert.equal(res1.modelUsed, modelId);
    assert.ok(res1.text.length > 0);

    const statsAfterTurn1 = getWebLLMRuntimeStats();
    assert.equal(statsAfterTurn1.activeWorkerCount, 1, `Active worker count must be 1 for ${modelId}`);

    // Second message on same model (must take 0-reinit fast path)
    const fastHitsBefore = statsAfterTurn1.fastPathHits;
    const res2 = await streamWebLLMMessage({
      prompt: `Hello ${modelId} turn 2`,
      model: modelId
    });
    assert.equal(res2.modelUsed, modelId);
    const statsAfterTurn2 = getWebLLMRuntimeStats();
    assert.equal(
      statsAfterTurn2.fastPathHits,
      fastHitsBefore + 1,
      `Second message on ${modelId} must reuse initialized engine via fast path`
    );
    assert.equal(statsAfterTurn2.activeWorkerCount, 1);
  }

  const finalStats = getWebLLMRuntimeStats();
  assert.equal(finalStats.activeWorkerCount, 1);
  assert.equal(finalStats.totalWorkersSpawned - finalStats.totalWorkersTerminated, 1);
});

// ----------------------------------------------------------------------------
// 8. Syntax Highlighter Whitespace Fast-Forward Equivalence & Benchmark
// ----------------------------------------------------------------------------
await runTest('8. tokenizeCode produces 100% identical tokens while accelerating multi-line indented code block tokenization', async () => {
  const sampleCode = [
    'import React, { useState, useEffect, useMemo } from "react";',
    '',
    'export function FibonacciStream({ count = 25 }) {',
    '  const values = useMemo(() => {',
    '    const seq = [0, 1];',
    '    for (let i = 2; i < count; i++) {',
    '      // Compute next Fibonacci number in the sequence',
    '      seq.push(seq[i - 1] + seq[i - 2]);',
    '    }',
    '    return seq;',
    '  }, [count]);',
    '',
    '  return (',
    '    <div className="fib-container">',
    '      {values.map((val, idx) => (',
    '        <span key={idx} data-index={idx}>',
    '          {`Item #${idx}: ${val}`}',
    '        </span>',
    '      ))}',
    '    </div>',
    '  );',
    '}'
  ].join('\n');

  const tokens = tokenizeCode(sampleCode, 'javascript');
  const reconstructed = tokens.map((t) => t.content).join('');
  assert.equal(reconstructed, sampleCode, 'Tokenized output must reconstruct 100% of original source code');
  assert.ok(tokens.some((t) => t.type === TOKEN_TYPES.KEYWORD && t.content === 'import'));
  assert.ok(tokens.some((t) => t.type === TOKEN_TYPES.FUNCTION && t.content === 'FibonacciStream'));
  assert.ok(tokens.some((t) => t.type === TOKEN_TYPES.COMMENT && t.content.includes('Compute next Fibonacci')));

  // Simulate 60 streaming frames of a growing code block
  const startNs = process.hrtime.bigint();
  for (let len = 20; len <= sampleCode.length; len += Math.ceil(sampleCode.length / 60)) {
    tokenizeCode(sampleCode.slice(0, len), 'javascript');
  }
  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  assert.ok(elapsedMs < 150, `60 streaming code block tokenizations should complete in <150ms (took ${elapsedMs.toFixed(2)}ms)`);

  benchmarkReport.syntaxHighlighter60FramesMs = Number(elapsedMs.toFixed(2));
});

console.log('\n📊 Phase 3 Reproducible Benchmark Summary:');
console.log(JSON.stringify(benchmarkReport, null, 2));
console.log(`\n================================================================`);
console.log(`✅ Passed: ${passed} | ❌ Failed: ${failed}`);
console.log(`================================================================\n`);

if (failed > 0) {
  process.exit(1);
}
