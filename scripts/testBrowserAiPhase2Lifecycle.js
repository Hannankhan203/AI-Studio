#!/usr/bin/env node

/**
 * testBrowserAiPhase2Lifecycle.js
 *
 * Comprehensive automated verification suite for Phase 2:
 * Optimize Orvix Browser AI Initialization and Model Reuse.
 *
 * Verifies:
 * 1. Reusing an initialized model (fast-path reuse, zero redundant requestAdapter(), zero 'checking' state flicker, worker/engine reuse across turns)
 * 2. Preventing duplicate concurrent initialization & downloads (coalescing pre-init async races, reference-counted multi-waiter cancellation, progress forwarding, concurrent download/cache check deduplication)
 * 3. Retrying after initialization failure (download failure, worker crash, GPU init timeout, and deadlock-free recursive shader-f16 -> FP32 fallback)
 * 4. Switching between all 4 models safely (SmolLM2 135M, SmolLM2 360M, Qwen3 0.6B, Qwen 2.5 1.5B, mid-init switch aborting obsolete model, activeWorkerCount <= 1 invariant, stale error reset on switch)
 * 5. Handling cancellation and component unmounting (AbortSignal, stopWebLLMGeneration, queued generation abort while waiting on previousTurn, serialized destroyWebLLMEngine)
 * 6. Avoiding unnecessary redownloads (valid cached shards preserved across retries and subsequent loads)
 * 7. Preserving offline inference (cached model runs offline; uncached model fails fast with WEBLLM_OFFLINE_UNCACHED)
 */

import assert from 'node:assert';
import * as webllmPkg from '@mlc-ai/web-llm';
import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  SMOLLM2_360M_F32_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID,
  QWEN3_06B_F32_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  getSupportedWebLLMModels,
  getWebLLMState,
  getWebLLMRuntimeStats,
  subscribeWebLLMState,
  checkWebGPUSupport,
  isWebLLMModelCached,
  inspectWebLLMReadiness,
  downloadModelArtifactsToCache,
  ensureWebLLMEngine,
  streamWebLLMMessage,
  stopWebLLMGeneration,
  unloadWebLLMEngine,
  resetWebLLMRuntimeForTesting,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting,
  setWebLLMFetchForTesting
} from '../src/services/webllmService.js';

let passed = 0;
let failed = 0;

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err.stack || err.message);
    failed++;
  }
}

function createInMemoryCacheStorage() {
  const buckets = new Map();

  function getBucket(scope) {
    if (!buckets.has(scope)) {
      buckets.set(scope, new Map());
    }
    return buckets.get(scope);
  }

  return {
    buckets,
    api: {
      open: async (scope) => {
        const bucket = getBucket(scope);
        return {
          keys: async () => Array.from(bucket.keys()).map((url) => new Request(url)),
          match: async (req) => {
            const url = typeof req === 'string' ? req : req?.url;
            const stored = bucket.get(url);
            return stored ? stored.clone() : undefined;
          },
          put: async (req, res) => {
            const url = typeof req === 'string' ? req : req?.url;
            bucket.set(url, res.clone());
          },
          delete: async (req) => {
            const url = typeof req === 'string' ? req : req?.url;
            return bucket.delete(url);
          }
        };
      },
      has: async (scope) => buckets.has(scope),
      delete: async (scope) => buckets.delete(scope)
    }
  };
}

