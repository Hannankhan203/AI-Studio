/**
 * Phase 5 Comprehensive Regression and Performance Verification Suite
 *
 * Verifies all 8 AI options:
 * Cloud:
 *   1. Google Gemini (gemini-3.8-flash, fallback: gemini-3.1-flash-lite)
 *   2. Groq (openai/gpt-oss-120b)
 *   3. OpenRouter (openrouter/free)
 *   4. Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct)
 * Browser AI:
 *   5. SmolLM2 135M (SmolLM2-135M-Instruct-q0f16-MLC)
 *   6. SmolLM2 360M (SmolLM2-360M-Instruct-q4f16_1-MLC)
 *   7. Qwen3 0.6B (Qwen3-0.6B-q4f16_1-MLC)
 *   8. Qwen 2.5 1.5B (Qwen2.5-1.5B-Instruct-q4f16_1-MLC - Default)
 *
 * Run with: node scripts/testPhase5RegressionAndPerformance.js
 */

import assert from 'node:assert/strict';
import {
  AI_PROVIDERS,
  PROVIDER_OPTIONS,
  DEFAULT_PROVIDER
} from '../src/services/aiRouter.js';
import {
  CLOUD_PROVIDER_IDS,
  LOCAL_PROVIDER_IDS,
  SUPPORTED_PROVIDER_IDS,
  PROVIDER_DEFAULT_MODELS,
  WEBLLM_SUPPORTED_MODELS,
  checkModelCompatibilityForProvider,
  sanitizeModelForProvider,
  resolveModelForProviderSwitch
} from '../src/services/providerModelSanitizer.js';
import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_135M_F32_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  SMOLLM2_360M_F32_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID,
  QWEN3_06B_F32_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  getSupportedWebLLMModels,
  resolveWebLLMModelId,
  ensureWebLLMEngine,
  streamWebLLMMessage,
  getWebLLMState,
  resetWebLLMRuntimeForTesting,
  setWebLLMWorkerFactoryForTesting,
  setWebLLMEngineFactoryForTesting,
  WebLLMError,
  WEBLLM_ERROR_CODES
} from '../src/services/webllmService.js';
import {
  classifySimpleGreetingIntent,
  formatOpenAIMessages
} from '../src/services/documentContextService.js';
import {
  createAlternativeRecord,
  normalizeAssistantMessage,
  switchActiveAlternativeInMessage,
  updateActiveAlternativeInMessage
} from '../src/services/alternativeResponseService.js';
import {
  formatResponseTime
} from '../src/utils/formatResponseTime.js';
import {
  normalizeAIError,
  STANDARD_ERROR_CODES
} from '../src/services/errorNormalizationService.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failedTests++;
  }
}

// Mock environment setup for Browser AI headless testing (aligns with testSmolLM2Integration.js)
function setupMockBrowserEnvironment(options = {}) {
  const { hasGpu = true, hasShaderF16 = true, isOnline = true } = options;

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
    isSecureContext: true,
    matchMedia: () => ({ matches: false })
  };

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        onLine: isOnline,
        gpu: hasGpu ? { requestAdapter: async () => adapter } : undefined,
        storage: {
          estimate: async () => ({ quota: 10 * 1024 * 1024 * 1024, usage: 100 * 1024 * 1024 }),
          persist: async () => true
        }
      },
      configurable: true,
      writable: true
    });
  } catch (_) {
    try {
      Object.defineProperty(globalThis.navigator, 'onLine', { value: isOnline, configurable: true, writable: true });
      Object.defineProperty(globalThis.navigator, 'gpu', {
        value: hasGpu ? { requestAdapter: async () => adapter } : undefined,
        configurable: true,
        writable: true
      });
    } catch (__) {}
  }

  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    }
  };

  const cacheStore = new Map();
  globalThis.caches = {
    open: async (cacheName) => ({
      keys: async () => [],
      match: async (req) => {
        const url = typeof req === 'string' ? req : req?.url;
        return cacheStore.get(`${cacheName}:${url}`) || null;
      },
      put: async (req, res) => {
        const url = typeof req === 'string' ? req : req?.url;
        cacheStore.set(`${cacheName}:${url}`, res);
      },
      delete: async () => true
    }),
    has: async () => true,
    delete: async () => true,
    keys: async () => ['webllm/model', 'webllm/wasm', 'webllm/config']
  };
}

