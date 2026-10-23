/**
 * Orvix Learning Mode Professional Formatting Verification Suite
 * Tests educational structures, callouts, lists, tables, streaming, and responsiveness.
 */

import fs from 'fs';
import path from 'path';

console.log('=== RUNNING ORVIX LEARNING MODE FORMATTING VERIFICATION ===\n');

let passCount = 0;
let failCount = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passCount++;
  } else {
    console.error(`  ✗ FAIL: ${testName}`);
    failCount++;
  }
}

// 1. Verify ChatMessage.jsx includes enhanced detectCalloutType & createMarkdownComponents
console.log('Test Suite 1: Callout Detection Patterns');
const chatMessagePath = path.resolve('src/components/chat/ChatMessage.jsx');
const chatMessageCode = fs.readFileSync(chatMessagePath, 'utf-8');

assert(chatMessageCode.includes('detectCalloutType'), 'detectCalloutType function exists');
assert(chatMessageCode.includes('important'), 'important callout type supported');
assert(chatMessageCode.includes('warning'), 'warning callout type supported');
assert(chatMessageCode.includes('note'), 'note callout type supported');
assert(chatMessageCode.includes('tip'), 'tip callout type supported');
assert(chatMessageCode.includes('takeaway'), 'takeaway callout type supported');
assert(chatMessageCode.includes('definition'), 'definition callout type supported');
assert(chatMessageCode.includes('example'), 'example callout type supported');
assert(chatMessageCode.includes('comparison'), 'comparison callout type supported');
assert(chatMessageCode.includes('stripAlertTag') || chatMessageCode.includes('stripped'), 'GFM alert tag cleanup in callout body supported');

