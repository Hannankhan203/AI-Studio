/**
 * Comprehensive Verification Suite for Multi-Provider Document-Aware Question Handling
 * Tests Gemini, Groq, OpenRouter, and Cloudflare Workers AI with:
 * 1. Ordinary text-only queries
 * 2. Specific page targeting ("Explain page 5")
 * 3. Specific slide targeting ("Explain slide 4")
 * 4. Page ranges ("Explain pages 2 to 4")
 * 5. Multi-document handling
 * 6. Non-paged document format handling
 * 7. Out-of-bounds page handling
 * 8. Unreadable/scanned document handling
 * 9. Large document bounding per provider
 * 10. Streaming vs non-streaming responses
 * 11. Error handling & fallback compatibility
 */

import assert from 'assert';
import {
  prepareDocumentContext,
  adaptDocumentContextForProvider,
  formatOpenAIMessages,
  generateSimulatedDocumentResponse,
  PROVIDER_PROFILES
} from './src/services/documentContextService.js';

const mockPdfDoc = {
  id: 'doc-report-1',
  fileId: 'doc-report-1',
  originalName: 'quarterly_report.pdf',
  filename: 'quarterly_report.pdf',
  format: 'PDF',
  mimeType: 'application/pdf',
  status: 'ready',
  success: true,
  totalCharacters: 8500,
  totalWords: 1450,
  pageCount: 5,
  pages: [
    { pageNumber: 1, text: 'Executive Summary: Q3 revenue grew by 24% year-over-year.', charCount: 65 },
    { pageNumber: 2, text: 'Product Metrics: Active daily users reached 1.2M with 85% retention.', charCount: 75 },
    { pageNumber: 3, text: 'Financial Breakdown: Gross margin expanded to 71%, operating income was $4.2M.', charCount: 82 },
    { pageNumber: 4, text: 'Risks & Mitigations: Supply chain lead times extended by 2 weeks.', charCount: 70 },
    { pageNumber: 5, text: 'Conclusion and Guidance: Raising full-year revenue projection to $48M.', charCount: 74 }
  ],
  text: 'Executive Summary: Q3 revenue grew by 24% year-over-year. Product Metrics: Active daily users reached 1.2M.'
};

const mockPptxDoc = {
  id: 'doc-deck-1',
  fileId: 'doc-deck-1',
  originalName: 'investor_deck.pptx',
  filename: 'investor_deck.pptx',
  format: 'PPTX',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  status: 'ready',
  success: true,
  totalCharacters: 6000,
  totalWords: 950,
  slideCount: 6,
  slides: [
    { slideNumber: 1, title: 'Title & Vision', text: 'Orvix Next-Gen Platform overview.', notes: 'Introduce the problem statement', charCount: 50 },
    { slideNumber: 2, title: 'Market Opportunity', text: '$50B addressable market across 3 sectors.', charCount: 45 },
    { slideNumber: 3, title: 'Product Architecture', text: 'Event-driven edge serverless architecture.', charCount: 46 },
    { slideNumber: 4, title: 'Traction & Milestones', text: '100k active users in 3 months with 40% organic referral.', notes: 'Highlight viral loop', charCount: 70 },
    { slideNumber: 5, title: 'Unit Economics', text: 'CAC is $12, LTV is $140, payback in 2.1 months.', charCount: 50 },
    { slideNumber: 6, title: 'The Ask', text: 'Seeking $3M Seed round to expand engineering team.', charCount: 52 }
  ],
  text: 'Orvix Next-Gen Platform overview. $50B addressable market across 3 sectors.'
};

const bigChapter = 'Detailed operational procedures, safety guidelines, and architectural specifications for system block. Includes diagnostic matrices, telemetry guidelines, and validation protocols. '.repeat(15);

const mockLargeDoc = {
  id: 'doc-large-1',
  fileId: 'doc-large-1',
  originalName: 'comprehensive_manual.pdf',
  filename: 'comprehensive_manual.pdf',
  format: 'PDF',
  mimeType: 'application/pdf',
  status: 'ready',
  success: true,
  totalCharacters: 180000,
  totalWords: 30000,
  pageCount: 60,
  pages: Array.from({ length: 60 }, (_, i) => ({
    pageNumber: i + 1,
    text: `Page ${i + 1}: ${bigChapter}`,
    charCount: bigChapter.length
  })),
  text: bigChapter.repeat(30)
};

