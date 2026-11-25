import { randomUUID } from 'node:crypto';
import type { Document, ObjectId } from 'mongodb';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';

export const workspaceIds = new Set(['ws_acme', 'ws_globex']);

export interface Conversation extends Document {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastActivity: Date;
  createdAt: Date;
}

export interface StoredMessage extends Document {
  workspace: string;
  contact: string;
  messageId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  occurredAt: Date;
  clientRef?: string;
  status?: string;
}

const getDbPromise = () => getDb();

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

async function ensureConversation(workspace: string, contact: string, activityAt = new Date()): Promise<void> {
  const conversations = (await getDbPromise()).collection<Conversation>('conversations');
  try {
    await conversations.updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          status: 'open',
          createdAt: activityAt,
        },
        $max: { lastActivity: activityAt },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    await conversations.updateOne({ workspace, contact }, { $max: { lastActivity: activityAt } });
  }
}

async function publishWorkspaceEvent(workspace: string, event: Record<string, unknown>): Promise<void> {
  const redis = getRedis();
  const lockKey = `sb:event-lock:${workspace}`;
  const token = randomUUID();
  const unlockScript = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  const expiresAt = Date.now() + 10_000;

  while (Date.now() < expiresAt) {
    if (await redis.set(lockKey, token, 'PX', 15_000, 'NX') === 'OK') {
      try {
        const seq = await redis.incr(`sb:seq:${workspace}`);
        const frame = { ...event, workspace, seq };
        await (await getDbPromise()).collection('stream_events').insertOne({
          workspace,
          seq,
          frame,
          createdAt: new Date(),
        });
        await redis.publish(`sb:events:${workspace}`, JSON.stringify(frame));
        return;
      } finally {
        await redis.eval(unlockScript, 1, lockKey, token);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
  }
  throw new Error(`Could not acquire event sequence lock for ${workspace}`);
}

export async function storeInbound(
  workspace: string,
  contact: string,
  messageId: string,
  text: string,
  occurredAt: Date,
): Promise<void> {
  const messages = (await getDbPromise()).collection<StoredMessage>('messages');
  await ensureConversation(workspace, contact, occurredAt);
  const result = await messages.updateOne(
    { workspace, messageId },
    {
      $setOnInsert: {
        workspace,
        contact,
        messageId,
        direction: 'inbound',
        text,
        occurredAt,
      },
    },
    { upsert: true },
  );
  if (result.upsertedCount > 0) {
    await publishWorkspaceEvent(workspace, { type: 'message.inbound', contact, message_id: messageId });
  }
}

function statusRank(status: string): number {
  if (status === 'sent') return 1;
  if (status === 'delivered' || status === 'failed') return 2;
  return 0;
}

export async function updateOutboundStatus(workspace: string, clientRef: string, status: string): Promise<void> {
  if (!['sent', 'delivered', 'failed'].includes(status)) return;
  const outbound = (await getDbPromise()).collection('outbound');
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await outbound.findOne({ workspace, clientRef });
    if (!current || statusRank(status) <= statusRank(String(current.status))) return;
    const result = await outbound.updateOne(
      { _id: current._id, status: current.status },
      { $set: { status, updatedAt: new Date() } },
    );
    if (result.modifiedCount > 0) {
      await publishWorkspaceEvent(workspace, {
        type: 'message.status',
        contact: current.contact,
        client_ref: clientRef,
        status,
      });
      return;
    }
  }
}

export async function processWebhookEvent(event: Document): Promise<void> {
  const body = event.body as Record<string, unknown>;
  const workspace = typeof body.workspace === 'string' ? body.workspace : '';
  if (!workspaceIds.has(workspace)) return;
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};

  if (body.type === 'message.inbound') {
    if (typeof data.message_id !== 'string' || typeof data.from !== 'string' || typeof data.text !== 'string') return;
    const parsedAt = new Date(typeof body.occurred_at === 'string' ? body.occurred_at : '');
    const occurredAt = Number.isNaN(parsedAt.getTime()) ? new Date() : parsedAt;
    await storeInbound(workspace, data.from, data.message_id, data.text, occurredAt);
  } else if (body.type === 'message.status'
    && typeof data.client_ref === 'string'
    && typeof data.status === 'string') {
    await updateOutboundStatus(workspace, data.client_ref, data.status);
  }
}

export async function recoverPendingWebhooks(): Promise<void> {
  const events = (await getDbPromise()).collection('webhook_events');
  const pending = await events.find({ processed: false }).sort({ receivedAt: 1 }).limit(50).toArray();
  for (const event of pending) {
    await processWebhookEvent(event);
    await events.updateOne({ _id: event._id, processed: false }, { $set: { processed: true } });
  }
}