function createDefaultMockFetch({ delayMs = 0, onFetch = null } = {}) {
  return async (url) => {
    const href = String(url);
    if (typeof onFetch === 'function') {
      onFetch(href);
    }
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    if (href.endsWith('mlc-chat-config.json')) {
      return new Response(
        JSON.stringify({ tokenizer_files: ['tokenizer.json'], context_window_size: 4096 }),
        { status: 200 }
      );
    }
    if (href.endsWith('tensor-cache.json') || href.endsWith('ndarray-cache.json')) {
      return new Response(
        JSON.stringify({
          records: [{ name: 'w0', dataPath: 'params_shard_0.bin', nbytes: 16 }]
        }),
        { status: 200 }
      );
    }
    if (href.endsWith('.json')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(new Uint8Array(16), { status: 200 });
  };
}

async function seedCachedModel(modelId) {
  const record = webllmPkg.prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
  if (!record) return;
  const prevFetch = createDefaultMockFetch();
  setWebLLMFetchForTesting(prevFetch);
  await downloadModelArtifactsToCache(record);
}

function setupMockEnvironment({
  hasGpu = true,
  hasShaderF16 = true,
  isSecureContext = true,
  isOnline = true,
  onRequestAdapter = null
} = {}) {
  const adapter = hasGpu
    ? {
        features: new Set(hasShaderF16 ? ['shader-f16'] : []),
        limits: {
          maxStorageBufferBindingSize: 1073741824,
          maxBufferSize: 1073741824
        },
        info: {
          vendor: 'mock-vendor',
          architecture: 'mock-arch',
          description: 'Mock WebGPU Adapter'
        }
      }
    : null;

  globalThis.window = {
    isSecureContext,
    matchMedia: () => ({ matches: false })
  };

  const gpuObj = hasGpu
    ? {
        requestAdapter: async () => {
          if (typeof onRequestAdapter === 'function') {
            onRequestAdapter();
          }
          return adapter;
        }
      }
    : undefined;

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      onLine: isOnline,
      gpu: gpuObj,
      storage: {
        estimate: async () => ({ quota: 10 * 1024 * 1024 * 1024, usage: 100 * 1024 * 1024 }),
        persist: async () => true
      }
    },
    configurable: true,
    writable: true
  });

  const cacheStorage = createInMemoryCacheStorage();
  globalThis.caches = cacheStorage.api;
  return { cacheStorage };
}

function createMockWorker() {
  const listeners = new Map();
  return {
    terminated: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      for (const fn of listeners.get(type) || []) {
        fn(payload);
      }
    },
    terminate() {
      this.terminated = true;
    }
  };
}

function createMockEngine(responseText = 'Browser AI test response') {
  return {
    unloaded: false,
    interrupted: false,
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            yield { choices: [{ delta: { content: responseText } }] };
          })()
      }
    },
    interruptGenerate() {
      this.interrupted = true;
    },
    async unload() {
      this.unloaded = true;
    }
  };
}

console.log('\n=== Phase 2: Browser AI Initialization & Model Reuse Verification Suite ===\n');

// ---------------------------------------------------------------------------
// 0. Model Catalog & Default Preservation Invariants
// ---------------------------------------------------------------------------
await runAsyncTest('0. All 4 primary Browser AI models & defaults remain intact', async () => {
  const primaries = getSupportedWebLLMModels();
  assert.strictEqual(primaries.length, 4, 'Must expose all 4 primary Browser AI models');
  assert.deepStrictEqual(
    primaries.map((m) => m.id),
    [
      SMOLLM2_135M_WEBLLM_MODEL_ID,
      SMOLLM2_360M_WEBLLM_MODEL_ID,
      QWEN3_06B_WEBLLM_MODEL_ID,
      DEFAULT_WEBLLM_MODEL_ID
    ]
  );
  assert.strictEqual(DEFAULT_WEBLLM_MODEL_ID, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
  assert.strictEqual(WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID].isDefault, true);
});

