import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  decryptPrivateNote,
  encryptPrivateNote,
  generateWorkspaceKey,
  isValidWorkspaceKey,
} from './privateNotes.js';

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
type PrivateNote = {
  noteId: string;
  workspace: string;
  contact: string;
  author: string;
  iv: string;
  ciphertext: string;
  createdAt: string;
  text?: string;
  decryptionFailed?: boolean;
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
  const [privateNotes, setPrivateNotes] = useState<PrivateNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [activeView, setActiveView] = useState<'messages' | 'notes'>('messages');
  const [workspaceKey, setWorkspaceKey] = useState('');
  const [workspaceKeyInput, setWorkspaceKeyInput] = useState('');
  const [showWorkspaceKey, setShowWorkspaceKey] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingReply = useRef<{ text: string; clientRef: string } | null>(null);
  const pendingNote = useRef<{
    workspace: string;
    contact: string;
    text: string;
    noteId: string;
    encrypted?: { iv: string; ciphertext: string };
  } | null>(null);
  const lastSeq = useRef(0);
  const workspaceGeneration = useRef(0);
  const privateNotesRequest = useRef(0);
  const selectionRef = useRef({ workspace, contact });
  selectionRef.current = { workspace, contact };

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.contact === contact),
    [conversations, contact],
  );
  const visiblePrivateNotes = privateNotes.filter(
    (note) => note.workspace === workspace && note.contact === contact,
  );

  const refreshConversations = useCallback(async () => {
    if (!workspace) return;
    const generation = workspaceGeneration.current;
    const result = await requestJson<{ conversations: Conversation[]; nextCursor: string | null }>(
      `/api/conversations?workspace=${encodeURIComponent(workspace)}&limit=30`,
    );
    if (generation !== workspaceGeneration.current || selectionRef.current.workspace !== workspace) return;
    setConversations(result.conversations);
    setNextCursor(result.nextCursor);
    setContact((current) => current && result.conversations.some((item) => item.contact === current)
      ? current
      : result.conversations[0]?.contact ?? '');
  }, [workspace]);

  const loadMoreConversations = useCallback(async () => {
    if (!workspace || !nextCursor) return;
    const generation = workspaceGeneration.current;
    const result = await requestJson<{ conversations: Conversation[]; nextCursor: string | null }>(
      `/api/conversations?workspace=${encodeURIComponent(workspace)}&limit=30&cursor=${encodeURIComponent(nextCursor)}`,
    );
    if (generation !== workspaceGeneration.current || selectionRef.current.workspace !== workspace) return;
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
    const generation = workspaceGeneration.current;
    const result = await requestJson<{ messages: Message[] }>(
      `/api/conversations/${encodeURIComponent(contact)}/messages?workspace=${encodeURIComponent(workspace)}`,
    );
    if (generation !== workspaceGeneration.current
      || selectionRef.current.workspace !== workspace
      || selectionRef.current.contact !== contact) return;
    setMessages(result.messages);
  }, [workspace, contact]);

  const refreshPrivateNotes = useCallback(async () => {
    const requestId = ++privateNotesRequest.current;
    if (!workspace || !contact) {
      setPrivateNotes([]);
      setNotesLoading(false);
      return;
    }
    const generation = workspaceGeneration.current;
    setNotesLoading(true);
    try {
      const result = await requestJson<{ notes: PrivateNote[] }>(
        `/api/conversations/${encodeURIComponent(contact)}/notes?workspace=${encodeURIComponent(workspace)}`,
      );
      if (requestId !== privateNotesRequest.current
        || generation !== workspaceGeneration.current
        || selectionRef.current.workspace !== workspace
        || selectionRef.current.contact !== contact) return;
      const decrypted = await Promise.all(result.notes.map(async (note) => {
        if (!workspaceKey) return note;
        try {
          return {
            ...note,
            text: await decryptPrivateNote(
              note.ciphertext,
              note.iv,
              workspaceKey,
              note.workspace,
              note.contact,
              note.noteId,
            ),
          };
        } catch {
          return { ...note, decryptionFailed: true };
        }
      }));
      if (requestId === privateNotesRequest.current
        && generation === workspaceGeneration.current
        && selectionRef.current.workspace === workspace
        && selectionRef.current.contact === contact) {
        setPrivateNotes(decrypted);
      }
    } finally {
      if (requestId === privateNotesRequest.current
        && generation === workspaceGeneration.current
        && selectionRef.current.workspace === workspace
        && selectionRef.current.contact === contact) {
        setNotesLoading(false);
      }
    }
  }, [workspace, contact, workspaceKey]);

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
    refreshPrivateNotes().catch((cause: unknown) => setError(String(cause)));
  }, [refreshPrivateNotes]);

  useEffect(() => {
    const key = workspace ? localStorage.getItem(`switchboard-note-key:${workspace}`) ?? '' : '';
    setWorkspaceKey(key);
    setWorkspaceKeyInput(key);
    setShowWorkspaceKey(false);
    setPrivateNotes([]);
    setNoteDraft('');
    pendingNote.current = null;
  }, [workspace]);

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
          void refreshPrivateNotes();
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
  }, [workspace, refreshConversations, refreshMessages, refreshPrivateNotes]);

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
    const clientRef = pendingReply.current?.text === text
      ? pendingReply.current.clientRef
      : crypto.randomUUID();
    pendingReply.current = { text, clientRef };
    try {
      await requestJson(`/api/conversations/${encodeURIComponent(selected.contact)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ workspace, text, client_ref: clientRef }),
      });
      pendingReply.current = null;
      setReply('');
      await refreshMessages();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sendPrivateNote(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !workspaceKey || !noteDraft.trim()) return;
    setBusy(true);
    setError('');
    const text = noteDraft.trim();
    const pending = pendingNote.current;
    const matchingPending = pending?.workspace === workspace
      && pending.contact === selected.contact
      && pending.text === text
      ? pending
      : null;
    const noteId = matchingPending?.noteId ?? crypto.randomUUID();
    const pendingRequest = matchingPending ?? { workspace, contact: selected.contact, text, noteId };
    pendingNote.current = pendingRequest;
    try {
      pendingRequest.encrypted ??= await encryptPrivateNote(
        text,
        workspaceKey,
        workspace,
        selected.contact,
        noteId,
      );
      await requestJson(`/api/conversations/${encodeURIComponent(selected.contact)}/notes`, {
        method: 'POST',
        body: JSON.stringify({
          workspace,
          note_id: noteId,
          iv: pendingRequest.encrypted.iv,
          ciphertext: pendingRequest.encrypted.ciphertext,
        }),
      });
      pendingNote.current = null;
      setNoteDraft('');
      try {
        await refreshPrivateNotes();
      } catch {
        setError('Note saved, but the notes list could not be refreshed.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function useWorkspaceKey() {
    const key = workspaceKeyInput.trim();
    if (!isValidWorkspaceKey(key)) {
      setError('Workspace key must be a valid 32-byte base64url key.');
      return;
    }
    localStorage.setItem(`switchboard-note-key:${workspace}`, key);
    setWorkspaceKey(key);
    setWorkspaceKeyInput(key);
    setShowWorkspaceKey(false);
    setError('');
  }

  function createWorkspaceKey() {
    if (workspaceKey) return;
    const key = generateWorkspaceKey();
    localStorage.setItem(`switchboard-note-key:${workspace}`, key);
    setWorkspaceKey(key);
    setWorkspaceKeyInput(key);
    setShowWorkspaceKey(true);
    setError('');
  }

  async function switchUser() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error(`Could not sign out (${response.status})`);
      workspaceGeneration.current += 1;
      setUser(null);
      setWorkspace('');
      setConversations([]);
      setMessages([]);
      setContact('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function changeWorkspace(nextWorkspace: string) {
    workspaceGeneration.current += 1;
    setConversations([]);
    setNextCursor(null);
    setContact('');
    setMessages([]);
    setError('');
    setWorkspace(nextWorkspace);
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
              <select value={workspace} onChange={(event) => changeWorkspace(event.target.value)}>
                {user.workspaces.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
              </select>
            </label>
          )}
          <span className="user-badge">{user.sub}</span>
          <button className="secondary-button switch-user" disabled={busy} onClick={switchUser}>
            Switch user
          </button>
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
              <nav className="detail-tabs" aria-label="Conversation view">
                <button aria-pressed={activeView === 'messages'} onClick={() => setActiveView('messages')}>Messages</button>
                <button aria-pressed={activeView === 'notes'} onClick={() => setActiveView('notes')}>Private notes</button>
              </nav>
              {activeView === 'messages' ? (
                <>
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
                <section className="private-notes-view">
                  <div className="workspace-key-panel">
                    <strong>Workspace encryption key</strong>
                    <p>Generate a key once and share it with workspace teammates through a secure channel. It stays in this browser; Switchboard stores ciphertext plus visible workspace, conversation, author, and time metadata.</p>
                    <div className="workspace-key-controls">
                      <input
                        aria-label="Workspace encryption key"
                        type={showWorkspaceKey ? 'text' : 'password'}
                        autoComplete="off"
                        value={workspaceKeyInput}
                        onChange={(event) => setWorkspaceKeyInput(event.target.value)}
                      />
                      <button type="button" className="secondary-button" onClick={useWorkspaceKey}>Use key</button>
                      <button type="button" className="secondary-button" disabled={Boolean(workspaceKey)} onClick={createWorkspaceKey}>
                        {workspaceKey ? 'Key installed' : 'Generate key'}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!workspaceKey}
                        onClick={() => {
                          setWorkspaceKeyInput(workspaceKey);
                          setShowWorkspaceKey(!showWorkspaceKey);
                        }}
                      >
                        {showWorkspaceKey ? 'Hide key' : 'Show/export key'}
                      </button>
                    </div>
                    <small>Replacing this browser’s key can make older notes unreadable unless you kept the previous key.</small>
                  </div>
                  <div className="private-note-list">
                    {visiblePrivateNotes.map((note) => (
                      <article className="private-note" key={note.noteId}>
                        <p>{note.text ?? (note.decryptionFailed
                          ? 'Could not decrypt this note with the installed key.'
                          : 'Import the workspace key to decrypt this note.')}</p>
                        <footer>
                          <span>{note.author}</span>
                          <time>{new Date(note.createdAt).toLocaleString()}</time>
                        </footer>
                      </article>
                    ))}
                    {notesLoading
                      ? <p className="empty-thread">Loading private notes…</p>
                      : visiblePrivateNotes.length === 0 && <p className="empty-thread">No private notes for this conversation yet.</p>}
                  </div>
                  <form className="reply-composer note-composer" onSubmit={sendPrivateNote}>
                    <textarea
                      aria-label="Write a private note"
                      placeholder={workspaceKey ? 'Write a private note…' : 'Install a workspace key to write notes…'}
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      rows={3}
                      disabled={!workspaceKey}
                    />
                    <div className="composer-footer">
                      <span>Visible to workspace members with the key</span>
                      <button className="primary-button" disabled={busy || !workspaceKey || !noteDraft.trim()}>
                        {busy ? 'Saving…' : 'Add private note'}
                      </button>
                    </div>
                  </form>
                </section>
              )}
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
