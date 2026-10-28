/**
 * Phase 4H — Global Error Classification & Normalization Verification Suite
 *
 * 50 Comprehensive behavioral and unit checks verifying:
 * - Group A: Canonical Error Contract Structure & Normalization (Tests 1–10)
 * - Group B: Provider-Specific Error Classification across all 6 Providers (Tests 11–20)
 * - Group C: Error Classification Precedence & Ambiguity Resolution (Tests 21–30)
 * - Group D: Local Privacy Invariants & Security / Data Sanitization (Tests 31–40)
 * - Group E: Stream Disruption, Partial Output Preservation & Isolation Integration (Tests 41–50)
 *
 * Run with: node scripts/testPhase4H.js
 */

process.env.TESTING = '1';

import assert from 'node:assert/strict';
import http from 'node:http';

import {
  CanonicalAIError,
  normalizeAIError,
  isCanonicalAIError,
  sanitizeErrorMessage,
  ERROR_CATEGORIES,
  STANDARD_ERROR_CODES
} from '../src/services/errorNormalizationService.js';

import {
  AI_PROVIDERS,
  parseRouterError,
  streamAIMessage
} from '../src/services/aiRouter.js';

import {
  WebLLMError,
  WEBLLM_ERROR_CODES,
  normalizeWebLLMError
} from '../src/services/webllmService.js';

import {
  createRequestIsolationController,
  cancelActiveChatRequest,
  runIsolatedPromptStream
} from '../src/services/requestIsolationService.js';

const { app } = await import('../server.ts');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

console.log('================================================================');
console.log('Phase 4H — Global Error Classification & Normalization Suite');
console.log('================================================================\n');

// ============================================================================
// Group A: Canonical Error Contract Structure & Normalization (Tests 1–10)
// ============================================================================
console.log('--- Group A: Canonical Error Contract Structure & Normalization ---');

// Test 1: Normalizes string error to full canonical structure
await runTest('1. Normalizes string error to full canonical structure', async () => {
  const err = normalizeAIError('Simple connection drop', {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    requestId: 'req-001'
  });

  assert.ok(isCanonicalAIError(err));
  assert.equal(typeof err.code, 'string');
  assert.equal(err.provider, 'gemini');
  assert.equal(err.model, 'gemini-2.5-flash');
  assert.equal(typeof err.httpStatus, 'number');
  assert.equal(typeof err.retryable, 'boolean');
  assert.equal(typeof err.canFallback, 'boolean');
  assert.equal(typeof err.cancelled, 'boolean');
  assert.equal(typeof err.timeout, 'boolean');
  assert.equal(typeof err.partial, 'boolean');
  assert.equal(typeof err.partialText, 'string');
  assert.equal(err.requestId, 'req-001');
});

// Test 2: Normalizes native Error instance preserving cause
await runTest('2. Normalizes native Error instance preserving cause', async () => {
  const underlying = new Error('Underlying socket closed');
  const nativeErr = new Error('Gateway timeout', { cause: underlying });
  nativeErr.code = 504;

  const normalized = normalizeAIError(nativeErr, { provider: 'groq' });
  assert.ok(isCanonicalAIError(normalized));
  assert.equal(normalized.code, STANDARD_ERROR_CODES.DEADLINE_EXCEEDED);
  assert.equal(normalized.timeout, true);
  assert.equal(normalized.httpStatus, 504);
  assert.equal(normalized.cause, nativeErr);
});

// Test 3: Normalizes null/undefined/empty input to safe generic contract
await runTest('3. Normalizes null/undefined/empty input to safe generic contract', async () => {
  for (const emptyInput of [null, undefined, '', {}]) {
    const norm = normalizeAIError(emptyInput);
    assert.ok(isCanonicalAIError(norm));
    assert.equal(norm.httpStatus, 500);
    assert.equal(typeof norm.message, 'string');
    assert.ok(norm.message.length > 0);
    assert.equal(norm.retryable, false);
  }
});

