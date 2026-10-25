/**
 * Orvix Firestore Chat Storage Service
 * Handles conversation metadata, message subcollections, title auto-generation,
 * renaming, and deep subcollection deletion in Cloud Firestore.
 *
 * Schema:
 *   users/{userId}/chats/{chatId}
 *     - id: string
 *     - title: string
 *     - userId: string
 *     - createdAt: timestamp
 *     - updatedAt: timestamp
 *
 *   users/{userId}/chats/{chatId}/messages/{messageId}
 *     - id: string
 *     - sender: 'user' | 'assistant'
 *     - content: string
 *     - modelUsed: string | null
 *     - createdAt: timestamp
 *     - clientTimestamp: string
 */

import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  writeBatch
} from 'firebase/firestore';
import {
  auth,
  db,
  isFirebaseConfigured,
  isBrowserOnline,
  syncFirestoreNetworkState
} from '../config/firebaseConfig.js';
import { getIdToken } from './authService.js';
import {
  normalizeAssistantMessage,
  ensureConversationAlternatives
} from './alternativeResponseService.js';

const FIRESTORE_OP_TIMEOUT_MS = 4500;
const activeSyncPromises = new Map();
const activeSubscriptions = new Map();

let customTokenProvider = null;

/**
 * Testing hook allowing unit and integration tests to supply mocked Firebase ID tokens.
 * @param {(() => Promise<string|null>)|null} provider
 */
export function setAuthTokenProviderForTesting(provider) {
  customTokenProvider = provider;
}

/**
 * Helper to securely obtain current user's Firebase ID token.
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<string|null>}
 */
export async function resolveAuthToken(forceRefresh = false) {
  if (customTokenProvider) {
    return customTokenProvider();
  }
  try {
    if (typeof getIdToken === 'function') {
      const token = await getIdToken(forceRefresh);
      if (token) return token;
    }
    if (auth?.currentUser?.getIdToken) {
      return await auth.currentUser.getIdToken(forceRefresh);
    }
  } catch (err) {
    console.warn('Could not resolve Firebase ID token:', err?.message || err);
  }
  return null;
}

/**
 * Helper to resolve the API endpoint URL in both browser and test/server environments.
 * @param {string} endpointPath
 * @returns {string}
 */
export function getApiEndpoint(endpointPath) {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return endpointPath;
  }
  const base = (typeof process !== 'undefined' && process.env?.TEST_API_BASE) || 'http://localhost:3000';
  return `${base}${endpointPath}`;
}

/**
 * Maps a MongoDB conversation document to the frontend conversation UI model.
 * @param {any} conv
 * @returns {any}
 */
export function mapMongoConversationToChat(conv) {
  if (!conv) return null;
  const updatedMs = conv.updatedAt ? new Date(conv.updatedAt).getTime() : Date.now();
  const pinnedMs = conv.pinnedAt ? new Date(conv.pinnedAt).getTime() : null;
  return {
    id: conv.id || conv._id,
    title: conv.title || 'Untitled Chat',
    mode: conv.mode || 'general',
    timestamp: formatChatDateLabel(updatedMs),
    rawUpdatedAt: updatedMs,
    isPinned: Boolean(conv.isPinned),
    pinnedAt: pinnedMs
  };
}

/**
 * Notifies all active subscribers for a user with the latest cached conversations.
 * @param {string} userId
 */
function notifyConversationListeners(userId) {
  if (!userId) return;
  const listeners = activeSubscriptions.get(userId);
  if (listeners && listeners.size > 0) {
    const cached = getCachedUserChats(userId);
    listeners.forEach((callback) => {
      try {
        callback(cached);
      } catch (err) {
        console.warn('Error in conversation subscriber listener:', err);
      }
    });
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event) => {
    if (event.key && event.key.startsWith('orvix_user_chats_')) {
      const uid = event.key.replace('orvix_user_chats_', '');
      notifyConversationListeners(uid);
    }
  });
}

function getUserChatsCacheKey(userId) {
  return `orvix_user_chats_${userId}`;
}

function getUserMessagesCacheKey(userId, chatId) {
  return `orvix_user_messages_${userId}_${chatId}`;
}

function getUserDeletedChatsKey(userId) {
  return `orvix_user_deleted_chats_${userId}`;
}

function formatChatDateLabel(ms) {
  if (!ms || !Number.isFinite(ms)) return 'Recently';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
  } catch (_) {
    return 'Recently';
  }
}

function withBoundedTimeout(promise, timeoutMs = FIRESTORE_OP_TIMEOUT_MS, label = 'Firestore operation') {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.code = 'unavailable';
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isOfflineOrNetworkError(err) {
  if (!isBrowserOnline()) return true;
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    code === 'unavailable' ||
    code.includes('unavailable') ||
    code.includes('network-request-failed') ||
    code.includes('deadline-exceeded') ||
    msg.includes('offline') ||
    msg.includes('timed out') ||
    msg.includes('failed to get document') ||
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('internet_disconnected')
  );
}

/**
 * Reads cached conversation metadata for a signed-in user from localStorage.
 * @param {string} userId
 * @returns {Array}
 */
export function getCachedUserChats(userId) {
  if (!userId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getUserChatsCacheKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Could not read cached user chats:', err);
    return [];
  }
}

/**
 * Persists conversation metadata list for a signed-in user to localStorage.
 * @param {string} userId
 * @param {Array} chats
 */
