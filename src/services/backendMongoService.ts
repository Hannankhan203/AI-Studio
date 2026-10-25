/**
 * Orvix Express Backend MongoDB Service Layer (Phase 2, Step 4)
 *
 * Integrates MongoDB repositories into the Express backend safely:
 * - Provides verified server-side data access helpers
 * - Validates input parameters strictly
 * - Respects the Phase 3 Authentication Boundary: does NOT trust client-supplied
 *   `userId` without cryptographic identity verification.
 */

import { getDatabase, isMongoConfigured, getMongoStatus } from '../db/mongodb.ts';
import {
  initializeRepositoryIndexes,
  findUserById,
  findConversationsByUserId,
  findMessagesByConversationId,
  getUserSettings,
  UserDocument,
  ConversationDocument,
  MessageDocument,
  UserSettingsDocument
} from '../repositories/index.ts';

export interface RepositoryReadiness {
  users: boolean;
  conversations: boolean;
  messages: boolean;
  user_settings: boolean;
  indexesInitialized: boolean;
}

export interface BackendMongoSummary {
  database: string;
  isConfigured: boolean;
  isConnected: boolean;
  collections: RepositoryReadiness;
  authBoundary: {
    status: 'enforced';
    phase: 'Phase 2 Step 4 Complete; Phase 3 Authentication Pending';
    message: string;
  };
}

let indexesReady = false;

/**
 * Initializes all MongoDB indexes on server startup.
 */
export async function setupBackendMongoIndexes(): Promise<boolean> {
  if (!isMongoConfigured()) return false;
  try {
    await initializeRepositoryIndexes();
    indexesReady = true;
    return true;
  } catch (err) {
    console.warn('[BackendMongoService] Index setup notice:', err);
    return false;
  }
}

/**
 * Validates a user ID string.
 */
export function validateUserId(userId?: string | null): { valid: boolean; error?: string; cleanId?: string } {
  if (!userId || typeof userId !== 'string') {
    return { valid: false, error: 'User ID is required and must be a string.' };
  }
  const clean = userId.trim();
  if (clean.length < 2 || clean.length > 128) {
    return { valid: false, error: 'User ID must be between 2 and 128 characters.' };
  }
  // Alphanumeric, hyphens, underscores, dots
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(clean)) {
    return { valid: false, error: 'User ID contains invalid characters.' };
  }
  return { valid: true, cleanId: clean };
}

/**
 * Validates a conversation ID string.
 */
export function validateConversationId(conversationId?: string | null): { valid: boolean; error?: string; cleanId?: string } {
  if (!conversationId || typeof conversationId !== 'string') {
    return { valid: false, error: 'Conversation ID is required and must be a string.' };
  }
  const clean = conversationId.trim();
  if (clean.length < 3 || clean.length > 128) {
    return { valid: false, error: 'Conversation ID length must be between 3 and 128 characters.' };
  }
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(clean)) {
    return { valid: false, error: 'Conversation ID contains invalid characters.' };
  }
  return { valid: true, cleanId: clean };
}

/**
 * Returns a high-level summary of backend MongoDB integration status.
 */
export async function getBackendMongoSummary(): Promise<BackendMongoSummary> {
  const status = await getMongoStatus();
  return {
    database: status.databaseName,
    isConfigured: status.isConfigured,
    isConnected: status.isConnected,
    collections: {
      users: status.isConnected,
      conversations: status.isConnected,
      messages: status.isConnected,
      user_settings: status.isConnected,
      indexesInitialized: indexesReady
    },
    authBoundary: {
      status: 'enforced',
      phase: 'Phase 2 Step 4 Complete; Phase 3 Authentication Pending',
      message:
        'Client-supplied userIds are untrusted. Public user-data CRUD endpoints are gated until Phase 3 implements cryptographic server-side authentication (e.g. Firebase Admin ID token verification).'
    }
  };
}