// Test 4: Normalizes nested JSON error strings without throwing or losing status
await runTest('4. Normalizes nested JSON error strings without throwing or losing status', async () => {
  const jsonErrString = JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'Quota exceeded for project 12345'
    }
  });

  const norm = normalizeAIError(jsonErrString, { provider: 'gemini' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.RATE_LIMITED);
  assert.equal(norm.httpStatus, 429);
  assert.equal(norm.retryable, true);
});

// Test 5: Preserves existing canonical error instance idempotently without double-wrapping
await runTest('5. Preserves existing canonical error instance idempotently without double-wrapping', async () => {
  const original = new CanonicalAIError({
    code: STANDARD_ERROR_CODES.AUTH_FAILED,
    message: 'Invalid API key',
    provider: 'cloudflare',
    httpStatus: 401
  });

  const processed = normalizeAIError(original);
  assert.strictEqual(processed, original);
});

// Test 6: Ensures error objects are serializable to JSON
await runTest('6. Ensures error objects are serializable to JSON', async () => {
  const err = normalizeAIError('Upstream outage', {
    provider: 'openrouter',
    model: 'openrouter/free',
    requestId: 42
  });

  const jsonRepresentation = JSON.parse(JSON.stringify(err));
  assert.equal(jsonRepresentation.provider, 'openrouter');
  assert.equal(jsonRepresentation.requestId, 42);
  assert.equal(typeof jsonRepresentation.code, 'string');
  assert.equal(typeof jsonRepresentation.httpStatus, 'number');
});

// Test 7: Handles missing optional metadata with safe defaults
await runTest('7. Handles missing optional metadata with safe defaults', async () => {
  const err = normalizeAIError('Bare error');
  assert.equal(err.model, null);
  assert.equal(err.requestId, null);
  assert.equal(err.partialText, '');
  assert.equal(err.partial, false);
});

// Test 8: Guarantees httpStatus is always a valid integer (400-599)
await runTest('8. Guarantees httpStatus is always a valid integer (400-599)', async () => {
  const err1 = normalizeAIError({ message: 'Bad request', httpStatus: 'invalid' });
  assert.equal(err1.httpStatus, 500);

  const err2 = normalizeAIError({ message: 'Out of range', httpStatus: 200 });
  assert.equal(err2.httpStatus, 500);

  const err3 = normalizeAIError({ message: 'Valid 404', httpStatus: 404 });
  assert.equal(err3.httpStatus, 404);
});

// Test 9: Guarantees retryable and canFallback are always strict booleans
await runTest('9. Guarantees retryable and canFallback are always strict booleans', async () => {
  const err = normalizeAIError({
    message: 'Test',
    retryable: 'yes',
    canFallback: 1
  });

  assert.strictEqual(typeof err.retryable, 'boolean');
  assert.strictEqual(typeof err.canFallback, 'boolean');
});

// Test 10: Preserves requestId when passed through context or error payload
await runTest('10. Preserves requestId when passed through context or error payload', async () => {
  const errWithCtx = normalizeAIError('Failed', { requestId: 'chat-turn-123' });
  assert.equal(errWithCtx.requestId, 'chat-turn-123');

  const errWithPayload = normalizeAIError({ message: 'Failed', requestId: 999 });
  assert.equal(errWithPayload.requestId, 999);
});

// ============================================================================
// Group B: Provider-Specific Error Classification across all 6 Providers (Tests 11–20)
// ============================================================================
console.log('\n--- Group B: Provider-Specific Error Classification across all 6 Providers ---');

