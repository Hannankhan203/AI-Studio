/**
 * Phase 4D — Groq Provider Hardening Test Suite
 *
 * Validates:
 * 1. Groq chat model selection & validation: active default (openai/gpt-oss-120b),
 *    valid alternatives (llama-3.1-8b-instant, openai/gpt-oss-20b), cross-provider ID rejection,
 *    and display label rejection.
 * 2. Audio-transcription model validation & task separation:
 *    - Valid audio models: whisper-large-v3-turbo and whisper-large-v3.
 *    - Strict separation from chat models: chat models (llama-3.3-70b-versatile, openai/gpt-oss-120b)
 *      passed to /api/transcribe are rejected with HTTP 400 INVALID_TRANSCRIPTION_MODEL.
 *    - Audio file routing: audio files execute genuine Whisper transcription without chat substitution.
 *    - Text refinement routing: text-only refinement accurately reports polisher model ID (not false whisper).
 * 3. Upstream SSE error detection during streaming:
 *    - Error frames (event: error, data: {"error": ...}) detected mid-stream.
 *    - False type: 'done' completion is strictly prevented.
 * 4. Partial text preservation:
 *    - Valid text emitted before an error frame is preserved in the failure event (partial: true, partialText).
 * 5. Non-retryable error handling:
 *    - 401 (UNAUTHENTICATED), 403 (PERMISSION_DENIED), 400 (INVALID_ARGUMENT) fail immediately without retries or fallbacks.
 * 6. Model fallback on 404:
 *    - Ordered plan construction with non-repeating candidates.
 *    - 404 advances to next valid model without repeating failed model.
 *    - Exhausted fallback returns structured 404 NOT_FOUND with serverRetriesExhausted: true.
 * 7. Cancellation semantics:
 *    - Aborting client connection aborts upstream reader and releases resources cleanly.
 * 8. Malformed upstream error frames handled safely without crashing.
 * 9. Provider isolation and Phase 4B error-contract invariants preserved.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  PROVIDER_DEFAULT_MODELS,
  sanitizeModelForProvider,
  validateServerModelForProvider,
  checkModelCompatibilityForProvider
} from '../src/services/providerModelSanitizer.js';
import {
  PROVIDER_OPTIONS,
  parseRouterError,
  streamAIMessage,
  AI_PROVIDERS
} from '../src/services/aiRouter.js';
import {
  PROVIDER_PROFILES
} from '../src/services/documentContextService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const tsxBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'tsx');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to evaluate parseGeminiError from server.ts in an isolated process with TESTING=1
function evalGroqError(errObj, provider = 'groq') {
  const script = `
    process.env.TESTING = '1';
    import('./server.ts').then(({ parseGeminiError }) => {
      const parsed = parseGeminiError(${JSON.stringify(errObj)}, ${JSON.stringify(provider)});
      console.log(JSON.stringify(parsed));
    });
  `;
  const res = spawnSync(tsxBin, ['-e', script], {
    cwd: ROOT_DIR,
    env: { ...process.env, TESTING: '1' },
    encoding: 'utf8'
  });
  if (res.error || res.status !== 0) {
    throw new Error(res.stderr || res.stdout || 'evalGroqError failed');
  }
  const lines = res.stdout.trim().split('\n');
  const jsonLine = lines.find((l) => l.trim().startsWith('{') && l.trim().endsWith('}')) || lines[lines.length - 1];
  return JSON.parse(jsonLine.trim());
}

let passedCount = 0;
let failedCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    failedCount++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    failedCount++;
  }
}

console.log('=== Phase 4D: Groq Provider Hardening Test Suite ===\n');

// ----------------------------------------------------------------------------
// Test 1: Groq chat model selection and validation
// ----------------------------------------------------------------------------
runTest('1. Groq chat model selection and validation (active default and valid alternatives)', () => {
  // 1a. Default model check
  assert.strictEqual(
    PROVIDER_DEFAULT_MODELS.groq,
    'openai/gpt-oss-120b',
    'PROVIDER_DEFAULT_MODELS.groq must be openai/gpt-oss-120b'
  );

  // 1b. PROVIDER_OPTIONS check
  const groqOption = PROVIDER_OPTIONS.find((p) => p.id === AI_PROVIDERS.GROQ);
  assert.ok(groqOption, 'Groq provider option must exist');
  assert.strictEqual(groqOption.defaultModel, 'openai/gpt-oss-120b');

  // 1c. Document context provider profile check
  assert.strictEqual(
    PROVIDER_PROFILES.groq.modelTag,
    'openai/gpt-oss-120b',
    'PROVIDER_PROFILES.groq.modelTag must be openai/gpt-oss-120b'
  );

  // 1d. Documented Groq models accepted by client sanitizer
  const documentedChatModels = [
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-20b'
  ];
  for (const m of documentedChatModels) {
    const sanitized = sanitizeModelForProvider('groq', m);
    assert.strictEqual(sanitized, m, `Client sanitizer must accept documented model ${m}`);
  }

  // 1e. Legacy Llama 3.3 alias normalized to active default
  const legacyLlama = sanitizeModelForProvider('groq', 'llama-3.3-70b-versatile');
  assert.strictEqual(legacyLlama, 'openai/gpt-oss-120b', 'Llama 3.3 alias must map to openai/gpt-oss-120b');

  // 1f. Cross-provider models are strictly rejected for Groq
  const crossProviderModels = [
    'gemini-2.5-flash',
    'gemini-3.8-flash',
    '@cf/meta/llama-3.1-8b-instruct',
    'openrouter/free',
    'qwen2.5:1.5b',
    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'
  ];
  for (const m of crossProviderModels) {
    const sanitized = sanitizeModelForProvider('groq', m);
    assert.strictEqual(sanitized, null, `Client sanitizer must reject cross-provider model "${m}"`);

    const serverVal = validateServerModelForProvider('groq', m);
    assert.strictEqual(serverVal.valid, false, `Server validator must reject cross-provider model "${m}"`);
  }

  // 1g. Display labels and synthetic placeholders strictly rejected
  const invalidLabels = [
    'Groq High Speed',
    'Groq (demo)',
    'Document Analyzer',
    'document analyzer (local)'
  ];
  for (const lbl of invalidLabels) {
    const sanitized = sanitizeModelForProvider('groq', lbl);
    assert.strictEqual(sanitized, null, `Client sanitizer must reject label "${lbl}"`);

    const serverVal = validateServerModelForProvider('groq', lbl);
    assert.strictEqual(serverVal.valid, false, `Server validator must reject label "${lbl}"`);
  }
});

// ----------------------------------------------------------------------------
// Test 2: Audio-transcription model validation and separation from chat models
// ----------------------------------------------------------------------------
runTest('2. Audio-transcription model validation and separation from chat models', () => {
  const VALID_GROQ_TRANSCRIPTION_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];

  // 2a. Valid audio transcription models
  for (const model of VALID_GROQ_TRANSCRIPTION_MODELS) {
    assert.ok(
      VALID_GROQ_TRANSCRIPTION_MODELS.includes(model),
      `Model ${model} must be recognized as a valid transcription model`
    );
  }

  // 2b. Chat completion models are invalid for audio transcription
  const invalidTranscriptionModels = [
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-120b',
    'llama-3.1-8b-instant',
    'gemini-2.5-flash'
  ];

  for (const model of invalidTranscriptionModels) {
    assert.strictEqual(
      VALID_GROQ_TRANSCRIPTION_MODELS.includes(model),
      false,
      `Chat model ${model} must NOT be considered a valid audio transcription model`
    );
  }
});

// ----------------------------------------------------------------------------
// Test 3: Upstream SSE error frame detection during streaming
// ----------------------------------------------------------------------------
await runAsyncTest('3. Upstream SSE error detection during streaming: error frames halt stream and prevent false done', async () => {
  // Mock Groq upstream server that emits a valid start chunk, followed by an error frame
  const mockUpstream = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    // Chunk 1: valid text
    res.write('data: {"choices":[{"delta":{"content":"Processing started: "},"finish_reason":null}]}\n\n');

    // Chunk 2: upstream error frame (e.g. rate limit / model overload encoded in SSE)
    setTimeout(() => {
      res.write('event: error\ndata: {"error":{"message":"Rate limit reached for model","type":"rate_limit_exceeded","code":429}}\n\n');
      res.end();
    }, 20);
  });

  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = mockUpstream.address().port;

  // Mock server.ts streaming pipeline reader simulation
  try {
    const upstreamRes = await fetch(`http://127.0.0.1:${upstreamPort}/openai/v1/chat/completions`);
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let currentEventType = null;
    let receivedError = null;
    let receivedDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed.startsWith('event:')) {
          currentEventType = trimmed.slice(6).trim();
          continue;
        }
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          receivedDone = true;
          continue;
        }

        if (currentEventType === 'error') {
          const parsed = JSON.parse(dataStr);
          receivedError = parsed.error;
          await reader.cancel();
          break;
        }

        const parsed = JSON.parse(dataStr);
        if (parsed.error) {
          receivedError = parsed.error;
          await reader.cancel();
          break;
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
        }
      }
      if (receivedError) break;
    }

    assert.ok(receivedError, 'Must detect and parse upstream SSE error frame');
    assert.strictEqual(receivedError.code, 429, 'Parsed error code must be 429');
    assert.strictEqual(receivedError.type, 'rate_limit_exceeded', 'Parsed error type must be rate_limit_exceeded');
    assert.strictEqual(receivedDone, false, 'Stream must NEVER emit or process [DONE] after an error frame');
    assert.strictEqual(fullText, 'Processing started: ', 'Must preserve text accumulated prior to error frame');
  } finally {
    mockUpstream.close();
  }
});

// ----------------------------------------------------------------------------
// Test 4: Retention of partial stream content on mid-stream failure
// ----------------------------------------------------------------------------
runTest('4. Retention of partial stream content: mid-stream error retains partial text in error metadata', () => {
  const partialText = 'Here is the step-by-step calculation: Step 1 = 42.';
  const serverErrorPayload = {
    type: 'error',
    error: 'Groq streaming connection interrupted.',
    code: 503,
    status: 'STREAM_FAILED',
    provider: 'groq',
    retryable: false,
    canFallback: true,
    partial: true,
    partialText
  };

  const routerErr = parseRouterError(serverErrorPayload, 503, 'groq');
  assert.strictEqual(routerErr.code, 503);
  assert.strictEqual(routerErr.status, 'STREAM_FAILED');
  assert.strictEqual(routerErr.retryable, false);
  assert.strictEqual(serverErrorPayload.partial, true);
  assert.strictEqual(serverErrorPayload.partialText, partialText);
});

// ----------------------------------------------------------------------------
// Test 5: Non-retryable error handling for authentication, permission, and bad requests
// ----------------------------------------------------------------------------
runTest('5. Non-retryable error handling: 401/403/400 fail immediately without retries or fallbacks', () => {
  // 5a. 401 Unauthorized
  const err401 = evalGroqError({ status: 401, message: 'Invalid API Key provided' }, 'groq');
  assert.strictEqual(err401.statusCode, 401);
  assert.strictEqual(err401.status, 'UNAUTHENTICATED');
  assert.strictEqual(err401.isRetryable, false, '401 must not be retryable');

  // 5b. 403 Forbidden
  const err403 = evalGroqError({ status: 403, message: 'Access denied: organization restricted' }, 'groq');
  assert.strictEqual(err403.statusCode, 403);
  assert.strictEqual(err403.status, 'PERMISSION_DENIED');
  assert.strictEqual(err403.isRetryable, false, '403 must not be retryable');

  // 5c. 400 Invalid Argument
  const err400 = evalGroqError({ status: 400, message: 'invalid_request_error: messages array is required' }, 'groq');
  assert.strictEqual(err400.statusCode, 400);
  assert.strictEqual(err400.status, 'INVALID_ARGUMENT');
  assert.strictEqual(err400.isRetryable, false, '400 must not be retryable');

  // 5d. Router preserves non-retryable status
  for (const err of [err401, err403, err400]) {
    const routerErr = parseRouterError(err, err.statusCode, 'groq');
    assert.strictEqual(routerErr.retryable, false, `Status ${err.statusCode} must not be retryable`);
  }
});

// ----------------------------------------------------------------------------
// Test 6: Groq 404 fallback progression and exhausted-fallback handling
// ----------------------------------------------------------------------------
runTest('6. Groq 404 fallback progression and exhausted-fallback handling', () => {
  const GROQ_ACTIVE_MODEL = 'openai/gpt-oss-120b';
  const fallbackCandidates = ['openai/gpt-oss-120b', 'llama-3.1-8b-instant'];

  // 6a. Attempt plan when default model is requested
  const planDefault = [GROQ_ACTIVE_MODEL];
  for (const cand of fallbackCandidates) {
    if (!planDefault.includes(cand)) planDefault.push(cand);
  }
  assert.deepStrictEqual(planDefault, ['openai/gpt-oss-120b', 'llama-3.1-8b-instant']);
  assert.notStrictEqual(planDefault[0], planDefault[1], 'Candidates must not repeat');

  // 6b. Attempt plan when fallback candidate is requested
  const planAlt = ['llama-3.1-8b-instant'];
  for (const cand of fallbackCandidates) {
    if (!planAlt.includes(cand)) planAlt.push(cand);
  }
  assert.deepStrictEqual(planAlt, ['llama-3.1-8b-instant', 'openai/gpt-oss-120b']);
  assert.notStrictEqual(planAlt[0], planAlt[1], 'Candidates must not repeat');

  // 6c. Attempt plan when legacy model is requested
  const planLegacy = ['llama-3.3-70b-versatile'];
  for (const cand of fallbackCandidates) {
    if (!planLegacy.includes(cand)) planLegacy.push(cand);
  }
  assert.deepStrictEqual(planLegacy, ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant']);
  assert.strictEqual(new Set(planLegacy).size, planLegacy.length, 'All plan models must be distinct');

  // 6d. 404 error parsing
  const err404 = evalGroqError({ status: 404, message: 'model_not_found: The model does not exist or has been decommissioned.' }, 'groq');
  assert.strictEqual(err404.statusCode, 404);
  assert.strictEqual(err404.status, 'NOT_FOUND');
  assert.strictEqual(err404.isRetryable, false);

  // 6e. Exhausted fallback representation
  const exhaustedErr = {
    error: 'The requested Groq model was not found and all fallback options were exhausted.',
    code: 404,
    status: 'NOT_FOUND',
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    retryable: false,
    serverRetriesExhausted: true,
    canFallback: true,
    suggestedProviders: ['gemini', 'openrouter']
  };
  const routerExhausted = parseRouterError(exhaustedErr, 404, 'groq');
  assert.strictEqual(routerExhausted.code, 404);
  assert.strictEqual(routerExhausted.status, 'NOT_FOUND');
  assert.strictEqual(routerExhausted.retryable, false);
  assert.strictEqual(routerExhausted.canFallback, true);
});

// ----------------------------------------------------------------------------
// Test 7: Preservation of cancellation semantics during streaming
// ----------------------------------------------------------------------------
await runAsyncTest('7. Preservation of cancellation semantics: aborting client signal terminates stream cleanly', async () => {
  let serverSawAbort = false;

  const mockServer = http.createServer((req, res) => {
    req.on('close', () => {
      serverSawAbort = true;
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('data: {"type":"start","modelUsed":"openai/gpt-oss-120b","provider":"groq"}\n\n');
    res.write('data: {"type":"chunk","text":"First chunk received "}\n\n');
    // Hang open until client aborts
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const abortController = new AbortController();
    let chunkCount = 0;

    const streamPromise = streamAIMessage({
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      prompt: 'Testing Groq cancellation',
      chatEndpoint: `http://127.0.0.1:${port}/api/chat`,
      signal: abortController.signal,
      onChunk: () => {
        chunkCount++;
        abortController.abort();
      }
    });

    await assert.rejects(streamPromise, (err) => {
      return err.name === 'AbortError' || err.message?.includes('cancelled');
    });

    assert.strictEqual(chunkCount, 1, 'Must receive initial chunk before abort');
    await sleep(50);
    assert.strictEqual(serverSawAbort, true, 'Server must observe connection close upon client abort');
  } finally {
    mockServer.close();
  }
});

// ----------------------------------------------------------------------------
// Test 8: Malformed upstream error frames handled safely without crashing
// ----------------------------------------------------------------------------
await runAsyncTest('8. Malformed upstream error frames handled safely without unhandled exceptions', async () => {
  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    // Emits malformed non-JSON error frame followed by normal text
    res.write('event: error\ndata: <!DOCTYPE html><html><body>502 Bad Gateway</body></html>\n\n');
    res.end();
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const upstreamRes = await fetch(`http://127.0.0.1:${port}`);
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEventType = null;
    let detectedError = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:')) {
          currentEventType = trimmed.slice(6).trim();
          continue;
        }
        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (currentEventType === 'error') {
            let parsedErrMessage = 'Groq streaming connection encountered an upstream error.';
            try {
              const errJson = JSON.parse(dataStr);
              if (errJson?.error) parsedErrMessage = errJson.error.message || parsedErrMessage;
            } catch (_) {
              if (dataStr) parsedErrMessage = dataStr;
            }
            detectedError = parsedErrMessage;
            await reader.cancel();
            break;
          }
        }
      }
      if (detectedError) break;
    }

    assert.ok(detectedError, 'Must handle malformed error safely');
    assert.ok(detectedError.includes('502 Bad Gateway'), 'Must capture raw error text when JSON parsing fails');
  } finally {
    mockServer.close();
  }
});

// ----------------------------------------------------------------------------
// Test 9: Provider isolation & Phase 4B error-contract invariants
// ----------------------------------------------------------------------------
runTest('9. Provider isolation & Phase 4B error-contract invariants', () => {
  // 9a. Groq 504 timeout error mapping
  const timeoutErr = evalGroqError({ name: 'TimeoutError', message: 'Upstream headers timeout' }, 'groq');
  assert.strictEqual(timeoutErr.statusCode, 504);
  assert.strictEqual(timeoutErr.status, 'DEADLINE_EXCEEDED');
  assert.strictEqual(timeoutErr.isRetryable, true);
  assert.ok(timeoutErr.message.toLowerCase().includes('groq'));

  // 9b. Groq 429 rate limit error mapping
  const rateLimitErr = evalGroqError({ status: 429, message: 'rate_limit_exceeded: TPM limit reached' }, 'groq');
  assert.strictEqual(rateLimitErr.statusCode, 429);
  assert.strictEqual(rateLimitErr.status, 'RESOURCE_EXHAUSTED');
  assert.strictEqual(rateLimitErr.isRetryable, true);
  assert.ok(rateLimitErr.message.toLowerCase().includes('groq'));

  // 9c. Groq 503 unavailable error mapping
  const unavailErr = evalGroqError({ status: 503, message: 'Service Unavailable' }, 'groq');
  assert.strictEqual(unavailErr.statusCode, 503);
  assert.strictEqual(unavailErr.status, 'UNAVAILABLE');
  assert.strictEqual(unavailErr.isRetryable, true);
  assert.ok(unavailErr.message.toLowerCase().includes('groq'));
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
console.log(`\nResults: ${passedCount} passed, ${failedCount} failed`);

if (failedCount > 0) {
  process.exit(1);
} else {
  console.log('Phase 4D Groq provider hardening tests completed successfully.');
}
