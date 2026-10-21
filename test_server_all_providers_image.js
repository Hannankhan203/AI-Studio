/**
 * End-to-End HTTP Integration Test for /api/chat with Image OCR Attachments
 * Tests all 4 providers: Gemini, Groq, OpenRouter, Cloudflare Workers AI
 */

import assert from 'assert';

const BASE_URL = 'http://localhost:3000/api/chat';
const ALL_PROVIDERS = ['gemini', 'groq', 'openrouter', 'cloudflare'];

const mockReceiptAttachment = {
  id: 'img-server-receipt-001',
  name: 'store_receipt.png',
  originalName: 'store_receipt.png',
  filename: 'store_receipt.png',
  type: 'image/png',
  isImage: true,
  status: 'ready',
  extraction: {
    id: 'img-server-receipt-001',
    fileId: 'img-server-receipt-001',
    originalName: 'store_receipt.png',
    filename: 'store_receipt.png',
    format: 'PNG',
    isImage: true,
    hasText: true,
    confidence: 96,
    totalCharacters: 185,
    totalWords: 30,
    lineCount: 6,
    text: [
      'ACME SUPERMARKET #104',
      'CASHIER: JANE D. - REGISTER 4',
      'ORGANIC WHOLE MILK    $4.99',
      'SOURDOUGH BREAD       $3.50',
      'SUBTOTAL              $8.49',
      'TOTAL TAX             $0.72'
    ].join('\n')
  }
};

const mockMenuAttachment = {
  id: 'img-server-menu-002',
  name: 'cafe_menu.jpg',
  originalName: 'cafe_menu.jpg',
  filename: 'cafe_menu.jpg',
  type: 'image/jpeg',
  isImage: true,
  status: 'ready',
  extraction: {
    id: 'img-server-menu-002',
    fileId: 'img-server-menu-002',
    originalName: 'cafe_menu.jpg',
    filename: 'cafe_menu.jpg',
    format: 'JPG',
    isImage: true,
    hasText: true,
    confidence: 93,
    totalCharacters: 150,
    totalWords: 24,
    lineCount: 4,
    text: [
      'MORNING SPECIALS',
      'AVOCADO TOAST        $9.00',
      'MATCHA LATTE         $5.50',
      'COLD BREW 16OZ       $4.50'
    ].join('\n')
  }
};

const mockBlankAttachment = {
  id: 'img-server-blank-003',
  name: 'abstract_art.jpg',
  originalName: 'abstract_art.jpg',
  filename: 'abstract_art.jpg',
  type: 'image/jpeg',
  isImage: true,
  status: 'NO_TEXT_DETECTED',
  extraction: {
    id: 'img-server-blank-003',
    fileId: 'img-server-blank-003',
    originalName: 'abstract_art.jpg',
    filename: 'abstract_art.jpg',
    format: 'JPG',
    isImage: true,
    hasText: false,
    confidence: 0,
    totalCharacters: 0,
    totalWords: 0,
    text: '',
    status: 'NO_TEXT_DETECTED',
    message: 'No readable text detected in this image.'
  }
};

async function testNonStreaming(provider, prompt, attachments) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      mode: 'general',
      prompt,
      stream: false,
      attachments
    })
  });

  const json = await res.json();
  return { status: res.status, ok: res.ok, data: json };
}

async function testStreaming(provider, prompt, attachments) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      mode: 'general',
      prompt,
      stream: true,
      attachments
    })
  });

  const text = await res.text();
  const chunks = [];
  let modelUsed = '';
  let fullText = '';

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.type === 'start') {
          modelUsed = parsed.modelUsed;
        } else if (parsed.type === 'chunk' && parsed.text) {
          chunks.push(parsed.text);
          fullText += parsed.text;
        } else if (parsed.type === 'done') {
          if (parsed.text) fullText = parsed.text;
          if (parsed.modelUsed) modelUsed = parsed.modelUsed;
        }
      } catch (_) {}
    }
  }

  return { status: res.status, ok: res.ok, fullText, modelUsed, chunkCount: chunks.length };
}