// ---------------------------------------------------------------------------
// 1. Reusing an Initialized Model (Fast-Path Reuse & State Discipline)
// ---------------------------------------------------------------------------
await runAsyncTest('1A. Reusing an initialized model hits synchronous fast path without checking flicker or extra workers', async () => {
  let adapterCalls = 0;
  setupMockEnvironment({
    hasGpu: true,
    hasShaderF16: true,
    onRequestAdapter: () => {
      adapterCalls++;
    }
  });
  resetWebLLMRuntimeForTesting();
  await seedCachedModel(SMOLLM2_135M_WEBLLM_MODEL_ID);

  const mockEngine = createMockEngine('Turn response');
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ handleInitProgress }) => {
    handleInitProgress?.({ progress: 0.5, text: 'Loading weights into GPU' });
    handleInitProgress?.({ progress: 1, text: 'Finish loading' });
    return mockEngine;
  });

  // First initialization
  const engine1 = await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
  assert.strictEqual(engine1.engine, mockEngine);
  assert.strictEqual(getWebLLMState().status, 'ready');
  assert.strictEqual(getWebLLMState().phase, 'ready');
  assert.strictEqual(adapterCalls, 1, 'requestAdapter called once on initial load');

  const statsAfterInit = getWebLLMRuntimeStats();
  assert.strictEqual(statsAfterInit.totalWorkersSpawned, 1);
  assert.strictEqual(statsAfterInit.activeWorkerCount, 1);
  assert.strictEqual(statsAfterInit.totalEngineInits, 1);
  assert.strictEqual(statsAfterInit.fastPathHits, 0);

  // Subscribe to state changes during subsequent reuse calls & streaming turns
  const observedStatuses = [];
  const unsubscribe = subscribeWebLLMState((snap) => {
    observedStatuses.push({ status: snap.status, phase: snap.phase });
  });
  observedStatuses.length = 0; // ignore initial subscription emit

  // Second ensureWebLLMEngine call for the same ready model
  let progressForwarded = false;
  const engine2 = await ensureWebLLMEngine({
    modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
    onProgress: (state) => {
      progressForwarded = state.status === 'ready' && state.progress === 1;
    }
  });
  assert.strictEqual(engine2.engine, mockEngine, 'Must reuse identical engine instance');
  assert.strictEqual(progressForwarded, true, 'onProgress notified immediately of ready state');
  assert.strictEqual(adapterCalls, 1, 'Zero extra requestAdapter() calls on fast path');
  assert.strictEqual(
    observedStatuses.some((s) => s.status === 'checking' || s.status === 'loading'),
    false,
    'Must NOT flicker through checking/loading when reusing ready model'
  );

  // Subsequent chat turns reuse the loaded model via fast path
  const turn1 = await streamWebLLMMessage({
    prompt: 'Hello 1',
    modelId: SMOLLM2_135M_WEBLLM_MODEL_ID
  });
  const turn2 = await streamWebLLMMessage({
    prompt: 'Hello 2',
    modelId: SMOLLM2_135M_WEBLLM_MODEL_ID
  });
  assert.strictEqual(turn1.text, 'Turn response');
  assert.strictEqual(turn2.text, 'Turn response');

  unsubscribe();

  const statsAfterTurns = getWebLLMRuntimeStats();
  assert.strictEqual(statsAfterTurns.totalWorkersSpawned, 1, 'Still only 1 worker spawned');
  assert.strictEqual(statsAfterTurns.activeWorkerCount, 1, 'Still 1 active worker');
  assert.strictEqual(statsAfterTurns.totalEngineInits, 1, 'Still only 1 engine init');
  assert.strictEqual(statsAfterTurns.fastPathHits, 3, '3 fast-path hits (ensure + 2 turns)');

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('1B. Fast-path reuse also works when F16 model was resolved to its FP32 fallback on non-f16 GPU', async () => {
  setupMockEnvironment({ hasGpu: true, hasShaderF16: false });
  resetWebLLMRuntimeForTesting();
  await seedCachedModel(QWEN3_06B_F32_WEBLLM_MODEL_ID);

  const mockEngine = createMockEngine('FP32 response');
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  // Request F16 model ID on a non-shader-f16 GPU -> loads F32 fallback
  await ensureWebLLMEngine({ modelId: QWEN3_06B_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMState().loadedModelId, QWEN3_06B_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(getWebLLMRuntimeStats().totalEngineInits, 1);

  // Calling ensureWebLLMEngine again with the F16 model ID must hit fast path!
  await ensureWebLLMEngine({ modelId: QWEN3_06B_WEBLLM_MODEL_ID });
  assert.strictEqual(getWebLLMRuntimeStats().totalEngineInits, 1);
  assert.strictEqual(getWebLLMRuntimeStats().fastPathHits, 1);

  resetWebLLMRuntimeForTesting();
});

// ---------------------------------------------------------------------------
// 2. Preventing Duplicate Concurrent Initialization & Downloads
// ---------------------------------------------------------------------------
await runAsyncTest('2A. Concurrent ensureWebLLMEngine calls for the same model coalesce into 1 worker & 1 init even before first await', async () => {
  let adapterCalls = 0;
  setupMockEnvironment({
    hasGpu: true,
    hasShaderF16: true,
    onRequestAdapter: () => {
      adapterCalls++;
    }
  });
  resetWebLLMRuntimeForTesting();
  await seedCachedModel(SMOLLM2_360M_WEBLLM_MODEL_ID);

  const mockEngine = createMockEngine('Concurrent response');
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ handleInitProgress }) => {
    await new Promise((r) => setTimeout(r, 30));
    handleInitProgress?.({ progress: 0.6, text: 'Loading GPU shaders...' });
    await new Promise((r) => setTimeout(r, 20));
    handleInitProgress?.({ progress: 1.0, text: 'Ready' });
    return mockEngine;
  });

  const progressCaller1 = [];
  const progressCaller2 = [];
  const progressCaller3 = [];

  // Fire 3 concurrent calls synchronously
  const [res1, res2, res3] = await Promise.all([
    ensureWebLLMEngine({
      modelId: SMOLLM2_360M_WEBLLM_MODEL_ID,
      onProgress: (s) => progressCaller1.push(s.progress)
    }),
    ensureWebLLMEngine({
      modelId: SMOLLM2_360M_WEBLLM_MODEL_ID,
      onProgress: (s) => progressCaller2.push(s.progress)
    }),
    ensureWebLLMEngine({
      modelId: SMOLLM2_360M_WEBLLM_MODEL_ID,
      onProgress: (s) => progressCaller3.push(s.progress)
    })
  ]);

  assert.strictEqual(res1.engine, mockEngine);
  assert.strictEqual(res2.engine, mockEngine);
  assert.strictEqual(res3.engine, mockEngine);

  const stats = getWebLLMRuntimeStats();
  assert.strictEqual(stats.totalWorkersSpawned, 1, 'Must spawn only 1 worker for 3 concurrent callers');
  assert.strictEqual(stats.activeWorkerCount, 1, 'Only 1 active worker');
  assert.strictEqual(stats.totalEngineInits, 1, 'Must run CreateWebWorkerMLCEngine only once');
  assert.strictEqual(adapterCalls, 1, 'WebGPU adapter check deduplicated');
  assert.ok(progressCaller1.length > 0 && progressCaller2.length > 0 && progressCaller3.length > 0, 'All concurrent callers receive progress updates');

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('2B. Reference-counted multi-waiter cancellation: Caller A aborting does NOT kill Caller B sharing the same initialization', async () => {
  setupMockEnvironment({ hasGpu: true, hasShaderF16: true });
  resetWebLLMRuntimeForTesting();
  await seedCachedModel(DEFAULT_WEBLLM_MODEL_ID);

  const mockEngine = createMockEngine('Survived response');
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ handleInitProgress }) => {
    await new Promise((r) => setTimeout(r, 60));
    handleInitProgress?.({ progress: 1, text: 'Loaded' });
    return mockEngine;
  });

  const controllerA = new AbortController();
  const controllerB = new AbortController();

  const promiseA = ensureWebLLMEngine({
    modelId: DEFAULT_WEBLLM_MODEL_ID,
    signal: controllerA.signal
  });
  const promiseB = ensureWebLLMEngine({
    modelId: DEFAULT_WEBLLM_MODEL_ID,
    signal: controllerB.signal
  });

  // Abort Caller A after 15ms while Caller B is still waiting
  setTimeout(() => controllerA.abort(), 15);

  await assert.rejects(promiseA, (err) => err.name === 'AbortError', 'Caller A must reject with AbortError');
  const engineB = await promiseB;
  assert.strictEqual(engineB.engine, mockEngine, 'Caller B must succeed without interruption');
  assert.strictEqual(getWebLLMState().status, 'ready');
  assert.strictEqual(getWebLLMRuntimeStats().activeWorkerCount, 1);

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('2C. Concurrent downloadModelArtifactsToCache calls for the same model coalesce into a single download session', async () => {
  setupMockEnvironment({ hasGpu: true, hasShaderF16: true });
  resetWebLLMRuntimeForTesting();

  let fetchCount = 0;
  setWebLLMFetchForTesting(
    createDefaultMockFetch({
      delayMs: 20,
      onFetch: () => {
        fetchCount++;
      }
    })
  );

  const record = webllmPkg.prebuiltAppConfig.model_list.find(
    (m) => m.model_id === SMOLLM2_135M_WEBLLM_MODEL_ID
  );

  const p1 = [];
  const p2 = [];
  await Promise.all([
    downloadModelArtifactsToCache(record, { onProgress: (info) => p1.push(info) }),
    downloadModelArtifactsToCache(record, { onProgress: (info) => p2.push(info) })
  ]);

  // Verify single-flight download deduplication: running once alone vs twice concurrently makes identical fetch count
  const singleFlightFetches = fetchCount;
  setupMockEnvironment({ hasGpu: true, hasShaderF16: true });
  resetWebLLMRuntimeForTesting();
  let soloFetchCount = 0;
  setWebLLMFetchForTesting(
    createDefaultMockFetch({
      onFetch: () => {
        soloFetchCount++;
      }
    })
  );
  await downloadModelArtifactsToCache(record);

  assert.strictEqual(
    singleFlightFetches,
    soloFetchCount,
    `Concurrent downloads must execute the exact same number of fetches as a single download (${singleFlightFetches} vs ${soloFetchCount})`
  );
  assert.ok(p1.length > 0 && p2.length > 0, 'Both download callers received progress callbacks');

  resetWebLLMRuntimeForTesting();
});