// Test 11: Gemini: Classifies safety filter block
await runTest('11. Gemini: Classifies safety filter block', async () => {
  const rawGeminiSafety = {
    message: 'Candidate was blocked due to SAFETY',
    status: 'SAFETY_BLOCKED',
    finishReason: 'SAFETY'
  };

  const norm = normalizeAIError(rawGeminiSafety, { provider: 'gemini' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.SAFETY_BLOCKED);
  assert.equal(norm.httpStatus, 400);
  assert.equal(norm.retryable, false);
  assert.equal(norm.finishReason, 'SAFETY');
});

// Test 12: Gemini: Classifies quota/rate limit error
await runTest('12. Gemini: Classifies quota/rate limit error', async () => {
  const rawGemini429 = {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Resource has been exhausted (e.g. check quota).'
  };

  const norm = normalizeAIError(rawGemini429, { provider: 'gemini' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.RATE_LIMITED);
  assert.equal(norm.httpStatus, 429);
  assert.equal(norm.retryable, true);
});

// Test 13: Groq: Classifies rate limit with retry metadata
await runTest('13. Groq: Classifies rate limit with retry metadata', async () => {
  const rawGroq = {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Rate limit reached for model openai/gpt-oss-120b. Please try again in 5s.',
    retryAfterSeconds: 5
  };

  const norm = normalizeAIError(rawGroq, { provider: 'groq' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.RATE_LIMITED);
  assert.equal(norm.httpStatus, 429);
  assert.equal(norm.retryable, true);
  assert.equal(norm.retryAfterSeconds, 5);
});

// Test 14: Groq: Classifies invalid model or decommissioned model
await runTest('14. Groq: Classifies invalid model or decommissioned model', async () => {
  const rawGroqModel = {
    code: 404,
    status: 'NOT_FOUND',
    message: 'The model llama-3-70b-8192 has been decommissioned.'
  };

  const norm = normalizeAIError(rawGroqModel, { provider: 'groq' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.MODEL_NOT_FOUND);
  assert.equal(norm.httpStatus, 404);
  assert.equal(norm.retryable, false);
});

// Test 15: OpenRouter: Classifies dynamic free model routing exhaustion
await runTest('15. OpenRouter: Classifies dynamic free model routing exhaustion', async () => {
  const rawOpenRouter = {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Free tier limits exceeded for openrouter/free.'
  };

  const norm = normalizeAIError(rawOpenRouter, { provider: 'openrouter' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.RATE_LIMITED);
  assert.equal(norm.httpStatus, 429);
  assert.equal(norm.retryable, true);
});

// Test 16: OpenRouter: Classifies upstream provider outage / bad gateway
await runTest('16. OpenRouter: Classifies upstream provider outage / bad gateway', async () => {
  const rawBadGateway = {
    code: 502,
    status: 'BAD_GATEWAY',
    message: 'Provider returned 502 Bad Gateway.'
  };

  const norm = normalizeAIError(rawBadGateway, { provider: 'openrouter' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.BAD_GATEWAY);
  assert.equal(norm.httpStatus, 502);
  assert.equal(norm.retryable, true);
});

// Test 17: Cloudflare: Classifies unconfigured credentials / invalid token
await runTest('17. Cloudflare: Classifies unconfigured credentials / invalid token', async () => {
  const rawCfAuth = {
    code: 401,
    status: 'UNAUTHENTICATED',
    message: 'Invalid API Token for Cloudflare Workers AI.'
  };

  const norm = normalizeAIError(rawCfAuth, { provider: 'cloudflare' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.UNAUTHENTICATED);
  assert.equal(norm.httpStatus, 401);
  assert.equal(norm.retryable, false);
});

// Test 18: Cloudflare: Classifies Workers AI upstream execution error
await runTest('18. Cloudflare: Classifies Workers AI upstream execution error', async () => {
  const rawCf500 = {
    code: 500,
    status: 'INTERNAL',
    message: 'Workers AI execution exception in pipeline.'
  };

  const norm = normalizeAIError(rawCf500, { provider: 'cloudflare' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.INTERNAL);
  assert.equal(norm.httpStatus, 500);
  assert.equal(norm.retryable, false);
});

// Test 19: Ollama: Classifies local daemon connection failure with local instructions
await runTest('19. Ollama: Classifies local daemon connection failure with local instructions', async () => {
  const rawOllamaConn = {
    code: 503,
    status: 'NETWORK_FAILURE',
    message: 'fetch failed (ECONNREFUSED)'
  };

  const norm = normalizeAIError(rawOllamaConn, { provider: 'ollama' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.CONNECTION_REFUSED);
  assert.equal(norm.httpStatus, 503);
  assert.equal(norm.retryable, false);
  assert.equal(norm.canFallback, false);
  assert.ok(norm.message.includes('ollama serve'));
  assert.ok(norm.message.includes('11434'));
});

// Test 20: WebLLM: Classifies missing WebGPU runtime capability
await runTest('20. WebLLM: Classifies missing WebGPU runtime capability', async () => {
  const rawWebGPU = new WebLLMError('Cannot find WebGPU', {
    code: WEBLLM_ERROR_CODES.WEBGPU_UNSUPPORTED,
    httpCode: 400
  });

  const norm = normalizeAIError(rawWebGPU, { provider: 'webllm' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.WEBGPU_UNSUPPORTED);
  assert.equal(norm.httpStatus, 400);
  assert.equal(norm.retryable, false);
  assert.equal(norm.canFallback, false);
});

// ============================================================================
// Group C: Error Classification Precedence & Ambiguity Resolution (Tests 21–30)
// ============================================================================
console.log('\n--- Group C: Error Classification Precedence & Ambiguity Resolution ---');

// Test 21: Precedence: User cancellation / abort supersedes network failure
await runTest('21. Precedence: User cancellation / abort supersedes network failure', async () => {
  const abortErr = new Error('The operation was aborted');
  abortErr.name = 'AbortError';

  const norm = normalizeAIError(abortErr, { provider: 'groq' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.REQUEST_CANCELLED);
  assert.equal(norm.cancelled, true);
  assert.equal(norm.retryable, false);
  assert.equal(norm.canFallback, false);
});

// Test 22: Precedence: Timeout / deadline exceeded supersedes generic abort when timeout occurred
await runTest('22. Precedence: Timeout / deadline exceeded supersedes generic abort when timeout occurred', async () => {
  const timeoutErr = new Error('Request timed out after 30000ms');
  timeoutErr.name = 'TimeoutError';

  const norm = normalizeAIError(timeoutErr, { provider: 'gemini', isTimeout: true });
  assert.equal(norm.code, STANDARD_ERROR_CODES.DEADLINE_EXCEEDED);
  assert.equal(norm.timeout, true);
  assert.equal(norm.cancelled, false);
  assert.equal(norm.httpStatus, 504);
});

// Test 23: Precedence: Auth failure supersedes generic invalid argument
await runTest('23. Precedence: Auth failure supersedes generic invalid argument', async () => {
  const authErr = {
    code: 401,
    status: 'UNAUTHENTICATED',
    message: 'API key not valid. Please pass a valid API key.'
  };

  const norm = normalizeAIError(authErr, { provider: 'gemini' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.UNAUTHENTICATED);
  assert.equal(norm.httpStatus, 401);
  assert.equal(norm.retryable, false);
});

// Test 24: Precedence: Unsupported / missing model supersedes generic 404
await runTest('24. Precedence: Unsupported / missing model supersedes generic 404', async () => {
  const modelErr = {
    code: 404,
    status: 'NOT_FOUND',
    message: 'Model nonexistent-model-xyz not found'
  };

  const norm = normalizeAIError(modelErr, { provider: 'groq' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.MODEL_NOT_FOUND);
  assert.equal(norm.httpStatus, 404);
  assert.equal(norm.retryable, false);
});

// Test 25: Precedence: Context length exceeded supersedes generic bad request
await runTest('25. Precedence: Context length exceeded supersedes generic bad request', async () => {
  const contextErr = {
    code: 400,
    status: 'CONTEXT_LENGTH_EXCEEDED',
    message: 'This model supports at most 8192 tokens. Your prompt requested 9500.'
  };

  const norm = normalizeAIError(contextErr, { provider: 'groq' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED);
  assert.equal(norm.httpStatus, 400);
  assert.equal(norm.retryable, false);
  assert.equal(norm.canFallback, false);
});

// Test 26: Precedence: Payload too large (413) supersedes generic validation errors
await runTest('26. Precedence: Payload too large (413) supersedes generic validation errors', async () => {
  const payloadErr = {
    code: 413,
    status: 'PAYLOAD_TOO_LARGE',
    message: 'Image payload exceeds 3.0 MB budget.'
  };

  const norm = normalizeAIError(payloadErr, { provider: 'gemini' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.PAYLOAD_TOO_LARGE);
  assert.equal(norm.httpStatus, 413);
  assert.equal(norm.canFallback, false);
  assert.equal(norm.retryable, false);
});

// Test 27: Precedence: WebGPU shader-f16 incompatibility resolves to SHADER_F16_UNSUPPORTED
await runTest('27. Precedence: WebGPU shader-f16 incompatibility resolves to SHADER_F16_UNSUPPORTED', async () => {
  const f16Err = new Error('Device does not support shader-f16 feature');
  const norm = normalizeAIError(f16Err, { provider: 'webllm' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.SHADER_F16_UNSUPPORTED);
  assert.equal(norm.httpStatus, 400);
  assert.equal(norm.canFallback, false);
});

// Test 28: Precedence: WebLLM offline uncached resolves to OFFLINE_UNCACHED over generic error
await runTest('28. Precedence: WebLLM offline uncached resolves to OFFLINE_UNCACHED over generic error', async () => {
  const offlineErr = {
    status: 'WEBLLM_OFFLINE_UNCACHED',
    message: 'Model has not been downloaded to this browser yet.'
  };

  const norm = normalizeAIError(offlineErr, { provider: 'webllm' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.OFFLINE_UNCACHED);
  assert.equal(norm.httpStatus, 503);
  assert.equal(norm.canFallback, false);
});

// Test 29: Precedence: Rate limit with retry-after header correctly extracts delay
await runTest('29. Precedence: Rate limit with retry-after header correctly extracts delay', async () => {
  const rateLimit = {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Too many requests.',
    retryAfterSeconds: 12
  };

  const norm = normalizeAIError(rateLimit, { provider: 'gemini' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.RATE_LIMITED);
  assert.equal(norm.retryAfterSeconds, 12);
  assert.equal(norm.retryable, true);
});

// Test 30: Precedence: Internal server error with exhausted server retries sets retryable: false
await runTest('30. Precedence: Internal server error with exhausted server retries sets retryable: false', async () => {
  const exhaustedErr = {
    code: 503,
    status: 'UNAVAILABLE',
    serverRetriesExhausted: true
  };

  const norm = normalizeAIError(exhaustedErr, { provider: 'gemini' });
  assert.equal(norm.retryable, false);
});

// ============================================================================
// Group D: Local Privacy Invariants & Security / Data Sanitization (Tests 31–40)
// ============================================================================
console.log('\n--- Group D: Local Privacy Invariants & Security / Data Sanitization ---');

// Test 31: Ollama invariant: canFallback is strictly false across all Ollama error types
await runTest('31. Ollama invariant: canFallback is strictly false across all Ollama error types', async () => {
  const errors = [
    { code: 503, status: 'UNAVAILABLE' },
    { code: 404, status: 'NOT_FOUND' },
    { code: 504, status: 'DEADLINE_EXCEEDED' },
    { code: 500, status: 'INTERNAL', canFallback: true } // explicit attempt to enable fallback
  ];

  for (const raw of errors) {
    const norm = normalizeAIError(raw, { provider: 'ollama' });
    assert.strictEqual(norm.canFallback, false, `Ollama error must never have canFallback: true (${norm.code})`);
  }
});

// Test 32: WebLLM invariant: canFallback is strictly false across all WebLLM error types
await runTest('32. WebLLM invariant: canFallback is strictly false across all WebLLM error types', async () => {
  const errors = [
    { code: 400, status: 'WEBGPU_UNSUPPORTED' },
    { code: 507, status: 'DEVICE_LOST' },
    { code: 500, status: 'WORKER_CRASHED', canFallback: true }
  ];

  for (const raw of errors) {
    const norm = normalizeAIError(raw, { provider: 'webllm' });
    assert.strictEqual(norm.canFallback, false, `WebLLM error must never have canFallback: true (${norm.code})`);
  }
});

// Test 33: Sanitization: Strips Gemini API keys (AIza...) from user-facing error messages
await runTest('33. Sanitization: Strips Gemini API keys (AIza...) from user-facing error messages', async () => {
  const leakedKey = 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q';
  const rawMsg = `Request failed: invalid key ${leakedKey} for project`;
  const sanitized = sanitizeErrorMessage(rawMsg);

  assert.ok(!sanitized.includes(leakedKey));
  assert.ok(sanitized.includes('[REDACTED_API_KEY]'));
});

// Test 34: Sanitization: Strips Groq API keys (gsk_...) from user-facing error messages
await runTest('34. Sanitization: Strips Groq API keys (gsk_...) from user-facing error messages', async () => {
  const leakedKey = 'gsk_1234567890abcdef1234567890abcdef12345678';
  const rawMsg = `Groq authorization error using key ${leakedKey} on endpoint`;
  const sanitized = sanitizeErrorMessage(rawMsg);

  assert.ok(!sanitized.includes(leakedKey));
  assert.ok(sanitized.includes('[REDACTED_API_KEY]'));
});

// Test 35: Sanitization: Strips OpenRouter API keys (sk-or-...) from user-facing error messages
await runTest('35. Sanitization: Strips OpenRouter API keys (sk-or-...) from user-facing error messages', async () => {
  const leakedKey = 'sk-or-v1-abcdef0123456789abcdef0123456789abcdef';
  const rawMsg = `OpenRouter error with token ${leakedKey}`;
  const sanitized = sanitizeErrorMessage(rawMsg);

  assert.ok(!sanitized.includes(leakedKey));
  assert.ok(sanitized.includes('[REDACTED_API_KEY]'));
});

// Test 36: Sanitization: Strips Bearer authorization tokens from user-facing error messages
await runTest('36. Sanitization: Strips Bearer authorization tokens from user-facing error messages', async () => {
  const rawMsg = 'Failed upstream headers: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.tokenBody.sig';
  const sanitized = sanitizeErrorMessage(rawMsg);

  assert.ok(!sanitized.includes('eyJhbGci'));
  assert.ok(sanitized.includes('Bearer [REDACTED]'));
});

// Test 37: Sanitization: Strips secret environment variable assignments from messages
await runTest('37. Sanitization: Strips secret environment variable assignments from messages', async () => {
  const rawMsg = 'Server environment contains GEMINI_API_KEY=AIzaSySecret123456789 and GROQ_API_KEY=gsk_SecretVal123456';
  const sanitized = sanitizeErrorMessage(rawMsg);

  assert.ok(!sanitized.includes('AIzaSySecret'));
  assert.ok(!sanitized.includes('gsk_SecretVal'));
  assert.ok(sanitized.includes('GEMINI_API_KEY=[REDACTED]'));
});

// Test 38: Sanitization: Redacts user prompt contents if included in raw upstream error payloads
await runTest('38. Sanitization: Redacts user prompt contents if included in raw upstream error payloads', async () => {
  const sensitivePrompt = 'My private secret bank statement password 12345';
  const rawMsg = `Provider rejected prompt: "${sensitivePrompt}" due to content error`;
  const sanitized = sanitizeErrorMessage(rawMsg, { promptText: sensitivePrompt });

  assert.ok(!sanitized.includes(sensitivePrompt));
  assert.ok(sanitized.includes('[USER_PROMPT]'));
});

// Test 39: Cloud providers permit fallback on temporary outages
await runTest('39. Cloud providers permit fallback on temporary outages', async () => {
  for (const cloudProv of ['gemini', 'groq', 'openrouter', 'cloudflare']) {
    const err = normalizeAIError({ code: 503, status: 'UNAVAILABLE' }, { provider: cloudProv });
    assert.strictEqual(err.canFallback, true, `Expected ${cloudProv} to permit fallback on 503`);
  }
});

// Test 40: Cloud providers reject fallback on non-fallback errors (e.g. 413 Payload Too Large)
await runTest('40. Cloud providers reject fallback on non-fallback errors (e.g. 413 Payload Too Large)', async () => {
  for (const cloudProv of ['gemini', 'groq', 'openrouter', 'cloudflare']) {
    const err = normalizeAIError({ code: 413, status: 'PAYLOAD_TOO_LARGE' }, { provider: cloudProv });
    assert.strictEqual(err.canFallback, false, `Expected ${cloudProv} to reject fallback on 413`);
  }
});

// ============================================================================
// Group E: Stream Disruption, Partial Output Preservation & Isolation Integration (Tests 41–50)
// ============================================================================
console.log('\n--- Group E: Stream Disruption, Partial Output Preservation & Isolation Integration ---');

// Test 41: Mid-stream interruption preserves partial: true and partialText
await runTest('41. Mid-stream interruption preserves partial: true and partialText', async () => {
  const streamDrop = {
    code: 503,
    status: 'STREAM_FAILED',
    message: 'Connection terminated mid-stream'
  };

  const norm = normalizeAIError(streamDrop, {
    provider: 'groq',
    partialText: 'Here is the first paragraph of the response.',
    partial: true
  });

  assert.equal(norm.partial, true);
  assert.equal(norm.partialText, 'Here is the first paragraph of the response.');
  assert.equal(norm.retryable, false); // Never auto-retry if partial tokens were already shown
});

// Test 42: Pre-stream interruption sets partial: false and empty partialText
await runTest('42. Pre-stream interruption sets partial: false and empty partialText', async () => {
  const norm = normalizeAIError('Connection failed before headers', {
    provider: 'gemini',
    partialText: '',
    partial: false
  });

  assert.equal(norm.partial, false);
  assert.equal(norm.partialText, '');
});

// Test 43: Request cancellation preserves visible streamed text without trailing buffer leakage
await runTest('43. Request cancellation preserves visible streamed text without trailing buffer leakage', async () => {
  const controller = createRequestIsolationController();
  const entry = controller.beginRequest({
    chatId: 'chat-test-cancel',
    assistantMessageId: 'msg-cancel-1',
    provider: 'gemini'
  });

  controller.recordProgress(entry.requestId, {
    displayedText: 'Visible output chunk.',
    partialText: 'Visible output chunk. Hidden trailing buffer that should not leak.'
  });

  let finalizedMessage = null;
  cancelActiveChatRequest(controller, 'stopped', {
    getActiveChatId: () => 'chat-test-cancel',
    onUpdateMessages: (updater) => {
      finalizedMessage = updater([{ id: 'msg-cancel-1', content: '' }])[0];
    },
    onPersistMessage: () => {},
    onSetLoadingState: () => {},
    findExistingAssistantMessage: () => null
  });

  assert.ok(finalizedMessage);
  assert.equal(finalizedMessage.content, 'Visible output chunk.');
  assert.ok(!finalizedMessage.content.includes('Hidden trailing buffer'));
});

// Test 44: Stream parse error classifies as STREAM_INTERRUPTED or MALFORMED_STREAM_FRAME
await runTest('44. Stream parse error classifies as STREAM_INTERRUPTED or MALFORMED_STREAM_FRAME', async () => {
  const malformed = {
    status: 'MALFORMED_STREAM_FRAME',
    message: 'Unexpected end of JSON stream frame'
  };

  const norm = normalizeAIError(malformed, { provider: 'cloudflare' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.MALFORMED_STREAM_FRAME);
  assert.equal(norm.category, ERROR_CATEGORIES.STREAMING_AND_GENERATION);
});

// Test 45: WebLLM device lost mid-stream preserves accumulated text and sets partial: true
await runTest('45. WebLLM device lost mid-stream preserves accumulated text and sets partial: true', async () => {
  const devLost = new WebLLMError('Device was lost during generation', {
    code: WEBLLM_ERROR_CODES.DEVICE_LOST,
    httpCode: 507,
    partial: true,
    partialText: 'Partial WebLLM text before GPU crash'
  });

  const norm = normalizeAIError(devLost, { provider: 'webllm' });
  assert.equal(norm.code, STANDARD_ERROR_CODES.DEVICE_LOST);
  assert.equal(norm.partial, true);
  assert.equal(norm.partialText, 'Partial WebLLM text before GPU crash');
  assert.equal(norm.canFallback, false);
});

// Test 46: Request isolation controller rejects UI mutation for cancelled request errors
await runTest('46. Request isolation controller rejects UI mutation for cancelled request errors', async () => {
  const controller = createRequestIsolationController();
  const entryA = controller.beginRequest({
    chatId: 'chat-iso-1',
    assistantMessageId: 'msg-a',
    provider: 'gemini'
  });

  // Cancel Request A
  controller.cancelActiveRequest('stopped');

  // Verify that canMutateChatUI rejects Request A
  assert.equal(controller.canMutateChatUI(entryA.requestId, 'chat-iso-1', 'chat-iso-1'), false);
  assert.equal(controller.isRequestActive(entryA.requestId), false);
});

// Test 47: Monotonic request isolation ensures only the active request error updates visible state
await runTest('47. Monotonic request isolation ensures only the active request error updates visible state', async () => {
  const controller = createRequestIsolationController();

  const reqA = controller.beginRequest({
    chatId: 'chat-mono-1',
    assistantMessageId: 'msg-a',
    provider: 'groq'
  });

  // Start Request B which supersedes Request A
  const reqB = controller.beginRequest({
    chatId: 'chat-mono-1',
    assistantMessageId: 'msg-b',
    provider: 'gemini'
  });

  assert.equal(controller.isRequestActive(reqA.requestId), false);
  assert.equal(controller.isRequestActive(reqB.requestId), true);
});

// Test 48: Switching conversations isolates error message to target chat without polluting visible chat
await runTest('48. Switching conversations isolates error message to target chat without polluting visible chat', async () => {
  const controller = createRequestIsolationController();
  let currentVisibleChat = 'chat-target';

  const entry = controller.beginRequest({
    chatId: 'chat-target',
    assistantMessageId: 'msg-conv-switch',
    provider: 'openrouter'
  });

  // User switches to a different conversation
  currentVisibleChat = 'chat-other';

  assert.equal(controller.canMutateChatUI(entry.requestId, 'chat-target', currentVisibleChat), false);
});

// Test 49: classifyError integration in runIsolatedPromptStream returns canonical structure with status: 'error'
await runTest('49. classifyError integration in runIsolatedPromptStream returns canonical structure with status: error', async () => {
  const controller = createRequestIsolationController();
  let uiUpdated = false;

  const result = await runIsolatedPromptStream({
    controller,
    targetChatId: 'chat-run-test',
    assistantMessageId: 'msg-run-err',
    providerToUse: 'gemini',
    promptText: 'Trigger test error',
    getActiveChatId: () => 'chat-run-test',
    onUpdateMessages: () => { uiUpdated = true; },
    onPersistMessage: () => {},
    onSetLoadingState: () => {},
    findExistingAssistantMessage: () => null,
    streamRequest: async () => {
      const err = new Error('Upstream quota limit');
      err.code = 429;
      err.status = 'RESOURCE_EXHAUSTED';
      throw err;
    },
    classifyError: (err, ctx) => {
      const norm = normalizeAIError(err, { provider: ctx.providerToUse });
      return {
        friendlyMsg: norm.message,
        effectiveProvider: norm.provider,
        canSwitchProvider: norm.canFallback,
        errorCode: norm.code,
        canonicalError: norm
      };
    }
  });

  assert.equal(result.status, 'error');
  assert.ok(result.error);
  assert.ok(result.classifiedErr);
  assert.equal(result.classifiedErr.errorCode, STANDARD_ERROR_CODES.RATE_LIMITED);
  assert.ok(uiUpdated);
});

// Test 50: Full end-to-end routing through parseRouterError produces canonical error contract on failure
await runTest('50. Full end-to-end routing through parseRouterError produces canonical error contract on failure', async () => {
  const parsed = parseRouterError(
    { error: 'High traffic surge', status: 'UNAVAILABLE' },
    503,
    'gemini'
  );

  assert.equal(parsed.code, 503);
  assert.equal(parsed.status, 'UNAVAILABLE');
  assert.equal(parsed.retryable, true);
  assert.equal(parsed.canFallback, true);
  assert.equal(parsed.timeout, false);
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.partial, false);
  assert.ok(parsed.message.includes('high demand'));
});

console.log('\n================================================================');
console.log(`Phase 4H Test Results: ${passed} Passed, ${failed} Failed out of 50 tests`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