export function saveCachedUserChats(userId, chats) {
  if (!userId || typeof window === 'undefined' || !Array.isArray(chats)) return;
  try {
    const sorted = [...chats].sort((a, b) => (b.rawUpdatedAt || 0) - (a.rawUpdatedAt || 0));
    localStorage.setItem(getUserChatsCacheKey(userId), JSON.stringify(sorted));
  } catch (err) {
    console.warn('Could not save cached user chats:', err);
  }
}

/**
 * Reads cached messages for a specific signed-in user's conversation from localStorage.
 * @param {string} userId
 * @param {string} chatId
 * @returns {Array}
 */
export function getCachedChatMessages(userId, chatId) {
  if (!userId || !chatId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getUserMessagesCacheKey(userId, chatId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Could not read cached chat messages:', err);
    return [];
  }
}

/**
 * Persists messages for a specific signed-in user's conversation to localStorage.
 * @param {string} userId
 * @param {string} chatId
 * @param {Array} messages
 */
export function saveCachedChatMessages(userId, chatId, messages) {
  if (!userId || !chatId || typeof window === 'undefined' || !Array.isArray(messages)) return;
  try {
    localStorage.setItem(getUserMessagesCacheKey(userId, chatId), JSON.stringify(messages));
  } catch (err) {
    console.warn('Could not save cached chat messages:', err);
  }
}

function getPendingDeletedChatIds(userId) {
  if (!userId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(getUserDeletedChatsKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function savePendingDeletedChatIds(userId, ids) {
  if (!userId || typeof window === 'undefined') return;
  try {
    localStorage.setItem(getUserDeletedChatsKey(userId), JSON.stringify(Array.from(new Set(ids))));
  } catch (_) {}
}

function upsertCachedUserChat(userId, chatPatch) {
  if (!userId || !chatPatch?.id) return [];
  const existing = getCachedUserChats(userId);
  const idx = existing.findIndex((c) => c.id === chatPatch.id);
  let next;
  if (idx >= 0) {
    next = existing.map((c, i) => (i === idx ? { ...c, ...chatPatch } : c));
  } else {
    next = [chatPatch, ...existing];
  }
  saveCachedUserChats(userId, next);
  return getCachedUserChats(userId);
}

function upsertCachedChatMessage(userId, chatId, messageObj) {
  if (!userId || !chatId || !messageObj?.id) return [];
  const existing = getCachedChatMessages(userId, chatId);
  const idx = existing.findIndex((m) => m.id === messageObj.id);
  let next;
  if (idx >= 0) {
    next = existing.map((m, i) => (i === idx ? { ...m, ...messageObj } : m));
  } else {
    next = [...existing, messageObj];
  }
  saveCachedChatMessages(userId, chatId, next);
  return next;
}

function serializeAttachmentForStorage(att) {
  return {
    id: att.id,
    name: att.name || att.originalName || 'document',
    originalName: att.originalName || att.name || 'document',
    size: att.size || 0,
    formattedSize: att.formattedSize || '',
    type: att.type || att.mimeType || '',
    extension: att.extension || '',
    isImage: Boolean(att.isImage),
    status: att.status || 'uploaded',
    extraction: att.extraction || null
  };
}

function buildFirestoreMessagePayload(targetMessage) {
  return {
    id: targetMessage.id,
    sender: targetMessage.sender,
    content: targetMessage.content,
    modelUsed: targetMessage.modelUsed || null,
    provider: targetMessage.provider || null,
    responseTimeMs: typeof targetMessage.responseTimeMs === 'number' ? targetMessage.responseTimeMs : null,
    parentMessageId: targetMessage.parentMessageId || null,
    activeAlternativeId: targetMessage.activeAlternativeId || null,
    alternatives: Array.isArray(targetMessage.alternatives)
      ? targetMessage.alternatives.map((alt) => ({
          id: alt.id,
          parentMessageId: alt.parentMessageId || targetMessage.parentMessageId || null,
          sender: 'assistant',
          content: typeof alt.content === 'string' ? alt.content : '',
          provider: alt.provider || targetMessage.provider || 'gemini',
          modelUsed: alt.modelUsed || null,
          responseTimeMs: typeof alt.responseTimeMs === 'number' ? alt.responseTimeMs : null,
          timestamp: alt.timestamp || '',
          createdAt: typeof alt.createdAt === 'number' ? alt.createdAt : Date.now(),
          referencedAttachments: Array.isArray(alt.referencedAttachments)
            ? alt.referencedAttachments.map(serializeAttachmentForStorage)
            : [],
          isError: Boolean(alt.isError),
          isStopped: Boolean(alt.isStopped)
        }))
      : [],
    attachments: Array.isArray(targetMessage.attachments)
      ? targetMessage.attachments.map(serializeAttachmentForStorage)
      : [],
    referencedAttachments: Array.isArray(targetMessage.referencedAttachments)
      ? targetMessage.referencedAttachments.map(serializeAttachmentForStorage)
      : [],
    createdAt: serverTimestamp(),
    clientTimestamp:
      targetMessage.timestamp ||
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
}

/**
 * Generates a clean, readable conversation title from the initial user prompt.
 * @param {string} promptText
 * @param {number} [maxLength=36]
 * @returns {string}
 */
export function generateChatTitle(promptText, maxLength = 36) {
  if (!promptText || !promptText.trim()) {
    return 'New Conversation';
  }

  // Clean markdown symbols, quotes, and excessive whitespace
  let clean = promptText
    .replace(/^[#*`>"'\s]+/, '')
    .replace(/[#*`>"'\n\r\t]+/g, ' ')
    .trim();

  if (!clean) {
    return 'New Conversation';
  }

  if (clean.length <= maxLength) {
    return clean;
  }

  // Truncate at last space before maxLength
  const truncated = clean.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 16) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Generates a valid chat ID without requiring network connectivity.
 * @param {string} [userId]
 * @returns {string}
 */
export function generateLocalChatId(userId = '') {
  if (db && userId) {
    try {
      return doc(collection(db, 'users', userId, 'chats')).id;
    } catch (_) {}
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Creates a new chat conversation document via authenticated Express/MongoDB API
 * with automatic offline local fallback and user isolation.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} [initialTitle='New Conversation']
 * @param {string} [mode='general'] - Active chat mode (general | coding | writing | learning)
 * @returns {Promise<string>} The generated chatId
 */
export async function createChatDocument(userId, initialTitle = 'New Conversation', mode = 'general') {
  if (!userId) {
    throw new Error('Valid userId is required to create a conversation.');
  }

  const isGuest = String(userId).startsWith('guest-');
  const nowMs = Date.now();
  const chatId = generateLocalChatId(userId);
  const cleanMode = mode || 'general';

  // Always record locally first so offline mode or interrupted connections never lose the chat
  upsertCachedUserChat(userId, {
    id: chatId,
    title: initialTitle,
    mode: cleanMode,
    timestamp: 'Just now',
    rawUpdatedAt: nowMs,
    createdAtMs: nowMs,
    isPinned: false,
    pinnedAt: null,
    pendingSync: !isGuest,
    createdOffline: !isBrowserOnline()
  });

  notifyConversationListeners(userId);

  // Guests persist strictly to local storage without authentication or database access
  if (isGuest) {
    return chatId;
  }

  if (!isBrowserOnline()) {
    return chatId;
  }

  try {
    const token = await resolveAuthToken();
    if (token) {
      const endpoint = getApiEndpoint('/api/conversations');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          id: chatId,
          title: initialTitle,
          mode: cleanMode,
          isPinned: false
        })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to create conversation (${res.status})`);
      }

      const resData = await res.json().catch(() => ({}));
      if (resData?.conversation) {
        const mapped = mapMongoConversationToChat(resData.conversation);
        upsertCachedUserChat(userId, {
          ...mapped,
          pendingSync: false,
          createdOffline: false
        });
      } else {
        upsertCachedUserChat(userId, {
          id: chatId,
          pendingSync: false,
          createdOffline: false
        });
      }
      notifyConversationListeners(userId);
    }
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      console.warn('Offline/network fallback: created conversation locally for later sync:', chatId);
      return chatId;
    }
    throw err;
  }

  // Also ensure parent chat document in Firestore for legacy Firestore message subcollection
  if (db && isFirebaseConfigured() && isBrowserOnline()) {
    try {
      const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
      await withBoundedTimeout(
        setDoc(
          chatDocRef,
          {
            id: chatId,
            title: initialTitle,
            mode: cleanMode,
            userId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            isPinned: false,
            pinnedAt: null
          },
          { merge: true }
        ),
        FIRESTORE_OP_TIMEOUT_MS,
        'ensureFirestoreChatDoc'
      );
    } catch (_) {
      // Non-fatal, unmigrated messages still function via subcollection doc reference
    }
  }

  return chatId;
}

/**
 * Updates the active mode of an existing conversation via authenticated Express/MongoDB API (and local cache).
 * @param {string} userId
 * @param {string} chatId
 * @param {string} mode
 */
export async function updateChatMode(userId, chatId, mode) {
  if (!userId || !chatId) return;
  const cleanMode = mode || 'general';
  const isGuest = String(userId).startsWith('guest-');

  upsertCachedUserChat(userId, {
    id: chatId,
    mode: cleanMode,
    rawUpdatedAt: Date.now(),
    pendingMetaSync: !isBrowserOnline() && !isGuest
  });
  notifyConversationListeners(userId);

  if (isGuest || !isBrowserOnline()) {
    return;
  }

  try {
    const token = await resolveAuthToken();
    if (token) {
      const endpoint = getApiEndpoint(`/api/conversations/${encodeURIComponent(chatId)}`);
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ mode: cleanMode })
      });

      if (res.ok) {
        upsertCachedUserChat(userId, { id: chatId, mode: cleanMode, pendingMetaSync: false });
        notifyConversationListeners(userId);
      } else {
        upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: true });
      }
    }
  } catch (err) {
    upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: true });
    console.warn('Could not update conversation mode in MongoDB API (saved locally):', err?.message || err);
  }

  // Also update Firestore if configured for legacy parity
  if (db && isFirebaseConfigured() && isBrowserOnline()) {
    try {
      const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
      await withBoundedTimeout(
        updateDoc(chatDocRef, {
          mode: cleanMode,
          updatedAt: serverTimestamp()
        }),
        FIRESTORE_OP_TIMEOUT_MS,
        'updateChatModeFirestore'
      );
    } catch (_) {}
  }
}

/**
 * Appends a message to a chat's messages subcollection and updates parent chat's updatedAt.
 * Always writes to user-scoped local cache first and falls back gracefully when offline.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 * @param {Object} message - Message object
 */
export async function saveChatMessage(userId, chatId, message) {
  if (!userId || !chatId || !message?.id) {
    return;
  }

  // Never persist temporary mock messages, loading states, or failed error messages
  if (message.isError || (message.sender !== 'user' && message.sender !== 'assistant')) {
    return;
  }

  const targetMessage =
    message.sender === 'assistant'
      ? normalizeAssistantMessage(message)
      : message;

  const clientTimestamp =
    targetMessage.timestamp ||
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const nowMs = Date.now();

  const localRecord = {
    ...targetMessage,
    timestamp: clientTimestamp,
    createdAtMs: typeof targetMessage.createdAtMs === 'number' ? targetMessage.createdAtMs : nowMs,
    pendingSync: true
  };

  // 1. Always persist locally first so messages survive refreshes while offline
  upsertCachedChatMessage(userId, chatId, localRecord);
  const cachedChat = getCachedUserChats(userId).find((c) => c.id === chatId);
  upsertCachedUserChat(userId, {
    id: chatId,
    title: cachedChat?.title || 'Conversation',
    mode: cachedChat?.mode || targetMessage.mode || 'general',
    timestamp: formatChatDateLabel(nowMs),
    rawUpdatedAt: nowMs,
    isPinned: Boolean(cachedChat?.isPinned),
    pinnedAt: cachedChat?.pinnedAt || null,
    pendingSync: true
  });

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return;
  }

  const messageDocRef = doc(db, 'users', userId, 'chats', chatId, 'messages', targetMessage.id);
  const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
  const payload = buildFirestoreMessagePayload({
    ...targetMessage,
    timestamp: clientTimestamp
  });

  try {
    // Ensure parent chat exists in Firestore if it was originally created offline
    if (cachedChat?.createdOffline) {
      await withBoundedTimeout(
        setDoc(
          chatDocRef,
          {
            id: chatId,
            title: cachedChat.title || 'New Conversation',
            mode: cachedChat.mode || 'general',
            userId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            isPinned: Boolean(cachedChat.isPinned),
            pinnedAt: cachedChat.pinnedAt || null
          },
          { merge: true }
        ),
        FIRESTORE_OP_TIMEOUT_MS,
        'ensureParentChatDoc'
      );
    }

    // Write message document idempotently by stable ID
    await withBoundedTimeout(setDoc(messageDocRef, payload), FIRESTORE_OP_TIMEOUT_MS, 'saveChatMessage');

    // Touch parent chat's updatedAt timestamp
    try {
      await withBoundedTimeout(
        updateDoc(chatDocRef, {
          updatedAt: serverTimestamp()
        }),
        FIRESTORE_OP_TIMEOUT_MS,
        'touchParentChatUpdatedAt'
      );
    } catch (_) {}

    upsertCachedChatMessage(userId, chatId, {
      ...localRecord,
      pendingSync: false
    });

    // Clear chat-level pendingSync if no other messages in this chat are still pending
    const remainingPending = getCachedChatMessages(userId, chatId).some((m) => m.pendingSync);
    upsertCachedUserChat(userId, {
      id: chatId,
      pendingSync: remainingPending,
      createdOffline: false
    });
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      console.warn('Firestore unreachable while saving message; retained in local sync queue:', targetMessage.id);
      return;
    }
    throw err;
  }
}

/**
 * Renames an existing conversation via authenticated Express/MongoDB API (and local cache).
 * @param {string} userId
 * @param {string} chatId
 * @param {string} newTitle
 */
export async function renameConversation(userId, chatId, newTitle) {
  const sanitized = (newTitle || '').trim();
  if (!sanitized) {
    throw new Error('Conversation title cannot be empty.');
  }

  const isGuest = !userId || String(userId).startsWith('guest-');

  if (userId && chatId) {
    upsertCachedUserChat(userId, {
      id: chatId,
      title: sanitized,
      rawUpdatedAt: Date.now(),
      pendingMetaSync: !isBrowserOnline() && !isGuest
    });
    notifyConversationListeners(userId);
  }

  if (isGuest || !isBrowserOnline()) {
    return;
  }

  try {
    const token = await resolveAuthToken();
    if (token) {
      const endpoint = getApiEndpoint(`/api/conversations/${encodeURIComponent(chatId)}`);
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ title: sanitized })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to rename conversation (${res.status})`);
      }

      upsertCachedUserChat(userId, { id: chatId, title: sanitized, pendingMetaSync: false });
      notifyConversationListeners(userId);
    }
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      upsertCachedUserChat(userId, { id: chatId, pendingMetaSync: true });
      return;
    }
    throw err;
  }

  // Also update Firestore if configured for legacy parity
  if (db && isFirebaseConfigured() && isBrowserOnline()) {
    try {
      const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
      await withBoundedTimeout(
        updateDoc(chatDocRef, {
          title: sanitized,
          updatedAt: serverTimestamp()
        }),
        FIRESTORE_OP_TIMEOUT_MS,
        'renameConversationFirestore'
      );
    } catch (_) {}
  }
}

/**
 * Toggles or updates the pinned status of a conversation via authenticated Express/MongoDB API (with offline local fallback).
 * Enforces a strict limit of maximum 5 pinned chats per user.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 * @param {boolean} isPinned - Target pinned status
 * @returns {Promise<boolean>} Resulting pinned state
 */
export async function toggleChatPinned(userId, chatId, isPinned) {
  if (!userId || !chatId) {
    throw new Error('Valid userId and chatId are required.');
  }

  const isGuest = String(userId).startsWith('guest-');
  const cachedChats = getCachedUserChats(userId);
  if (isPinned) {
    const localPinnedCount = cachedChats.filter((c) => c.isPinned && c.id !== chatId).length;
    if (localPinnedCount >= 5) {
      throw new Error('Maximum of 5 pinned conversations reached. Unpin another conversation first.');
    }
  }

  const nowMs = Date.now();

  // If guest or offline, persist to local cache immediately
  if (isGuest || !isBrowserOnline()) {
    upsertCachedUserChat(userId, {
      id: chatId,
      isPinned: Boolean(isPinned),
      pinnedAt: isPinned ? nowMs : null,
      rawUpdatedAt: nowMs,
      pendingMetaSync: !isGuest
    });
    notifyConversationListeners(userId);
    return Boolean(isPinned);
  }

  try {
    const token = await resolveAuthToken();
    if (token) {
      const endpoint = getApiEndpoint(`/api/conversations/${encodeURIComponent(chatId)}`);
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ isPinned: Boolean(isPinned) })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        // If pin limit was exceeded on server, throw the specific error message
        if (res.status === 400 && errorData.code === 'PIN_LIMIT_EXCEEDED') {
          throw new Error(errorData.error || 'Maximum of 5 pinned conversations reached. Unpin another conversation first.');
        }
        throw new Error(errorData.error || `Failed to update pin status (${res.status})`);
      }

      const data = await res.json().catch(() => ({}));
      const resultingPinned = data?.conversation?.isPinned ?? Boolean(isPinned);
      upsertCachedUserChat(userId, {
        id: chatId,
        isPinned: resultingPinned,
        pinnedAt: resultingPinned ? (data?.conversation?.pinnedAt ? new Date(data.conversation.pinnedAt).getTime() : nowMs) : null,
        rawUpdatedAt: nowMs,
        pendingMetaSync: false
      });
      notifyConversationListeners(userId);

      // Also update Firestore if configured
      if (db && isFirebaseConfigured() && isBrowserOnline()) {
        try {
          const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
          await withBoundedTimeout(
            updateDoc(chatDocRef, {
              isPinned: resultingPinned,
              pinnedAt: resultingPinned ? serverTimestamp() : null,
              updatedAt: serverTimestamp()
            }),
            FIRESTORE_OP_TIMEOUT_MS,
            'toggleChatPinnedFirestore'
          );
        } catch (_) {}
      }

      return resultingPinned;
    }
  } catch (err) {
    if (err.message && err.message.includes('5 pinned')) {
      throw err;
    }
    if (isOfflineOrNetworkError(err)) {
      upsertCachedUserChat(userId, {
        id: chatId,
        isPinned: Boolean(isPinned),
        pinnedAt: isPinned ? nowMs : null,
        rawUpdatedAt: nowMs,
        pendingMetaSync: true
      });
      notifyConversationListeners(userId);
      return Boolean(isPinned);
    }
    throw err;
  }

  return Boolean(isPinned);
}

/**
 * Deletes a conversation via authenticated Express/MongoDB API (cascading to MongoDB messages)
 * and cleans up associated unmigrated Firestore messages and local cache.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 */
export async function deleteConversation(userId, chatId) {
  if (!userId || !chatId) {
    throw new Error('Valid userId and chatId are required.');
  }

  const isGuest = String(userId).startsWith('guest-');
  const existingLocal = getCachedUserChats(userId);
  const targetLocal = existingLocal.find((c) => c.id === chatId);

  saveCachedUserChats(
    userId,
    existingLocal.filter((c) => c.id !== chatId)
  );
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(getUserMessagesCacheKey(userId, chatId));
    } catch (_) {}
  }
  notifyConversationListeners(userId);

  if (isGuest) {
    return;
  }

  if (!isBrowserOnline()) {
    if (!targetLocal?.createdOffline) {
      savePendingDeletedChatIds(userId, [...getPendingDeletedChatIds(userId), chatId]);
    }
    return;
  }

  try {
    const token = await resolveAuthToken();
    if (token) {
      const endpoint = getApiEndpoint(`/api/conversations/${encodeURIComponent(chatId)}`);
      const res = await fetch(endpoint, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });

      if (!res.ok && res.status !== 404) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to delete conversation (${res.status})`);
      }
    }
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      if (!targetLocal?.createdOffline) {
        savePendingDeletedChatIds(userId, [...getPendingDeletedChatIds(userId), chatId]);
      }
      return;
    }
    throw err;
  }

  // Clean up unmigrated Firestore messages and parent doc for this specific conversation
  if (db && isFirebaseConfigured() && isBrowserOnline()) {
    try {
      const messagesRef = collection(db, 'users', userId, 'chats', chatId, 'messages');
      const snapshot = await withBoundedTimeout(getDocs(messagesRef), FIRESTORE_OP_TIMEOUT_MS, 'loadMessagesForDelete');

      const docs = snapshot.docs;
      const CHUNK_SIZE = 400;

      for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
        const chunk = docs.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        chunk.forEach((docSnap) => {
          batch.delete(docSnap.ref);
        });
        await withBoundedTimeout(batch.commit(), FIRESTORE_OP_TIMEOUT_MS, 'deleteMessagesBatch');
      }

      const chatDocRef = doc(db, 'users', userId, 'chats', chatId);
      await withBoundedTimeout(deleteDoc(chatDocRef), FIRESTORE_OP_TIMEOUT_MS, 'deleteChatDoc');
    } catch (err) {
      console.warn('Could not clean up Firestore documents during conversation deletion:', err?.message || err);
    }
  }
}

/**
 * Deletes specific messages from a chat's messages subcollection in Firestore (and local cache).
 * Used when truncating conversation branches during Edit and Resend.
 *
 * @param {string} userId - Authenticated user UID
 * @param {string} chatId - Chat document ID
 * @param {string[]} messageIds - Array of message document IDs to delete
 */
export async function deleteChatMessages(userId, chatId, messageIds = []) {
  if (!userId || !chatId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return;
  }

  const validIds = messageIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (validIds.length === 0) return;

  const removeSet = new Set(validIds);
  const remainingLocal = getCachedChatMessages(userId, chatId).filter((m) => !removeSet.has(m.id));
  saveCachedChatMessages(userId, chatId, remainingLocal);

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return;
  }

  try {
    const CHUNK_SIZE = 400;
    for (let i = 0; i < validIds.length; i += CHUNK_SIZE) {
      const chunk = validIds.slice(i, i + CHUNK_SIZE);
      const batch = writeBatch(db);
      chunk.forEach((msgId) => {
        const msgRef = doc(db, 'users', userId, 'chats', chatId, 'messages', msgId);
        batch.delete(msgRef);
      });
      await withBoundedTimeout(batch.commit(), FIRESTORE_OP_TIMEOUT_MS, 'deleteChatMessages');
    }
  } catch (err) {
    console.warn('Could not delete truncated messages in Firestore (updated locally):', err?.message || err);
  }
}

/**
 * Merges cloud conversation metadata with locally cached pending conversations
 * so offline-created or unsynced chats are never overwritten or hidden.
 */
function mergeCloudAndLocalChats(userId, cloudChats) {
  const localChats = getCachedUserChats(userId);
  const deletedSet = new Set(getPendingDeletedChatIds(userId));
  const mergedMap = new Map();

  for (const c of cloudChats) {
    if (deletedSet.has(c.id)) continue;
    const localMatch = localChats.find((l) => l.id === c.id);
    if (localMatch && (localMatch.pendingSync || localMatch.pendingMetaSync)) {
      const newerRawUpdated = Math.max(c.rawUpdatedAt || 0, localMatch.rawUpdatedAt || 0);
      mergedMap.set(c.id, {
        ...c,
        title: localMatch.pendingMetaSync ? localMatch.title : (c.title || localMatch.title),
        mode: localMatch.pendingMetaSync ? localMatch.mode : (c.mode || localMatch.mode),
        isPinned: localMatch.pendingMetaSync ? Boolean(localMatch.isPinned) : Boolean(c.isPinned),
        pinnedAt: localMatch.pendingMetaSync ? localMatch.pinnedAt : c.pinnedAt,
        rawUpdatedAt: newerRawUpdated,
        timestamp: formatChatDateLabel(newerRawUpdated),
        pendingSync: Boolean(localMatch.pendingSync),
        pendingMetaSync: Boolean(localMatch.pendingMetaSync),
        createdOffline: false
      });
    } else {
      mergedMap.set(c.id, {
        ...c,
        pendingSync: false,
        pendingMetaSync: false,
        createdOffline: false
      });
    }
  }

  for (const localChat of localChats) {
    if (deletedSet.has(localChat.id)) continue;
    if (!mergedMap.has(localChat.id) && (localChat.pendingSync || localChat.createdOffline || localChat.pendingMetaSync)) {
      mergedMap.set(localChat.id, localChat);
    }
  }

  const merged = Array.from(mergedMap.values()).sort(
    (a, b) => (b.rawUpdatedAt || 0) - (a.rawUpdatedAt || 0)
  );
  saveCachedUserChats(userId, merged);
  return merged;
}

/**
 * Synchronizes any offline-created or offline-updated chats and messages to Cloud Firestore
 * idempotently once internet connectivity returns, without duplicating or losing messages.
 *
 * @param {string} userId
 * @returns {Promise<{ syncedChats: number, syncedMessages: number }>}
 */
/**
 * Synchronizes any offline-created or offline-updated conversations to MongoDB Atlas
 * and unmigrated offline messages to Cloud Firestore idempotently once internet connectivity returns.
 *
 * @param {string} userId
 * @returns {Promise<{ syncedChats: number, syncedMessages: number }>}
 */
export async function syncOfflineUserChatsToFirestore(userId) {
  if (!userId || String(userId).startsWith('guest-') || !isBrowserOnline()) {
    return { syncedChats: 0, syncedMessages: 0 };
  }

  if (activeSyncPromises.has(userId)) {
    return activeSyncPromises.get(userId);
  }

  const syncTask = (async () => {
    let syncedChats = 0;
    let syncedMessages = 0;

    try {
      // 1. Replay any pending offline deletions via MongoDB API
      const pendingDeleted = getPendingDeletedChatIds(userId);
      if (pendingDeleted.length > 0) {
        const remainingDeletes = [];
        for (const delChatId of pendingDeleted) {
          try {
            await deleteConversation(userId, delChatId);
            syncedChats++;
          } catch (_) {
            remainingDeletes.push(delChatId);
          }
        }
        savePendingDeletedChatIds(userId, remainingDeletes);
      }

      // 2. Sync pending conversation metadata to MongoDB API
      const token = await resolveAuthToken();
      const localChats = getCachedUserChats(userId);

      for (const localChat of localChats) {
        if (!isBrowserOnline()) break;

        const needsMetaSync = Boolean(
          localChat.pendingSync ||
          localChat.pendingMetaSync ||
          localChat.createdOffline
        );

        if (needsMetaSync && token) {
          try {
            if (localChat.createdOffline || localChat.pendingSync) {
              const createEndpoint = getApiEndpoint('/api/conversations');
              const res = await fetch(createEndpoint, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json',
                  'Accept': 'application/json'
                },
                body: JSON.stringify({
                  id: localChat.id,
                  title: localChat.title || 'New Conversation',
                  mode: localChat.mode || 'general',
                  isPinned: Boolean(localChat.isPinned)
                })
              });
              if (res.ok) {
                syncedChats++;
                upsertCachedUserChat(userId, {
                  id: localChat.id,
                  pendingSync: false,
                  createdOffline: false,
                  pendingMetaSync: false
                });
              }
            } else if (localChat.pendingMetaSync) {
              const patchEndpoint = getApiEndpoint(`/api/conversations/${encodeURIComponent(localChat.id)}`);
              const res = await fetch(patchEndpoint, {
                method: 'PATCH',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json',
                  'Accept': 'application/json'
                },
                body: JSON.stringify({
                  title: localChat.title,
                  mode: localChat.mode,
                  isPinned: Boolean(localChat.isPinned)
                })
              });
              if (res.ok) {
                syncedChats++;
                upsertCachedUserChat(userId, {
                  id: localChat.id,
                  pendingMetaSync: false
                });
              }
            }
          } catch (chatErr) {
            console.warn('Deferred syncing conversation metadata to MongoDB:', localChat.id, chatErr?.message || chatErr);
          }
        }

        // 3. Sync pending messages to Firestore (unmigrated message persistence)
        if (db && isFirebaseConfigured() && isBrowserOnline()) {
          const localMessages = getCachedChatMessages(userId, localChat.id);
          const pendingMessages = localMessages.filter(
            (m) => m && m.pendingSync && !m.isError && (m.sender === 'user' || m.sender === 'assistant')
          );

          if (pendingMessages.length > 0) {
            try {
              await syncFirestoreNetworkState(true);
              const chatDocRef = doc(db, 'users', userId, 'chats', localChat.id);
              let allMessagesSynced = true;

              for (const msg of pendingMessages) {
                try {
                  const targetMsg = msg.sender === 'assistant' ? normalizeAssistantMessage(msg) : msg;
                  const msgRef = doc(db, 'users', userId, 'chats', localChat.id, 'messages', targetMsg.id);
                  const payload = buildFirestoreMessagePayload(targetMsg);
                  await withBoundedTimeout(
                    setDoc(msgRef, payload, { merge: true }),
                    FIRESTORE_OP_TIMEOUT_MS,
                    'syncMessageDoc'
                  );
                  upsertCachedChatMessage(userId, localChat.id, {
                    ...msg,
                    pendingSync: false
                  });
                  syncedMessages++;
                } catch (msgErr) {
                  allMessagesSynced = false;
                  console.warn('Deferred syncing message until next online cycle:', msg?.id, msgErr?.message || msgErr);
                }
              }

              if (allMessagesSynced) {
                try {
                  await withBoundedTimeout(
                    updateDoc(chatDocRef, { updatedAt: serverTimestamp() }),
                    FIRESTORE_OP_TIMEOUT_MS,
                    'syncTouchUpdatedAt'
                  );
                } catch (_) {}
              }
            } catch (fsErr) {
              console.warn('Error during Firestore message sync:', fsErr?.message || fsErr);
            }
          }
        }
      }

      notifyConversationListeners(userId);
    } finally {
      activeSyncPromises.delete(userId);
    }

    return { syncedChats, syncedMessages };
  })();

  activeSyncPromises.set(userId, syncTask);
  return syncTask;
}

/**
 * Lists conversations for the authenticated user from MongoDB API (with local cache fallback).
 * @param {string} userId
 * @param {Object} [options]
 * @returns {Promise<Array>}
 */
export async function listConversations(userId, options = {}) {
  if (!userId) return [];
  const isGuest = String(userId).startsWith('guest-');
  if (isGuest || !isBrowserOnline()) {
    return getCachedUserChats(userId);
  }

  try {
    const token = await resolveAuthToken();
    if (!token) {
      return getCachedUserChats(userId);
    }

    const queryParams = new URLSearchParams();
    if (options.mode) queryParams.set('mode', options.mode);
    if (options.limit) queryParams.set('limit', String(options.limit));
    if (options.skip) queryParams.set('skip', String(options.skip));
    const qs = queryParams.toString();
    const endpoint = getApiEndpoint(`/api/conversations${qs ? '?' + qs : ''}`);

    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      throw new Error(`Failed to list conversations (${res.status})`);
    }

    const data = await res.json();
    if (Array.isArray(data?.conversations)) {
      const mapped = data.conversations.map(mapMongoConversationToChat).filter(Boolean);
      return mergeCloudAndLocalChats(userId, mapped);
    }
    return getCachedUserChats(userId);
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      return getCachedUserChats(userId);
    }
    throw err;
  }
}

/**
 * Subscribes in real-time to the authenticated user's conversations list.
 * Hydrates immediately from local cache and syncs with the authenticated MongoDB API.
 *
 * @param {string} userId
 * @param {(chats: Array) => void} onUpdate
 * @param {(err: Error) => void} onError
 * @returns {() => void} Unsubscribe function
 */
export function subscribeToUserChats(userId, onUpdate, onError = null) {
  if (!userId) {
    if (onUpdate) onUpdate([]);
    return () => {};
  }

  const isGuest = String(userId).startsWith('guest-');
  const cached = getCachedUserChats(userId);

  // Emit cached conversations immediately so offline/slow startups never show an empty or stuck sidebar
  if (cached.length > 0) {
    onUpdate(cached);
  }

  if (isGuest || !isBrowserOnline()) {
    if (cached.length === 0) {
      onUpdate([]);
    }
    return () => {};
  }

  if (!activeSubscriptions.has(userId)) {
    activeSubscriptions.set(userId, new Set());
  }
  const listenerSet = activeSubscriptions.get(userId);
  listenerSet.add(onUpdate);

  let isSubscribed = true;

  async function fetchFromMongo() {
    try {
      const token = await resolveAuthToken();
      if (!token || !isSubscribed) return;

      const endpoint = getApiEndpoint('/api/conversations');
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch conversations (${res.status})`);
      }

      const data = await res.json();
      if (!isSubscribed) return;

      if (Array.isArray(data?.conversations)) {
        const mapped = data.conversations.map(mapMongoConversationToChat).filter(Boolean);
        const merged = mergeCloudAndLocalChats(userId, mapped);
        onUpdate(merged);
      }
    } catch (err) {
      if (isOfflineOrNetworkError(err)) {
        if (isSubscribed) onUpdate(getCachedUserChats(userId));
        return;
      }
      console.warn('Error fetching user conversations from MongoDB API:', err?.message || err);
      if (onError && isSubscribed) onError(err);
    }
  }

  void fetchFromMongo();

  return () => {
    isSubscribed = false;
    listenerSet.delete(onUpdate);
    if (listenerSet.size === 0) {
      activeSubscriptions.delete(userId);
    }
  };
}

