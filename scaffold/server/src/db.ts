import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let clientPromise: Promise<MongoClient> | undefined;

export async function getDb(): Promise<Db> {
  if (!clientPromise) {
    const client = new MongoClient(config.mongoUrl);
    clientPromise = client.connect().catch((error: unknown) => {
      clientPromise = undefined;
      throw error;
    });
  }
  const client = await clientPromise;
  return client.db();
}

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.collection('webhook_events').createIndex({ processed: 1, receivedAt: 1 }),
    db.collection('messages').createIndex({ workspace: 1, messageId: 1 }, { unique: true }),
    db.collection('messages').createIndex({ workspace: 1, contact: 1, occurredAt: 1 }),
    db.collection('conversations').createIndex({ workspace: 1, contact: 1 }, { unique: true }),
    db.collection('conversations').createIndex({ workspace: 1, lastActivity: -1 }),
    db.collection('outbound').createIndex({ workspace: 1, clientRef: 1 }, { unique: true }),
    db.collection('outbound').createIndex({ status: 1, nextAttemptAt: 1, leaseUntil: 1 }),
    db.collection('stream_events').createIndex({ workspace: 1, seq: 1 }, { unique: true }),
  ]);
}
