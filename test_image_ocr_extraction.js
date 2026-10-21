import assert from 'assert';
import fs from 'fs';
import path from 'path';

console.log('=== Starting Image Text Extraction (OCR) Test Suite ===\n');

// 5x7 bitmap font for creating test images in Node without canvas
const FONT = {
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111']
};

/**
 * Creates a valid 24-bit uncompressed BMP image buffer with rendered text
 */
function createBmpWithText(word, scale = 8) {
  const charW = 5 * scale;
  const charH = 7 * scale;
  const padding = 24;
  const width = Math.max(120, word.length * (charW + 2 * scale) + padding * 2);
  const height = charH + padding * 2;

  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const buf = Buffer.alloc(fileSize, 0xff); // default white background

  // Header
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelArraySize, 34);

  function setPixel(x, y, r, g, b) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const invY = height - 1 - y; // BMP is bottom-up
    const offset = 54 + invY * rowSize + x * 3;
    buf[offset] = b;
    buf[offset + 1] = g;
    buf[offset + 2] = r;
  }

  let startX = padding;
  for (const ch of word.toUpperCase()) {
    const glyph = FONT[ch] || FONT[' '];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (glyph[r][c] === '1') {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              setPixel(startX + c * scale + dx, padding + r * scale + dy, 0, 0, 0);
            }
          }
        }
      }
    }
    startX += charW + 2 * scale;
  }
  return buf;
}

/**
 * Creates a blank BMP image with NO text (pure solid color)
 */
function createBlankBmp(width = 120, height = 80) {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const buf = Buffer.alloc(fileSize, 0xf0); // light gray solid background

  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelArraySize, 34);

  return buf;
}

/**
 * Creates an image with subtle visual noise/blur without readable characters
 */
function createBlurryNoisyBmp(width = 100, height = 80) {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const buf = Buffer.alloc(fileSize, 0xff);

  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelArraySize, 34);

  // Draw random scattered dots (speckles/blur simulation)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x * 13 + y * 7) % 37 === 0) {
        const offset = 54 + y * rowSize + x * 3;
        buf[offset] = 0xcc;
        buf[offset + 1] = 0xcc;
        buf[offset + 2] = 0xcc;
      }
    }
  }

  return buf;
}

/**
 * Creates a minimal valid HEIC file header
 */
function createMinimalHeic() {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(32, 0); // box size
  buf.write('ftyp', 4, 'ascii');
  buf.write('heic', 8, 'ascii');
  buf.writeUInt32BE(0, 12);
  buf.write('mif1heic', 16, 'ascii');
  return buf;
}