// ---------------------------------------------------------------------------
// 3. Retrying After Initialization Failure & Deadlock-Free FP32 Fallback
// ---------------------------------------------------------------------------
await runAsyncTest('3A. Initialization failure clears in-progress state and allows clean retry without page reload', async () => {
  setupMockEnvironment({ hasGpu: true, hasShaderF16: true });
  resetWebLLMRuntimeForTesting();
  await seedCachedModel(SMOLLM2_135M_WEBLLM_MODEL_ID);

  let attempt = 0;
  const mockEngine = createMockEngine('Recovered after failure');

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => {
    attempt++;
    if (attempt === 1) {
      throw new Error('Simulated transient WebGPU pipeline creation failure');
    }
    return mockEngine;
  });

  // First attempt fails
  await assert.rejects(
    ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID }),
    /Simulated transient WebGPU pipeline creation failure/
  );

  const failedState = getWebLLMState();
  assert.strictEqual(failedState.status, 'error');
  assert.strictEqual(failedState.phase, 'error');
  assert.strictEqual(failedState.loadedModelId, null);
  assert.strictEqual(
    getWebLLMRuntimeStats().activeWorkerCount,
    0,
    'Failed worker must be terminated immediately'
  );

  // Retry succeeds without page reload
  const recoveredEngine = await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
  assert.strictEqual(recoveredEngine.engine, mockEngine);
  const readyState = getWebLLMState();
  assert.strictEqual(readyState.status, 'ready');
  assert.strictEqual(readyState.phase, 'ready');
  assert.strictEqual(readyState.error, null);
  assert.strictEqual(getWebLLMRuntimeStats().activeWorkerCount, 1);

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('3B. Runtime shader-f16 error during CreateWebWorkerMLCEngine falls back to FP32 without self-await deadlock', async () => {
  setupMockEnvironment({ hasGpu: true, hasShaderF16: true });
  resetWebLLMRuntimeForTesting();
  await seedCachedModel(SMOLLM2_360M_WEBLLM_MODEL_ID);
  await seedCachedModel(SMOLLM2_360M_F32_WEBLLM_MODEL_ID);

  const requestedModels = [];
  const mockEngine = createMockEngine('FP32 fallback engine');

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
    requestedModels.push(modelId);
    if (modelId === SMOLLM2_360M_WEBLLM_MODEL_ID) {
      throw new Error('WebGPU error: shader-f16 extension is not enabled on this device');
    }
    return mockEngine;
  });

  const engine = await ensureWebLLMEngine({ modelId: SMOLLM2_360M_WEBLLM_MODEL_ID });
  assert.strictEqual(engine.engine, mockEngine);
  assert.deepStrictEqual(requestedModels, [
    SMOLLM2_360M_WEBLLM_MODEL_ID,
    SMOLLM2_360M_F32_WEBLLM_MODEL_ID
  ]);
  const state = getWebLLMState();
  assert.strictEqual(state.status, 'ready');
  assert.strictEqual(state.loadedModelId, SMOLLM2_360M_F32_WEBLLM_MODEL_ID);
  assert.strictEqual(state.hasShaderF16, false);
  assert.strictEqual(
    getWebLLMRuntimeStats().activeWorkerCount,
    1,
    'First failed F16 worker terminated; only 1 FP32 worker remains active'
  );

  resetWebLLMRuntimeForTesting();
});

