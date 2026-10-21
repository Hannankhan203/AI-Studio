import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== Starting Image Upload & Security Test Suite ===\n');

// 1. Helper to create valid image buffers
function createMinimalJpeg() {
  // JPEG SOI (FF D8) + APP0 marker + SOF0 (baseline 10x10) + EOI (FF D9)
  const buf = Buffer.alloc(32);
  buf[0] = 0xff; buf[1] = 0xd8; // SOI
  buf[2] = 0xff; buf[3] = 0xe0; // APP0
  buf[4] = 0x00; buf[5] = 0x10; // length
  buf.write('JFIF\0', 6, 'ascii');
  buf[11] = 0x01; buf[12] = 0x01; // version
  buf[13] = 0x00; buf[14] = 0x00; buf[15] = 0x01; buf[16] = 0x00; buf[17] = 0x01;
  // SOF0 marker
  buf[18] = 0xff; buf[19] = 0xc0;
  buf[20] = 0x00; buf[21] = 0x0b; // length
  buf[22] = 0x08; // precision
  buf.writeUInt16BE(48, 23); // height = 48
  buf.writeUInt16BE(64, 25); // width = 64
  buf[27] = 0x03; // components
  buf[28] = 0xff; buf[29] = 0xd9; // EOI
  return buf;
}

function createMinimalPng() {
  // 8-byte signature + IHDR chunk (width=32, height=16)
  const buf = Buffer.alloc(33);
  // Signature: 89 50 4E 47 0D 0A 1A 0A
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  sig.forEach((b, i) => { buf[i] = b; });
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(32, 16); // width = 32
  buf.writeUInt32BE(16, 20); // height = 16
  buf[24] = 8; // bit depth
  buf[25] = 2; // color type (RGB)
  return buf;
}

function createMinimalGif() {
  // Header: GIF89a + width=100 (LE), height=80 (LE)
  const buf = Buffer.alloc(14);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(100, 6);
  buf.writeUInt16LE(80, 8);
  buf[10] = 0x80; // color table info
  buf[11] = 0x00;
  buf[12] = 0x00;
  buf[13] = 0x3b; // trailer
  return buf;
}

function createMinimalBmp() {
  // BM header (14 bytes) + DIB header (40 bytes)
  const buf = Buffer.alloc(54);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54, 2); // file size
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // DIB header size
  buf.writeInt32LE(120, 18); // width = 120
  buf.writeInt32LE(90, 22);  // height = 90
  buf.writeUInt16LE(1, 26);  // color planes
  buf.writeUInt16LE(24, 28); // bpp
  return buf;
}

function createMinimalWebp() {
  // RIFF header (4) + size (4) + WEBP (4) + VP8 (4)
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(12, 16); // chunk size
  // Frame tag
  buf[20] = 0x00; buf[21] = 0x00; buf[22] = 0x00;
  buf[23] = 0x9d; buf[24] = 0x01; buf[25] = 0x2a; // 0x2a019d sync code
  buf.writeUInt16LE(60, 26); // width = 60
  buf.writeUInt16LE(40, 28); // height = 40
  return buf;
}

function createMinimalHeic() {
  // ISOBMFF: size(4) + 'ftyp'(4) + 'heic'(4) + minor_version(4) + compatible_brands
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(32, 0); // box size
  buf.write('ftyp', 4, 'ascii');
  buf.write('heic', 8, 'ascii');
  buf.writeUInt32BE(0, 12);
  buf.write('mif1heic', 16, 'ascii');
  return buf;
}