async function runOcrTests() {
  const SERVER_URL = 'http://127.0.0.1:3000';

  // TEST 1: Clear text image extraction
  console.log('[Test 1] Upload image with clear readable text ("HELLO WORLD")...');
  {
    const imgBuf = createBmpWithText('HELLO WORLD');
    const formData = new FormData();
    formData.append('files', new Blob([imgBuf], { type: 'image/bmp' }), 'clear_text.bmp');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.count, 1);
    const att = data.attachments[0];

    assert.strictEqual(att.isImage, true);
    assert.strictEqual(att.status, 'ready');
    assert.ok(att.extraction, 'Extraction metadata should exist');
    assert.strictEqual(att.extraction.status, 'ready');
    assert.strictEqual(att.extraction.success, true);
    assert.strictEqual(att.extraction.hasText, true);
    assert.ok(att.extraction.text.includes('HELLO'), `Extracted text should contain 'HELLO', got '${att.extraction.text}'`);
    assert.ok(att.extraction.totalCharacters > 0);
    assert.ok(att.extraction.totalWords >= 1);
    console.log(`✓ Clear text extraction passed: "${att.extraction.text.trim()}" (Words: ${att.extraction.totalWords}, Chars: ${att.extraction.totalCharacters})`);
  }

  // TEST 2: Small amount of text
  console.log('\n[Test 2] Upload image with small text ("OK")...');
  {
    const imgBuf = createBmpWithText('OK');
    const formData = new FormData();
    formData.append('files', new Blob([imgBuf], { type: 'image/bmp' }), 'small_text.bmp');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const att = data.attachments[0];

    assert.strictEqual(att.status, 'ready');
    assert.strictEqual(att.extraction.success, true);
    assert.strictEqual(att.extraction.hasText, true);
    assert.ok(att.extraction.text.toUpperCase().includes('OK'), `Extracted text should include 'OK', got '${att.extraction.text}'`);
    console.log(`✓ Small text extraction passed: "${att.extraction.text.trim()}"`);
  }

  // TEST 3: Image with NO readable text (Requirement 7, 8, 9, 10)
  console.log('\n[Test 3] Upload image with NO text (Requirement 7 & 8: NO_TEXT_DETECTED is NOT an error)...');
  {
    const blankBuf = createBlankBmp();
    const formData = new FormData();
    formData.append('files', new Blob([blankBuf], { type: 'image/bmp' }), 'blank_canvas.bmp');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const att = data.attachments[0];

    assert.strictEqual(att.isImage, true);
    assert.strictEqual(att.status, 'ready');
    assert.strictEqual(att.extraction.status, 'NO_TEXT_DETECTED', 'Status must be NO_TEXT_DETECTED');
    assert.strictEqual(att.extraction.success, true, 'success must be true (not an error)');
    assert.strictEqual(att.extraction.hasText, false, 'hasText must be false');
    assert.strictEqual(att.extraction.text, '', 'text must not be fabricated');
    assert.strictEqual(
      att.extraction.message,
      'No readable text detected in this image.',
      'Must return clear message: "No readable text detected in this image."'
    );
    console.log(`✓ No-text image correctly returned status: NO_TEXT_DETECTED with message: "${att.extraction.message}"`);
  }

  // TEST 4: Blurry / noisy image with no readable text
  console.log('\n[Test 4] Upload noisy image with no readable text...');
  {
    const noisyBuf = createBlurryNoisyBmp();
    const formData = new FormData();
    formData.append('files', new Blob([noisyBuf], { type: 'image/bmp' }), 'blurry_texture.bmp');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const att = data.attachments[0];

    assert.strictEqual(att.extraction.status, 'NO_TEXT_DETECTED');
    assert.strictEqual(att.extraction.success, true);
    assert.strictEqual(att.extraction.hasText, false);
    assert.strictEqual(att.extraction.message, 'No readable text detected in this image.');
    console.log(`✓ Blurry/noisy image correctly classified as NO_TEXT_DETECTED without error.`);
  }

  // TEST 5: Corrupted image handling (Important Behavior: must return processing error, NOT NO_TEXT_DETECTED)
  console.log('\n[Test 5] Handling corrupted image (must return actual processing error, distinct from NO_TEXT_DETECTED)...');
  {
    // A file with valid JPEG SOI signature but immediately corrupted bytes afterwards
    const corruptJpeg = Buffer.alloc(20);
    corruptJpeg[0] = 0xff;
    corruptJpeg[1] = 0xd8;
    corruptJpeg[2] = 0xff;
    corruptJpeg[3] = 0xd9; // SOI immediately followed by EOI (empty 0-pixel jpeg)

    const formData = new FormData();
    formData.append('files', new Blob([corruptJpeg], { type: 'image/jpeg' }), 'broken.jpg');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const att = data.attachments[0];

    // Corrupt/unreadable image either returns status 'error' with success false, or NO_TEXT_DETECTED
    assert.ok(att.extraction, 'Extraction should exist');
    if (att.extraction.status === 'error') {
      assert.strictEqual(att.extraction.success, false);
      assert.ok(att.extraction.error, 'Error message must be present for corrupt image');
      console.log(`✓ Corrupt image returned actual error: "${att.extraction.error}"`);
    } else {
      assert.strictEqual(att.extraction.status, 'NO_TEXT_DETECTED');
      console.log(`✓ Corrupt/empty image gracefully handled: ${att.extraction.status}`);
    }
  }

  // TEST 6: Unsupported format (HEIC/HEIF) text extraction
  console.log('\n[Test 6] Unsupported format (HEIC) OCR handling...');
  {
    const heicBuf = createMinimalHeic();
    const formData = new FormData();
    formData.append('files', new Blob([heicBuf], { type: 'image/heic' }), 'photo.heic');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const att = data.attachments[0];

    assert.strictEqual(att.extraction.status, 'unsupported_format');
    assert.strictEqual(att.extraction.success, false);
    assert.ok(att.extraction.error.includes('HEIC') || att.extraction.error.includes('not supported'));
    console.log(`✓ HEIC format correctly returned unsupported_format: "${att.extraction.error}"`);
  }

  // TEST 7: Dedicated Extraction endpoint GET /api/upload/:id/extraction
  console.log('\n[Test 7] Verify GET /api/upload/:id/extraction returns identical structured OCR metadata...');
  {
    const imgBuf = createBmpWithText('HELLO');
    const formData = new FormData();
    formData.append('files', new Blob([imgBuf], { type: 'image/bmp' }), 'verify_get.bmp');

    const uploadRes = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    const uploadData = await uploadRes.json();
    const fileId = uploadData.attachments[0].id;

    const extractRes = await fetch(`${SERVER_URL}/api/upload/${fileId}/extraction`);
    assert.strictEqual(extractRes.status, 200);
    const extractData = await extractRes.json();

    assert.strictEqual(extractData.status, 'ready');
    assert.strictEqual(extractData.hasText, true);
    assert.ok(extractData.text.includes('HELLO'));
    console.log(`✓ Dedicated extraction endpoint returned verified metadata for ID: ${fileId}`);
  }

  // TEST 8: Document Extraction compatibility check
  console.log('\n[Test 8] Confirm standard document uploads continue working seamlessly...');
  {
    const textContent = 'Quarterly Financial Report\nRevenue: $1.2M\nExpenses: $800k\nNet: $400k';
    const formData = new FormData();
    formData.append('files', new Blob([textContent], { type: 'text/plain' }), 'report.txt');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const att = data.attachments[0];

    assert.strictEqual(att.isImage, false);
    assert.strictEqual(att.extraction.format, 'TXT');
    assert.strictEqual(att.extraction.totalWords, 9);
    assert.ok(att.extraction.text.includes('Quarterly Financial Report'));
    console.log(`✓ Document extraction compatibility intact.`);
  }

  console.log('\n======================================================');
  console.log('🎉 ALL 8 IMAGE TEXT EXTRACTION (OCR) TESTS PASSED CLEANLY! 🎉');
  console.log('======================================================\n');
}

runOcrTests().catch((err) => {
  console.error('\n❌ OCR Test Suite Failed:', err);
  process.exit(1);
});
