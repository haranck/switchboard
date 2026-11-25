import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Workspace = { id: string; role: 'admin' | 'agent' };
type User = { sub: string; workspaces: Workspace[] };
type Conversation = {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastActivity: string;
};
type Message = {
  messageId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  occurredAt: string;
  status?: string;
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function App() {
  const [user, setUser] = useState<User | null>();
  const [workspace, setWorkspace] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [contact, setContact] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lastSeq = useRef(0);

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.contact === contact),
    [conversations, contact],
  );

  const refreshConversations = useCallback(async () => {
    if (!workspace) return;
    const result = await requestJson<{ conversations: Conversation[]; nextCursor: string | null }>(
      `/api/conversations?workspace=${encodeURIComponent(workspace)}&limit=30`,
    );
    setConversations(result.conversations);
    setNextCursor(result.nextCursor);
    setContact((current) => current && result.conversations.some((item) => item.contact === current)
      ? current
      : result.conversations[0]?.contact ?? '');
  }, [workspace]);

  const loadMoreConversations = useCallback(async () => {
    if (!workspace || !nextCursor) return;
    const result = await requestJson<{ conversations: Conversation[]; nextCursor: string | null }>(
      `/api/conversations?workspace=${encodeURIComponent(workspace)}&limit=30&cursor=${encodeURIComponent(nextCursor)}`,
    );
    setConversations((current) => {
      const byContact = new Map(current.map((item) => [item.contact, item]));
      for (const item of result.conversations) byContact.set(item.contact, item);
      return [...byContact.values()].sort(
        (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
          || a.contact.localeCompare(b.contact),
      );
    });
    setNextCursor(result.nextCursor);
  }, [workspace, nextCursor]);

  const refreshMessages = useCallback(async () => {
    if (!workspace || !contact) {
      setMessages([]);
      return;
    }
    const result = await requestJson<{ messages: Message[] }>(
      `/api/conversations/${encodeURIComponent(contact)}/messages?workspace=${encodeURIComponent(workspace)}`,
    );
    setMessages(result.messages);
  }, [workspace, contact]);

  useEffect(() => {
    requestJson<User>('/api/me')
      .then((me) => {
        setUser(me);
        setWorkspace(me.workspaces[0]?.id ?? '');
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.message !== 'authentication required') setError(cause.message);
        setUser(null);
      });
  }, []);

  useEffect(() => {
    if (!workspace) return;
    setError('');
    refreshConversations().catch((cause: unknown) => setError(String(cause)));
  }, [workspace, refreshConversations]);

  useEffect(() => {
    refreshMessages().catch((cause: unknown) => setError(String(cause)));
  }, [refreshMessages]);

  useEffect(() => {
    if (!workspace) return;
    const storageKey = `switchboard-seq:${workspace}`;
    lastSeq.current = Number(sessionStorage.getItem(storageKey)) || 0;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(
        `${scheme}//${location.host}/ws?workspace=${encodeURIComponent(workspace)}&after=${lastSeq.current}`,
      );
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as { seq?: number };
          if (typeof frame.seq === 'number' && frame.seq > lastSeq.current) {
            lastSeq.current = frame.seq;
            sessionStorage.setItem(storageKey, String(frame.seq));
          }
          void refreshConversations();
          void refreshMessages();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Received an invalid live update');
        }
      };
      socket.onclose = () => {
        if (!stopped) retry = setTimeout(connect, 1000);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [workspace, refreshConversations, refreshMessages]);

  async function claimConversation() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await requestJson(`/api/conversations/${encodeURIComponent(selected.contact)}/claim`, {
        method: 'POST',
        body: JSON.stringify({ workspace }),
      });
      await refreshConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await requestJson(`/api/conversations/${encodeURIComponent(selected.contact)}`, {
        method: 'PATCH',
        body: JSON.stringify({ workspace, status: selected.status === 'open' ? 'closed' : 'open' }),
      });
      await refreshConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !reply.trim()) return;
    setBusy(true);
    setError('');
    const text = reply.trim();
    try {
      await requestJson(`/api/conversations/${encodeURIComponent(selected.contact)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ workspace, text, client_ref: crypto.randomUUID() }),
      });
      setReply('');
      await refreshMessages();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (user === undefined) return <main className="center-card">Connecting to Switchboard…</main>;
  if (!user) {
    return (
      <main className="center-card login-card">
        <div className="brand-mark">S</div>
        <p className="eyebrow">SHARED TEAM INBOX</p>
        <h1>Welcome to Switchboard</h1>
        <p>Sign in with your team account to see customer conversations.</p>
        {error && <p className="error">{error}</p>}
        <a className="primary-button login-button" href="/auth/login">Sign in</a>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">S</span>
          <span>switchboard</span>
        </a>
        <div className="topbar-right">
          {user.workspaces.length > 1 && (
            <label className="workspace-picker">
              <span className="sr-only">Workspace</span>
              <select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
                {user.workspaces.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
              </select>
            </label>
          )}
          <span className="user-badge">{user.sub}</span>
        </div>
      </header>

      <section className="inbox-layout">
        <aside className="conversation-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">WORKSPACE</p>
              <h1>Inbox</h1>
            </div>
            <span className="count-badge">{conversations.length}</span>
          </div>
          <div className="conversation-list">
            {conversations.map((item) => (
              <button
                className={`conversation-row ${item.contact === contact ? 'active' : ''}`}
                key={item.contact}
                onClick={() => setContact(item.contact)}
              >
                <span className="avatar">{item.contact.slice(-2)}</span>
                <span className="conversation-summary">
                  <strong>{item.contact}</strong>
                  <span>{item.assignee ? `Assigned to ${item.assignee}` : 'Unassigned'}</span>
                </span>
                <span className={`status-dot ${item.status}`} />
              </button>
            ))}
            {conversations.length === 0 && (
              <div className="empty-list">
                <div className="empty-icon">✳</div>
                <strong>Your inbox is clear</strong>
                <span>New customer messages will show up here.</span>
              </div>
            )}
            {nextCursor && (
              <button className="load-more" onClick={() => void loadMoreConversations()}>
                Load more conversations
              </button>
            )}
          </div>
        </aside>

        <section className="conversation-detail">
          {selected ? (
            <>
              <header className="conversation-header">
                <div className="contact-heading">
                  <span className="avatar large">{selected.contact.slice(-2)}</span>
                  <div>
                    <h2>{selected.contact}</h2>
                    <span>{selected.assignee ? `Assigned to ${selected.assignee}` : 'No one assigned yet'}</span>
                  </div>
                </div>
                <div className="conversation-actions">
                  <button className="secondary-button" disabled={busy} onClick={claimConversation}>
                    {selected.assignee === user.sub ? 'Assigned to you' : 'Claim'}
                  </button>
                  <button className="secondary-button" disabled={busy} onClick={toggleStatus}>
                    {selected.status === 'open' ? 'Close conversation' : 'Reopen'}
                  </button>
                </div>
              </header>
              <div className="message-list">
                {messages.map((message) => (
                  <article className={`message ${message.direction}`} key={message.messageId}>
                    <p>{message.text}</p>
                    <footer>
                      <time>{new Date(message.occurredAt).toLocaleString()}</time>
                      {message.direction === 'outbound' && <span>{message.status}</span>}
                    </footer>
                  </article>
                ))}
                {messages.length === 0 && <p className="empty-thread">No messages in this conversation yet.</p>}
              </div>
              <form className="reply-composer" onSubmit={sendReply}>
                <textarea
                  aria-label="Write a reply"
                  placeholder="Write a reply…"
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  rows={3}
                />
                <div className="composer-footer">
                  <span>Reply as {user.sub}</span>
                  <button className="primary-button" disabled={busy || !reply.trim()}>
                    {busy ? 'Sending…' : 'Send reply'}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div className="empty-thread">
              <div className="empty-icon">↙</div>
              <h2>Select a conversation</h2>
              <p>Choose a customer from the inbox to read and reply.</p>
            </div>
          )}
          {error && <div className="toast error" role="alert">{error}</div>}
        </section>
      </section>
    </main>
  );
}
