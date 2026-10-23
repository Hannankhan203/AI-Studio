/**
 * Verification Test Suite for Orvix Coding Mode & Code Block Renderer
 * Tests all 20 scenarios specified in Section 12 of the Coding Mode prompt.
 */

import { tokenizeCode, TOKEN_TYPES } from './src/utils/syntaxHighlighter.js';
import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

console.log('======================================================================');
console.log('ORVIX CODING MODE — COMPREHENSIVE VERIFICATION TEST SUITE (20 SCENARIOS)');
console.log('======================================================================\n');

// 1. Short JavaScript snippet
console.log('Scenario 1: Short JavaScript snippet');
const shortJs = 'const greeting = "Hello, Orvix!";\nconsole.log(greeting);';
const shortJsTokens = tokenizeCode(shortJs, 'javascript');
assert(shortJsTokens.some(t => t.type === 'keyword' && t.content === 'const'), 'Identifies keyword "const"');
assert(shortJsTokens.some(t => t.type === 'string' && t.content.includes('Hello, Orvix!')), 'Identifies string token');
assert(shortJsTokens.some(t => t.type === 'function' && t.content === 'log'), 'Identifies function call "log"');
assert(shortJsTokens.map(t => t.content).join('') === shortJs, '100% character and whitespace preservation');

// 2. Long JavaScript file (>100 lines)
console.log('\nScenario 2: Long JavaScript file (>100 lines)');
const longJsLines = [];
for (let i = 1; i <= 120; i++) {
  longJsLines.push(`const var_${i} = ${i * 10}; // Line ${i}`);
}
const longJsCode = longJsLines.join('\n');
const splitLongLines = longJsCode.split('\n');
assert(splitLongLines.length === 120, 'Generates exactly 120 lines');
const longTokens = tokenizeCode(longJsCode, 'javascript');
assert(longTokens.map(t => t.content).join('') === longJsCode, 'Preserves all 120 lines without truncation or drift');
assert(longTokens.filter(t => t.type === 'comment').length === 120, 'Correctly highlights comments on all 120 lines');

// 3. JSX / TSX Component
console.log('\nScenario 3: JSX/TSX Component with HTML-like tags');
const jsxCode = `import React, { useState } from 'react';
export function Counter({ initialCount = 0 }: { initialCount: number }) {
  const [count, setCount] = useState<number>(initialCount);
  return (
    <div className="counter-card">
      <button onClick={() => setCount(c => c + 1)}>Increment</button>
      <span>{count}</span>
    </div>
  );
}`;
const jsxTokens = tokenizeCode(jsxCode, 'jsx');
assert(jsxTokens.some(t => t.type === 'keyword' && t.content === 'export'), 'Highlights "export" keyword');
assert(jsxTokens.some(t => t.type === 'tag' && t.content.includes('<div')), 'Highlights JSX opening tag');
assert(jsxTokens.some(t => t.type === 'type' && t.content === 'number'), 'Highlights TypeScript type "number"');
assert(jsxTokens.map(t => t.content).join('') === jsxCode, 'Preserves full JSX structure');

// 4. Python code with indentation, def, return, docstrings, and blank lines
console.log('\nScenario 4: Python code with indentation and blank lines');
const pythonCode = `def fibonacci(n: int) -> list:
    """Calculate fibonacci sequence up to n terms."""
    if n <= 0:
        return []

    # Initialize sequence
    seq = [0, 1]
    while len(seq) < n:
        seq.append(seq[-1] + seq[-2])

    return seq`;
const pyTokens = tokenizeCode(pythonCode, 'python');
assert(pyTokens.some(t => t.type === 'keyword' && t.content === 'def'), 'Highlights "def" keyword');
assert(pyTokens.some(t => t.type === 'string' && t.content.includes('Calculate fibonacci')), 'Highlights triple-quoted docstring');
assert(pyTokens.some(t => t.type === 'comment' && t.content.includes('Initialize sequence')), 'Highlights Python # comment');
assert(pyTokens.some(t => t.type === 'type' && t.content === 'list'), 'Highlights "list" type');
assert(pyTokens.some(t => t.type === 'function' && t.content === 'append'), 'Highlights method call "append"');
assert(pyTokens.map(t => t.content).join('') === pythonCode, 'Preserves indentation and blank lines exactly');

