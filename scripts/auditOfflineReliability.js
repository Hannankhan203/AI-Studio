/**
 * Orvix Offline Reliability & Production Hardening Automated Audit
 * Validates offline readiness logic, document parsers, model resolution,
 * service worker configuration, and build artifact integrity.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { extractDocumentContent } from '../src/services/documentExtractor.js';

import {
  isBrowserExtractable,
  countWords,
  truncateSafely,
  extractSectionsFromMarkdown,
  parseDelimitedText
} from '../src/services/browserDocumentExtractor.js';

import {
  DEFAULT_WEBLLM_MODEL_ID,
  FALLBACK_F32_WEBLLM_MODEL_ID,
  LIGHTWEIGHT_WEBLLM_MODEL_ID,
  LIGHTWEIGHT_F32_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  WEBLLM_ERROR_CODES,
  WebLLMError,
  resolveWebLLMModelId
} from '../src/services/webllmService.js';

import {
  formatSpeechTranscript,
  combineComposerText,
  mergeTranscriptSegments
} from '../src/hooks/useVoiceDictation.js';

import {
  polishSpokenTranscript
} from '../src/utils/speechTextCleaner.js';

import {
  prepareDocumentContext,
  generateSimulatedDocumentResponse,
  isVisionCapableProvider,
  isImageAttachment,
  PROVIDER_PROFILES
} from '../src/services/documentContextService.js';

import JSZip from 'jszip';
import {
  validateImageBuffer,
  normalizeOcrText,
  detectReadableText,
  extractImageText,
  rawImageDataToBmp,
  discardOcrWorker
} from '../src/services/imageOcrService.js';

console.log('--- Starting Orvix Offline Reliability Audit ---');

let passedTests = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => {
          console.log(`  ✓ ${name}`);
          passedTests++;
        })
        .catch((err) => {
          console.error(`  ✗ FAIL: ${name}`);
          console.error(err);
          process.exit(1);
        });
    }
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------
// 1. Document Format Support Decisions
// ----------------------------------------------------------------------------
test('isBrowserExtractable accurately identifies supported browser document formats', () => {
  const supported = ['txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'docx', 'pdf', 'pptx'];
  for (const ext of supported) {
    assert.strictEqual(isBrowserExtractable(ext), true, `Extension .${ext} should be extractable in browser`);
    assert.strictEqual(isBrowserExtractable(`.${ext}`), true, `Extension with dot .${ext} should be extractable`);
  }

  // Common MIME types
  assert.strictEqual(isBrowserExtractable('', 'application/pdf'), true);
  assert.strictEqual(isBrowserExtractable('', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
  assert.strictEqual(isBrowserExtractable('', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), true);
  assert.strictEqual(isBrowserExtractable('', 'text/markdown'), true);
  assert.strictEqual(isBrowserExtractable('', 'text/csv'), true);
  assert.strictEqual(isBrowserExtractable('', 'application/json'), true);
});

test('isBrowserExtractable rejects unsupported, binary, or image formats requiring server OCR', () => {
  const unsupported = ['doc', 'ppt', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'zip', 'exe', 'mp4'];
  for (const ext of unsupported) {
    assert.strictEqual(isBrowserExtractable(ext), false, `Extension .${ext} must NOT be reported as extractable`);
  }
  assert.strictEqual(isBrowserExtractable('', 'image/png'), false);
  assert.strictEqual(isBrowserExtractable('', 'application/msword'), false);
  assert.strictEqual(isBrowserExtractable('', 'application/vnd.ms-powerpoint'), false);
});

// ----------------------------------------------------------------------------
// 2. Client-side Parsing Utilities
// ----------------------------------------------------------------------------
test('countWords handles empty strings and multi-line whitespace accurately', () => {
  assert.strictEqual(countWords(''), 0);
  assert.strictEqual(countWords('   \n\t  '), 0);
  assert.strictEqual(countWords('Hello world'), 2);
  assert.strictEqual(countWords('The quick brown\nfox jumps\tover the   lazy dog.'), 9);
});

test('truncateSafely respects character thresholds and appends warning when needed', () => {
  const shortText = 'This is a short text document.';
  const res1 = truncateSafely(shortText, 50);
  assert.strictEqual(res1.isTruncated, false);
  assert.strictEqual(res1.text, shortText);

  const longText = 'A'.repeat(100);
  const res2 = truncateSafely(longText, 40);
  assert.strictEqual(res2.isTruncated, true);
  assert.ok(res2.text.startsWith('A'.repeat(40)));
  assert.ok(res2.text.includes('[... Remaining content truncated for performance ...]'));
});

test('extractSectionsFromMarkdown splits headings properly', () => {
  const md = `# Title\n\nIntro text.\n\n## Section 1\n\nDetails about section 1.\n\n### Subsection\n\nDeep info.`;
  const sections = extractSectionsFromMarkdown(md);
  assert.strictEqual(sections.length, 3);
  assert.strictEqual(sections[0].heading, 'Title');
  assert.strictEqual(sections[0].level, 1);
  assert.strictEqual(sections[1].heading, 'Section 1');
  assert.strictEqual(sections[1].level, 2);
  assert.strictEqual(sections[2].heading, 'Subsection');
  assert.strictEqual(sections[2].level, 3);
});

test('parseDelimitedText accurately parses quoted CSV and formats Markdown tables', () => {
  const csv = `Name,Role,Notes\n"Smith, John",Engineer,"Expert in WebGPU, PWA"\n"Doe, Jane",Designer,"UX Lead"`;
  const table = parseDelimitedText(csv, ',');
  assert.strictEqual(table.rowCount, 2);
  assert.strictEqual(table.headers.length, 3);
  assert.strictEqual(table.headers[0], 'Name');
  assert.strictEqual(table.headers[1], 'Role');
  assert.strictEqual(table.previewRows[0][0], 'Smith, John');
  assert.strictEqual(table.previewRows[0][2], 'Expert in WebGPU, PWA');
  assert.ok(table.markdownTable.includes('| Name'));
  assert.ok(table.markdownTable.includes('| Smith, John'));
});

// ----------------------------------------------------------------------------
// 3. WebLLM Model Catalog & Resolution Logic
// ----------------------------------------------------------------------------
test('WEBLLM_MODEL_CATALOG contains verified 1.5B and 0.5B models with valid configurations', () => {
  assert.ok(WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID], 'Default 1.5B model must exist');
  assert.ok(WEBLLM_MODEL_CATALOG[FALLBACK_F32_WEBLLM_MODEL_ID], 'Fallback 1.5B FP32 model must exist');
  assert.ok(WEBLLM_MODEL_CATALOG[LIGHTWEIGHT_WEBLLM_MODEL_ID], 'Lightweight 0.5B model must exist');
  assert.ok(WEBLLM_MODEL_CATALOG[LIGHTWEIGHT_F32_WEBLLM_MODEL_ID], 'Lightweight 0.5B FP32 model must exist');

  const defaultModel = WEBLLM_MODEL_CATALOG[DEFAULT_WEBLLM_MODEL_ID];
  assert.strictEqual(defaultModel.prefersShaderF16, true);
  assert.strictEqual(defaultModel.f32FallbackModelId, FALLBACK_F32_WEBLLM_MODEL_ID);
  assert.ok(defaultModel.estimatedDownloadMB > 0);
  assert.ok(defaultModel.minStorageBytes > defaultModel.estimatedDownloadMB * 1024 * 1024);
});

test('resolveWebLLMModelId correctly resolves shader-f16 vs fp32 fallback', () => {
  // With shader-f16 available: keep default
  const withF16 = resolveWebLLMModelId(DEFAULT_WEBLLM_MODEL_ID, { hasShaderF16: true });
  assert.strictEqual(withF16, DEFAULT_WEBLLM_MODEL_ID);

  // Without shader-f16: fallback to FP32 variant
  const withoutF16 = resolveWebLLMModelId(DEFAULT_WEBLLM_MODEL_ID, { hasShaderF16: false, allowF32Fallback: true });
  assert.strictEqual(withoutF16, FALLBACK_F32_WEBLLM_MODEL_ID);

  // Lightweight model fallback
  const lightweightWithoutF16 = resolveWebLLMModelId(LIGHTWEIGHT_WEBLLM_MODEL_ID, { hasShaderF16: false, allowF32Fallback: true });
  assert.strictEqual(lightweightWithoutF16, LIGHTWEIGHT_F32_WEBLLM_MODEL_ID);
});

test('WebLLMError enforces local non-fallback invariants', () => {
  const err = new WebLLMError('Test error', { code: WEBLLM_ERROR_CODES.DEVICE_LOST });
  assert.strictEqual(err.canFallback, false, 'Local Browser AI errors must never trigger silent cloud fallback');
  assert.strictEqual(err.provider, 'webllm');
  assert.strictEqual(err.errorCode, WEBLLM_ERROR_CODES.DEVICE_LOST);
});

// ----------------------------------------------------------------------------
// 4. Production Service Worker & Precache Manifest Verification
// ----------------------------------------------------------------------------
test('Generated production service worker contains required precached chunks and routes', () => {
  const swPath = path.resolve('dist/sw.js');
  assert.ok(fs.existsSync(swPath), 'dist/sw.js must be generated after build');

  const swContent = fs.readFileSync(swPath, 'utf8');

  // Verify navigation route and denylist
  assert.ok(swContent.includes('NavigationRoute'), 'sw.js must register NavigationRoute');
  assert.ok(swContent.includes('/index.html'), 'NavigationRoute must fallback to /index.html');
  assert.ok(/\/api\//.test(swContent) || swContent.includes('\\/api\\/'), 'Navigation denylist must exclude /api/');
  assert.ok(/\/health/.test(swContent) || swContent.includes('\\/health'), 'Navigation denylist must exclude /health');
  assert.ok(/\/upload/.test(swContent) || swContent.includes('\\/upload'), 'Navigation denylist must exclude /upload');

  // Verify NetworkOnly routes for external weights & API
  assert.ok(swContent.includes('NetworkOnly'), 'sw.js must register NetworkOnly for API and weights');

  // Verify essential lazy chunks in precache
  assert.ok(swContent.includes('webllmWorker-'), 'WebLLM dedicated worker must be in precache manifest');
  assert.ok(swContent.includes('pdfjs-'), 'PDF parsing chunk (unpdf) must be in precache manifest');
  assert.ok(swContent.includes('jszip'), 'PPTX parsing chunk (jszip) must be in precache manifest');

  // Verify model weights are NOT in precache
  assert.ok(!swContent.includes('resolve/main/params_shard'), 'Model weights must NOT be precached via Workbox');
  assert.ok(!swContent.includes('huggingface.co/Qwen'), 'Model weights URLs must NOT be in Workbox precache');
});

// ----------------------------------------------------------------------------
// 5. Speech Recognition Segment Accumulation & Technical Formatting
// ----------------------------------------------------------------------------
test('formatSpeechTranscript formats technical English vocabulary and verbal punctuation accurately', () => {
  const spoken =
    'can you write a function for palindrome in javascript period and explain var comma const comma let comma functions comma arrow functions comma objects comma arrays comma callbacks comma promises comma async await comma and ecmascript question mark';

  const formatted = formatSpeechTranscript(spoken);
  assert.ok(formatted.includes('palindrome'), 'Must preserve "palindrome"');
  assert.ok(formatted.includes('JavaScript'), 'Must capitalize "JavaScript"');
  assert.ok(formatted.includes('. And explain'), 'Must convert "period" to dot and capitalize next sentence');
  assert.ok(formatted.includes('var, const, let'), 'Must convert verbal commas cleanly without spaces before punctuation');
  assert.ok(formatted.includes('async/await'), 'Must format "async await" to "async/await"');
  assert.ok(formatted.includes('ECMAScript?'), 'Must format "ecmascript question mark" to "ECMAScript?"');
});

test('formatSpeechTranscript protects Math.random from palindrome disambiguation', () => {
  const spoken = 'generate a random number using math.random';
  const formatted = formatSpeechTranscript(spoken);
  assert.ok(formatted.includes('Math.random'), 'Must preserve "Math.random" without converting to palindrome');
});

test('combineComposerText preserves existing typed text without dropping words or creating double spaces', () => {
  const existing = 'Here is my existing code:\n';
  const speech = 'generate a palindrome function in JavaScript.';
  const combined = combineComposerText(existing, speech);

  assert.strictEqual(
    combined,
    'Here is my existing code:\ngenerate a palindrome function in JavaScript.',
    'Must cleanly preserve existing composer base text'
  );

  const existingWithSpace = 'Tell me about ';
  const speech2 = 'TypeScript interfaces.';
  assert.strictEqual(combineComposerText(existingWithSpace, speech2), 'Tell me about TypeScript interfaces.');
});

test('Speech recognition simulation accumulates multi-part chronological segments without dropping early words', () => {
  // Simulates Web Speech API emitting sequential phrases across multiple indices in event.results
  const mockResults = [
    { isFinal: true, 0: { transcript: 'generate JavaScript palindrome code' } },
    { isFinal: true, 0: { transcript: 'and explain var const let' } },
    { isFinal: false, 0: { transcript: 'functions and arrow functions' } },
    { isFinal: false, 0: { transcript: 'async await and ECMAScript' } }
  ];

  // 1. Finalized results accumulation
  const committedSegments = [];
  for (let i = 0; i < mockResults.length; i++) {
    const res = mockResults[i];
    if (res.isFinal) {
      committedSegments.push({
        index: i,
        text: formatSpeechTranscript(res[0].transcript)
      });
    }
  }

  // 2. Unfinalized interim results concatenation (NOT overwriting)
  const unfinalizedParts = [];
  for (let i = 0; i < mockResults.length; i++) {
    const res = mockResults[i];
    if (!res.isFinal) {
      unfinalizedParts.push(res[0].transcript.trim());
    }
  }
  const currentInterim = unfinalizedParts.join(' ');

  // 3. Final session assembly
  let allFinalSpeech = '';
  for (const seg of committedSegments) {
    allFinalSpeech = combineComposerText(allFinalSpeech, seg.text);
  }
  if (currentInterim) {
    allFinalSpeech = combineComposerText(allFinalSpeech, currentInterim);
  }

  const finalFormatted = formatSpeechTranscript(allFinalSpeech);

  assert.ok(finalFormatted.includes('Generate JavaScript palindrome code'), 'Must retain the beginning of the sentence');
  assert.ok(finalFormatted.includes('var const let'), 'Must retain middle clauses');
  assert.ok(finalFormatted.includes('functions and arrow functions'), 'Must retain intermediate unfinalized clauses');
  assert.ok(finalFormatted.includes('async/await and ECMAScript'), 'Must retain final clauses and format technical terms');
  assert.ok(!finalFormatted.startsWith('async/await'), 'Must NEVER truncate to only the last phrase');
});

test('mergeTranscriptSegments cleanly deduplicates word overlap across silence restarts and engine breaks', () => {
  // Exact match
  assert.strictEqual(mergeTranscriptSegments('hello world', 'hello world'), 'hello world');

  // Superset progressive expansion
  assert.strictEqual(
    mergeTranscriptSegments('generate javascript', 'generate javascript palindrome code'),
    'generate javascript palindrome code'
  );

  // Trailing echo
  assert.strictEqual(
    mergeTranscriptSegments('functions and arrow functions', 'arrow functions'),
    'functions and arrow functions'
  );

  // Word boundary overlap (e.g. 2 words repeated across silence restart)
  assert.strictEqual(
    mergeTranscriptSegments('explain var const let and', 'let and functions arrow functions'),
    'explain var const let and functions arrow functions'
  );

  // Non-overlapping chronological segments
  assert.strictEqual(
    mergeTranscriptSegments('generate JavaScript palindrome code.', 'And explain async/await and ECMAScript.'),
    'generate JavaScript palindrome code. And explain async/await and ECMAScript.'
  );

  // Empty handling
  assert.strictEqual(mergeTranscriptSegments('', 'test speech'), 'test speech');
  assert.strictEqual(mergeTranscriptSegments('test speech', ''), 'test speech');
});

test('Multi-instance speech accumulation survives browser silence cutoffs without losing earlier sentences', () => {
  // Simulates user speaking a long technical request where Chrome cuts off after each pause:
  // Utterance 1 (Instance 1): "can you write a function for palindrome in JavaScript"
  // Engine restart...
  // Utterance 2 (Instance 2): "and explain var const let functions and arrow functions"
  // Engine restart...
  // Utterance 3 (Instance 3): "objects arrays callbacks promises async await and ECMAScript"
  let sessionAccumulatedText = '';

  const instance1Final = 'can you write a function for palindrome in JavaScript';
  sessionAccumulatedText = mergeTranscriptSegments(sessionAccumulatedText, instance1Final);

  const instance2Final = 'and explain var comma const comma let comma functions and arrow functions';
  sessionAccumulatedText = mergeTranscriptSegments(sessionAccumulatedText, instance2Final);

  const instance3Final = 'objects arrays callbacks promises async await and ECMAScript';
  sessionAccumulatedText = mergeTranscriptSegments(sessionAccumulatedText, instance3Final);

  const formattedSession = formatSpeechTranscript(sessionAccumulatedText);

  // Verify all parts of the spoken prompt are present
  assert.ok(formattedSession.includes('Can you write a function for palindrome in JavaScript'), 'Must retain Utterance 1');
  assert.ok(formattedSession.includes('var, const, let'), 'Must retain Utterance 2');
  assert.ok(formattedSession.includes('arrow functions'), 'Must retain arrow functions');
  assert.ok(formattedSession.includes('async/await and ECMAScript'), 'Must retain Utterance 3 and format technical terms');
  assert.ok(!formattedSession.startsWith('ECMAScript'), 'Must never truncate to only the final word');
});

test('Truncation detection triggers audio fallback when substantial speech duration yields suspiciously few words', () => {
  // Check truncation detection predicate
  const isTruncated = (cleanSpeech, durationSec, hasAudio) => {
    const wordCount = cleanSpeech ? cleanSpeech.split(/\s+/).filter(Boolean).length : 0;
    return hasAudio && (!cleanSpeech || (durationSec >= 3 && wordCount <= 2) || (durationSec >= 6 && wordCount <= 4));
  };

  // Normal short phrase (e.g. 1 sec "hello") -> not truncated
  assert.strictEqual(isTruncated('hello', 1, true), false);

  // Normal 5 sec with 12 words -> not truncated
  assert.strictEqual(isTruncated('Can you write code for a palindrome function in JavaScript right now', 5, true), false);

  // Long 8 second recording with only 1 word returned ("ECMAScript") -> detected as truncated!
  assert.strictEqual(isTruncated('ECMAScript', 8, true), true);

  // 4 second recording with 2 words returned -> detected as truncated!
  assert.strictEqual(isTruncated('ECMAScript code', 4, true), true);

  // Empty speech with audio -> detected as truncated / empty!
  assert.strictEqual(isTruncated('', 5, true), true);

  // No audio captured -> cannot fallback
  assert.strictEqual(isTruncated('ECMAScript', 8, false), false);
});

// ----------------------------------------------------------------------------
// 6. Phase 2A: Image OCR & Vision Multimodal Dispatch Regression Tests
// ----------------------------------------------------------------------------
test('isVisionCapableProvider correctly identifies vision-capable models vs text-only models', () => {
  // Gemini is vision-capable
  assert.strictEqual(isVisionCapableProvider('gemini'), true);
  assert.strictEqual(isVisionCapableProvider('GEMINI'), true);
  assert.strictEqual(isVisionCapableProvider('gemini', 'gemini-3.8-flash'), true);
  assert.strictEqual(isVisionCapableProvider('gemini', 'gemini-flash-latest'), true);

  // All other providers are text-only
  assert.strictEqual(isVisionCapableProvider('groq'), false);
  assert.strictEqual(isVisionCapableProvider('openrouter'), false);
  assert.strictEqual(isVisionCapableProvider('cloudflare'), false);
  assert.strictEqual(isVisionCapableProvider('ollama'), false);
  assert.strictEqual(isVisionCapableProvider('webllm'), false);
  assert.strictEqual(isVisionCapableProvider(''), false);
  assert.strictEqual(isVisionCapableProvider(null), false);

  // PROVIDER_PROFILES reflects vision capability accurately
  assert.strictEqual(PROVIDER_PROFILES.gemini.supportsVision, true);
  assert.strictEqual(PROVIDER_PROFILES.groq.supportsVision, false);
  assert.strictEqual(PROVIDER_PROFILES.openrouter.supportsVision, false);
  assert.strictEqual(PROVIDER_PROFILES.cloudflare.supportsVision, false);
  assert.strictEqual(PROVIDER_PROFILES.ollama.supportsVision, false);
  assert.strictEqual(PROVIDER_PROFILES.webllm.supportsVision, false);
});

test('Phase 2A Acceptance Test 1: A photograph without text reaches Gemini multimodal request without premature rejection', () => {
  const photoDoc = {
    fileId: 'photo-1',
    originalName: 'nature_photo.jpg',
    filename: 'nature_photo.jpg',
    format: 'JPG',
    mimeType: 'image/jpeg',
    status: 'ready',
    success: true,
    isImage: true,
    hasText: false,
    text: '',
    totalCharacters: 0,
    totalWords: 0
  };

  const geminiPrep = prepareDocumentContext('What animals are in this picture?', [photoDoc], {
    provider: 'gemini'
  });

  // Must NOT prematurely reject with directAnswer
  assert.strictEqual(geminiPrep.directAnswer, undefined, 'Gemini must not receive premature directAnswer rejection');
  assert.strictEqual(geminiPrep.isVision, true, 'isVision must be true for Gemini');
  assert.ok(geminiPrep.formattedContext.includes('nature_photo.jpg'), 'Filename must be present in formattedContext');
  assert.ok(
    geminiPrep.formattedContext.includes('Multimodal visual analysis') ||
    geminiPrep.formattedContext.includes('visual contents'),
    'Context must indicate multimodal visual analysis is active'
  );

  // Simulated response in demo mode must describe visual analysis, not reject
  const simulatedResp = generateSimulatedDocumentResponse('What animals are in this picture?', geminiPrep);
  assert.ok(!simulatedResp.includes('No readable text detected in this image.'), 'Demo response must not reject without text');
  assert.ok(simulatedResp.includes('Visual Analysis'), 'Demo response must provide visual analysis');
});

test('Phase 2A Acceptance Test 2: An image containing text retains its existing OCR text and AI processing pathway', () => {
  const receiptDoc = {
    fileId: 'receipt-1',
    originalName: 'coffee_receipt.png',
    filename: 'coffee_receipt.png',
    format: 'PNG',
    mimeType: 'image/png',
    status: 'ready',
    success: true,
    isImage: true,
    hasText: true,
    text: 'BLUE BOTTLE COFFEE\nEspresso Blend $4.50\nSubtotal: $4.50\nTotal: $4.88',
    totalCharacters: 68,
    totalWords: 10,
    lineCount: 4
  };

  // For Gemini: OCR text is included in formattedContext AND directAnswer is undefined
  const geminiPrep = prepareDocumentContext('What was the total on the receipt?', [receiptDoc], {
    provider: 'gemini'
  });
  assert.strictEqual(geminiPrep.directAnswer, undefined);
  assert.ok(geminiPrep.formattedContext.includes('BLUE BOTTLE COFFEE'));
  assert.ok(geminiPrep.formattedContext.includes('Total: $4.88'));
  assert.ok(geminiPrep.formattedContext.includes('[Extracted OCR Text from Image "coffee_receipt.png"]'));

  // For Groq (text-only): OCR text is also included in formattedContext AND directAnswer is undefined
  const groqPrep = prepareDocumentContext('What was the total on the receipt?', [receiptDoc], {
    provider: 'groq'
  });
  assert.strictEqual(groqPrep.directAnswer, undefined);
  assert.ok(groqPrep.formattedContext.includes('BLUE BOTTLE COFFEE'));
  assert.ok(groqPrep.formattedContext.includes('Total: $4.88'));
});

test('Phase 2A Acceptance Test 3: OCR failure does not prevent Gemini from analyzing a valid image', () => {
  const failedOcrImage = {
    fileId: 'failed-ocr-1',
    originalName: 'diagram.png',
    filename: 'diagram.png',
    format: 'PNG',
    mimeType: 'image/png',
    status: 'error',
    success: false,
    isImage: true,
    hasText: false,
    text: '',
    error: 'Offline image text extraction is unavailable because the local OCR engine could not be initialized.',
    totalCharacters: 0,
    totalWords: 0
  };

  // For Gemini: directAnswer must NOT block visual inspection
  const geminiPrep = prepareDocumentContext('Explain this diagram', [failedOcrImage], {
    provider: 'gemini'
  });
  assert.strictEqual(geminiPrep.directAnswer, undefined, 'OCR failure must not block Gemini visual analysis');
  assert.ok(geminiPrep.formattedContext.includes('OCR FAILED'), 'Context must distinguish OCR failure');
  assert.ok(geminiPrep.formattedContext.includes('multimodal vision model'), 'Context must note multimodal vision fallback');

  // For text-only providers (Groq): OCR failure DOES produce directAnswer explanation to prevent hallucination
  const groqPrep = prepareDocumentContext('Explain this diagram', [failedOcrImage], {
    provider: 'groq'
  });
  assert.ok(groqPrep.directAnswer, 'Text-only model must receive directAnswer on OCR failure');
  assert.ok(groqPrep.directAnswer.includes('Offline image text extraction is unavailable'));
});

test('Phase 2A Acceptance Test 4: Text-only models receive appropriate no-text notice and no raw image payload', () => {
  const photoDoc = {
    fileId: 'photo-no-text',
    originalName: 'sunset.jpg',
    filename: 'sunset.jpg',
    format: 'JPG',
    mimeType: 'image/jpeg',
    status: 'ready',
    success: true,
    isImage: true,
    hasText: false,
    text: '',
    totalCharacters: 0,
    totalWords: 0
  };

  const textProviders = ['groq', 'openrouter', 'cloudflare', 'ollama', 'webllm'];
  for (const prov of textProviders) {
    const prep = prepareDocumentContext('What is in this picture?', [photoDoc], {
      provider: prov
    });
    assert.strictEqual(
      prep.directAnswer,
      'No readable text detected in this image.',
      `Provider ${prov} must receive exact no-text directAnswer`
    );
    assert.strictEqual(prep.isVision, false, `Provider ${prov} must have isVision false`);
  }
});

test('Phase 2A Acceptance Test 5: Existing non-image document behavior remains completely unchanged', () => {
  // Empty text file
  const emptyDoc = {
    fileId: 'empty-1',
    originalName: 'notes.txt',
    filename: 'notes.txt',
    format: 'TXT',
    status: 'empty',
    success: true,
    text: '',
    totalCharacters: 0,
    totalWords: 0
  };
  const emptyPrepGemini = prepareDocumentContext('Summarize notes', [emptyDoc], { provider: 'gemini' });
  const emptyPrepGroq = prepareDocumentContext('Summarize notes', [emptyDoc], { provider: 'groq' });
  assert.ok(emptyPrepGemini.directAnswer?.includes('empty (contains 0 bytes'));
  assert.strictEqual(emptyPrepGemini.directAnswer, emptyPrepGroq.directAnswer);

  // Encrypted PDF
  const encDoc = {
    fileId: 'enc-1',
    originalName: 'secret.pdf',
    filename: 'secret.pdf',
    format: 'PDF',
    status: 'encrypted',
    success: false,
    text: '',
    totalCharacters: 0,
    totalWords: 0
  };
  const encPrepGemini = prepareDocumentContext('Read secret', [encDoc], { provider: 'gemini' });
  assert.ok(encPrepGemini.directAnswer?.includes('is encrypted or password-protected'));

  // Out of bounds PDF page
  const pdfDoc = {
    fileId: 'pdf-1',
    originalName: 'report.pdf',
    filename: 'report.pdf',
    format: 'PDF',
    status: 'ready',
    success: true,
    pageCount: 3,
    pages: [
      { pageNumber: 1, text: 'Page 1 content' },
      { pageNumber: 2, text: 'Page 2 content' },
      { pageNumber: 3, text: 'Page 3 content' }
    ],
    text: 'Page 1 content\nPage 2 content\nPage 3 content',
    totalCharacters: 42,
    totalWords: 9
  };
  const oobPrep = prepareDocumentContext('Explain page 99 of report.pdf', [pdfDoc], { provider: 'gemini' });
  assert.ok(oobPrep.directAnswer?.includes('Requested page 99 does not exist in this document.'));
});

// ----------------------------------------------------------------------------
// 7. Phase 2B: Image OCR Reliability for Readable Writing & Buffer Integrity
// ----------------------------------------------------------------------------
test('Phase 2B Test 1: normalizeOcrText preserves multiline layouts, numbers, currency, and punctuation', () => {
  const formText = [
    'INVOICE #9821-B',
    'Date: 2026-03-15 | Customer ID: C-4401',
    '----------------------------------------',
    'Item Description        Qty    Unit     Total',
    '1. Web App Security      1   $350.00   $350.00',
    '2. Database Migration    2   $100.00   $200.00',
    '----------------------------------------',
    'Subtotal: $550.00',
    'Tax (8.25%): $45.38',
    'Total Due: $595.38 [PAID IN FULL]',
    '',
    'Notes / Remarks:',
    '* Guaranteed 99.9% uptime SLA.',
    '* Support contact: support@example.com (Ext: 402)'
  ].join('\r\n');

  const normalized = normalizeOcrText(formText);
  assert.ok(normalized.includes('INVOICE #9821-B'), 'Must preserve invoice heading');
  assert.ok(normalized.includes('$595.38 [PAID IN FULL]'), 'Must preserve currency and bracketed status');
  assert.ok(normalized.includes('Tax (8.25%): $45.38'), 'Must preserve parentheses and percentages');
  assert.ok(normalized.includes('support@example.com (Ext: 402)'), 'Must preserve email and extension');
  assert.strictEqual(normalized.split('\n').length, 14, 'Must preserve exact multiline line breaks');
  assert.strictEqual(detectReadableText(normalized, 95), true, 'Form text must be detected as readable text');
});

test('Phase 2B Test 2: normalizeOcrText preserves code snippets, indentations, and technical symbols', () => {
  const codeSnippet = [
    'export async function fetchUser(id: string): Promise<User | null> {',
    '  if (!id || id.trim().length === 0) return null;',
    '  const url = `https://api.example.com/v1/users/${encodeURIComponent(id)}`;',
    '  const res = await fetch(url, { headers: { "Accept": "application/json" } });',
    '  return res.ok ? await res.json() : null;',
    '}'
  ].join('\n');

  const normalized = normalizeOcrText(codeSnippet);
  assert.ok(normalized.includes('Promise<User | null>'), 'Must preserve TypeScript generics');
  assert.ok(normalized.includes('`https://api.example.com/v1/users/${encodeURIComponent(id)}`'), 'Must preserve template literals');
  assert.ok(normalized.includes('"Accept": "application/json"'), 'Must preserve quotes and colons');
  assert.strictEqual(detectReadableText(normalized, 90), true, 'Code snippet must be detected as readable text');
});

test('Phase 2B Test 3: detectReadableText distinguishes readable signs/notes from sparse speckles and noise', () => {
  // Signs and short notes
  assert.strictEqual(detectReadableText('STOP', 85), true, 'Sign text must be readable');
  assert.strictEqual(detectReadableText('ROOM 101', 80), true, 'Room numbers must be readable');
  assert.strictEqual(detectReadableText('GATE 4B', 75), true, 'Alphanumeric gate must be readable');
  assert.strictEqual(detectReadableText('Exit 24A', 90), true, 'Highway exit must be readable');

  // Noise / speckles / lone artifacts
  assert.strictEqual(detectReadableText('', 0), false, 'Empty string is not readable');
  assert.strictEqual(detectReadableText('   \n  \t ', 0), false, 'Whitespace is not readable');
  assert.strictEqual(detectReadableText('...', 30), false, 'Dots only are not readable');
  assert.strictEqual(detectReadableText('~', 15), false, 'Tilde only is not readable');
  assert.strictEqual(detectReadableText('`', 10), false, 'Backtick only is not readable');
  assert.strictEqual(detectReadableText('x', 20), false, 'Single speckle char with low confidence (<40) is treated as noise');
});

test('Phase 2B Test 4: validateImageBuffer accurately validates image signatures and catches corrupted buffers', () => {
  // Valid PNG
  const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  assert.strictEqual(validateImageBuffer(validPng).valid, true);
  assert.strictEqual(validateImageBuffer(validPng).format, 'PNG');

  // Valid JPEG
  const validJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  assert.strictEqual(validateImageBuffer(validJpg).valid, true);
  assert.strictEqual(validateImageBuffer(validJpg).format, 'JPEG');

  // Valid BMP
  const validBmp = Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00]);
  assert.strictEqual(validateImageBuffer(validBmp).valid, true);
  assert.strictEqual(validateImageBuffer(validBmp).format, 'BMP');

  // Valid GIF
  const validGif = Buffer.from('GIF89a\x01\x00\x01\x00');
  assert.strictEqual(validateImageBuffer(validGif).valid, true);
  assert.strictEqual(validateImageBuffer(validGif).format, 'GIF');

  // Corrupted / malformed payload (e.g. truncated or random binary)
  const corruptPayload = Buffer.from('Not an image file at all! Just raw plain text.');
  const corruptResult = validateImageBuffer(corruptPayload);
  assert.strictEqual(corruptResult.valid, false);
  assert.ok(corruptResult.error.includes('Corrupted or unreadable image file'));

  // Truncated buffer (<4 bytes)
  const tinyBuffer = Buffer.from([0x89, 0x50]);
  assert.strictEqual(validateImageBuffer(tinyBuffer).valid, false);
  assert.ok(validateImageBuffer(tinyBuffer).error.includes('too small or truncated'));
});

await test('Phase 2B Test 5: extractImageText safely reports corrupted buffers with status error and clear message', async () => {
  const corruptBuffer = Buffer.from('Fake image content that is completely invalid');
  const result = await extractImageText(corruptBuffer, 'corrupted.png', '.png', 'image/png');
  assert.strictEqual(result.status, 'error', 'Must return status error on corrupted image');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.hasText, false);
  assert.ok(result.error.includes('Corrupted or unreadable image file'), 'Must report corrupted header');
});

test('Phase 2B Test 6: Status NO_TEXT_DETECTED preserves Phase 2A Gemini visual routing and text-only directAnswer', () => {
  const noTextDoc = {
    fileId: 'photo-doc-1',
    originalName: 'landscape.png',
    filename: 'landscape.png',
    format: 'PNG',
    mimeType: 'image/png',
    status: 'NO_TEXT_DETECTED',
    success: true,
    isImage: true,
    hasText: false,
    text: '',
    totalCharacters: 0,
    totalWords: 0
  };

  // Gemini: must NOT be blocked by directAnswer
  const geminiContext = prepareDocumentContext('What landmark is in this landscape?', [noTextDoc], {
    provider: 'gemini'
  });
  assert.strictEqual(geminiContext.directAnswer, undefined, 'NO_TEXT_DETECTED must never block Gemini');
  assert.strictEqual(geminiContext.isVision, true, 'isVision must be true for Gemini');
  assert.ok(geminiContext.formattedContext.includes('NO TEXT DETECTED'));
  assert.ok(geminiContext.formattedContext.includes('Multimodal visual analysis will inspect'));

  // Text-only provider (Groq): receives directAnswer explaining no text detected
  const groqContext = prepareDocumentContext('What landmark is in this landscape?', [noTextDoc], {
    provider: 'groq'
  });
  assert.strictEqual(groqContext.directAnswer, 'No readable text detected in this image.');
  assert.strictEqual(groqContext.isVision, false);
});

test('Phase 2B Test 7: Readable extracted text with punctuation and numbers is delivered to both Gemini and text-only models', () => {
  const ocrText = 'Invoice #10492\nDate: 2026-03-15\nTotal: $450.00';
  const readableDoc = {
    fileId: 'invoice-doc-1',
    originalName: 'invoice.png',
    filename: 'invoice.png',
    format: 'PNG',
    mimeType: 'image/png',
    status: 'ready',
    success: true,
    isImage: true,
    hasText: true,
    text: ocrText,
    totalCharacters: ocrText.length,
    totalWords: 5,
    lineCount: 3
  };

  const geminiContext = prepareDocumentContext('Summarize this invoice', [readableDoc], {
    provider: 'gemini'
  });
  assert.strictEqual(geminiContext.directAnswer, undefined);
  assert.ok(geminiContext.formattedContext.includes('Invoice #10492'));
  assert.ok(geminiContext.formattedContext.includes('Total: $450.00'));

  const groqContext = prepareDocumentContext('Summarize this invoice', [readableDoc], {
    provider: 'groq'
  });
  assert.strictEqual(groqContext.directAnswer, undefined);
  assert.ok(groqContext.formattedContext.includes('Invoice #10492'));
  assert.ok(groqContext.formattedContext.includes('Total: $450.00'));
});

// ----------------------------------------------------------------------------
// 8. Phase 2C: Scanned PDF Processing & OCR Reliability Tests
// ----------------------------------------------------------------------------

// Deterministic test fixtures helpers for real PDF creation with embedded images
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function computeCrc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) | 0;
}

function createPngChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(12 + len);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  const typeAndData = Buffer.concat([Buffer.from(type), data]);
  chunk.writeInt32BE(computeCrc32(typeAndData), 8 + len);
  return chunk;
}

function createDeterministicPng(width, height, rgbData) {
  const scanlineLength = 1 + width * 3;
  const rawData = Buffer.alloc(scanlineLength * height);
  for (let y = 0; y < height; y++) {
    const rawOffset = y * scanlineLength;
    rawData[rawOffset] = 0;
    const srcOffset = y * width * 3;
    rgbData.copy(rawData, rawOffset + 1, srcOffset, srcOffset + width * 3);
  }
  const compressed = zlib.deflateSync(rawData);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([sig, createPngChunk('IHDR', ihdr), createPngChunk('IDAT', compressed), createPngChunk('IEND', Buffer.alloc(0))]);
}

function drawDeterministicTextBitmap(width, height, text) {
  const font5x7 = {
    ' ': [0, 0, 0, 0, 0],
    'A': [0x7c, 0x12, 0x11, 0x12, 0x7c],
    'B': [0x7f, 0x49, 0x49, 0x49, 0x36],
    'C': [0x3e, 0x41, 0x41, 0x41, 0x22],
    'D': [0x7f, 0x41, 0x41, 0x22, 0x1c],
    'E': [0x7f, 0x49, 0x49, 0x49, 0x41],
    'H': [0x7f, 0x08, 0x08, 0x08, 0x7f],
    'L': [0x7f, 0x40, 0x40, 0x40, 0x40],
    'O': [0x3e, 0x41, 0x41, 0x41, 0x3e],
    'R': [0x7f, 0x09, 0x19, 0x29, 0x46],
    'S': [0x46, 0x49, 0x49, 0x49, 0x31],
    'T': [0x01, 0x01, 0x7f, 0x01, 0x01],
    'W': [0x3f, 0x40, 0x38, 0x40, 0x3f],
    '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
    '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
    '2': [0x42, 0x61, 0x51, 0x49, 0x46]
  };

  const scale = 5;
  const pixels = Buffer.alloc(width * height * 3, 255);
  let cursorX = 30;
  const cursorY = 25;

  for (const char of text.toUpperCase()) {
    const glyph = font5x7[char] || font5x7[' '];
    for (let col = 0; col < 5; col++) {
      const colBits = glyph[col];
      for (let row = 0; row < 7; row++) {
        if ((colBits & (1 << row)) !== 0) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = cursorX + col * scale + dx;
              const py = cursorY + row * scale + dy;
              if (px < width && py < height) {
                const idx = (py * width + px) * 3;
                pixels[idx] = 0;
                pixels[idx + 1] = 0;
                pixels[idx + 2] = 0;
              }
            }
          }
        }
      }
    }
    cursorX += (5 + 2) * scale;
  }
  return pixels;
}

await test('Phase 2C Test 1: A text-based PDF uses native extraction without unnecessary OCR', async () => {
  // Create a real text-based PDF using pdf-lib
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([400, 300]);
  page.drawText('This is a native digital PDF document containing plain selectable text.', {
    x: 20,
    y: 250,
    size: 14
  });
  const pdfBytes = Buffer.from(await pdfDoc.save());

  const result = await extractDocumentContent(pdfBytes, 'text_doc.pdf', '.pdf', 'application/pdf', 'test-pdf-native');
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.isScanned, false, 'Must not be flagged as scanned');
  assert.ok(result.totalCharacters >= 40, 'Must extract native text characters');
  assert.ok(result.text.includes('native digital PDF'), 'Must contain native extracted text');
  assert.strictEqual(result.ocrEngine, undefined, 'Must not invoke OCR for text-based PDFs');

  // Verify prepareDocumentContext accepts native PDF without rejection
  const prep = prepareDocumentContext('Summarize this document', [result], { provider: 'gemini' });
  assert.strictEqual(prep.directAnswer, undefined);
  assert.ok(prep.formattedContext.includes('native digital PDF'));
});

await test('Phase 2C Test 2: A scanned PDF with readable text successfully produces OCR text', async () => {
  // Create a real scanned PDF fixture: PDF containing an embedded raster image with readable text
  const w = 480;
  const h = 90;
  const rgb = drawDeterministicTextBitmap(w, h, 'HELLO WORLD');
  const png = createDeterministicPng(w, h, rgb);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([500, 200]);
  const img = await pdfDoc.embedPng(png);
  page.drawImage(img, { x: 10, y: 50, width: 480, height: 90 });
  const pdfBytes = Buffer.from(await pdfDoc.save());

  // Run extraction using local OCR (offline mode)
  const result = await extractDocumentContent(
    pdfBytes,
    'scanned_contract.pdf',
    '.pdf',
    'application/pdf',
    'test-pdf-scanned-real',
    { offline: true }
  );

  assert.strictEqual(result.status, 'ready', 'Must successfully return status ready');
  assert.strictEqual(result.success, true, 'Must return success true');
  assert.strictEqual(result.isScanned, true, 'Must correctly identify as scanned PDF');
  assert.strictEqual(result.hasText, true, 'hasText must be true');
  assert.ok(result.totalCharacters > 0, 'Must contain positive extracted character count');
  assert.ok(result.text.includes('HELLO') || result.text.includes('WORLD'), 'Extracted text must contain OCR words');
  assert.strictEqual(result.ocrEngine, 'tesseract-local', 'Must record tesseract-local OCR engine');
  assert.strictEqual(result.pages.length, 1, 'Must have page entry for page 1');
  assert.ok(result.pages[0].text.length > 0, 'Page 1 must contain extracted text');

  // Verify prepareDocumentContext passes extracted OCR text to model without premature rejection
  const prep = prepareDocumentContext('What text is in this scanned contract?', [result], { provider: 'groq' });
  assert.strictEqual(prep.directAnswer, undefined, 'Must not reject scanned PDF when OCR extracted text');
  assert.ok(prep.formattedContext.includes('Type: Scanned PDF (OCR Extracted Text)'));
  assert.ok(prep.formattedContext.includes(result.pages[0].text));
});

await test('Phase 2C Test 3: A scanned PDF with no readable text returns the correct no-text result', async () => {
  // Create a real PDF containing a blank raster image (no text)
  const w = 120;
  const h = 60;
  const blankRgb = Buffer.alloc(w * h * 3, 255); // pure white
  const png = createDeterministicPng(w, h, blankRgb);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([200, 200]);
  const img = await pdfDoc.embedPng(png);
  page.drawImage(img, { x: 10, y: 10, width: 120, height: 60 });
  const pdfBytes = Buffer.from(await pdfDoc.save());

  const result = await extractDocumentContent(
    pdfBytes,
    'blank_scan.pdf',
    '.pdf',
    'application/pdf',
    'test-pdf-blank',
    { offline: true }
  );

  assert.strictEqual(result.status, 'NO_TEXT_DETECTED', 'Must return NO_TEXT_DETECTED');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.isScanned, true);
  assert.strictEqual(result.hasText, false);
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.totalCharacters, 0);
  assert.ok(result.message.includes('No readable text detected in this scanned PDF.'));

  // Verify prepareDocumentContext handles NO_TEXT_DETECTED with clear explanation
  const prep = prepareDocumentContext('Summarize this document', [result], { provider: 'groq' });
  assert.ok(prep.directAnswer, 'Must provide directAnswer explaining no text was detected');
  assert.ok(prep.directAnswer.includes('No readable text detected'));
});

test('Phase 2C Test 4: OCR and rendering failures are accurately distinguished from successful no-text detection', () => {
  // OCR failure doc fixture
  const ocrFailedDoc = {
    fileId: 'ocr-failed-1',
    originalName: 'damaged_scan.pdf',
    filename: 'damaged_scan.pdf',
    format: 'PDF',
    status: 'ocr_failed',
    success: false,
    isScanned: true,
    hasText: false,
    text: '',
    error: 'Optical Character Recognition (OCR) failed on this scanned PDF: Local OCR recognition timed out (60s limit).',
    totalCharacters: 0,
    totalWords: 0
  };

  const prepFailed = prepareDocumentContext('What is in damaged_scan.pdf?', [ocrFailedDoc], { provider: 'groq' });
  assert.ok(prepFailed.directAnswer.includes('Optical Character Recognition (OCR) failed'));
  assert.ok(prepFailed.formattedContext.includes('STATUS: OCR FAILED'));

  // Unsupported rendering doc fixture (e.g. vector rasterization without extractable image streams)
  const unsuppDoc = {
    fileId: 'unsupp-1',
    originalName: 'vector_scan.pdf',
    filename: 'vector_scan.pdf',
    format: 'PDF',
    status: 'unsupported_rendering',
    success: false,
    isScanned: true,
    hasText: false,
    text: '',
    error: 'No readable text layer was found, and page images could not be extracted for OCR processing.',
    totalCharacters: 0,
    totalWords: 0
  };

  const prepUnsupp = prepareDocumentContext('What is in vector_scan.pdf?', [unsuppDoc], { provider: 'groq' });
  assert.ok(prepUnsupp.directAnswer.includes('No readable text layer was found'));
  assert.ok(prepUnsupp.formattedContext.includes('STATUS: UNSUPPORTED RENDERING'));
});

await test('Phase 2C Test 5: Invalid and encrypted PDFs preserve appropriate error handling', async () => {
  // Corrupted / malformed PDF bytes
  const corruptPdf = Buffer.from('NOT A PDF FILE DATA - JUST CORRUPTED GARBAGE');
  const corruptResult = await extractDocumentContent(corruptPdf, 'broken.pdf', '.pdf', 'application/pdf', 'corrupt-1');
  assert.strictEqual(corruptResult.status, 'corrupted');
  assert.strictEqual(corruptResult.success, false);
  assert.ok(corruptResult.error.includes('Failed to parse PDF document'));

  // Encrypted PDF fixture
  const encDoc = {
    fileId: 'enc-pdf-1',
    originalName: 'payroll_protected.pdf',
    filename: 'payroll_protected.pdf',
    format: 'PDF',
    status: 'encrypted',
    success: false,
    hasText: false,
    text: '',
    error: 'This PDF document is encrypted or password-protected and cannot be read without a password.',
    totalCharacters: 0,
    totalWords: 0
  };

  const prepEnc = prepareDocumentContext('Read payroll', [encDoc], { provider: 'gemini' });
  assert.ok(prepEnc.directAnswer.includes('is encrypted or password-protected'));
  assert.ok(prepEnc.formattedContext.includes('STATUS: ENCRYPTED'));
});

test('Phase 2C Test 6: Scanned PDF page-range limits and page query boundaries remain enforced', () => {
  // Multi-page scanned PDF with OCR extracted text on each page
  const multiPageScannedDoc = {
    fileId: 'scanned-multi-1',
    originalName: 'financial_records_scanned.pdf',
    filename: 'financial_records_scanned.pdf',
    format: 'PDF',
    status: 'ready',
    success: true,
    isScanned: true,
    hasText: true,
    pageCount: 3,
    pages: [
      { pageNumber: 1, text: 'Q1 Revenue: $1,250,000\nOperating Expenses: $820,000', charCount: 48 },
      { pageNumber: 2, text: 'Q2 Revenue: $1,410,000\nOperating Expenses: $890,000', charCount: 48 },
      { pageNumber: 3, text: 'Q3 Revenue: $1,650,000\nOperating Expenses: $940,000', charCount: 48 }
    ],
    text: '--- Page 1 ---\nQ1 Revenue: $1,250,000\n\n--- Page 2 ---\nQ2 Revenue: $1,410,000\n\n--- Page 3 ---\nQ3 Revenue: $1,650,000',
    totalCharacters: 120,
    totalWords: 15,
    ocrEngine: 'tesseract-local'
  };

  // Valid page query: "What is on page 2?"
  const page2Prep = prepareDocumentContext('What is on page 2?', [multiPageScannedDoc], { provider: 'groq' });
  assert.strictEqual(page2Prep.directAnswer, undefined);
  assert.ok(page2Prep.formattedContext.includes('Q2 Revenue: $1,410,000'));
  assert.ok(!page2Prep.formattedContext.includes('Q1 Revenue'));

  // Out of bounds page query: "What is on page 99?"
  const page99Prep = prepareDocumentContext('What is on page 99?', [multiPageScannedDoc], { provider: 'groq' });
  assert.ok(page99Prep.directAnswer.includes('Requested page 99 does not exist in this document.'));

  // Page range query: "Explain pages 1 to 2"
  const rangePrep = prepareDocumentContext('Explain pages 1 to 2', [multiPageScannedDoc], { provider: 'groq' });
  assert.strictEqual(rangePrep.directAnswer, undefined);
  assert.ok(rangePrep.formattedContext.includes('Q1 Revenue'));
  assert.ok(rangePrep.formattedContext.includes('Q2 Revenue'));
});

test('Phase 2C Test 7: Phase 2A/2B image OCR behavior and rawImageDataToBmp conversion remain unchanged', () => {
  // Test rawImageDataToBmp produces valid BMP format recognized by validateImageBuffer
  const testPixels = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]); // 2x2 RGB
  const bmpBuf = rawImageDataToBmp(2, 2, 3, testPixels);
  assert.ok(Buffer.isBuffer(bmpBuf), 'Must return a Buffer');
  const validation = validateImageBuffer(bmpBuf);
  assert.strictEqual(validation.valid, true, 'validateImageBuffer must validate rawImageDataToBmp output');
  assert.strictEqual(validation.format, 'BMP');

  // Verify Phase 2A/2B plain image behavior remains intact
  const pngDoc = {
    fileId: 'img-1',
    originalName: 'photo.jpg',
    format: 'JPG',
    status: 'NO_TEXT_DETECTED',
    success: true,
    isImage: true,
    hasText: false,
    text: '',
    totalCharacters: 0,
    totalWords: 0
  };

  // Gemini vision allows visual analysis
  const geminiPrep = prepareDocumentContext('What is in photo.jpg?', [pngDoc], { provider: 'gemini' });
  assert.strictEqual(geminiPrep.isVision, true);
  assert.strictEqual(geminiPrep.directAnswer, undefined);

  // Text-only provider receives no-text notice
  const groqPrep = prepareDocumentContext('What is in photo.jpg?', [pngDoc], { provider: 'groq' });
  assert.strictEqual(groqPrep.isVision, false);
  assert.strictEqual(groqPrep.directAnswer, 'No readable text detected in this image.');
});

console.log(`\nAll ${passedTests} offline reliability tests passed successfully!`);