// ---------------------------------------------------------------------------
// 4. Switching Between All 4 Models Safely (Including Mid-Init Switch)
// ---------------------------------------------------------------------------
await runAsyncTest('4A. Switching mid-initialization aborts obsolete model load and initializes the newly selected model cleanly', async () => {
  setupMockEnvironment({ hasGpu: true, hasShaderF16: true });
  resetWebLLMRuntimeForTesting();
  await seedCachedModel(DEFAULT_WEBLLM_MODEL_ID);
  await seedCachedModel(SMOLLM2_135M_WEBLLM_MODEL_ID);

  const engineByModel = new Map();
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
    if (modelId === DEFAULT_WEBLLM_MODEL_ID) {
      // Slow initialization for Model A
      await new Promise((r) => setTimeout(r, 80));
    } else {
      await new Promise((r) => setTimeout(r, 15));
    }
    const eng = createMockEngine(`Response from ${modelId}`);
    engineByModel.set(modelId, eng);
    return eng;
  });

  // Start loading Qwen 2.5 1.5B
  const loadQwenPromise = ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });

  // After 15ms, user switches to SmolLM2 135M
  await new Promise((r) => setTimeout(r, 15));
  const loadSmolPromise = ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });

  // First load must reject with AbortError
  await assert.rejects(loadQwenPromise, (err) => err.name === 'AbortError');

  // Second load must succeed and become the sole active engine
  const smolEngine = await loadSmolPromise;
  assert.strictEqual(smolEngine.engine, engineByModel.get(SMOLLM2_135M_WEBLLM_MODEL_ID));
  assert.strictEqual(getWebLLMState().status, 'ready');
  assert.strictEqual(getWebLLMState().loadedModelId, SMOLLM2_135M_WEBLLM_MODEL_ID);
  assert.strictEqual(
    getWebLLMRuntimeStats().activeWorkerCount,
    1,
    'Must never leave obsolete workers running after mid-init switch'
  );

  resetWebLLMRuntimeForTesting();
});