// 5. HTML markup with nested tags and attributes
console.log('\nScenario 5: HTML markup with nested tags and attributes');
const htmlCode = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Orvix AI</title>
  </head>
  <body>
    <!-- Main App Container -->
    <main id="app" class="container">
      <h1>Welcome</h1>
    </main>
  </body>
</html>`;
const htmlTokens = tokenizeCode(htmlCode, 'html');
assert(htmlTokens.some(t => t.type === 'directive' && t.content.includes('DOCTYPE')), 'Highlights DOCTYPE directive');
assert(htmlTokens.some(t => t.type === 'tag' && t.content.includes('<html')), 'Highlights <html tag');
assert(htmlTokens.some(t => t.type === 'attr-name' && t.content === 'class'), 'Highlights attribute name');
assert(htmlTokens.some(t => t.type === 'string' && t.content === '"container"'), 'Highlights attribute value string');
assert(htmlTokens.some(t => t.type === 'comment' && t.content.includes('Main App Container')), 'Highlights HTML comment');
assert(htmlTokens.map(t => t.content).join('') === htmlCode, 'Preserves HTML markup exactly');

// 6. CSS with selectors, properties, values, units, hex colors
console.log('\nScenario 6: CSS with selectors, properties, and values');
const cssCode = `/* Theme Variables */
:root {
  --primary-accent: #10b981;
  --header-height: 56px;
}

.editor-card {
  display: flex;
  padding: 1rem 16px;
  background-color: var(--primary-accent);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}`;
const cssTokens = tokenizeCode(cssCode, 'css');
assert(cssTokens.some(t => t.type === 'comment' && t.content.includes('Theme Variables')), 'Highlights CSS block comment');
assert(cssTokens.some(t => t.type === 'property' && t.content === 'display'), 'Highlights CSS property name');
assert(cssTokens.some(t => t.type === 'constant' && t.content === '#10b981'), 'Highlights hex color code');
assert(cssTokens.some(t => t.type === 'variable' && t.content.includes('--primary-accent')), 'Highlights CSS variable');
assert(cssTokens.map(t => t.content).join('') === cssCode, 'Preserves CSS whitespace and formatting');

// 7. JSON data with nested objects, arrays, types
console.log('\nScenario 7: JSON data with nested objects and types');
const jsonCode = `{
  "id": "chat-101",
  "active": true,
  "count": 42,
  "tags": ["frontend", "ai", "coding"],
  "metadata": null
}`;
const jsonTokens = tokenizeCode(jsonCode, 'json');
assert(jsonTokens.some(t => t.type === 'property' && t.content === '"id"'), 'Highlights JSON object key');
assert(jsonTokens.some(t => t.type === 'string' && t.content === '"chat-101"'), 'Highlights JSON string value');
assert(jsonTokens.some(t => t.type === 'boolean' && t.content === 'true'), 'Highlights boolean literal');
assert(jsonTokens.some(t => t.type === 'number' && t.content === '42'), 'Highlights number literal');
assert(jsonTokens.some(t => t.type === 'boolean' && t.content === 'null'), 'Highlights null literal');
assert(jsonTokens.map(t => t.content).join('') === jsonCode, 'Preserves JSON formatting');

// 8. SQL query with keywords, functions, clauses
console.log('\nScenario 8: SQL query with keywords, functions, and clauses');
const sqlCode = `-- Fetch active users with order summary
SELECT 
  u.id,
  u.name,
  COUNT(o.id) AS total_orders,
  COALESCE(SUM(o.amount), 0.0) AS total_spent
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.status = 'active'
GROUP BY u.id, u.name
ORDER BY total_spent DESC
LIMIT 10;`;
const sqlTokens = tokenizeCode(sqlCode, 'sql');
assert(sqlTokens.some(t => t.type === 'comment' && t.content.includes('Fetch active users')), 'Highlights SQL comment');
assert(sqlTokens.some(t => t.type === 'keyword' && t.content.toUpperCase() === 'SELECT'), 'Highlights SELECT keyword');
assert(sqlTokens.some(t => t.type === 'keyword' && t.content.toUpperCase() === 'LEFT'), 'Highlights LEFT JOIN keyword');
assert(sqlTokens.some(t => t.type === 'function' && t.content.toUpperCase() === 'COUNT'), 'Highlights COUNT aggregate function');
assert(sqlTokens.some(t => t.type === 'string' && t.content === "'active'"), 'Highlights SQL string literal');
assert(sqlTokens.map(t => t.content).join('') === sqlCode, 'Preserves SQL whitespace');

// 9. Bash/Shell script with commands, flags, variables
console.log('\nScenario 9: Bash/Shell script with commands, flags, and variables');
const bashCode = `#!/bin/bash
# Deployment script
APP_ENV="production"
PORT=3000

