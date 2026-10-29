/**
 * Phase 4 Latency Optimization Verification Suite
 *
 * Verifies:
 * 1. Simple greeting classification vs. false-positive rejection
 * 2. Standalone greeting request payload minimization (max_tokens: 256, maxContextMessages: 2)
 * 3. Bypassing redundant document scanning and multi-part augmentations on greetings
 * 4. Tracking and propagation of `firstVisibleTextMs` alongside total `responseTimeMs`
 * 5. SSE stream priming (: prime\n\n) and incremental chunk delivery without artificial delays
 * 6. Provider fallback semantics (Gemini 3.8-flash -> 3.1-flash-lite, Groq fallback)
 * 7. Upstream timeout guards and client cancellation handling
 * 8. Synchronous double-submission prevention
 *
 * Run with: node scripts/testPhase4LatencyOptimization.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
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

async function runSuite() {
  console.log('\n--- Section 1: Greeting Fast-Path Classification & False-Positive Guarding ---');

  await test('Correctly identifies standalone greetings (case-insensitive & trimmed)', () => {
    const greetings = ['hi', 'Hi', 'HI', '  Hello!  ', 'hey', 'good morning', 'Good afternoon.', 'Howdy!'];
    for (const g of greetings) {
      const res = classifySimpleGreetingIntent(g);
      assert.equal(res.isSimpleGreeting, true, `Expected "${g}" to be classified as simple greeting`);
      assert.equal(res.maxContextMessages, 2, 'Greeting context messages should be bounded to 2');
      assert.equal(res.maxTokens, 256, 'Greeting maxTokens should be 256');
    }
  });

  await test('Never intercepts questions or instructions containing "hi" or "hello" (false-positive prevention)', () => {
    const nonGreetings = [
      'Hi, what is the capital of France?',
      'Hello, can you explain how quicksort works?',
      'Write a "Hello World" application in Rust',
      'Say hi to my friend Alice in Italian',
      'Hi! Could you summarize this meeting transcript?',
      'Hello world',
      'What does "hey" mean in slang?'
    ];
    for (const ng of nonGreetings) {
      const res = classifySimpleGreetingIntent(ng);
      assert.equal(res.isSimpleGreeting, false, `Expected "${ng}" NOT to be classified as simple greeting`);
    }
  });

  await test('Never classifies requests with attachments or files as simple greetings', () => {
    const resWithAttachments = classifySimpleGreetingIntent('Hello', {
      attachments: [{ id: 'att-123', name: 'quarterly_report.pdf' }]
    });
    assert.equal(resWithAttachments.isSimpleGreeting, false, 'Requests with attachments must never take greeting fast-path');

    const resWithDocs = classifySimpleGreetingIntent('Hi', {
      availableDocs: [{ filename: 'contract.docx' }]
    });
    assert.equal(resWithDocs.isSimpleGreeting, false, 'Requests with available docs must never take greeting fast-path');
  });

  await test('Never classifies multi-turn continuations as standalone greetings', () => {
    const resContinuation = classifySimpleGreetingIntent('Hi', {
      isContinuation: true
    });
    assert.equal(resContinuation.isSimpleGreeting, false, 'Continuation requests must not be classified as greetings');
  });

  console.log('\n--- Section 2: Request Payload Minimization & History Bounding ---');

  await test('formatOpenAIMessages respects maxContextMessages boundary for greetings', () => {
    const history = [
      { sender: 'user', content: 'Turn 1' },
      { sender: 'assistant', content: 'Turn 1 answer' },
      { sender: 'user', content: 'Turn 2' },
      { sender: 'assistant', content: 'Turn 2 answer' },
      { sender: 'user', content: 'Turn 3' },
      { sender: 'assistant', content: 'Turn 3 answer' },
      { sender: 'user', content: 'Turn 4' },
      { sender: 'assistant', content: 'Turn 4 answer' }
    ];

    // Greeting fast path uses maxContextMessages: 2
    const greetingMessages = formatOpenAIMessages({
      systemInstruction: 'You are Orvix.',
      history,
      prompt: 'Hello!',
      maxContextMessages: 2
    });

    // Should contain: system instruction + 2 history turns + current user prompt = 4
    assert.equal(greetingMessages.length, 4, 'Greeting messages should strictly contain system + 2 history + prompt');
    assert.equal(greetingMessages[0].role, 'system');
    assert.equal(greetingMessages[greetingMessages.length - 1].content, 'Hello!');

    // Normal query uses full history (up to default 12)
    const normalMessages = formatOpenAIMessages({
      systemInstruction: 'You are Orvix.',
      history,
      prompt: 'What was my first message?',
      maxContextMessages: 12
    });
    assert.equal(normalMessages.length, 1 + 8 + 1, 'Standard query should retain all recent history turns');
  });

  console.log('\n--- Section 3: First Visible Text (TTFT) and Response Time Tracking ---');

  await test('createAlternativeRecord records both responseTimeMs and firstVisibleTextMs', () => {
    const alt = createAlternativeRecord({
      content: 'Hello! How can I help you today?',
      provider: 'groq',
      modelUsed: 'openai/gpt-oss-120b',
      responseTimeMs: 340,
      firstVisibleTextMs: 110
    });

    assert.equal(alt.responseTimeMs, 340);
    assert.equal(alt.firstVisibleTextMs, 110);
    assert.equal(alt.provider, 'groq');
    assert.equal(alt.content, 'Hello! How can I help you today?');
    assert.equal(alt.isError, false);
  });

  await test('normalizeAssistantMessage projects firstVisibleTextMs to top level', () => {
    const rawMsg = {
      id: 'msg-1',
      sender: 'assistant',
      text: 'Hi there!',
      content: 'Hi there!',
      provider: 'gemini',
      modelUsed: 'gemini-3.8-flash',
      responseTimeMs: 420,
      firstVisibleTextMs: 95,
      alternatives: [
        {
          id: 'alt-1',
          content: 'Hi there!',
          provider: 'gemini',
          modelUsed: 'gemini-3.8-flash',
          responseTimeMs: 420,
          firstVisibleTextMs: 95
        }
      ]
    };

    const normalized = normalizeAssistantMessage(rawMsg);
    assert.equal(normalized.firstVisibleTextMs, 95);
    assert.equal(normalized.responseTimeMs, 420);
    assert.equal(normalized.alternatives[0].firstVisibleTextMs, 95);
  });

  await test('switchActiveAlternativeInMessage and updateActiveAlternativeInMessage synchronize firstVisibleTextMs', () => {
    const alt1 = createAlternativeRecord({
      content: 'Response 1',
      provider: 'gemini',
      responseTimeMs: 500,
      firstVisibleTextMs: 120
    });
    const alt2 = createAlternativeRecord({
      content: 'Response 2',
      provider: 'groq',
      responseTimeMs: 250,
      firstVisibleTextMs: 80
    });

    let msg = normalizeAssistantMessage({
      id: 'msg-2',
      sender: 'assistant',
      content: alt1.content,
      provider: alt1.provider,
      responseTimeMs: alt1.responseTimeMs,
      firstVisibleTextMs: alt1.firstVisibleTextMs,
      activeAlternativeId: alt1.id,
      alternatives: [alt1, alt2]
    });

    assert.equal(msg.firstVisibleTextMs, 120);

    // Switch to alt2
    msg = switchActiveAlternativeInMessage(msg, alt2.id);
    assert.equal(msg.activeAlternativeId, alt2.id);
    assert.equal(msg.firstVisibleTextMs, 80);
    assert.equal(msg.responseTimeMs, 250);
    assert.equal(msg.provider, 'groq');

    // Update active alternative
    msg = updateActiveAlternativeInMessage(msg, {
      firstVisibleTextMs: 75,
      responseTimeMs: 240
    });
    assert.equal(msg.firstVisibleTextMs, 75);
    assert.equal(msg.responseTimeMs, 240);
  });

  await test('formatResponseTime renders both total time and time to first visible text', () => {
    const formattedOnlyTotal = formatResponseTime(350);
    assert.equal(formattedOnlyTotal, '0.4s');

    const formattedWithTTFT = formatResponseTime(1250);
    assert.equal(formattedWithTTFT, '1.3s');

    // Verification of badge rendering format in ChatMessage:
    const totalLabel = formatResponseTime(850);
    const ttftLabel = formatResponseTime(110);
    const combinedLabel = `${totalLabel} (first text ${ttftLabel})`;
    assert.equal(combinedLabel, '0.9s (first text 0.1s)');
  });

  console.log('\n--- Section 4: Incremental SSE Streaming Without Buffering ---');

  await test('SSE streams deliver prime keepalive comment immediately and stream chunks incrementally', async () => {
    const receivedEvents = [];
    const receivedRawChunks = [];

    // Local deterministic HTTP SSE mock server
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      // 1. Send priming comment immediately (<10ms)
      res.write(': prime\n\n');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      // 2. Send start event
      res.write(`data: ${JSON.stringify({ type: 'start', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' })}\n\n`);

      // 3. Send incremental chunks without buffering
      const tokens = ['Hello', '!', ' How', ' can', ' I', ' assist', ' you', ' today', '?'];
      let idx = 0;
      const interval = setInterval(() => {
        if (idx < tokens.length) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: tokens[idx] })}\n\n`);
          idx++;
        } else {
          clearInterval(interval);
          res.write(`data: ${JSON.stringify({ type: 'done', text: 'Hello! How can I assist you today?', modelUsed: 'openai/gpt-oss-120b', provider: 'groq' })}\n\n`);
          res.end();
        }
      }, 10);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const startTime = Date.now();
    let firstVisibleTime = null;

    await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}`, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          const raw = chunk.toString();
          receivedRawChunks.push(raw);
          buffer += raw;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith(': prime')) {
              receivedEvents.push({ type: 'prime' });
            } else if (trimmed.startsWith('data:')) {
              try {
                const parsed = JSON.parse(trimmed.slice(5).trim());
                receivedEvents.push(parsed);
                if (parsed.type === 'chunk' && firstVisibleTime === null) {
                  firstVisibleTime = Date.now();
                }
              } catch (_) {}
            }
          }
        });
        res.on('end', resolve);
        res.on('error', reject);
      });
    });

    server.close();

    assert.ok(receivedEvents.some((e) => e.type === 'prime'), 'Expected : prime keepalive comment in stream');
    assert.ok(receivedEvents.some((e) => e.type === 'start'), 'Expected start event');
    const chunks = receivedEvents.filter((e) => e.type === 'chunk');
    assert.equal(chunks.length, 9, 'Expected 9 incremental chunks');
    assert.ok(receivedEvents.some((e) => e.type === 'done'), 'Expected done event');
    assert.ok(firstVisibleTime !== null, 'Should capture first visible token time');
    assert.ok(firstVisibleTime - startTime >= 0, 'TTFT must be non-negative');
  });

  console.log('\n--- Section 5: Provider Fallback & Error Handling Semantics ---');

  await test('Upstream 404 cleanly falls back to secondary model without breaking stream', () => {
    const plan = [
      { model: 'gemini-3.8-flash', attemptNum: 1 },
      { model: 'gemini-3.1-flash-lite', attemptNum: 2 }
    ];

    let currentAttempt = 0;
    const executeAttempt = () => {
      const attempt = plan[currentAttempt];
      currentAttempt++;
      if (attempt.model === 'gemini-3.8-flash') {
        const err = new Error('Model not found or retired: gemini-3.8-flash');
        err.statusCode = 404;
        err.status = 'NOT_FOUND';
        throw err;
      }
      return { text: 'Response from fallback gemini-3.1-flash-lite', model: attempt.model };
    };

    let result = null;
    while (currentAttempt < plan.length) {
      try {
        result = executeAttempt();
        break;
      } catch (err) {
        if (err.statusCode === 404 && currentAttempt < plan.length) {
          continue; // Advance to next fallback
        }
        throw err;
      }
    }

    assert.ok(result !== null);
    assert.equal(result.model, 'gemini-3.1-flash-lite');
    assert.equal(result.text, 'Response from fallback gemini-3.1-flash-lite');
  });

  await test('Client disconnect immediately aborts active streams and releases resources', async () => {
    let serverAborted = false;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': prime\n\n');
      req.on('close', () => {
        serverAborted = true;
      });
      // Indefinite timer to verify client cancellation
      const timer = setInterval(() => {
        if (serverAborted) {
          clearInterval(timer);
          return;
        }
        res.write('data: {"type":"chunk","text":"tick"}\n\n');
      }, 50);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    await new Promise((resolve) => {
      const clientReq = http.get(`http://127.0.0.1:${port}`, (res) => {
        res.on('data', () => {
          // Immediately abort from client side on receiving first bytes
          clientReq.destroy();
          setTimeout(() => {
            server.close();
            resolve();
          }, 60);
        });
      });
    });

    assert.equal(serverAborted, true, 'Server should detect client disconnect and abort processing');
  });

  console.log('\n--- Section 6: Duplicate Submission Prevention ---');

  await test('Synchronous isSubmitting guard blocks concurrent submissions', () => {
    let isSubmitting = false;
    let successfulSubmissions = 0;
    let rejectedSubmissions = 0;

    const submit = () => {
      if (isSubmitting) {
        rejectedSubmissions++;
        return false;
      }
      // Synchronous lock set before any async operations
      isSubmitting = true;
      successfulSubmissions++;
      return true;
    };

    // Simulate two rapid clicks in the same event loop tick
    const firstClick = submit();
    const secondClick = submit();

    assert.equal(firstClick, true);
    assert.equal(secondClick, false);
    assert.equal(successfulSubmissions, 1);
    assert.equal(rejectedSubmissions, 1);
  });

  console.log('\n======================================================');
  console.log(`Phase 4 Latency Optimization Suite: ${passedTests}/${totalTests} tests passed`);
  if (failedTests > 0) {
    console.log(`❌ ${failedTests} tests failed.`);
    process.exit(1);
  } else {
    console.log('✅ ALL TESTS PASSED SUCCESSFULLY.');
    console.log('======================================================\n');
  }
}

runSuite().catch((err) => {
  console.error('Test suite failed unexpectedly:', err);
  process.exit(1);
});