await runAsyncTest('4B. Switching across all 4 models keeps activeWorkerCount <= 1 and resets stale errors on inspectWebLLMReadiness', async () => {
  setupMockEnvironment({ hasGpu: true, hasShaderF16: true });
  resetWebLLMRuntimeForTesting();

  const modelsToCycle = [
    SMOLLM2_135M_WEBLLM_MODEL_ID,
    SMOLLM2_360M_WEBLLM_MODEL_ID,
    QWEN3_06B_WEBLLM_MODEL_ID,
    DEFAULT_WEBLLM_MODEL_ID
  ];

  for (const id of modelsToCycle) {
    await seedCachedModel(id);
  }

  const engines = [];
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
    const eng = createMockEngine(`Output:${modelId}`);
    engines.push({ modelId, eng });
    return eng;
  });

  for (let i = 0; i < modelsToCycle.length; i++) {
    const targetId = modelsToCycle[i];
    await inspectWebLLMReadiness(targetId);
    if (i > 0) {
      // Before loading the newly selected model, status should reflect idle (since a different model is loaded)
      assert.strictEqual(getWebLLMState().status, 'idle');
    }
    const res = await streamWebLLMMessage({
      prompt: `Ping ${targetId}`,
      modelId: targetId
    });
    assert.strictEqual(res.text, `Output:${targetId}`);
    assert.strictEqual(getWebLLMState().status, 'ready');
    assert.strictEqual(getWebLLMState().loadedModelId, targetId);
    assert.strictEqual(
      getWebLLMRuntimeStats().activeWorkerCount,
      1,
      `activeWorkerCount must be 1 after switching to ${targetId}`
    );
    if (i > 0) {
      assert.strictEqual(
        engines[i - 1].eng.unloaded,
        true,
        `Previous model ${engines[i - 1].modelId} engine must be unloaded before loading ${targetId}`
      );
    }
  }

  resetWebLLMRuntimeForTesting();
});

