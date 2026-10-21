import assert from 'assert';
import {
  parseDocumentQueryIntent,
  prepareDocumentContext,
  generateSimulatedDocumentResponse,
} from './src/services/documentContextService.ts';

console.log('--- Starting Document Question Handling Tests ---');

// Mock PDF document
const mockPdfDoc = {
  id: 'doc-pdf-1',
  fileId: 'doc-pdf-1',
  originalName: 'quarterly_report.pdf',
  filename: 'quarterly_report.pdf',
  format: 'PDF',
  status: 'ready',
  success: true,
  totalCharacters: 12500,
  totalWords: 2400,
  pageCount: 5,
  pages: [
    { pageNumber: 1, text: 'Executive Summary: Q3 revenue exceeded expectations by 18%. Growth was driven by cloud services.', charCount: 95 },
    { pageNumber: 2, text: 'Financial Breakdown: Gross margin expanded to 72%. Operating expenses were kept flat.', charCount: 84 },
    { pageNumber: 3, text: 'Product Milestones: Version 2.0 shipped with enhanced security and real-time collaboration features.', charCount: 104 },
    { pageNumber: 4, text: 'Market Analysis: Competitor moves in APAC region. New enterprise tier customer acquisitions up 35%.', charCount: 101 },
    { pageNumber: 5, text: 'Conclusion and Guidance: Projected Q4 growth remains between 15% and 20%. Key risk factors include foreign exchange volatility.', charCount: 128 },
  ],
  text: 'Executive Summary: Q3 revenue exceeded expectations...\nFinancial Breakdown...\nProduct Milestones...\nMarket Analysis...\nConclusion and Guidance...'
};

// Mock PPTX document
const mockPptxDoc = {
  id: 'doc-pptx-1',
  fileId: 'doc-pptx-1',
  originalName: 'pitch_deck.pptx',
  filename: 'pitch_deck.pptx',
  format: 'PPTX',
  status: 'ready',
  success: true,
  totalCharacters: 6500,
  totalWords: 1100,
  slideCount: 4,
  slides: [
    { slideNumber: 1, title: 'Title Slide', text: 'Orvix AI - Next-Gen Conversational Companion', notes: 'Welcome investors and introduce vision', charCount: 45 },
    { slideNumber: 2, title: 'Problem Statement', text: 'Context fragmentation across apps causes 40% productivity loss in distributed teams.', notes: 'Emphasize market pain point', charCount: 85 },
    { slideNumber: 3, title: 'Solution Architecture', text: 'Document-aware multi-modal AI router integrating PDF, Word, and Presentation analysis.', notes: 'Point to patent-pending extraction engine', charCount: 87 },
    { slideNumber: 4, title: 'Traction and Milestones', text: '120,000 active users, $1.2M ARR, 94% retention rate.', notes: 'Highlight viral organic growth metrics', charCount: 52 },
  ],
  text: 'Slide 1: Orvix AI...\nSlide 2: Problem Statement...\nSlide 3: Solution Architecture...\nSlide 4: Traction and Milestones...'
};

// Mock DOCX document (no reliable physical pages)
const mockDocxDoc = {
  id: 'doc-docx-1',
  fileId: 'doc-docx-1',
  originalName: 'architecture_specs.docx',
  filename: 'architecture_specs.docx',
  format: 'DOCX',
  status: 'ready',
  success: true,
  totalCharacters: 8200,
  totalWords: 1500,
  sectionCount: 3,
  sections: [
    { heading: 'Overview', level: 1, content: 'This specification outlines the modular architecture of the document extraction and reasoning service.', charCount: 110 },
    { heading: 'Authentication & Security', level: 2, content: 'Role-based access control with token verification and file integrity checks.', charCount: 78 },
    { heading: 'Performance SLAs', level: 2, content: 'P95 latency under 250ms for extraction of documents up to 25MB.', charCount: 65 },
  ],
  text: '# Overview\nThis specification outlines...\n## Authentication & Security\nRole-based access...'
};

// Mock Scanned PDF (Unreadable)
const mockScannedPdf = {
  id: 'doc-scanned-1',
  fileId: 'doc-scanned-1',
  originalName: 'scanned_receipt.pdf',
  filename: 'scanned_receipt.pdf',
  format: 'PDF',
  status: 'scanned_or_image_only',
  isScanned: true,
  success: false,
  totalCharacters: 0,
  totalWords: 0,
  pageCount: 2,
  pages: [{ pageNumber: 1, text: '', charCount: 0 }, { pageNumber: 2, text: '', charCount: 0 }],
  text: '',
  warning: 'No readable text could be extracted from this PDF. This document appears to be scanned, image-only, or contains rasterized pages without a text layer. Optical Character Recognition (OCR) may be required.'
};