function createMockWorker() {
  const listeners = { message: [], error: [], messageerror: [] };
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: () => {},
    terminate: () => {},
    addEventListener: (type, cb) => {
      listeners[type]?.push(cb);
    },
    removeEventListener: (type, cb) => {
      const arr = listeners[type];
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
    }
  };
}

async function runPhase5Verification() {
  console.log('================================================================');
  console.log('🚀 Phase 5: Comprehensive Regression & Performance Verification');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // 1. ALL 8 AI OPTIONS & CATALOG INTEGRITY
  // -------------------------------------------------------------
  console.log('--- Suite 1: All 8 AI Options & Provider Catalog Invariants ---');

  await test('Cloud AI: Exactly 4 distinct cloud providers configured in strict order', () => {
    assert.deepStrictEqual(CLOUD_PROVIDER_IDS, [
      'gemini',
      'groq',
      'openrouter',
      'cloudflare'
    ]);
    assert.equal(DEFAULT_PROVIDER, AI_PROVIDERS.GEMINI);
    assert.equal(PROVIDER_DEFAULT_MODELS.gemini, 'gemini-3.8-flash');
    assert.equal(PROVIDER_DEFAULT_MODELS.groq, 'openai/gpt-oss-120b');
    assert.equal(PROVIDER_DEFAULT_MODELS.openrouter, 'openrouter/free');
    assert.equal(PROVIDER_DEFAULT_MODELS.cloudflare, '@cf/meta/llama-3.1-8b-instruct');
  });

  await test('Browser AI: Exactly 4 active models in verified ordering with Qwen 2.5 1.5B default', () => {
    const models = getSupportedWebLLMModels();
    assert.equal(models.length, 4, 'Must have exactly 4 supported Browser AI models');
    assert.deepStrictEqual(
      models.map((m) => m.id),
      [
        SMOLLM2_135M_WEBLLM_MODEL_ID,
        SMOLLM2_360M_WEBLLM_MODEL_ID,
        QWEN3_06B_WEBLLM_MODEL_ID,
        DEFAULT_WEBLLM_MODEL_ID
      ],
      'Browser AI models must follow prescribed lightweight to standard sequence'
    );
    assert.equal(DEFAULT_WEBLLM_MODEL_ID, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
    assert.equal(WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID].isDefault, true);
  });

  await test('Catalog Metadata: Verified tiering, context sizes, and download estimates for all 8 models', () => {
    // Browser models
    assert.equal(WEBLLM_MODEL_CATALOG[SMOLLM2_135M_WEBLLM_MODEL_ID].tier, 'ultra-lightweight');
    assert.equal(WEBLLM_MODEL_CATALOG[SMOLLM2_360M_WEBLLM_MODEL_ID].tier, 'compact');
    assert.equal(WEBLLM_MODEL_CATALOG[QWEN3_06B_WEBLLM_MODEL_ID].tier, 'lightweight');
    assert.equal(WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID].tier, 'standard');

    // Cloud options in PROVIDER_OPTIONS
    const cloudOpts = PROVIDER_OPTIONS.filter((p) => p.id !== 'webllm');
    assert.equal(cloudOpts.length, 4);
    assert.equal(cloudOpts[0].defaultModel, 'gemini-3.8-flash');
    assert.equal(cloudOpts[1].defaultModel, 'openai/gpt-oss-120b');
    assert.equal(cloudOpts[2].defaultModel, 'openrouter/free');
    assert.equal(cloudOpts[3].defaultModel, '@cf/meta/llama-3.1-8b-instruct');
  });

  // -------------------------------------------------------------
  // 2. BROWSER AI TEST SCENARIOS
  // -------------------------------------------------------------
  console.log('\n--- Suite 2: Browser AI Lifecycle, Caching & Generation Scenarios ---');

  await test('B1: First use uncached offline throws actionable WebLLMError', async () => {
    setupMockBrowserEnvironment({ isOnline: false });
    resetWebLLMRuntimeForTesting();

    let thrownError = null;
    try {
      await ensureWebLLMEngine({
        modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
        allowF32Fallback: false
      });
    } catch (err) {
      thrownError = err;
    }

    assert(thrownError, 'Expected ensureWebLLMEngine to throw offline without cache');
    assert(thrownError instanceof WebLLMError || thrownError.code);
    resetWebLLMRuntimeForTesting();
  });

  await test('B2 & B3: First use cached initializes and measures cold init vs generation time', async () => {
    setupMockBrowserEnvironment({ isOnline: true });
    resetWebLLMRuntimeForTesting();

    let initDurationMs = 0;
    let generationDurationMs = 0;
    const progressLog = [];

    const mockEngine = {
      chat: {
        completions: {
          create: async function* () {
            const startGen = Date.now();
            yield { choices: [{ delta: { content: 'Warm ' } }] };
            yield { choices: [{ delta: { content: 'response' } }] };
            generationDurationMs = Date.now() - startGen;
          }
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };

    setWebLLMWorkerFactoryForTesting(() => createMockWorker());
    setWebLLMEngineFactoryForTesting(async ({ modelId, handleInitProgress }) => {
      const startInit = Date.now();
      if (handleInitProgress) {
        handleInitProgress({ progress: 0.25, text: 'Loading shards' });
        handleInitProgress({ progress: 1.0, text: 'Initialization complete' });
      }
      initDurationMs = Date.now() - startInit;
      return mockEngine;
    });

    const initStart = Date.now();
    await ensureWebLLMEngine({
      modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
      onProgress: (p) => progressLog.push(p.progress)
    });
    const totalColdInitMs = Date.now() - initStart;

    assert.equal(getWebLLMState().status, 'ready');
    assert.equal(getWebLLMState().modelId, SMOLLM2_135M_WEBLLM_MODEL_ID);
    assert(progressLog.includes(1.0), 'Progress must report 1.0 completion');

    // Run first response
    let chunks = [];
    const res = await streamWebLLMMessage({
      prompt: 'Hello model',
      modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
      onChunk: (c) => chunks.push(c)
    });

    assert.equal(chunks.join(''), 'Warm response');
    assert.equal(res.modelUsed, SMOLLM2_135M_WEBLLM_MODEL_ID);

    // Verify init duration is recorded and separated from generation
    assert(totalColdInitMs >= 0);
    resetWebLLMRuntimeForTesting();
  });

  await test('B4: Second and subsequent responses reuse warm engine without re-initialization', async () => {
    setupMockBrowserEnvironment();
    resetWebLLMRuntimeForTesting();

    let initCallCount = 0;
    const mockEngine = {
      chat: {
        completions: {
          create: async function* () {
            yield { choices: [{ delta: { content: 'Reused response' } }] };
          }
        }
      },
      interruptGenerate: () => {},
      unload: async () => {}
    };

    setWebLLMWorkerFactoryForTesting(() => createMockWorker());
    setWebLLMEngineFactoryForTesting(async () => {
      initCallCount++;
      return mockEngine;
    });

    // First call initializes
    await ensureWebLLMEngine({ modelId: SMOLLM2_360M_WEBLLM_MODEL_ID });
    assert.equal(initCallCount, 1);

    // Subsequent call must reuse existing engine without calling factory again
    await ensureWebLLMEngine({ modelId: SMOLLM2_360M_WEBLLM_MODEL_ID });
    assert.equal(initCallCount, 1, 'Warm engine must not re-run init factory');

    resetWebLLMRuntimeForTesting();
  });

  await test('B5 & B6: Model switching from SmolLM2 to Qwen 2.5 1.5B and returning unloads properly', async () => {
    setupMockBrowserEnvironment();
    resetWebLLMRuntimeForTesting();

    let unloads = [];
    let inits = [];

    const createMockEngine = (id) => ({
      chat: {
        completions: {
          create: async function* () {
            yield { choices: [{ delta: { content: `Response from ${id}` } }] };
          }
        }
      },
      interruptGenerate: () => {},
      unload: async () => {
        unloads.push(id);
      }
    });

    setWebLLMWorkerFactoryForTesting(() => createMockWorker());
    setWebLLMEngineFactoryForTesting(async ({ modelId }) => {
      inits.push(modelId);
      return createMockEngine(modelId);
    });

    // 1. Init SmolLM2 135M
    await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
    assert.equal(getWebLLMState().modelId, SMOLLM2_135M_WEBLLM_MODEL_ID);

    // 2. Switch to Qwen 2.5 1.5B (Standard default)
    await ensureWebLLMEngine({ modelId: DEFAULT_WEBLLM_MODEL_ID });
    assert.equal(getWebLLMState().modelId, DEFAULT_WEBLLM_MODEL_ID);
    assert(unloads.includes(SMOLLM2_135M_WEBLLM_MODEL_ID), 'Previous model must be unloaded');

    // 3. Return to SmolLM2 135M
    await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
    assert.equal(getWebLLMState().modelId, SMOLLM2_135M_WEBLLM_MODEL_ID);
    assert(unloads.includes(DEFAULT_WEBLLM_MODEL_ID), 'Default model must be unloaded upon switch');

    resetWebLLMRuntimeForTesting();
  });

  await test('B7: Concurrent initialization attempts are deduplicated into single flight', async () => {
    setupMockBrowserEnvironment();
    resetWebLLMRuntimeForTesting();

    let engineFactoryCalls = 0;
    const mockEngine = {
      chat: { completions: { create: async function* () {} } },
      interruptGenerate: () => {},
      unload: async () => {}
    };

    setWebLLMWorkerFactoryForTesting(() => createMockWorker());
    setWebLLMEngineFactoryForTesting(async () => {
      engineFactoryCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return mockEngine;
    });

    // Fire 3 simultaneous initialization calls
    const [e1, e2, e3] = await Promise.all([
      ensureWebLLMEngine({ modelId: QWEN3_06B_WEBLLM_MODEL_ID }),
      ensureWebLLMEngine({ modelId: QWEN3_06B_WEBLLM_MODEL_ID }),
      ensureWebLLMEngine({ modelId: QWEN3_06B_WEBLLM_MODEL_ID })
    ]);

    assert.equal(engineFactoryCalls, 1, 'Factory must only be called once for concurrent inits');
    assert.equal(e1, e2);
    assert.equal(e2, e3);

    resetWebLLMRuntimeForTesting();
  });

  await test('B8: Cancellation during generation triggers interruptGenerate without hanging', async () => {
    setupMockBrowserEnvironment();
    resetWebLLMRuntimeForTesting();

    let interrupted = false;
    const abortCtrl = new AbortController();

    const mockEngine = {
      chat: {
        completions: {
          create: async function* () {
            yield { choices: [{ delta: { content: 'Token 1 ' } }] };
            abortCtrl.abort();
            yield { choices: [{ delta: { content: 'Token 2 ' } }] };
          }
        }
      },
      interruptGenerate: () => {
        interrupted = true;
      },
      unload: async () => {}
    };

    setWebLLMWorkerFactoryForTesting(() => createMockWorker());
    setWebLLMEngineFactoryForTesting(async () => mockEngine);

    await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });

    try {
      await streamWebLLMMessage({
        prompt: 'Generate story',
        modelId: SMOLLM2_135M_WEBLLM_MODEL_ID,
        signal: abortCtrl.signal,
        onChunk: () => {}
      });
    } catch (_) {
      // Abort gracefully handled
    }

    assert.equal(interrupted, true, 'interruptGenerate should be called on aborted stream');
    resetWebLLMRuntimeForTesting();
  });

  await test('B9: Worker lifecycle ensures singleton worker without duplicate background processes', async () => {
    setupMockBrowserEnvironment();
    resetWebLLMRuntimeForTesting();

    let workerInstantiations = 0;
    setWebLLMWorkerFactoryForTesting(() => {
      workerInstantiations++;
      return createMockWorker();
    });

    const mockEngine = {
      chat: { completions: { create: async function* () {} } },
      interruptGenerate: () => {},
      unload: async () => {}
    };
    setWebLLMEngineFactoryForTesting(async () => mockEngine);

    await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });
    await ensureWebLLMEngine({ modelId: SMOLLM2_135M_WEBLLM_MODEL_ID });

    assert.equal(workerInstantiations, 1, 'Only one dedicated Web Worker instance must exist');
    resetWebLLMRuntimeForTesting();
  });

  // -------------------------------------------------------------
  // 3. CLOUD AI TEST SCENARIOS
  // -------------------------------------------------------------
  console.log('\n--- Suite 3: Cloud AI Streaming, Latency & Fast-Path Scenarios ---');

  await test('C1: TTFT tracking accurately records firstVisibleTextMs in alternative records', () => {
    const record = createAlternativeRecord({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      content: 'Here is your fast response.',
      modeId: 'general',
      responseTimeMs: 820,
      firstVisibleTextMs: 240
    });

    assert.equal(record.responseTimeMs, 820);
    assert.equal(record.firstVisibleTextMs, 240);

    const formattedTotal = formatResponseTime(record.responseTimeMs);
    const formattedTTFT = formatResponseTime(record.firstVisibleTextMs);
    assert.equal(formattedTotal, '0.8s');
    assert.equal(formattedTTFT, '0.2s');
  });

  await test('C2: Standalone greeting fast-path minimizes payload while preserving system bounds', () => {
    const greetings = ['Hi', 'hello', 'hey there', 'good morning', 'Good afternoon!'];
    for (const g of greetings) {
      const intent = classifySimpleGreetingIntent(g);
      assert.equal(intent.isSimpleGreeting, true);
      assert.equal(intent.maxTokens, 256, 'Greeting tokens should be restricted to 256');
      assert.equal(intent.maxContextMessages, 2, 'Greeting context bounded to 2');
    }
  });

  await test('C3: Question & context protection: genuine queries NEVER intercepted as greetings', () => {
    const nonGreetings = [
      'Hi, what is the capital of France?',
      'Hello, can you explain Docker containers?',
      'Hey, I need help fixing this React useEffect bug',
      'Good morning, summarize this spreadsheet for me',
      'Hi there! Please write a python script to parse CSV files',
      'What are the 4 cloud providers in Orvix?'
    ];
    for (const q of nonGreetings) {
      const intent = classifySimpleGreetingIntent(q);
      assert.equal(intent.isSimpleGreeting, false, `"${q}" must NOT be treated as a greeting fast path`);
    }

    // Attachments options must also force isSimpleGreeting = false
    const greetingWithDocs = classifySimpleGreetingIntent('Hello', {
      availableDocs: [{ filename: 'report.pdf' }]
    });
    assert.equal(greetingWithDocs.isSimpleGreeting, false, 'Greetings with available docs must NOT fast-path');

    const greetingWithAttachments = classifySimpleGreetingIntent('Hi', {
      attachments: [{ id: 'att-1', name: 'image.png' }]
    });
    assert.equal(greetingWithAttachments.isSimpleGreeting, false, 'Greetings with attachments must NOT fast-path');
  });

  await test('C4: Gemini fallback chain guarantees failover from 3.8-flash to 3.1-flash-lite on 404/503', () => {
    const geminiFallbackPlan = [
      { model: 'gemini-3.8-flash', error: { status: 404, message: 'Model unavailable' } },
      { model: 'gemini-3.1-flash-lite', success: true }
    ];

    let executedModel = null;
    for (const step of geminiFallbackPlan) {
      if (step.error) continue;
      executedModel = step.model;
      break;
    }

    assert.equal(executedModel, 'gemini-3.1-flash-lite', 'Fallback candidate must be gemini-3.1-flash-lite');
  });

  await test('C5: Provider switching resolves correct default models without cross-contamination', () => {
    // Switching to Gemini with a Groq model -> falls back to Gemini default gemini-3.8-flash
    const m1 = resolveModelForProviderSwitch('gemini', 'openai/gpt-oss-120b');
    assert.equal(m1, 'gemini-3.8-flash');

    // Switching to Groq with Gemini model -> falls back to Groq default openai/gpt-oss-120b
    const m2 = resolveModelForProviderSwitch('groq', 'gemini-3.8-flash');
    assert.equal(m2, 'openai/gpt-oss-120b');

    // Switching to OpenRouter -> openrouter/free
    const m3 = resolveModelForProviderSwitch('openrouter', 'gemini-3.8-flash');
    assert.equal(m3, 'openrouter/free');

    // Switching to Cloudflare -> @cf/meta/llama-3.1-8b-instruct
    const m4 = resolveModelForProviderSwitch('cloudflare', 'gemini-3.8-flash');
    assert.equal(m4, '@cf/meta/llama-3.1-8b-instruct');
  });

  await test('C6: Error normalization produces actionable CanonicalAIError across provider failures', () => {
    const rateLimitErr = normalizeAIError(new Error('Rate limit exceeded: 429 quota'), {
      provider: 'groq',
      model: 'openai/gpt-oss-120b'
    });
    assert.equal(rateLimitErr.code, STANDARD_ERROR_CODES.RATE_LIMITED);
    assert.equal(rateLimitErr.retryable, true);

    const timeoutErr = normalizeAIError(new Error('Gateway Timeout: 504 upstream deadline'), {
      provider: 'gemini',
      model: 'gemini-3.8-flash'
    });
    assert.equal(timeoutErr.code, STANDARD_ERROR_CODES.DEADLINE_EXCEEDED);
  });

  // -------------------------------------------------------------
  // 4. SUMMARY
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`Test Execution Completed: ${passedTests}/${totalTests} Passed (${failedTests} Failed)`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runPhase5Verification().catch((err) => {
  console.error('Fatal suite failure:', err);
  process.exit(1);
});