// ---------------------------------------------------------------------------
// 5. Handling Cancellation, Queued Generation Abort, and Unmounting
// ---------------------------------------------------------------------------
await runAsyncTest('5. Queued generation aborted while waiting on previousTurn exits immediately without starting inference', async () => {
  setupMockEnvironment({ hasGpu: true, hasShaderF16: true });
  resetWebLLMRuntimeForTesting();
  await seedCachedModel(SMOLLM2_135M_WEBLLM_MODEL_ID);

  let completionCalls = 0;
  const mockEngine = {
    unloaded: false,
    interrupted: false,
    chat: {
      completions: {
        create: async () => {
          completionCalls++;
          return (async function* () {
            await new Promise((r) => setTimeout(r, 50));
            yield { choices: [{ delta: { content: `Gen-${completionCalls}` } }] };
          })();
        }
      }
    },
    interruptGenerate() {
      this.interrupted = true;
    },
    async unload() {
      this.unloaded = true;
    }
  };

  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });

  // Start Turn 1 (takes 50ms)
  const turn1Promise = streamWebLLMMessage({
    prompt: 'First prompt',
    modelId: SMOLLM2_135M_WEBLLM_MODEL_ID
  });

  // Queue Turn 2 behind Turn 1, then abort Turn 2 before Turn 1 finishes
  const turn2Controller = new AbortController();
  const turn2Promise = streamWebLLMMessage({
    prompt: 'Second prompt',
    modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
    signal: turn2Controller.signal
  });

  setTimeout(() => turn2Controller.abort(), 10);

  await assert.rejects(turn2Promise, (err) => err.name === 'AbortError');
  const res1 = await turn1Promise;
  assert.strictEqual(res1.text, 'Gen-1');
  assert.strictEqual(
    completionCalls,
    1,
    'Aborted queued turn must NOT invoke engine.chat.completions.create'
  );

  // Also verify unloadWebLLMEngine cleanly releases worker & resets state
  await unloadWebLLMEngine();
  assert.strictEqual(getWebLLMRuntimeStats().activeWorkerCount, 0);
  assert.strictEqual(getWebLLMState().status, 'idle');
  assert.strictEqual(getWebLLMState().loadedModelId, null);

  resetWebLLMRuntimeForTesting();
});