export async function enqueueReply(
  workspace: string,
  contact: string,
  text: string,
  clientRef: string,
): Promise<void> {
  const at = new Date();
  await ensureConversation(workspace, contact, at);
  try {
    await (await getDbPromise()).collection('outbound').updateOne(
      { workspace, clientRef },
      {
        $setOnInsert: {
          workspace,
          contact,
          clientRef,
          text,
          status: 'queued',
          attempts: 0,
          createdAt: at,
          updatedAt: at,
          nextAttemptAt: at,
          leaseUntil: null,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }
}

const rateLimitScript = `
local cooldown = redis.call('pttl', KEYS[2])
if cooldown > 0 then return {0, cooldown} end
local now = tonumber(ARGV[1])
local tokens = tonumber(redis.call('hget', KEYS[1], 'tokens')) or 8
local updated = tonumber(redis.call('hget', KEYS[1], 'updated')) or now
tokens = math.min(8, tokens + math.max(0, now - updated) / 1000 * 4)
if tokens < 1 then
  local wait = math.ceil((1 - tokens) * 250)
  redis.call('hmset', KEYS[1], 'tokens', tokens, 'updated', now)
  redis.call('pexpire', KEYS[1], 60000)
  return {0, wait}
end
tokens = tokens - 1
redis.call('hmset', KEYS[1], 'tokens', tokens, 'updated', now)
redis.call('pexpire', KEYS[1], 60000)
return {1, 0}
`;

async function reserveSend(workspace: string): Promise<number> {
  const result = await getRedis().eval(
    rateLimitScript,
    2,
    `sb:rate:${workspace}`,
    `sb:cooldown:${workspace}`,
    String(Date.now()),
  ) as [number, number];
  return Number(result[0]) === 1 ? 0 : Number(result[1]);
}

async function delayOutbound(id: ObjectId, delayMs: number): Promise<void> {
  await (await getDbPromise()).collection('outbound').updateOne(
    { _id: id, status: 'queued' },
    {
      $set: {
        nextAttemptAt: new Date(Date.now() + delayMs),
        leaseUntil: null,
        updatedAt: new Date(),
      },
    },
  );
}

async function dispatchOne(workerId: string): Promise<void> {
  const outbound = (await getDbPromise()).collection('outbound');
  const now = new Date();
  const job = await outbound.findOneAndUpdate(
    {
      status: 'queued',
      nextAttemptAt: { $lte: now },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
    },
    {
      $set: { leaseUntil: new Date(now.getTime() + 30_000), workerId },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!job) return;

  const wait = await reserveSend(String(job.workspace));
  if (wait > 0) {
    await delayOutbound(job._id, wait);
    return;
  }
  try {
    const apiKey = config.pigeon.apiKeys[String(job.workspace)];
    if (!apiKey) throw new Error(`No Pigeon API key configured for ${String(job.workspace)}`);
    const response = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': String(job.clientRef),
      },
      body: JSON.stringify({ to: job.contact, text: job.text, client_ref: job.clientRef }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      const seconds = Math.max(1, Number(response.headers.get('retry-after')) || 2);
      const delayMs = Math.ceil(seconds * 1000);
      await getRedis().set(`sb:cooldown:${String(job.workspace)}`, '1', 'PX', delayMs);
      await delayOutbound(job._id, delayMs);
      return;
    }
    if (!response.ok) throw new Error(`Pigeon send returned ${response.status}`);
    const result = await response.json() as { id?: unknown };
    const updated = await outbound.updateOne(
      { _id: job._id, status: 'queued' },
      { $set: { status: 'sent', providerId: result.id, leaseUntil: null, updatedAt: new Date() } },
    );
    if (updated.modifiedCount > 0) {
      await publishWorkspaceEvent(String(job.workspace), {
        type: 'message.status',
        contact: job.contact,
        client_ref: job.clientRef,
        status: 'sent',
      });
    }
  } catch (error) {
    const delayMs = Math.min(30_000, 500 * (2 ** Math.min(Number(job.attempts) - 1, 6)));
    await delayOutbound(job._id, delayMs);
    console.error('Pigeon send will be retried:', error);
  }
}

let workerTimer: NodeJS.Timeout | undefined;
let workerRunning = false;

export function startOutboxWorker(): void {
  if (workerTimer) return;
  const workerId = randomUUID();
  workerTimer = setInterval(() => {
    if (workerRunning) return;
    workerRunning = true;
    dispatchOne(workerId)
      .catch((error: unknown) => console.error('Outbox worker failed:', error))
      .finally(() => {
        workerRunning = false;
      });
  }, 100);
}

export async function claimConversation(workspace: string, contact: string, agent: string): Promise<boolean> {
  const conversations = (await getDbPromise()).collection<Conversation>('conversations');
  try {
    const result = await conversations.findOneAndUpdate(
      { workspace, contact, assignee: null },
      {
        $set: { assignee: agent, lastActivity: new Date() },
        $setOnInsert: { workspace, contact, status: 'open', createdAt: new Date() },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if (!result) return false;
    await publishWorkspaceEvent(workspace, { type: 'conversation.assigned', contact, assignee: agent });
    return true;
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    const current = await conversations.findOne({ workspace, contact });
    return current?.assignee === agent;
  }
}

export async function setConversationStatus(
  workspace: string,
  contact: string,
  status: 'open' | 'closed',
): Promise<void> {
  await ensureConversation(workspace, contact);
  const result = await (await getDbPromise()).collection<Conversation>('conversations').updateOne(
    { workspace, contact, status: { $ne: status } },
    { $set: { status, lastActivity: new Date() } },
  );
  if (result.modifiedCount > 0) {
    await publishWorkspaceEvent(workspace, { type: 'conversation.status', contact, status });
  }
}

export async function listConversations(
  workspace: string,
  limit: number,
  cursor?: string,
): Promise<{ conversations: Conversation[]; nextCursor: string | null }> {
  const filter: Document = { workspace };
  if (cursor) {
    let position: { lastActivity: string; contact: string };
    try {
      position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof position;
    } catch {
      const error = new Error('Invalid conversation cursor');
      Object.assign(error, { status: 400 });
      throw error;
    }
    if (typeof position !== 'object' || position === null
      || typeof position.lastActivity !== 'string'
      || typeof position.contact !== 'string') {
      const error = new Error('Invalid conversation cursor');
      Object.assign(error, { status: 400 });
      throw error;
    }
    const lastActivity = new Date(position.lastActivity);
    if (Number.isNaN(lastActivity.getTime())) {
      const error = new Error('Invalid conversation cursor');
      Object.assign(error, { status: 400 });
      throw error;
    }
    filter.$or = [
      { lastActivity: { $lt: lastActivity } },
      { lastActivity, contact: { $gt: position.contact } },
    ];
  }
  const records = await (await getDbPromise()).collection<Conversation>('conversations')
    .find(filter)
    .sort({ lastActivity: -1, contact: 1 })
    .limit(limit + 1)
    .toArray();
  const hasMore = records.length > limit;
  const conversations = hasMore ? records.slice(0, limit) : records;
  const last = conversations[conversations.length - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({
      lastActivity: last.lastActivity.toISOString(),
      contact: last.contact,
    })).toString('base64url')
    : null;
  return { conversations, nextCursor };
}

export async function listMessages(workspace: string, contact: string): Promise<StoredMessage[]> {
  const database = await getDbPromise();
  const [inbound, outbound] = await Promise.all([
    database.collection<StoredMessage>('messages')
      .find({ workspace, contact })
      .sort({ occurredAt: 1, messageId: 1 })
      .limit(500)
      .toArray(),
    database.collection('outbound')
      .find({ workspace, contact })
      .sort({ createdAt: 1 })
      .limit(500)
      .toArray(),
  ]);
  return [
    ...inbound,
    ...outbound.map((message) => ({
      workspace,
      contact,
      messageId: String(message.clientRef),
      clientRef: String(message.clientRef),
      direction: 'outbound' as const,
      text: String(message.text),
      occurredAt: message.createdAt as Date,
      status: String(message.status),
    })),
  ].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

export async function getSnapshot(): Promise<Record<string, unknown>> {
  const database = await getDbPromise();
  const [conversations, messages, outbound] = await Promise.all([
    database.collection<Conversation>('conversations').find({}).toArray(),
    database.collection<StoredMessage>('messages')
      .find({ direction: 'inbound' })
      .sort({ occurredAt: 1, messageId: 1 })
      .toArray(),
    database.collection('outbound').find({}).toArray(),
  ]);
  const workspaces: Record<string, {
    contacts: Record<string, { inbound: string[]; assignee: string | null }>;
    outbound: Record<string, string>;
  }> = {};
  const ensureWorkspace = (workspace: string) => {
    workspaces[workspace] ??= { contacts: {}, outbound: {} };
    return workspaces[workspace];
  };
  for (const conversation of conversations) {
    ensureWorkspace(conversation.workspace).contacts[conversation.contact] = {
      inbound: [],
      assignee: conversation.assignee ?? null,
    };
  }
  for (const message of messages) {
    const workspace = ensureWorkspace(message.workspace);
    workspace.contacts[message.contact] ??= { inbound: [], assignee: null };
    workspace.contacts[message.contact].inbound.push(message.messageId);
  }
  for (const message of outbound) {
    ensureWorkspace(String(message.workspace)).outbound[String(message.clientRef)] = String(message.status);
  }
  return { workspaces };
}

export async function resetApplicationData(): Promise<void> {
  const database = await getDbPromise();
  await Promise.all([
    database.collection('webhook_events').deleteMany({}),
    database.collection('messages').deleteMany({}),
    database.collection('conversations').deleteMany({}),
    database.collection('outbound').deleteMany({}),
    database.collection('stream_events').deleteMany({}),
  ]);
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'sb:*', 'COUNT', 500);
    cursor = next;
    const appKeys = keys.filter((key) => !key.startsWith('sb:session:') && !key.startsWith('sb:oidc:'));
    if (appKeys.length) await redis.del(...appKeys);
  } while (cursor !== '0');
}