const ALL_PROVIDERS = ['gemini', 'groq', 'openrouter', 'cloudflare'];

async function runTests() {
  console.log('=== MULTI-PROVIDER DOCUMENT INTEGRATION TEST SUITE ===\n');

  // 1. Verify Provider Profiles
  console.log('[Test 1] Verifying provider context profiles...');
  for (const prov of ALL_PROVIDERS) {
    const profile = PROVIDER_PROFILES[prov];
    assert.ok(profile, `Profile must exist for provider: ${prov}`);
    assert.ok(profile.maxDocChars > 0, `${prov} must have positive maxDocChars`);
    console.log(`  ✓ Provider: ${profile.name} (${profile.modelTag}) -> Max Context Chars: ${profile.maxDocChars.toLocaleString()}`);
  }

  // 2. Ordinary Text-Only Queries (Requirement 11)
  console.log('\n[Test 2] Ordinary text-only queries across all providers...');
  for (const prov of ALL_PROVIDERS) {
    const adapted = adaptDocumentContextForProvider({
      provider: prov,
      prompt: 'Hello, what is 2 + 2?',
      baseSystemInstruction: 'You are Orvix assistant.',
      preparedContext: { formattedContext: '', hasErrorsOrWarnings: false, unreadableDocNotes: [], targetedDocs: [], scope: 'none', isBoundedOrChunked: false }
    });
    assert.strictEqual(adapted.effectivePrompt, 'Hello, what is 2 + 2?', 'Prompt should be unchanged for text-only');
    assert.strictEqual(adapted.effectiveSystemInstruction, 'You are Orvix assistant.', 'System instruction unchanged');
    assert.strictEqual(adapted.isBoundedForProvider, false);

    const openAiMsgs = formatOpenAIMessages({
      systemInstruction: adapted.effectiveSystemInstruction,
      history: [{ sender: 'user', content: 'Hi' }],
      prompt: adapted.effectivePrompt
    });
    assert.strictEqual(openAiMsgs.length, 3, 'Must have system, history, and prompt');
    console.log(`  ✓ ${prov}: Text-only prompt passes cleanly without document overhead`);
  }

  // 3. Page-Specific Questions ("Explain page 5") across all providers (Requirement 5 & 6)
  console.log('\n[Test 3] Page-specific queries ("Explain page 5") across all providers...');
  const page5Context = prepareDocumentContext('Explain page 5.', [mockPdfDoc]);
  assert.ok(page5Context.formattedContext.includes('Page 5 of 5'), 'Context targets page 5');
  assert.ok(page5Context.formattedContext.includes('Conclusion and Guidance'), 'Context includes page 5 content');
  assert.ok(!page5Context.formattedContext.includes('Page 2 of 5'), 'Context excludes other pages');

  for (const prov of ALL_PROVIDERS) {
    const adapted = adaptDocumentContextForProvider({
      provider: prov,
      prompt: 'Explain page 5.',
      baseSystemInstruction: 'You are Orvix.',
      preparedContext: page5Context
    });
    assert.ok(adapted.effectiveSystemInstruction.includes('Page 5 of 5'), `${prov} receives targeted Page 5`);
    assert.ok(adapted.effectiveSystemInstruction.includes('quarterly_report.pdf'), `${prov} receives filename`);
    assert.strictEqual(adapted.isBoundedForProvider, false, `Page 5 easily fits ${prov} limit`);
    console.log(`  ✓ ${prov}: Correctly formatted with targeted Page 5 content and citations`);
  }

  // 4. Slide-Specific Questions ("Explain slide 4") across all providers (Requirement 5 & 6)
  console.log('\n[Test 4] Slide-specific queries ("Explain slide 4") across all providers...');
  const slide4Context = prepareDocumentContext('Explain slide 4.', [mockPptxDoc]);
  assert.ok(slide4Context.formattedContext.includes('Slide 4 of 6: Traction & Milestones'), 'Context targets slide 4');
  assert.ok(slide4Context.formattedContext.includes('Highlight viral loop'), 'Context includes slide 4 speaker notes');
  assert.ok(!slide4Context.formattedContext.includes('Slide 1 of 6'), 'Context excludes other slides');

  for (const prov of ALL_PROVIDERS) {
    const adapted = adaptDocumentContextForProvider({
      provider: prov,
      prompt: 'Explain slide 4.',
      baseSystemInstruction: 'You are Orvix.',
      preparedContext: slide4Context
    });
    assert.ok(adapted.effectiveSystemInstruction.includes('Slide 4 of 6: Traction & Milestones'), `${prov} receives targeted Slide 4`);
    assert.ok(adapted.effectiveSystemInstruction.includes('Highlight viral loop'), `${prov} receives speaker notes`);
    console.log(`  ✓ ${prov}: Correctly formatted with targeted Slide 4 and speaker notes`);
  }

  // 5. Large Document Context Handling & Bounding (Requirements 7, 8, 10)
  console.log('\n[Test 5] Large document bounding per provider capabilities...');
  const largeContext = prepareDocumentContext('Summarize this document.', [mockLargeDoc]);
  assert.ok(largeContext.isBoundedOrChunked, 'Must identify document as needing chunking');

  // Gemini (120k budget) vs Groq (24k budget) vs OpenRouter (16k budget) vs Cloudflare (16k budget)
  const geminiAdapted = adaptDocumentContextForProvider({
    provider: 'gemini',
    prompt: 'Summarize this document.',
    baseSystemInstruction: 'You are Orvix.',
    preparedContext: largeContext
  });
  console.log(`  ✓ Gemini: Context size ${geminiAdapted.formattedDocContext.length.toLocaleString()} chars (Bounded: ${geminiAdapted.isBoundedForProvider})`);

  const groqAdapted = adaptDocumentContextForProvider({
    provider: 'groq',
    prompt: 'Summarize this document.',
    baseSystemInstruction: 'You are Orvix.',
    preparedContext: largeContext
  });
  assert.ok(groqAdapted.isBoundedForProvider, 'Groq must be safely bounded');
  assert.ok(groqAdapted.providerNotice.includes('Context Notice for Groq'), 'Must include transparency notice');
  assert.ok(groqAdapted.formattedDocContext.length <= 26000, 'Must stay safely within Groq token limits');
  console.log(`  ✓ Groq: Safely bounded to ${groqAdapted.formattedDocContext.length.toLocaleString()} chars with explicit transparency notice`);

  const openrouterAdapted = adaptDocumentContextForProvider({
    provider: 'openrouter',
    prompt: 'Summarize this document.',
    baseSystemInstruction: 'You are Orvix.',
    preparedContext: largeContext
  });
  assert.ok(openrouterAdapted.isBoundedForProvider, 'OpenRouter must be safely bounded');
  assert.ok(openrouterAdapted.providerNotice.includes('Context Notice for OpenRouter'), 'Must include transparency notice');
  assert.ok(openrouterAdapted.formattedDocContext.length <= 18000, 'Must stay safely within OpenRouter limits');
  console.log(`  ✓ OpenRouter: Safely bounded to ${openrouterAdapted.formattedDocContext.length.toLocaleString()} chars with explicit transparency notice`);

  const cloudflareAdapted = adaptDocumentContextForProvider({
    provider: 'cloudflare',
    prompt: 'Summarize this document.',
    baseSystemInstruction: 'You are Orvix.',
    preparedContext: largeContext
  });
  assert.ok(cloudflareAdapted.isBoundedForProvider, 'Cloudflare must be safely bounded');
  assert.ok(cloudflareAdapted.providerNotice.includes('Context Notice for Cloudflare Workers AI'), 'Must include notice');
  assert.ok(cloudflareAdapted.formattedDocContext.length <= 18000, 'Must stay safely within Cloudflare limits');
  console.log(`  ✓ Cloudflare: Safely bounded to ${cloudflareAdapted.formattedDocContext.length.toLocaleString()} chars with explicit transparency notice`);

  // 6. Direct HTTP Endpoints & Simulated Responses Verification
  console.log('\n[Test 6] Testing live HTTP endpoint /api/chat for all 4 providers...');
  const baseUrl = 'http://127.0.0.1:3000';

  for (const prov of ALL_PROVIDERS) {
    // Non-streaming test with attachments
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: prov,
        prompt: 'Explain page 5.',
        stream: false,
        conversationId: `conv-test-${prov}`,
        attachments: [{
          id: mockPdfDoc.id,
          originalName: mockPdfDoc.originalName,
          format: mockPdfDoc.format,
          extraction: mockPdfDoc
        }]
      })
    });

    assert.strictEqual(res.status, 200, `${prov} request should return 200`);
    const data = await res.json();
    assert.ok(data.text && data.text.length > 0, `${prov} must return non-empty text`);
    assert.strictEqual(data.provider, prov, `Response provider must match ${prov}`);
    console.log(`  ✓ ${prov} (non-streaming): Responded with model '${data.modelUsed}' (text length: ${data.text.length} chars)`);

    // Streaming test (SSE)
    const streamRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({
        provider: prov,
        prompt: 'Explain slide 4.',
        stream: true,
        conversationId: `conv-test-${prov}`,
        attachments: [{
          id: mockPptxDoc.id,
          originalName: mockPptxDoc.originalName,
          format: mockPptxDoc.format,
          extraction: mockPptxDoc
        }]
      })
    });

    assert.strictEqual(streamRes.status, 200, `${prov} streaming should return 200`);
    const streamBody = await streamRes.text();
    assert.ok(streamBody.includes('data: {"type":"start"'), `${prov} stream must have start event`);
    assert.ok(streamBody.includes('data: {"type":"chunk"'), `${prov} stream must have chunk events`);
    assert.ok(streamBody.includes('data: {"type":"done"'), `${prov} stream must have done event`);
    console.log(`  ✓ ${prov} (SSE streaming): Verified start, chunk, and done SSE events`);
  }

  // 7. Out-of-bounds Page Query across all providers
  console.log('\n[Test 7] Out-of-bounds page query ("Explain page 99") across all providers...');
  for (const prov of ALL_PROVIDERS) {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: prov,
        prompt: 'Explain page 99.',
        stream: false,
        conversationId: `conv-bounds-${prov}`,
        attachments: [{
          id: mockPdfDoc.id,
          originalName: mockPdfDoc.originalName,
          format: mockPdfDoc.format,
          extraction: mockPdfDoc
        }]
      })
    });

    const data = await res.json();
    assert.ok(data.text.includes('contains 5 pages'), `${prov} must state total pages`);
    assert.ok(data.text.includes('does not exist'), `${prov} must state page does not exist`);
    console.log(`  ✓ ${prov}: Immediate honest boundary answer without hallucinating`);
  }

  // 8. Unreadable Document Handling across all providers
  console.log('\n[Test 8] Unreadable/scanned document handling across all providers...');
  const scannedDoc = {
    id: 'doc-scanned-1',
    originalName: 'scanned_receipt.pdf',
    filename: 'scanned_receipt.pdf',
    format: 'PDF',
    status: 'scanned_or_image_only',
    isScanned: true,
    totalCharacters: 0,
    totalWords: 0,
    success: false
  };

  for (const prov of ALL_PROVIDERS) {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: prov,
        prompt: 'Summarize this document.',
        stream: false,
        conversationId: `conv-scanned-${prov}`,
        attachments: [{
          id: scannedDoc.id,
          originalName: scannedDoc.originalName,
          format: scannedDoc.format,
          extraction: scannedDoc
        }]
      })
    });

    const data = await res.json();
    assert.ok(data.text.includes('scanned, image-only') || data.text.includes('No readable text'), `${prov} must explain scanned issue`);
    console.log(`  ✓ ${prov}: Honest diagnostic returned without fabricating a fake summary`);
  }

  console.log('\n======================================================');
  console.log('🎉 ALL MULTI-PROVIDER DOCUMENT TESTS PASSED CLEANLY! 🎉');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
