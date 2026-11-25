import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { getRedis } from './redis.js';

const SESSION_COOKIE = 'switchboard_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface Workspace {
  id: string;
  role: 'admin' | 'agent';
}

export interface UserSession {
  sub: string;
  name?: string;
  email?: string;
  workspaces: Workspace[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nonce: string;
  sub: string;
  name?: string;
  email?: string;
  workspaces: Workspace[];
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function readCookie(cookie: string | undefined, name: string): string | undefined {
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function getDiscovery(): Promise<Discovery> {
  const response = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OIDC discovery returned ${response.status}`);
  const result = await response.json() as Discovery;
  if (result.issuer !== config.oidc.issuer) throw new Error('OIDC issuer did not match configuration');
  return result;
}

export async function beginLogin(response: Response): Promise<void> {
  const discovery = await getDiscovery();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await getRedis().set(
    `sb:oidc:${state}`,
    JSON.stringify({ verifier, nonce }),
    'EX',
    300,
  );
  const authorization = new URL(discovery.authorization_endpoint);
  authorization.search = new URLSearchParams({
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  response.redirect(authorization.toString());
}

function decodeJwtPart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function validateIdToken(token: string, expectedNonce: string): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('IdP returned a malformed ID token');
  const header = decodeJwtPart<{ alg?: string; kid?: string }>(parts[0]);
  const claims = decodeJwtPart<IdTokenClaims>(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('IdP used an unsupported ID token algorithm');

  const discovery = await getDiscovery();
  const keyResponse = await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(10_000) });
  if (!keyResponse.ok) throw new Error(`OIDC keys returned ${keyResponse.status}`);
  const keySet = await keyResponse.json() as {
    keys?: Array<{ kid?: string; alg?: string; kty?: string; n?: string; e?: string }>;
  };
  const jwk = keySet.keys?.find((key) => key.kid === header.kid && (!key.alg || key.alg === 'RS256'));
  if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) throw new Error('IdP signing key was not found');
  const signatureValid = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'),
  );
  if (!signatureValid) throw new Error('ID token signature is invalid');

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.oidc.issuer || !audiences.includes(config.oidc.clientId)) {
    throw new Error('ID token issuer or audience is invalid');
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('ID token has expired');
  }
  if (!constantTimeEqual(claims.nonce, expectedNonce) || typeof claims.sub !== 'string') {
    throw new Error('ID token nonce or subject is invalid');
  }
  if (!Array.isArray(claims.workspaces)) throw new Error('ID token has no workspace membership');
  return claims;
}

export async function finishLogin(request: Request, response: Response): Promise<void> {
  const state = request.query.state;
  const code = request.query.code;
  if (typeof state !== 'string' || typeof code !== 'string') {
    response.status(400).send('Login response is missing state or code');
    return;
  }
  const redis = getRedis();
  const stateValue = await redis.get(`sb:oidc:${state}`);
  if (!stateValue) {
    response.status(400).send('Login state expired or was already used');
    return;
  }
  await redis.del(`sb:oidc:${state}`);
  const stateRecord = JSON.parse(stateValue) as { verifier: string; nonce: string };
  const discovery = await getDiscovery();
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: stateRecord.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) {
    response.status(401).send('The identity provider rejected the login');
    return;
  }
  const tokenPayload = await tokenResponse.json() as { id_token?: unknown };
  if (typeof tokenPayload.id_token !== 'string') {
    response.status(401).send('The identity provider did not return an ID token');
    return;
  }
  const claims = await validateIdToken(tokenPayload.id_token, stateRecord.nonce);
  const session: UserSession = {
    sub: claims.sub,
    name: claims.name,
    email: claims.email,
    workspaces: claims.workspaces.filter(
      (workspace) => typeof workspace.id === 'string' && ['admin', 'agent'].includes(workspace.role),
    ),
  };
  const sessionId = randomToken();
  await redis.set(`sb:session:${sessionId}`, JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
  response.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
  response.redirect(config.webOrigin);
}

export async function getRequestSession(request: Request): Promise<UserSession | undefined> {
  return getSessionFromCookieHeader(request.headers.cookie);
}

export async function endSession(request: Request, response: Response): Promise<void> {
  const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (sessionId) await getRedis().del(`sb:session:${sessionId}`);
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
  });
}

export async function getSessionFromCookieHeader(cookie: string | undefined): Promise<UserSession | undefined> {
  const sessionId = readCookie(cookie, SESSION_COOKIE);
  if (!sessionId) return undefined;
  const value = await getRedis().get(`sb:session:${sessionId}`);
  return value ? JSON.parse(value) as UserSession : undefined;
}

export function isWorkspaceMember(session: UserSession, workspaceId: string): boolean {
  return session.workspaces.some((workspace) => workspace.id === workspaceId);
}
