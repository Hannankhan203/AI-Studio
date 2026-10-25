/**
 * MongoDB Atlas Connection Module for Orvix Backend
 *
 * Provides a resilient, reusable connection to MongoDB Atlas using the official
 * `mongodb` Node.js driver.
 *
 * Features:
 * - Reads `MONGODB_URI` from environment (never hardcoded)
 * - Connects to the database named 'Orvix' (configurable via MONGODB_DB_NAME)
 * - Connection pooling and client reuse
 * - Sanitized logging (masks credentials and sensitive query params)
 * - Safe error handling that prevents server crashes if MongoDB is unreachable
 * - Connection health & ping diagnostics
 */

import { MongoClient, Db, ServerApiVersion, MongoClientOptions } from 'mongodb';

export const DEFAULT_DATABASE_NAME = 'Orvix';

interface MongoConnectionState {
  client: MongoClient | null;
  db: Db | null;
  isConnected: boolean;
  isConnecting: boolean;
  lastConnectedAt: Date | null;
  lastError: string | null;
  connectionPromise: Promise<Db | null> | null;
}

const state: MongoConnectionState = {
  client: null,
  db: null,
  isConnected: false,
  isConnecting: false,
  lastConnectedAt: null,
  lastError: null,
  connectionPromise: null
};

/**
 * Masks any potential connection string, username, or password from error strings.
 */
export function sanitizeMongoError(errorText: any): string {
  if (!errorText) return 'Unknown database error';
  const raw = String(errorText?.message || errorText);
  return raw
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'`]+/gi, 'mongodb+srv://[REDACTED]')
    .replace(/\/\/([^:]+):([^@]+)@/g, '//[REDACTED_USER]:[REDACTED_PASSWORD]@');
}

/**
 * Returns a safe configuration descriptor without exposing URI, username, password, or host.
 */
export function getUriConfigState(uri?: string | null): 'mongodb+srv' | 'mongodb' | 'none' {
  if (!uri) return 'none';
  if (uri.startsWith('mongodb+srv://')) return 'mongodb+srv';
  if (uri.startsWith('mongodb://')) return 'mongodb';
  return 'none';
}

/**
 * Returns the configured MongoDB database name.
 */
export function getDatabaseName(): string {
  return process.env.MONGODB_DB_NAME?.trim() || DEFAULT_DATABASE_NAME;
}

/**
 * Returns whether a MongoDB URI has been configured in the environment.
 */
export function isMongoConfigured(): boolean {
  const uri = process.env.MONGODB_URI?.trim();
  return Boolean(uri && !uri.includes('YOUR_MONGODB_URI'));
}

/**
 * Builds recommended MongoClient options for MongoDB Atlas with serverless & timeout resilience.
 */
function getMongoClientOptions(): MongoClientOptions {
  return {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: true
    },
    // Fail fast if cluster is unreachable so backend routes do not hang
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    // Optimal pool sizing for Node.js / Express
    maxPoolSize: 20,
    minPoolSize: 0,
    maxIdleTimeMS: 30000
  };
}

/**
 * Connects to MongoDB Atlas using the connection string from process.env.MONGODB_URI.
 * Reuses existing connection if already established or in progress.
 *
 * @returns {Promise<Db | null>} The connected Db instance, or null if unconfigured/failed.
 */
export async function connectToDatabase(): Promise<Db | null> {
  // If already connected, return cached db
  if (state.isConnected && state.db) {
    return state.db;
  }

  // If a connection attempt is already in flight, await it
  if (state.connectionPromise) {
    return state.connectionPromise;
  }

  const uri = process.env.MONGODB_URI?.trim();
  if (!uri || uri.includes('YOUR_MONGODB_URI')) {
    state.lastError = 'MONGODB_URI is not configured in environment variables.';
    return null;
  }

  const targetDbName = getDatabaseName();
  state.isConnecting = true;
  state.lastError = null;

  state.connectionPromise = (async () => {
    try {
      console.log(`[MongoDB] Connecting to Atlas database: "${targetDbName}"...`);

      const client = new MongoClient(uri, getMongoClientOptions());

      // Setup connection event listeners
      client.on('serverClosed', () => {
        console.warn('[MongoDB] Server connection closed.');
        state.isConnected = false;
      });

      client.on('error', (err) => {
        console.error('[MongoDB] Client error:', sanitizeMongoError(err));
      });

      await client.connect();

      // Verify connection with a quick ping command
      const db = client.db(targetDbName);
      await db.command({ ping: 1 });

      state.client = client;
      state.db = db;
      state.isConnected = true;
      state.isConnecting = false;
      state.lastConnectedAt = new Date();
      state.lastError = null;

      console.log(`[MongoDB] Successfully connected to database: "${targetDbName}".`);
      return db;
    } catch (error: any) {
      state.isConnected = false;
      state.isConnecting = false;
      state.client = null;
      state.db = null;
      const sanitizedMsg = sanitizeMongoError(error);
      state.lastError = sanitizedMsg;
      console.error(`[MongoDB] Failed to connect to database "${targetDbName}": ${sanitizedMsg}`);
      return null;
    } finally {
      state.connectionPromise = null;
    }
  })();

  return state.connectionPromise;
}

/**
 * Returns the currently active Db instance.
 * Throws a descriptive error if MongoDB is not connected.
 */
export function getDatabase(): Db {
  if (!state.db || !state.isConnected) {
    throw new Error(
      state.lastError
        ? `MongoDB is not connected: ${state.lastError}`
        : 'MongoDB is not connected. Call connectToDatabase() first.'
    );
  }
  return state.db;
}

/**
 * Returns the active MongoClient instance, or null if not connected.
 */
export function getMongoClient(): MongoClient | null {
  return state.client;
}

/**
 * Returns a diagnostic snapshot of the MongoDB connection status.
 */
export interface MongoStatusInfo {
  isConfigured: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  databaseName: string;
  uriScheme: 'mongodb+srv' | 'mongodb' | 'none';
  lastConnectedAt: string | null;
  lastError: string | null;
  pingLatencyMs?: number;
}

export async function getMongoStatus(): Promise<MongoStatusInfo> {
  const configured = isMongoConfigured();
  const dbName = getDatabaseName();
  const rawUri = process.env.MONGODB_URI?.trim();

  let pingLatencyMs: number | undefined;

  if (state.isConnected && state.db) {
    try {
      const start = Date.now();
      await state.db.command({ ping: 1 });
      pingLatencyMs = Date.now() - start;
    } catch (err: any) {
      state.isConnected = false;
      state.lastError = sanitizeMongoError(err);
    }
  }

  return {
    isConfigured: configured,
    isConnected: state.isConnected,
    isConnecting: state.isConnecting,
    databaseName: dbName,
    uriScheme: getUriConfigState(rawUri),
    lastConnectedAt: state.lastConnectedAt ? state.lastConnectedAt.toISOString() : null,
    lastError: state.lastError,
    pingLatencyMs
  };
}

/**
 * Gracefully disconnects the MongoDB client on application shutdown.
 */
export async function closeDatabase(): Promise<void> {
  if (state.client) {
    try {
      console.log('[MongoDB] Closing database connection...');
      await state.client.close();
      console.log('[MongoDB] Database connection closed.');
    } catch (err) {
      console.warn('[MongoDB] Error while closing connection:', err);
    } finally {
      state.client = null;
      state.db = null;
      state.isConnected = false;
      state.isConnecting = false;
    }
  }
}
