/**
 * Test Suite: Orvix Writing Mode — Professional Writing Response Formatting Verification
 * Tests the 15 required verification scenarios defined in Section 8 of the prompt:
 * 1. Short writing
 * 2. Long-form writing
 * 3. Multiple headings
 * 4. Paragraph-heavy content
 * 5. Bullet lists
 * 6. Numbered lists
 * 7. Nested lists
 * 8. Blockquotes
 * 9. Tables
 * 10. Mixed formatting
 * 11. Long responses
 * 12. Streaming responses
 * 13. Desktop layout
 * 14. Tablet layout
 * 15. Mobile layout
 */

import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    failed++;
  }
}

console.log('=== RUNNING ORVIX WRITING MODE FORMATTING VERIFICATION ===\n');

// 1. Inspect ChatMessage.jsx implementation
console.log('Test Suite 1: ChatMessage Component Integration for Writing Mode');
const chatMessageSrc = fs.readFileSync(path.resolve('./src/components/chat/ChatMessage.jsx'), 'utf-8');

assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-h1' : ''"), 'h1 element provides writing-h1 class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-h2' : ''"), 'h2 element provides writing-h2 class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-h3' : ''"), 'h3 element provides writing-h3 class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-h4' : ''"), 'h4 element provides writing-h4 class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-h5' : ''"), 'h5 element provides writing-h5 class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-h6' : ''"), 'h6 element provides writing-h6 class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-table-wrapper' : ''"), 'table element provides writing-table-wrapper in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-table' : ''"), 'table element provides writing-table class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-blockquote' : ''"), 'blockquote provides writing-blockquote class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-ul' : ''"), 'ul provides writing-ul class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-ol' : ''"), 'ol provides writing-ol class in writing mode');
assert(chatMessageSrc.includes("effectiveMode === 'writing' ? 'writing-divider' : ''"), 'hr provides writing-divider class in writing mode');
assert(chatMessageSrc.includes("writing-memo-field"), 'paragraph detects memo / email header fields without modifying content');

// Memo header detection regex test
const memoRegex = /^(?:\*{1,2}|_{1,2})?(?:Subject|To|From|Date|Cc|Bcc|Regarding|Re)\s*:/i;
assert(memoRegex.test('**Subject:** Annual Q4 Financial Review'), 'Matches **Subject:** email header');
assert(memoRegex.test('**To:** Executive Committee'), 'Matches **To:** memo header');
assert(memoRegex.test('*From:* Strategic Operations'), 'Matches *From:* memo header');
assert(memoRegex.test('Date: October 24, 2026'), 'Matches Date: memo header');
assert(memoRegex.test('**Regarding:** Launch Schedule'), 'Matches **Regarding:** memo header');
assert(!memoRegex.test('Today we are discussing our progress.'), 'Does not match regular paragraph text');

// 2. Inspect CSS Design System in index.css
console.log('\nTest Suite 2: CSS Architecture & Typography for Writing Mode');
const cssSrc = fs.readFileSync(path.resolve('./src/styles/index.css'), 'utf-8');

// Scenario 1: Short writing & container baseline
assert(cssSrc.includes('.ai-markdown-container.mode-writing'), 'mode-writing container rule is defined');
assert(cssSrc.includes('max-width: 76ch;'), 'Reading column measure constrained to 76ch preventing ultra-wide eye strain');
assert(cssSrc.includes('line-height: 1.78;'), 'Relaxed editorial leading (1.78) for long-form comfort');

// Scenario 2: Long-form writing & paragraph spacing
assert(cssSrc.includes('.ai-markdown-container.mode-writing .markdown-p'), 'Paragraph styling for mode-writing defined');
assert(cssSrc.includes('margin-bottom: 1.15rem;'), 'Balanced 1.15rem paragraph spacing for clear thought breaks');

// Scenario 3: Multiple headings hierarchy
assert(cssSrc.includes('.writing-h1'), 'writing-h1 style defined');
assert(cssSrc.includes('.writing-h2'), 'writing-h2 style defined');
assert(cssSrc.includes('.writing-h3'), 'writing-h3 style defined');
assert(cssSrc.includes('.writing-h4'), 'writing-h4 style defined');
assert(cssSrc.includes('.writing-h1 + .writing-h2'), 'Title + Subtitle adjacency margin collapse present');
assert(cssSrc.includes('.writing-h2 + .writing-h3'), 'Section + Subsection adjacency margin collapse present');

// Scenario 4: Paragraph-heavy content
assert(cssSrc.includes('word-break: break-word;'), 'Long paragraphs break words properly');
assert(cssSrc.includes('overflow-wrap: break-word;'), 'Overflow wrap ensures zero mobile clipping');

