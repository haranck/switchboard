# Private note encryption protocol

Each workspace uses one random 256-bit AES key. An agent generates it in the
browser, where it is saved in that browser's local storage, then shares it
with teammates through a separate secure channel. Each teammate imports the
same key in their own browser. Switchboard does not distribute, back up, or
recover keys.

Before a note is sent, the browser encrypts its UTF-8 text with AES-256-GCM and
a fresh 96-bit random IV. The authenticated additional data is the
workspace ID, contact, and note ID, separated by NUL bytes. This prevents
ciphertext from being moved to a different workspace, conversation, or note
ID without detection. The server stores and returns only the ciphertext, IV,
note ID, workspace, contact, author ID, and creation time. It checks workspace
membership but does not have the encryption key or plaintext.

The shared workspace key is easy to deploy but has important limits:

1. A teammate who obtains the key can read every note encrypted with it and
   can copy or disclose plaintext.
2. Malware, a compromised browser, or same-origin script injection can read
   the key and plaintext while an agent is using the inbox.
3. There is no forward secrecy or per-member revocation. Removing a member or
   rotating the key does not prevent someone who kept the old key from reading
   old ciphertext.

The server can also observe note metadata and can delete or withhold notes.
Agents must retain and share keys securely; losing the only copy makes notes
unreadable.