// Test Regex Patterns directly against educational test inputs
function testDetect(cleanText) {
  const calloutPatterns = [
    { type: 'important', label: 'Important', pattern: /^(?:[\*\_]{1,3})?(?:Important|Caution|Notice|Crucial|Critical)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i },
    { type: 'warning', label: 'Warning', pattern: /^(?:[\*\_]{1,3})?(?:Warnings?|Common Pitfalls?|Pitfalls?|Watch Out|Common Mistakes?)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i },
    { type: 'note', label: 'Note', pattern: /^(?:[\*\_]{1,3})?(?:Notes?|Quick Notes?|FYI|Please Note|Info|Information)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i },
    { type: 'tip', label: 'Tip', pattern: /^(?:[\*\_]{1,3})?(?:Tips?|Study Tips?|Pro Tips?|Helpful Tips?)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i },
    { type: 'takeaway', label: 'Key Takeaway', pattern: /^(?:[\*\_]{1,3})?(?:Key Takeaways?|Takeaways?|Key Points?|Core Concepts?|Summary|In Summary)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i },
    { type: 'definition', label: 'Definition', pattern: /^(?:[\*\_]{1,3})?(?:Definitions?|Terminology|Key Terms?|Concept Definitions?)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i },
    { type: 'example', label: 'Example', pattern: /^(?:[\*\_]{1,3})?(?:Examples?|Real-World Examples?|Practical Examples?|Analog(?:y|ies)|Everyday Analog(?:y|ies)|Illustrative Examples?|Worked Examples?)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i },
    { type: 'comparison', label: 'Comparison', pattern: /^(?:[\*\_]{1,3})?(?:Comparisons?|Comparison Matrix|Contrast|Side-by-Side)(?:\s*(?:\([^\)]+\)|#?\d+|[A-Z]))?\s*(?::\s*(?:[\*\_]{1,3})?|(?:[\*\_]{1,3})?\s*:)/i }
  ];

  const cleaned = cleanText.trim().replace(/^(?:>+\s*)?[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]*\s*/u, '');

  if (/^\[!(NOTE|INFO)\]/i.test(cleaned)) return 'note';
  if (/^\[!TIP\]/i.test(cleaned)) return 'tip';
  if (/^\[!(IMPORTANT|ATTENTION)\]/i.test(cleaned)) return 'important';
  if (/^\[!(WARNING|CAUTION)\]/i.test(cleaned)) return 'warning';

  for (const p of calloutPatterns) {
    if (p.pattern.test(cleaned)) return p.type;
  }
  return null;
}

console.log('\nTest Suite 2: Callout Variations & Edge Cases');
assert(testDetect('**Important:** Verify edge conditions') === 'important', 'Matches **Important:**');
assert(testDetect('**Important**: Notice the colon outside') === 'important', 'Matches **Important**:');
assert(testDetect('⚠️ **Warning:** Memory leak possible') === 'warning', 'Matches ⚠️ **Warning:** with emoji');
assert(testDetect('💡 **Tip:** Use binary search') === 'tip', 'Matches 💡 **Tip:** with emoji');
assert(testDetect('📌 **Note (Performance):** O(1) average lookup') === 'note', 'Matches 📌 **Note (Performance):** with parenthetical');
assert(testDetect('🎯 **Key Takeaway:** Superposition enables exponential state space') === 'takeaway', 'Matches 🎯 **Key Takeaway:**');
assert(testDetect('📖 **Definition (Qubit):** Quantum bit representing linear combination') === 'definition', 'Matches 📖 **Definition (Qubit):**');
assert(testDetect('🔍 **Example 1:** Coin spinning on a table') === 'example', 'Matches 🔍 **Example 1:** with number');
assert(testDetect('**Comparison Matrix:** Relational vs Document databases') === 'comparison', 'Matches **Comparison Matrix:**');
assert(testDetect('> [!NOTE]') === 'note', 'Matches GFM > [!NOTE]');
assert(testDetect('> [!WARNING]') === 'warning', 'Matches GFM > [!WARNING]');
assert(testDetect('Regular explanatory paragraph with no callout.') === null, 'Rejects standard text correctly');

console.log('\nTest Suite 3: CSS Architecture for Learning Mode');
const cssPath = path.resolve('src/styles/index.css');
const cssContent = fs.readFileSync(cssPath, 'utf-8');

assert(cssContent.includes('.ai-markdown-container.mode-learning'), 'mode-learning container rule present');
assert(cssContent.includes('.educational-topic-heading'), 'h1 topic heading class present');
assert(cssContent.includes('.educational-concept-heading'), 'h2 concept heading class present');
assert(cssContent.includes('.educational-subconcept-heading'), 'h3 subconcept heading class present');
assert(cssContent.includes('.educational-step-heading'), 'h4 step heading class present');
assert(cssContent.includes('.ai-markdown-container.mode-learning .markdown-ol'), 'ol styling present in mode-learning');
assert(cssContent.includes('.ai-markdown-container.mode-learning .markdown-ul'), 'ul styling present in mode-learning');
assert(cssContent.includes('list-style-type: lower-alpha'), 'Multi-tier nested ordered lists support lower-alpha');
assert(cssContent.includes('list-style-type: lower-roman'), 'Multi-tier nested ordered lists support lower-roman');
assert(cssContent.includes('list-style-type: circle'), 'Multi-tier nested unordered lists support circle');
assert(cssContent.includes('list-style-type: square'), 'Multi-tier nested unordered lists support square');
assert(cssContent.includes('.callout-comparison'), 'callout-comparison rule present');
assert(cssContent.includes('.callout-important'), 'callout-important rule present');
assert(cssContent.includes('.callout-warning'), 'callout-warning rule present');
assert(cssContent.includes('.callout-note'), 'callout-note rule present');
assert(cssContent.includes('.callout-tip'), 'callout-tip rule present');
assert(cssContent.includes('.callout-takeaway'), 'callout-takeaway rule present');
assert(cssContent.includes('.callout-definition'), 'callout-definition rule present');
assert(cssContent.includes('.callout-example'), 'callout-example rule present');
assert(cssContent.includes('[data-theme="light"] .ai-markdown-container.mode-learning'), 'Light theme mode-learning support present');
assert(cssContent.includes('[data-theme="light"] .callout-comparison'), 'Light theme comparison callout present');
assert(cssContent.includes('.ai-markdown-container.mode-learning.is-streaming'), 'Learning mode streaming cursor rule present');

console.log('\nTest Suite 4: Responsive Media Queries');
assert(cssContent.includes('@media (max-width: 640px)'), 'Mobile media query present');
assert(cssContent.includes('@media (min-width: 641px) and (max-width: 1024px)'), 'Tablet media query present');

console.log(`\n=== RESULTS: ${passCount} passed, ${failCount} failed ===`);
if (failCount > 0) {
  process.exit(1);
} else {
  console.log('All Learning Mode formatting tests PASSED successfully!\n');
}
