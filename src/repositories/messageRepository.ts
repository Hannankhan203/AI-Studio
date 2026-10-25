/**
 * Orvix Message Repository (MongoDB Atlas)
 *
 * Handles persistence and queries for the 'messages' collection in database 'Orvix'.
 * Replaces Firebase Firestore /users/{userId}/chats/{chatId}/messages/{messageId} subcollection.
 */

import { Collection, ObjectId } from 'mongodb';
import { getDatabase } from '../db/mongodb.ts';

export interface MessageAttachment {
  id?: string;
  name?: string;
  originalName?: string;
  size?: number;
  formattedSize?: string;
  type?: string;
  extension?: string;
  isImage?: boolean;
  status?: string;
  extraction?: any;
}

export interface MessageAlternative {
  id: string;
  parentMessageId?: string | null;
  sender: 'assistant';
  content: string;
  provider?: string;
  modelUsed?: string | null;
  responseTimeMs?: number | null;
  timestamp?: string;
  createdAt?: number | Date;
  referencedAttachments?: MessageAttachment[];
  isError?: boolean;
  isStopped?: boolean;
}

export interface MessageDocument {
  _id: string; // Stable Message ID (e.g. 'msg-...' or ObjectId string)
  id: string; // Parity with _id for frontend compatibility
  conversationId: string; // Foreign key referencing conversation._id
  userId?: string; // Optional user owner reference
  sender: 'user' | 'assistant';
  content: string;
  modelUsed?: string | null;
  provider?: string | null;
  responseTimeMs?: number | null;
  parentMessageId?: string | null;
  activeAlternativeId?: string | null;
  alternatives?: MessageAlternative[];
  attachments?: MessageAttachment[];
  referencedAttachments?: MessageAttachment[];
  clientTimestamp?: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface CreateMessageInput {
  id?: string;
  conversationId: string;
  userId?: string;
  sender: 'user' | 'assistant';
  content: string;
  modelUsed?: string | null;
  provider?: string | null;
  responseTimeMs?: number | null;
  parentMessageId?: string | null;
  activeAlternativeId?: string | null;
  alternatives?: MessageAlternative[];
  attachments?: MessageAttachment[];
  referencedAttachments?: MessageAttachment[];
  clientTimestamp?: string;
  createdAt?: Date;
}

export interface UpdateMessageInput {
  content?: string;
  modelUsed?: string | null;
  provider?: string | null;
  responseTimeMs?: number | null;
  activeAlternativeId?: string | null;
  alternatives?: MessageAlternative[];
  attachments?: MessageAttachment[];
  referencedAttachments?: MessageAttachment[];
  clientTimestamp?: string;
}

/**
 * Returns the MongoDB collection for messages.
 */
export function getMessagesCollection(): Collection<MessageDocument> {
  const db = getDatabase();
  return db.collection<MessageDocument>('messages');
}

/**
 * Ensures optimal indexes for the 'messages' collection.
 */
export async function ensureMessageIndexes(): Promise<void> {
  try {
    const col = getMessagesCollection();
    await col.createIndex({ conversationId: 1, createdAt: 1 });
    await col.createIndex({ id: 1 }, { unique: true, sparse: true });
    await col.createIndex({ userId: 1, createdAt: -1 });
  } catch (err: any) {
    console.warn('[MessageRepository] Index creation notice:', err?.message || err);
  }
}

/**
 * Creates and persists a new message document in MongoDB.
 */
export async function createMessage(input: CreateMessageInput): Promise<MessageDocument> {
  if (!input.conversationId || !input.conversationId.trim()) {
    throw new Error('Valid conversationId is required to save a message.');
  }
  if (!input.content && input.content !== '') {
    throw new Error('Message content must be provided.');
  }

  const col = getMessagesCollection();
  const cleanId = (input.id && input.id.trim()) ? input.id.trim() : `msg-${Date.now()}-${new ObjectId().toHexString().slice(-6)}`;
  const now = input.createdAt || new Date();
  const formattedClientTime = input.clientTimestamp || now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const doc: MessageDocument = {
    _id: cleanId,
    id: cleanId,
    conversationId: input.conversationId.trim(),
    userId: input.userId?.trim() || undefined,
    sender: input.sender,
    content: input.content,
    modelUsed: input.modelUsed || null,
    provider: input.provider || null,
    responseTimeMs: typeof input.responseTimeMs === 'number' ? input.responseTimeMs : null,
    parentMessageId: input.parentMessageId || null,
    activeAlternativeId: input.activeAlternativeId || null,
    alternatives: Array.isArray(input.alternatives) ? input.alternatives : [],
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    referencedAttachments: Array.isArray(input.referencedAttachments) ? input.referencedAttachments : [],
    clientTimestamp: formattedClientTime,
    createdAt: now,
    updatedAt: now
  };

  await col.insertOne(doc);
  return doc;
}

/**
 * Finds a single message by ID.
 */
export async function findMessageById(id: string): Promise<MessageDocument | null> {
  if (!id || !id.trim()) return null;
  const col = getMessagesCollection();
  const cleanId = id.trim();
  return col.findOne({
    $or: [{ _id: cleanId }, { id: cleanId }]
  });
}

/**
 * Loads all messages for a conversation, ordered chronologically (oldest to newest by default).
 */
export async function findMessagesByConversationId(
  conversationId: string,
  options: { sort?: 'asc' | 'desc'; limit?: number } = {}
): Promise<MessageDocument[]> {
  if (!conversationId || !conversationId.trim()) return [];

  const col = getMessagesCollection();
  const sortDirection = options.sort === 'desc' ? -1 : 1;
  const cursor = col
    .find({ conversationId: conversationId.trim() })
    .sort({ createdAt: sortDirection });

  if (options.limit && options.limit > 0) {
    cursor.limit(options.limit);
  }

  return cursor.toArray();
}

/**
 * Finds the latest message in a conversation.
 */
export async function findLatestMessageByConversationId(conversationId: string): Promise<MessageDocument | null> {
  if (!conversationId || !conversationId.trim()) return null;
  const col = getMessagesCollection();
  return col.findOne(
    { conversationId: conversationId.trim() },
    { sort: { createdAt: -1 } }
  );
}

/**
 * Counts total messages in a conversation.
 */
export async function countMessagesByConversationId(conversationId: string): Promise<number> {
  if (!conversationId || !conversationId.trim()) return 0;
  const col = getMessagesCollection();
  return col.countDocuments({ conversationId: conversationId.trim() });
}

/**
 * Updates a specific message by ID.
 */
export async function updateMessage(id: string, patch: UpdateMessageInput): Promise<MessageDocument | null> {
  if (!id || !id.trim()) {
    throw new Error('Valid message id is required.');
  }

  const col = getMessagesCollection();
  const cleanId = id.trim();
  const updateFields: any = {
    updatedAt: new Date()
  };

  if (patch.content !== undefined) updateFields.content = patch.content;
  if (patch.modelUsed !== undefined) updateFields.modelUsed = patch.modelUsed;
  if (patch.provider !== undefined) updateFields.provider = patch.provider;
  if (patch.responseTimeMs !== undefined) updateFields.responseTimeMs = patch.responseTimeMs;
  if (patch.activeAlternativeId !== undefined) updateFields.activeAlternativeId = patch.activeAlternativeId;
  if (patch.alternatives !== undefined) updateFields.alternatives = patch.alternatives;
  if (patch.attachments !== undefined) updateFields.attachments = patch.attachments;
  if (patch.referencedAttachments !== undefined) updateFields.referencedAttachments = patch.referencedAttachments;
  if (patch.clientTimestamp !== undefined) updateFields.clientTimestamp = patch.clientTimestamp;

  return col.findOneAndUpdate(
    { $or: [{ _id: cleanId }, { id: cleanId }] },
    { $set: updateFields },
    { returnDocument: 'after' }
  );
}

/**
 * Deletes a single message by ID.
 */
export async function deleteMessage(id: string): Promise<boolean> {
  if (!id || !id.trim()) return false;
  const col = getMessagesCollection();
  const cleanId = id.trim();
  const result = await col.deleteOne({
    $or: [{ _id: cleanId }, { id: cleanId }]
  });
  return result.deletedCount > 0;
}

/**
 * Deletes specific messages by their IDs within a conversation.
 * Used when truncating conversation branches during Edit and Resend.
 */
export async function deleteMessagesByIds(conversationId: string, messageIds: string[]): Promise<number> {
  if (!conversationId || !conversationId.trim() || !Array.isArray(messageIds) || messageIds.length === 0) {
    return 0;
  }

  const cleanIds = messageIds.filter((id) => typeof id === 'string' && id.trim().length > 0);
  if (cleanIds.length === 0) return 0;

  const col = getMessagesCollection();
  const result = await col.deleteMany({
    conversationId: conversationId.trim(),
    $or: [{ _id: { $in: cleanIds } }, { id: { $in: cleanIds } }]
  });

  return result.deletedCount;
}

/**
 * Deletes all messages belonging to a conversation.
 * Used during conversation deletion.
 */
export async function deleteMessagesByConversationId(conversationId: string): Promise<number> {
  if (!conversationId || !conversationId.trim()) return 0;
  const col = getMessagesCollection();
  const result = await col.deleteMany({ conversationId: conversationId.trim() });
  return result.deletedCount;
}