/**
 * Loads all messages for a specific conversation, ordered chronologically.
 * Falls back cleanly to user-scoped local cache when offline, and merges any unsynced local messages when online.
 *
 * @param {string} userId
 * @param {string} chatId
 * @returns {Promise<Array>}
 */
export async function loadConversationMessages(userId, chatId) {
  const localMessages = getCachedChatMessages(userId, chatId);

  if (!db || !isFirebaseConfigured() || !isBrowserOnline()) {
    return ensureConversationAlternatives(localMessages);
  }

  const messagesRef = collection(db, 'users', userId, 'chats', chatId, 'messages');
  const q = query(messagesRef, orderBy('createdAt', 'asc'));

  try {
    const snapshot = await withBoundedTimeout(getDocs(q), FIRESTORE_OP_TIMEOUT_MS, 'loadConversationMessages');
    const cloudMessages = [];

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      cloudMessages.push({
        id: docSnap.id,
        sender: data.sender,
        content: data.content,
        modelUsed: data.modelUsed || null,
        provider: data.provider || null,
        responseTimeMs: typeof data.responseTimeMs === 'number' ? data.responseTimeMs : null,
        parentMessageId: data.parentMessageId || null,
        activeAlternativeId: data.activeAlternativeId || null,
        alternatives: Array.isArray(data.alternatives) ? data.alternatives : [],
        attachments: Array.isArray(data.attachments) ? data.attachments : [],
        referencedAttachments: Array.isArray(data.referencedAttachments) ? data.referencedAttachments : [],
        createdAtMs: data.createdAt?.toMillis ? data.createdAt.toMillis() : undefined,
        timestamp:
          data.clientTimestamp ||
          (data.createdAt?.toDate
            ? data.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : ''),
        pendingSync: false
      });
    });

    // Merge cloud messages with any unsynced local messages by deterministic message ID (zero duplicates)
    const byId = new Map();
    for (const cm of cloudMessages) {
      byId.set(cm.id, cm);
    }
    for (const lm of localMessages) {
      if (!lm?.id) continue;
      if (!byId.has(lm.id)) {
        if (lm.pendingSync || cloudMessages.length === 0) {
          byId.set(lm.id, lm);
        }
      } else if (lm.pendingSync) {
        // Prefer locally updated version until sync completes
        byId.set(lm.id, lm);
      }
    }

    const merged = Array.from(byId.values());
    const normalized = ensureConversationAlternatives(merged);
    saveCachedChatMessages(userId, chatId, normalized);
    return normalized;
  } catch (err) {
    if (isOfflineOrNetworkError(err)) {
      console.warn('Offline fallback: loaded conversation messages from local cache:', chatId);
      return ensureConversationAlternatives(localMessages);
    }
    throw err;
  }
}