// Mock Giant Document (>100k chars)
const giantText = 'Chapter Content '.repeat(10000); // ~160,000 chars
const mockGiantDoc = {
  id: 'doc-giant-1',
  fileId: 'doc-giant-1',
  originalName: 'encyclopedia.pdf',
  filename: 'encyclopedia.pdf',
  format: 'PDF',
  status: 'ready',
  success: true,
  totalCharacters: giantText.length,
  totalWords: 20000,
  pageCount: 60,
  pages: Array.from({ length: 60 }, (_, i) => ({
    pageNumber: i + 1,
    text: `Page ${i + 1} detailed text content regarding topic ${i + 1}.`,
    charCount: 60
  })),
  text: giantText
};

// TEST 1: Whole file summary
console.log('\n[Test 1] Whole-file summary intent & response...');
{
  const intent = parseDocumentQueryIntent('Summarize this document.', [mockPdfDoc]);
  assert.strictEqual(intent.targetScope, 'whole_file', 'Should identify whole_file scope');

  const context = prepareDocumentContext('Summarize this document.', [mockPdfDoc]);
  assert.ok(context.formattedContext.includes('quarterly_report.pdf'), 'Should include filename');
  assert.ok(context.formattedContext.includes('Executive Summary'), 'Should include text');

  const simulated = generateSimulatedDocumentResponse('Summarize this document.', context);
  assert.ok(simulated.includes('quarterly_report.pdf'), 'Simulated answer should mention filename');
  assert.ok(simulated.includes('Executive Summary'), 'Simulated answer should include document executive summary');
  console.log('✓ Test 1 passed.');
}

// TEST 2: Specific PDF page
console.log('\n[Test 2] Specific PDF page ("Explain page 5")...');
{
  const intent = parseDocumentQueryIntent('Explain page 5.', [mockPdfDoc]);
  assert.strictEqual(intent.targetScope, 'page', 'Should identify page scope');
  assert.deepStrictEqual(intent.targetPages, [5], 'Should identify page 5');

  const context = prepareDocumentContext('Explain page 5.', [mockPdfDoc]);
  assert.ok(context.formattedContext.includes('Page 5 of 5'), 'Context should target Page 5');
  assert.ok(context.formattedContext.includes('Conclusion and Guidance'), 'Context should have Page 5 text');
  assert.ok(!context.formattedContext.includes('Page 2 of 5'), 'Context should not include unrelated pages');

  const simulated = generateSimulatedDocumentResponse('Explain page 5.', context);
  assert.ok(simulated.includes('Page 5'), 'Simulated response should focus on Page 5');
  assert.ok(simulated.includes('Conclusion and Guidance') || simulated.includes('Projected Q4 growth'), 'Should extract Page 5 content');
  console.log('✓ Test 2 passed.');
}

// TEST 3: PDF Page Range ("Explain pages 2 to 4")
console.log('\n[Test 3] PDF Page Range ("Explain pages 2 to 4")...');
{
  const intent = parseDocumentQueryIntent('Explain pages 2 to 4.', [mockPdfDoc]);
  assert.strictEqual(intent.targetScope, 'page_range', 'Should identify page_range scope');
  assert.deepStrictEqual(intent.targetPages, [2, 3, 4], 'Should identify pages 2, 3, 4');

  const context = prepareDocumentContext('Explain pages 2 to 4.', [mockPdfDoc]);
  assert.ok(context.formattedContext.includes('Page 2 of 5'), 'Should include Page 2');
  assert.ok(context.formattedContext.includes('Page 3 of 5'), 'Should include Page 3');
  assert.ok(context.formattedContext.includes('Page 4 of 5'), 'Should include Page 4');
  assert.ok(!context.formattedContext.includes('Page 1 of 5'), 'Should not include Page 1');

  const simulated = generateSimulatedDocumentResponse('Explain pages 2 to 4.', context);
  assert.ok(simulated.includes('Pages 2 to 4'), 'Response should mention range');
  assert.ok(simulated.includes('Page 2:') && simulated.includes('Page 3:') && simulated.includes('Page 4:'), 'Response should detail pages');
  console.log('✓ Test 3 passed.');
}