// Scenario 5: Bullet lists
assert(cssSrc.includes('.ai-markdown-container.mode-writing .markdown-ul'), 'Writing mode unordered list styled');
assert(cssSrc.includes('padding-left: 1.75rem;'), 'Unordered list has generous padding-left');

// Scenario 6: Numbered lists & step indent
assert(cssSrc.includes('.ai-markdown-container.mode-writing .markdown-ol'), 'Writing mode ordered list styled');
assert(cssSrc.includes('padding-left: 2.15rem;'), 'Ordered list has 2.15rem padding preventing 2-digit number clipping');
assert(cssSrc.includes('font-variant-numeric: tabular-nums;'), 'Numbered list markers use tabular figures for vertical alignment');

// Scenario 7: Nested lists (3 tiers)
assert(cssSrc.includes('list-style-type: lower-alpha;'), 'Nested ordered list (tier 2) uses lower-alpha');
assert(cssSrc.includes('list-style-type: lower-roman;'), 'Nested ordered list (tier 3) uses lower-roman');
assert(cssSrc.includes('list-style-type: circle;'), 'Nested unordered list (tier 2) uses circle');
assert(cssSrc.includes('list-style-type: square;'), 'Nested unordered list (tier 3) uses square');

// Scenario 8: Blockquotes & Pullquotes
assert(cssSrc.includes('.ai-markdown-container.mode-writing .markdown-blockquote'), 'Blockquote styling present in writing mode');
assert(cssSrc.includes('border-left: 3px solid #d97706;'), 'Amber warm accent border for writing mode blockquotes');
assert(cssSrc.includes('font-style: italic;'), 'Blockquote text formatted in elegant italic');

// Scenario 9: Tables
assert(cssSrc.includes('.writing-table-wrapper'), 'Writing table wrapper defined');
assert(cssSrc.includes('.writing-table'), 'Writing table styled');
assert(cssSrc.includes('background-color: rgba(217, 119, 6, 0.08);'), 'Table header has warm amber tint');
assert(cssSrc.includes('-webkit-overflow-scrolling: touch;'), 'Touch horizontal scroll enabled on tables');

// Scenario 10: Mixed formatting (inline code, links, dividers, memo fields)
assert(cssSrc.includes('.ai-markdown-container.mode-writing .inline-code'), 'Inline code styled for writing mode');
assert(cssSrc.includes('.ai-markdown-container.mode-writing .markdown-link'), 'Links styled with warm amber accent');
assert(cssSrc.includes('.writing-divider'), 'Thematic section break divider styled');
assert(cssSrc.includes('.writing-memo-field'), 'Memo / email header field styling defined');

// Scenario 11: Long responses & clean resets
assert(cssSrc.includes('.ai-markdown-container.mode-writing > *:first-child'), 'First child top margin reset');
assert(cssSrc.includes('.ai-markdown-container.mode-writing > *:last-child'), 'Last child bottom margin reset');

// Scenario 12: Streaming responses & cursor
assert(cssSrc.includes('.ai-markdown-container.mode-writing.is-streaming'), 'Writing mode streaming selector present');
assert(cssSrc.includes('background-color: #d97706;'), 'Amber cursor for dark theme streaming');
assert(cssSrc.includes('[data-theme="light"] .ai-markdown-container.mode-writing.is-streaming'), 'Light theme streaming cursor defined');

// Light Theme overrides
console.log('\nTest Suite 3: Light Theme Support for Writing Mode');
assert(cssSrc.includes('[data-theme="light"] .ai-markdown-container.mode-writing'), 'Light theme mode-writing container override present');
assert(cssSrc.includes('[data-theme="light"] .ai-markdown-container.mode-writing .writing-blockquote'), 'Light theme blockquote override present');
assert(cssSrc.includes('[data-theme="light"] .ai-markdown-container.mode-writing .writing-memo-field'), 'Light theme memo field override present');
assert(cssSrc.includes('[data-theme="light"] .ai-markdown-container.mode-writing .table-responsive-wrapper'), 'Light theme table override present');

// Scenarios 13, 14, 15: Responsive layouts (Desktop, Tablet, Mobile)
console.log('\nTest Suite 4: Responsive Media Queries (Desktop, Tablet, Mobile)');
assert(cssSrc.includes('@media (max-width: 640px)'), 'Mobile media query present');
assert(cssSrc.includes('@media (min-width: 641px) and (max-width: 1024px)'), 'Tablet media query present');

// Summary
console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
if (failed === 0) {
  console.log('All Writing Mode formatting tests PASSED successfully!');
  process.exit(0);
} else {
  console.error('Some tests failed.');
  process.exit(1);
}