async function runTests() {
  const SERVER_URL = 'http://127.0.0.1:3000';

  // TEST 1: Valid JPEG Upload
  console.log('[Test 1] Upload valid JPEG with dimensions...');
  {
    const jpegBuf = createMinimalJpeg();
    const formData = new FormData();
    const blob = new Blob([jpegBuf], { type: 'image/jpeg' });
    formData.append('files', blob, 'sample_photo.jpg');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.count, 1);
    const att = data.attachments[0];
    assert.strictEqual(att.isImage, true, 'isImage should be true');
    assert.strictEqual(att.extension, 'JPG');
    assert.strictEqual(att.originalName, 'sample_photo.jpg');
    assert.strictEqual(att.status, 'ready', 'Image status should be ready');
    assert.ok(att.id && att.id.length === 36, 'Should generate valid UUID');
    assert.ok(!att.diskFilename, 'diskFilename must NOT be exposed');
    assert.ok(!att.fullDiskPath, 'fullDiskPath must NOT be exposed');
    console.log('✓ Valid JPEG upload passed: ' + JSON.stringify({ id: att.id, status: att.status, dimensions: att.dimensions }));
  }

  // TEST 2: Valid PNG Upload
  console.log('\n[Test 2] Upload valid PNG with dimensions...');
  {
    const pngBuf = createMinimalPng();
    const formData = new FormData();
    const blob = new Blob([pngBuf], { type: 'image/png' });
    formData.append('files', blob, 'chart_diagram.png');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const att = data.attachments[0];
    assert.strictEqual(att.isImage, true);
    assert.strictEqual(att.extension, 'PNG');
    assert.strictEqual(att.status, 'ready');
    assert.deepStrictEqual(att.dimensions, { width: 32, height: 16 });
    console.log('✓ Valid PNG upload passed with correct dimensions: 32x16');
  }

  // TEST 3: Valid WebP, GIF, BMP, HEIC Uploads
  console.log('\n[Test 3] Upload WebP, GIF, BMP, HEIC images...');
  {
    const webpBuf = createMinimalWebp();
    const gifBuf = createMinimalGif();
    const bmpBuf = createMinimalBmp();
    const heicBuf = createMinimalHeic();

    const formData = new FormData();
    formData.append('files', new Blob([webpBuf], { type: 'image/webp' }), 'banner.webp');
    formData.append('files', new Blob([gifBuf], { type: 'image/gif' }), 'animation.gif');
    formData.append('files', new Blob([bmpBuf], { type: 'image/bmp' }), 'graphic.bmp');
    formData.append('files', new Blob([heicBuf], { type: 'image/heic' }), 'iphone_shot.heic');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.count, 4);
    assert.ok(data.attachments.every(a => a.isImage === true));
    assert.ok(data.attachments.every(a => a.status === 'ready'));
    console.log('✓ WebP, GIF, BMP, and HEIC multi-upload all validated successfully');
  }

  // TEST 4: Invalid/Corrupt JPEG (missing SOI magic bytes)
  console.log('\n[Test 4] Reject corrupt JPEG without SOI marker...');
  {
    const fakeJpeg = Buffer.from('NOT A REAL JPEG FILE CONTENT 12345678');
    const formData = new FormData();
    formData.append('files', new Blob([fakeJpeg], { type: 'image/jpeg' }), 'fake.jpg');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 400, 'Corrupt image should be rejected with 400');
    const data = await res.json();
    assert.ok(data.error.includes('Invalid JPEG format'), `Expected error message, got: ${data.error}`);
    console.log('✓ Corrupt JPEG correctly rejected with user-facing error: ' + data.error);
  }

  // TEST 5: Disguised Executable Binary (Linux ELF or PE with .jpg extension)
  console.log('\n[Test 5] Reject disguised executable binary disguised as .jpg...');
  {
    const fakeElf = Buffer.alloc(64);
    fakeElf[0] = 0x7f; fakeElf[1] = 0x45; fakeElf[2] = 0x4c; fakeElf[3] = 0x46; // \x7fELF
    const formData = new FormData();
    formData.append('files', new Blob([fakeElf], { type: 'image/jpeg' }), 'malware.jpg');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Binary executable format'), `Expected security rejection, got: ${data.error}`);
    console.log('✓ Disguised executable correctly rejected: ' + data.error);
  }

  // TEST 6: Unsupported File Extension (e.g. .exe, .sh, .py)
  console.log('\n[Test 6] Reject unsupported file extension (.exe)...');
  {
    const formData = new FormData();
    formData.append('files', new Blob([Buffer.from('echo hello')], { type: 'application/x-sh' }), 'script.sh');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('Unsupported file'), `Expected unsupported extension error, got: ${data.error}`);
    console.log('✓ Unsupported file extension rejected: ' + data.error);
  }

  // TEST 7: Path Traversal in Filename & Safe Handling
  console.log('\n[Test 7] Prevent path traversal in filename (e.g. ../../../etc/passwd.png)...');
  {
    const pngBuf = createMinimalPng();
    const formData = new FormData();
    formData.append('files', new Blob([pngBuf], { type: 'image/png' }), '../../../../etc/passwd.png');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const att = data.attachments[0];
    assert.ok(!att.originalName.includes('/'), 'Path traversal characters must be stripped');
    assert.ok(!att.originalName.includes('..'), 'Path traversal dots must be sanitized');
    console.log('✓ Path traversal in filename sanitized safely to: ' + att.originalName);
  }

  // TEST 8: Path Traversal Guard on File Retrieval Endpoint
  console.log('\n[Test 8] Prevent path traversal on file download endpoint...');
  {
    const res = await fetch(`${SERVER_URL}/api/upload/..%2F..%2Fetc%2Fpasswd/file`);
    assert.strictEqual(res.status, 400, 'Non-UUID attachment ID must be rejected with 400');
    console.log('✓ Path traversal in URL parameter rejected with HTTP 400');
  }

  // TEST 9: Existing Document Uploads (PDF, TXT) Still Function Seamlessly
  console.log('\n[Test 9] Verify existing document uploads (PDF, TXT) continue working...');
  {
    const pdfBuf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
    const txtBuf = Buffer.from('Quarterly performance notes and architecture summary.');

    const formData = new FormData();
    formData.append('files', new Blob([pdfBuf], { type: 'application/pdf' }), 'report.pdf');
    formData.append('files', new Blob([txtBuf], { type: 'text/plain' }), 'notes.txt');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.count, 2);
    const pdfAtt = data.attachments.find(a => a.extension === 'PDF');
    const txtAtt = data.attachments.find(a => a.extension === 'TXT');
    assert.ok(pdfAtt && pdfAtt.isImage === false, 'PDF is not an image');
    assert.ok(txtAtt && txtAtt.isImage === false, 'TXT is not an image');
    assert.ok(txtAtt.extraction, 'TXT has document extraction');
    console.log('✓ Document uploads continue working perfectly alongside image uploads');
  }

  // TEST 10: Mixed Multi-Upload (Image + Document)
  console.log('\n[Test 10] Mixed Multi-Upload (Image + Document in single request)...');
  {
    const pngBuf = createMinimalPng();
    const txtBuf = Buffer.from('Architecture overview document.');

    const formData = new FormData();
    formData.append('files', new Blob([pngBuf], { type: 'image/png' }), 'diagram.png');
    formData.append('files', new Blob([txtBuf], { type: 'text/plain' }), 'spec.txt');

    const res = await fetch(`${SERVER_URL}/api/upload`, {
      method: 'POST',
      body: formData
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.count, 2);
    const imgAtt = data.attachments.find(a => a.extension === 'PNG');
    const docAtt = data.attachments.find(a => a.extension === 'TXT');
    assert.strictEqual(imgAtt.isImage, true);
    assert.strictEqual(docAtt.isImage, false);
    console.log('✓ Mixed upload succeeded with correct classification for each file');
  }

  console.log('\n🎉 ALL 10 SECURITY AND IMAGE UPLOAD TESTS PASSED CLEANLY! 🎉\n');
}

runTests().catch(err => {
  console.error('\n❌ Test execution failed:', err);
  process.exit(1);
});