// TEST 4: Out of bounds page
console.log('\n[Test 4] Out of bounds page ("Explain page 10" on 5-page PDF)...');
{
  const context = prepareDocumentContext('Explain page 10.', [mockPdfDoc]);
  assert.ok(context.directAnswer, 'Should generate directAnswer for out-of-bounds page');
  assert.ok(context.directAnswer.includes('contains 5 pages'), 'Should explain document only has 5 pages');
  assert.ok(context.directAnswer.includes('does not exist'), 'Should state page does not exist');
  console.log('✓ Test 4 passed: ' + context.directAnswer);
}

// TEST 5: PowerPoint Slide Question ("Explain slide 4")
console.log('\n[Test 5] PowerPoint slide question ("Explain slide 4")...');
{
  const intent = parseDocumentQueryIntent('Explain slide 4.', [mockPptxDoc]);
  assert.strictEqual(intent.targetScope, 'slide', 'Should identify slide scope');
  assert.deepStrictEqual(intent.targetSlides, [4], 'Should identify slide 4');

  const context = prepareDocumentContext('Explain slide 4.', [mockPptxDoc]);
  assert.ok(context.formattedContext.includes('Slide 4 of 4: Traction and Milestones'), 'Should include Slide 4 title');
  assert.ok(context.formattedContext.includes('120,000 active users'), 'Should include Slide 4 body');
  assert.ok(context.formattedContext.includes('Speaker Notes'), 'Should include speaker notes');

  const simulated = generateSimulatedDocumentResponse('Explain slide 4.', context);
  assert.ok(simulated.includes('Slide 4') && simulated.includes('Traction and Milestones'), 'Simulated should identify slide');
  assert.ok(simulated.includes('120,000 active users'), 'Simulated should cite slide stats');
  assert.ok(simulated.includes('Speaker Notes'), 'Simulated should cite notes');
  console.log('✓ Test 5 passed.');
}

// TEST 6: Formats without reliable page boundaries (DOCX page request)
console.log('\n[Test 6] Format without page boundaries ("Explain page 2" on DOCX)...');
{
  const context = prepareDocumentContext('Explain page 2.', [mockDocxDoc]);
  assert.ok(context.formattedContext.includes('Notice regarding format limitations'), 'Must explain format limitation');
  assert.ok(context.formattedContext.includes('do not have fixed physical page numbers'), 'Must explain DOCX pagination limitation');
  assert.ok(context.formattedContext.includes('Authentication & Security'), 'Must provide headings/sections');
  console.log('✓ Test 6 passed.');
}

// TEST 7: Multiple attached files
console.log('\n[Test 7] Multiple attached files...');
{
  const context = prepareDocumentContext('What do these files cover?', [mockPdfDoc, mockPptxDoc]);
  assert.ok(context.formattedContext.includes('quarterly_report.pdf'), 'Must identify first file');
  assert.ok(context.formattedContext.includes('pitch_deck.pptx'), 'Must identify second file');
  assert.ok(context.formattedContext.includes('DOCUMENT 1 of 2'), 'Must demarcate Document 1');
  assert.ok(context.formattedContext.includes('DOCUMENT 2 of 2'), 'Must demarcate Document 2');
  console.log('✓ Test 7 passed.');
}

// TEST 8: Unreadable / Scanned document
console.log('\n[Test 8] Unreadable / Scanned document...');
{
  const context = prepareDocumentContext('Summarize this document.', [mockScannedPdf]);
  assert.ok(context.directAnswer, 'Must provide directAnswer explaining issue');
  assert.ok(context.directAnswer.includes('No readable text could be extracted'), 'Must explain no readable text');
  assert.ok(context.directAnswer.includes('Optical Character Recognition (OCR)'), 'Must explain OCR requirement');
  console.log('✓ Test 8 passed: ' + context.directAnswer);
}

// TEST 9: Giant document bounded context limit
console.log('\n[Test 9] Giant document exceeding context limit...');
{
  const context = prepareDocumentContext('Summarize this whole file.', [mockGiantDoc]);
  assert.strictEqual(context.isBoundedOrChunked, true, 'Should flag bounded/chunked');
  assert.ok(context.truncationNote, 'Should provide clear notification of bounded outline');
  assert.ok(context.formattedContext.includes('Structural Overview'), 'Should include outline');
  console.log('✓ Test 9 passed.');
}

console.log('\n🎉 ALL 9 TEST SUITES PASSED CLEANLY! 🎉\n');