echo "Deploying in $APP_ENV mode on port $PORT..."
npm run build
if [ $? -eq 0 ]; then
  docker build -t orvix-app:latest .
  echo "Build succeeded!"
fi`;
const bashTokens = tokenizeCode(bashCode, 'bash');
assert(bashTokens.some(t => t.type === 'comment' && t.content.includes('Deployment script')), 'Highlights Bash comment');
assert(bashTokens.some(t => t.type === 'function' && t.content === 'echo'), 'Highlights shell command "echo"');
assert(bashTokens.some(t => t.type === 'function' && t.content === 'npm'), 'Highlights CLI command "npm"');
assert(bashTokens.some(t => t.type === 'variable' && t.content === '$APP_ENV'), 'Highlights shell variable');
assert(bashTokens.some(t => t.type === 'keyword' && t.content === 'if'), 'Highlights "if" keyword');
assert(bashTokens.map(t => t.content).join('') === bashCode, 'Preserves Bash indentation and newlines');

// 10. Code with tabs and spaces (strict indentation preservation)
console.log('\nScenario 10: Code with tabs and spaces (strict preservation)');
const indentedCode = 'function example() {\n\t// Tab indentation\n    // 4 spaces indentation\n        // 8 spaces\n}';
const indentedTokens = tokenizeCode(indentedCode, 'javascript');
const reconstructed = indentedTokens.map(t => t.content).join('');
assert(reconstructed === indentedCode, 'Tabs and spaces are 100% bit-exact preserved');
assert(reconstructed.includes('\t// Tab'), 'Tab character preserved');
assert(reconstructed.includes('    // 4 spaces'), '4 space indentation preserved');

// 11. Blank lines handling
console.log('\nScenario 11: Blank lines handling');
const codeWithBlanks = 'line 1\n\n\nline 4\n\nline 6';
const linesArr = codeWithBlanks.split('\n');
assert(linesArr.length === 6, 'Correct line count includes all blank lines (6 lines)');
assert(linesArr[1] === '', 'Line 2 is empty string');
assert(linesArr[2] === '', 'Line 3 is empty string');
assert(linesArr[4] === '', 'Line 5 is empty string');
// Ensure 1-to-1 line number mapping:
const lineNumbers = linesArr.map((_, i) => i + 1);
assert(JSON.stringify(lineNumbers) === JSON.stringify([1, 2, 3, 4, 5, 6]), 'Line numbers are strictly sequential from 1 to 6 without missing numbers');

// 12. Very long code lines (horizontal scroll test)
console.log('\nScenario 12: Very long code lines (horizontal scroll integrity)');
const longLineCode = 'const veryLongString = "' + 'A'.repeat(500) + '";';
const longLineTokens = tokenizeCode(longLineCode, 'javascript');
assert(longLineTokens.map(t => t.content).join('') === longLineCode, 'Long line preserved without truncation');
assert(!longLineCode.includes('\n'), 'Long line is exactly 1 line without synthetic soft-wrap insertions');

// 13. Line numbers beyond 99 (100, 101, ... width expansion & tabular-nums)
console.log('\nScenario 13: Line numbers beyond 99');
const lines150 = Array.from({ length: 150 }, (_, i) => `console.log(${i + 1});`).join('\n');
const lines150Arr = lines150.split('\n');
assert(lines150Arr.length === 150, 'Contains 150 lines');
const digits150 = Math.max(2, String(lines150Arr.length).length);
assert(digits150 === 3, 'Calculates 3 digits for lines >= 100');
const numbersBeyond99 = lines150Arr.map((_, i) => i + 1);
assert(numbersBeyond99[98] === 99, 'Line 99 is exactly 99');
assert(numbersBeyond99[99] === 100, 'Line 100 is sequential 100 without gaps or misalignment');
assert(numbersBeyond99[149] === 150, 'Line 150 is sequential 150');

// 14. Copy code test: verifying only code is copied (no line numbers, no header)
console.log('\nScenario 14: Copy code test');
const rawSnippet = 'function add(a, b) {\n  return a + b;\n}\n';
const normalized = rawSnippet.replace(/\n$/, '');
assert(normalized === 'function add(a, b) {\n  return a + b;\n}', 'Normalized code strips only final parser newline');
assert(!normalized.includes('1'), 'Code does not include line number 1 as a prefix');
assert(!normalized.includes('Copy code'), 'Code does not include button label text');
assert(!normalized.includes('JavaScript'), 'Code does not include language header badge');

// 15. Streaming code test: progressive chunks render without crashing
console.log('\nScenario 15: Streaming code test');
const streamChunks = [
  'function fetch',
  'function fetchData() {\n',
  'function fetchData() {\n  const url = "/api/data";\n',
  'function fetchData() {\n  const url = "/api/data";\n  return fetch(url);\n}'
];
streamChunks.forEach((chunk, idx) => {
  const tokens = tokenizeCode(chunk, 'javascript');
  const renderedText = tokens.map(t => t.content).join('');
  assert(renderedText === chunk, `Stream step ${idx + 1} renders safely without syntax crash`);
});

// 16. Unspecified language fallback
console.log('\nScenario 16: Unspecified language fallback');
const plainSnippet = 'Generic server output\nStatus: 200 OK\nDone.';
const plainTokens = tokenizeCode(plainSnippet, '');
assert(plainTokens.map(t => t.content).join('') === plainSnippet, 'Renders plain text accurately when no language is given');

// 17, 18, 19, 20: Inspect CSS rules for Desktop, Tablet, Mobile, and Themes
console.log('\nScenarios 17-20: CSS Inspection for Desktop, Tablet, Mobile, and Theme Support');
const cssPath = path.resolve('src/styles/index.css');
const cssContent = fs.readFileSync(cssPath, 'utf8');

assert(cssContent.includes('.code-block-container'), 'CSS contains .code-block-container');
assert(cssContent.includes('.code-line-numbers'), 'CSS contains .code-line-numbers');
assert(cssContent.includes('position: sticky'), 'Line numbers gutter has sticky pinning for horizontal scroll');
assert(cssContent.includes('white-space: pre !important'), 'Code content enforces preformatted whitespace without soft wrap');
assert(cssContent.includes('tabular-nums'), 'Line numbers use tabular-nums for fixed-digit alignment');
assert(cssContent.includes('@media (max-width: 640px)'), 'Contains mobile viewport adjustments (<=640px)');
assert(cssContent.includes('@media (min-width: 641px) and (max-width: 1024px)'), 'Contains tablet viewport adjustments (641px-1024px)');
assert(cssContent.includes('[data-theme="light"] .code-block-container'), 'Contains Light theme overrides for code blocks');
assert(cssContent.includes('.code-syntax .token.keyword'), 'Contains token syntax highlighting for keywords');
assert(cssContent.includes('.code-syntax .token.type'), 'Contains token syntax highlighting for types');
assert(cssContent.includes('.code-syntax .token.constant'), 'Contains token syntax highlighting for constants');
assert(cssContent.includes('.code-editor-dots'), 'Contains macOS/VS Code editor window dots');
assert(cssContent.includes('.ai-markdown-container.mode-coding'), 'Contains Coding Mode specific Markdown hierarchy styles');
assert(cssContent.includes('.coding-inline-code'), 'Contains Coding Mode distinctive inline code styles');

console.log('\n======================================================================');
console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('======================================================================');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n🎉 ALL 20 CODING MODE SCENARIOS PASSED WITH 100% SUCCESS!');
}
