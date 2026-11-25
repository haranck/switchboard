function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function isValidWorkspaceKey(value: string): boolean {
  try {
    return decodeBase64Url(value).length === 32
      && encodeBase64Url(decodeBase64Url(value)) === value;
  } catch {
    return false;
  }
}

export function generateWorkspaceKey(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function noteAdditionalData(workspace: string, contact: string, noteId: string): Uint8Array {
  return new TextEncoder().encode(`${workspace}\u0000${contact}\u0000${noteId}`);
}

async function importWorkspaceKey(value: string, usage: KeyUsage[]): Promise<CryptoKey> {
  if (!isValidWorkspaceKey(value)) throw new Error('Workspace key must be a 32-byte base64url key');
  return crypto.subtle.importKey('raw', copyToArrayBuffer(decodeBase64Url(value)), 'AES-GCM', false, usage);
}

export async function encryptPrivateNote(
  text: string,
  key: string,
  workspace: string,
  contact: string,
  noteId: string,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const importedKey = await importWorkspaceKey(key, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: copyToArrayBuffer(iv),
      additionalData: copyToArrayBuffer(noteAdditionalData(workspace, contact, noteId)),
    },
    importedKey,
    copyToArrayBuffer(new TextEncoder().encode(text)),
  );
  return { iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(new Uint8Array(encrypted)) };
}

export async function decryptPrivateNote(
  ciphertext: string,
  iv: string,
  key: string,
  workspace: string,
  contact: string,
  noteId: string,
): Promise<string> {
  const importedKey = await importWorkspaceKey(key, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: copyToArrayBuffer(decodeBase64Url(iv)),
      additionalData: copyToArrayBuffer(noteAdditionalData(workspace, contact, noteId)),
    },
    importedKey,
    copyToArrayBuffer(decodeBase64Url(ciphertext)),
  );
  return new TextDecoder().decode(decrypted);
}