async function runE2ETests() {
  console.log('=== END-TO-END HTTP TESTS: ALL 4 PROVIDERS WITH IMAGE OCR ===\n');

  for (const provider of ALL_PROVIDERS) {
    console.log(`--- Testing Provider: [${provider.toUpperCase()}] ---`);

    // 1. Single image: "What does this image say?" (Non-streaming)
    console.log(`  [1.1] Non-streaming: "What does this image say?"`);
    const res1 = await testNonStreaming(provider, 'What does this image say?', [mockReceiptAttachment]);
    assert.strictEqual(res1.status, 200, `${provider} non-streaming should return 200`);
    assert(res1.data.text.includes('store_receipt.png'), `${provider} response must cite filename 'store_receipt.png'`);
    assert(res1.data.text.includes('ACME SUPERMARKET'), `${provider} response must contain extracted OCR text`);
    console.log(`    ✓ Cites filename & extracted OCR text (modelUsed: ${res1.data.modelUsed})`);

    // 2. Single image: "What is written in the top section?" (Streaming SSE)
    console.log(`  [1.2] Streaming SSE: "What is written in the top section?"`);
    const streamRes = await testStreaming(provider, 'What is written in the top section?', [mockReceiptAttachment]);
    assert.strictEqual(streamRes.status, 200, `${provider} streaming should return 200`);
    assert(streamRes.fullText.includes('store_receipt.png'), `${provider} streaming must cite filename`);
    assert(streamRes.fullText.includes('ACME SUPERMARKET'), `${provider} streaming must include top section text`);
    console.log(`    ✓ Streamed successfully with ${streamRes.chunkCount} chunks`);

    // 3. Multi-image: Both images attached
    console.log(`  [1.3] Multi-Image Attachments: "Explain the information in these images"`);
    const multiRes = await testNonStreaming(provider, 'Explain the information in these images', [mockReceiptAttachment, mockMenuAttachment]);
    assert.strictEqual(multiRes.status, 200);
    assert(multiRes.data.text.includes('store_receipt.png'), `${provider} multi-doc must cite store_receipt.png`);
    assert(multiRes.data.text.includes('cafe_menu.jpg') || multiRes.data.text.includes('cafe_menu'), `${provider} multi-doc must cite second image`);
    console.log(`    ✓ Multi-image filenames strictly distinguished`);

    // 4. Blank/No-Text Image: Must return uniform "No readable text detected in this image."
    console.log(`  [1.4] Blank Image with NO Text: "What does this image say?"`);
    const blankRes = await testNonStreaming(provider, 'What does this image say?', [mockBlankAttachment]);
    assert.strictEqual(blankRes.status, 200);
    assert.strictEqual(
      blankRes.data.text.trim(),
      'No readable text detected in this image.',
      `${provider} must return exact required message for no text image`
    );
    console.log(`    ✓ Returns exact required message: "${blankRes.data.text.trim()}"`);

    // 5. Blank image in Streaming mode: Must also stream exact required message
    const blankStreamRes = await testStreaming(provider, 'Explain this image', [mockBlankAttachment]);
    assert.strictEqual(blankStreamRes.status, 200);
    assert.strictEqual(
      blankStreamRes.fullText.trim(),
      'No readable text detected in this image.',
      `${provider} streaming must return exact required message for no text image`
    );
    console.log(`    ✓ Streaming mode also returns exact required message`);

    // 6. Normal text-only question (no attachments)
    console.log(`  [1.5] Text-only prompt: "What is quantum computing?"`);
    const textRes = await testNonStreaming(provider, 'What is quantum computing?', []);
    assert.strictEqual(textRes.status, 200);
    assert(textRes.data.text.length > 20, `${provider} text-only response should be populated`);
    console.log(`    ✓ Normal text-only chat unchanged\n`);
  }

  console.log('================================================================');
  console.log('ALL E2E HTTP TESTS PASSED: Gemini, Groq, OpenRouter, Cloudflare');
  console.log('================================================================');
}

runE2ETests().catch((err) => {
  console.error('E2E Test Failed:', err);
  process.exit(1);
});
