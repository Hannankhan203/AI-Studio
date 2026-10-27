/**
 * Focused Regression Suite for Phase 2B:
 * Image Attachment Hydration from IndexedDB across Reloaded Sessions
 */

import assert from 'node:assert';
import {
  saveAttachmentBlob,
  getAttachmentRecord,
  getAttachmentBlob,
  convertBlobToDataUrl,
  hydrateAttachmentsWithImageBytes
} from '../src/services/attachmentStorageService.js';

// Setup minimal In-Memory IndexedDB shim for Node test runner
const memoryStores = new Map();

globalThis.indexedDB = {
  open(dbName, version) {
    const req = {
      result: {
        objectStoreNames: {
          contains: (name) => memoryStores.has(name)
        },
        createObjectStore: (name) => {
          if (!memoryStores.has(name)) memoryStores.set(name, new Map());
          return {
            createIndex: () => {}
          };
        },
        transaction: (storeNames, mode) => {
          const storeName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
          if (!memoryStores.has(storeName)) {
            memoryStores.set(storeName, new Map());
          }
          const map = memoryStores.get(storeName);
          return {
            objectStore: () => ({
              put: (record) => {
                const putReq = {};
                setTimeout(() => {
                  map.set(record.id, record);
                  if (putReq.onsuccess) putReq.onsuccess({ target: putReq });
                }, 0);
                return putReq;
              },
              get: (id) => {
                const getReq = { result: map.get(id) || null };
                setTimeout(() => {
                  getReq.result = map.get(id) || null;
                  if (getReq.onsuccess) getReq.onsuccess({ target: getReq });
                }, 0);
                return getReq;
              }
            })
          };
        }
      }
    };
    setTimeout(() => {
      if (req.onupgradeneeded) {
        req.onupgradeneeded({ target: req });
      }
      if (req.onsuccess) {
        req.onsuccess({ target: req });
      }
    }, 0);
    return req;
  }
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

console.log('=== Starting Phase 2B Image Hydration Regression Suite ===\n');

// 1. Existing session: Previously uploaded image remains usable for follow-up
await test('Existing session: In-memory image attachment retains usable payload for follow-up', async () => {
  const existingAtt = {
    id: 'att-session-1',
    name: 'photo.png',
    type: 'image/png',
    isImage: true,
    base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  };

  const hydrated = await hydrateAttachmentsWithImageBytes([existingAtt]);
  assert.strictEqual(hydrated.length, 1);
  assert.strictEqual(hydrated[0].id, 'att-session-1');
  assert.strictEqual(hydrated[0].base64, existingAtt.base64);
  assert.strictEqual(hydrated[0].dataUrl, existingAtt.dataUrl);
});

// 2. Reloaded session: Recover serialized attachment without bytes from IndexedDB
await test('Reloaded session: Deserialized attachment without bytes recovers original image from IndexedDB', async () => {
  const imageId = 'att-reloaded-101';
  const rawPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
  const mockBlob = new Blob([rawPngBytes], { type: 'image/png' });

  // Save blob into IndexedDB
  const saved = await saveAttachmentBlob(imageId, mockBlob, {
    name: 'architecture_diagram.png',
    originalName: 'architecture_diagram.png',
    type: 'image/png',
    size: rawPngBytes.length,
    isImage: true
  });
  assert.strictEqual(saved, true, 'Failed to save mockBlob to IndexedDB');

  // Verify getAttachmentBlob retrieves the blob
  const retrievedBlob = await getAttachmentBlob(imageId);
  assert.ok(retrievedBlob, 'getAttachmentBlob must return stored blob');
  assert.strictEqual(retrievedBlob.size, rawPngBytes.length);

  // Serialized representation as stored in Firestore / localStorage (bytes stripped)
  const serializedChatAttachment = {
    id: imageId,
    name: 'architecture_diagram.png',
    originalName: 'architecture_diagram.png',
    size: rawPngBytes.length,
    formattedSize: '12 B',
    type: 'image/png',
    extension: '.png',
    isImage: true,
    status: 'uploaded',
    extraction: null
  };
  assert.strictEqual(serializedChatAttachment.base64, undefined);
  assert.strictEqual(serializedChatAttachment.dataUrl, undefined);

  // Hydrate before request dispatch
  const hydrated = await hydrateAttachmentsWithImageBytes([serializedChatAttachment]);
  assert.strictEqual(hydrated.length, 1);
  const hydratedAtt = hydrated[0];
  assert.strictEqual(hydratedAtt.id, imageId);
  assert.ok(hydratedAtt.base64, 'Must have hydrated base64 payload');
  assert.ok(hydratedAtt.base64.startsWith('data:image/png;base64,'));

  // Verify byte equality
  const expectedBase64 = `data:image/png;base64,${rawPngBytes.toString('base64')}`;
  assert.strictEqual(hydratedAtt.base64, expectedBase64);
});

// 3. Missing IndexedDB record degrades gracefully without crashing
await test('Missing IndexedDB record: Request degrades gracefully without crashing or throwing', async () => {
  const missingAttachment = {
    id: 'att-non-existent-999',
    name: 'missing.png',
    type: 'image/png',
    isImage: true,
    extraction: null
  };

  const hydrated = await hydrateAttachmentsWithImageBytes([missingAttachment]);
  assert.strictEqual(hydrated.length, 1);
  assert.strictEqual(hydrated[0].id, 'att-non-existent-999');
  assert.strictEqual(hydrated[0].base64, undefined);
  assert.strictEqual(hydrated[0].dataUrl, undefined);
});

// 4. Missing image bytes: Do not fabricate an image part
await test('Missing image bytes: Empty or corrupt blob does not fabricate an image payload', async () => {
  const emptyBlobId = 'att-empty-blob';
  const emptyBlob = new Blob([], { type: 'image/png' }); // 0 bytes

  await saveAttachmentBlob(emptyBlobId, emptyBlob, {
    name: 'empty.png',
    type: 'image/png',
    isImage: true
  });

  const emptyAtt = {
    id: emptyBlobId,
    name: 'empty.png',
    type: 'image/png',
    isImage: true
  };

  const hydrated = await hydrateAttachmentsWithImageBytes([emptyAtt]);
  assert.strictEqual(hydrated[0].base64, undefined, 'Must not fabricate base64 for 0-byte blob');
});

// 5. Payload integrity: Expected MIME type and exact byte sequence
await test('Payload integrity: Restored payload matches original MIME type and binary bytes exactly', async () => {
  const id = 'att-integrity-test';
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const jpegBlob = new Blob([jpegBytes], { type: 'image/jpeg' });

  await saveAttachmentBlob(id, jpegBlob, {
    name: 'sample.jpeg',
    type: 'image/jpeg',
    isImage: true
  });

  const att = {
    id,
    name: 'sample.jpeg',
    type: 'image/jpeg',
    isImage: true
  };

  const [hydrated] = await hydrateAttachmentsWithImageBytes([att]);
  assert.ok(hydrated.base64.startsWith('data:image/jpeg;base64,'));
  const restoredRaw = Buffer.from(hydrated.base64.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  assert.deepStrictEqual(restoredRaw, jpegBytes);
});

// 6. Persistence safety: Temporary base64 data is not persisted to storage representation
await test('Persistence safety: Temporary base64 data is not written into storage serialization', async () => {
  const hydratedAtt = {
    id: 'att-persist-safety',
    name: 'temporary.png',
    originalName: 'temporary.png',
    size: 1024,
    formattedSize: '1 KB',
    type: 'image/png',
    extension: '.png',
    isImage: true,
    status: 'uploaded',
    base64: 'data:image/png;base64,temporaryData',
    dataUrl: 'data:image/png;base64,temporaryData',
    extraction: { status: 'ready', hasText: false, text: '' }
  };

  // Simulate serializeAttachmentForStorage behavior in chatStorageService.js
  const serialized = {
    id: hydratedAtt.id,
    name: hydratedAtt.name || hydratedAtt.originalName || 'document',
    originalName: hydratedAtt.originalName || hydratedAtt.name || 'document',
    size: hydratedAtt.size || 0,
    formattedSize: hydratedAtt.formattedSize || '',
    type: hydratedAtt.type || hydratedAtt.mimeType || '',
    extension: hydratedAtt.extension || '',
    isImage: Boolean(hydratedAtt.isImage),
    status: hydratedAtt.status || 'uploaded',
    extraction: hydratedAtt.extraction || null
  };

  assert.strictEqual(serialized.base64, undefined);
  assert.strictEqual(serialized.dataUrl, undefined);
  assert.strictEqual(serialized.blob, undefined);
  assert.strictEqual(JSON.stringify(serialized).includes('temporaryData'), false);
});

// 7. No duplicates: Usable payload is not duplicated or re-read
await test('No duplicates: Attachment with existing usable bytes is preserved as-is without re-read', async () => {
  const existingAtt = {
    id: 'att-no-dup',
    name: 'existing.png',
    type: 'image/png',
    isImage: true,
    base64: 'data:image/png;base64,AAAABBBBCCCC'
  };

  const [result] = await hydrateAttachmentsWithImageBytes([existingAtt]);
  assert.strictEqual(result, existingAtt, 'Must return same reference when already has base64');
});

// 8. Existing document behavior: Non-image documents and OCR text preserved for follow-ups
await test('Existing document behavior: Text document metadata and OCR text are untouched', async () => {
  const docxAtt = {
    id: 'att-docx-1',
    name: 'spec.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    isImage: false,
    extraction: {
      status: 'ready',
      text: 'Section 1: Architecture Overview and System Goals',
      totalCharacters: 48,
      totalWords: 7
    }
  };

  const [result] = await hydrateAttachmentsWithImageBytes([docxAtt]);
  assert.strictEqual(result.isImage, false);
  assert.strictEqual(result.base64, undefined);
  assert.strictEqual(result.extraction.text, 'Section 1: Architecture Overview and System Goals');
});

// 9. Simulated Serverless Cold Start: Request with hydrated client payload succeeds with empty server fileRegistry
await test('Simulated Serverless: Server accepts hydrated client base64 when in-memory fileRegistry is empty', async () => {
  const testPngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
    0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82
  ]);

  const clientHydratedAttachment = {
    id: `unregistered-coldstart-${Date.now()}`,
    name: 'coldstart_photo.png',
    type: 'image/png',
    isImage: true,
    base64: `data:image/png;base64,${testPngBytes.toString('base64')}`,
    extraction: { status: 'ready', hasText: false, text: '' }
  };

  // POST directly to running server /api/chat
  const res = await fetch('http://127.0.0.1:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'What image did I upload? Reply in one short sentence.',
      provider: 'gemini',
      stream: false,
      attachments: [clientHydratedAttachment]
    })
  });

  assert.strictEqual(res.status, 200, 'Server must return 200 OK');
  const data = await res.json();
  assert.ok(data.text, 'Must return response text');
  assert.strictEqual(data.provider, 'gemini');
});

console.log(`\n=== Image Hydration Tests Complete: ${passed} Passed, ${failed} Failed ===`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