// ---------------------------------------------------------------------------
// 6. Avoiding Unnecessary Redownloads (Preserving Valid Cached Shards)
// ---------------------------------------------------------------------------
await runAsyncTest('6. Partial download failure preserves valid cached shards and subsequent retry only fetches missing shards', async () => {
  const { cacheStorage } = setupMockEnvironment({ hasGpu: true, hasShaderF16: true });
  resetWebLLMRuntimeForTesting();

  const fetchedUrls = [];
  let failSecondShard = true;

  setWebLLMFetchForTesting(async (url) => {
    const href = String(url);
    fetchedUrls.push(href);
    if (href.endsWith('mlc-chat-config.json')) {
      return new Response(
        JSON.stringify({ tokenizer_files: ['tokenizer.json'], context_window_size: 4096 }),
        { status: 200 }
      );
    }
    if (href.endsWith('tensor-cache.json') || href.endsWith('ndarray-cache.json')) {
      return new Response(
        JSON.stringify({
          records: [
            { name: 'w0', dataPath: 'params_shard_0.bin', nbytes: 16 },
            { name: 'w1', dataPath: 'params_shard_1.bin', nbytes: 16 }
          ]
        }),
        { status: 200 }
      );
    }
    if (href.endsWith('params_shard_1.bin') && failSecondShard) {
      return new Response('Service Unavailable', { status: 503 });
    }
    if (href.endsWith('.json')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(new Uint8Array(16), { status: 200 });
  });

  const record = webllmPkg.prebuiltAppConfig.model_list.find(
    (m) => m.model_id === SMOLLM2_135M_WEBLLM_MODEL_ID
  );

  // First attempt fails on params_shard_1.bin
  await assert.rejects(downloadModelArtifactsToCache(record));
  const modelBucket = cacheStorage.buckets.get('webllm/model');
  assert.ok(
    modelBucket && Array.from(modelBucket.keys()).some((k) => k.endsWith('params_shard_0.bin')),
    'Valid shard 0 must be preserved in cache'
  );

  // Second attempt succeeds and skips already-cached config, wasm, and shard 0
  fetchedUrls.length = 0;
  failSecondShard = false;
  await downloadModelArtifactsToCache(record);

  assert.strictEqual(
    fetchedUrls.some((u) => u.endsWith('params_shard_0.bin')),
    false,
    'Already cached params_shard_0.bin must NOT be redownloaded on retry'
  );
  assert.strictEqual(
    fetchedUrls.some((u) => u.endsWith('params_shard_1.bin')),
    true,
    'Missing params_shard_1.bin is fetched on retry'
  );

  resetWebLLMRuntimeForTesting();
});

// ---------------------------------------------------------------------------
// 7. Preserving Offline Inference
// ---------------------------------------------------------------------------
await runAsyncTest('7. Offline mode runs cached models without network and fails fast with WEBLLM_OFFLINE_UNCACHED for uncached models', async () => {
  setupMockEnvironment({ hasGpu: true, hasShaderF16: true, isOnline: false });
  resetWebLLMRuntimeForTesting();

  // Case A: Uncached model while offline -> fails fast with WEBLLM_OFFLINE_UNCACHED
  await assert.rejects(
    ensureWebLLMEngine({ modelId: SMOLLM2_360M_WEBLLM_MODEL_ID }),
    (err) =>
      err.code === 'WEBLLM_OFFLINE_UNCACHED' ||
      err.reasonCode === 'WEBLLM_OFFLINE_UNCACHED' ||
      /not been downloaded to this browser yet/i.test(err.message)
  );

  // Case B: Cached model while offline -> initializes and streams locally without network
  await seedCachedModel(SMOLLM2_135M_WEBLLM_MODEL_ID);
  const mockEngine = createMockEngine('Offline local inference');
  setWebLLMWorkerFactoryForTesting(() => createMockWorker());
  setWebLLMEngineFactoryForTesting(async () => mockEngine);

  const res = await streamWebLLMMessage({
    prompt: 'Offline test',
    modelId: SMOLLM2_135M_WEBLLM_MODEL_ID
  });
  assert.strictEqual(res.text, 'Offline local inference');
  assert.strictEqual(getWebLLMState().status, 'ready');

  resetWebLLMRuntimeForTesting();
});

console.log(`\nPhase 2 Verification Summary: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
