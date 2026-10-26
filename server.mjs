import { createServer } from 'node:http';
import { constants, createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbPool, inTransaction } from './lib/db.mjs';
import { removeDemoData, seedDemoData } from './lib/demo-data.mjs';
import { digestToken, hashPassword, newToken, timingSafeTextEqual, verifyPassword } from './lib/security.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const configuredOrigin = process.env.APP_ORIGIN || 'http://' + host + ':' + port;
const originUrl = new URL(configuredOrigin);
if ((originUrl.pathname !== '/' && originUrl.pathname !== '') || originUrl.search || originUrl.hash) {
  throw new Error('APP_ORIGIN must contain only the public origin, such as https://ops.example.com.');
}
const appOrigin = originUrl.origin;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
if (production && originUrl.protocol !== 'https:') throw new Error('Production APP_ORIGIN must use HTTPS.');
if (!production && !['http:', 'https:'].includes(originUrl.protocol)) throw new Error('APP_ORIGIN must use HTTP or HTTPS.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. The API will not start without a database.');

const casdoorIssuer = String(process.env.CASDOOR_ISSUER || '').trim();
const casdoorClientId = String(process.env.CASDOOR_CLIENT_ID || '').trim();
const casdoorClientSecret = String(process.env.CASDOOR_CLIENT_SECRET || '');
const casdoorEnabled = Boolean(casdoorIssuer && casdoorClientId && casdoorClientSecret);
const casdoorSettingCount = [casdoorIssuer, casdoorClientId, casdoorClientSecret].filter(Boolean).length;
const casdoorCallback = appOrigin + '/api/auth/casdoor/callback';
let casdoorMetadataCache = null;
let casdoorJwksCache = null;
if (casdoorSettingCount > 0 && !casdoorEnabled) {
  throw new Error('Casdoor sign-in needs CASDOOR_ISSUER, CASDOOR_CLIENT_ID, and CASDOOR_CLIENT_SECRET together.');
}
if (casdoorEnabled) {
  const issuerUrl = new URL(casdoorIssuer);
  if (!['http:', 'https:'].includes(issuerUrl.protocol) || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) {
    throw new Error('CASDOOR_ISSUER must be an absolute HTTP(S) issuer URL without credentials, query, or fragment.');
  }
  if (production && issuerUrl.protocol !== 'https:') throw new Error('Casdoor issuer must use HTTPS in production.');
}

const pool = createDbPool();
pool.on('error', (error) => console.error('PostgreSQL pool error:', error.message));

const cookieName = production ? '__Host-northstar_session' : 'northstar_session_dev';
const sessionMaxAgeSeconds = 8 * 60 * 60;
const maxBodyBytes = 16 * 1024;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const publicFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
]);

class HttpError extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function setSecurityHeaders(response) {
  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
  ];
  if (production) directives.push('upgrade-insecure-requests');
  response.setHeader('Content-Security-Policy', directives.join('; '));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  if (production) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...extraHeaders,
  });
  response.end(body);
}

function sendError(response, status, message, code) {
  sendJson(response, status, { error: { code, message } });
}

function fail(status, message, code) {
  return new HttpError(status, message, code);
}

async function readJson(request, bodyLimit = maxBodyBytes) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw fail(415, 'Send a JSON request body.', 'unsupported_media_type');
  }
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > bodyLimit) throw fail(413, 'Request body is too large.', 'payload_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > bodyLimit) throw fail(413, 'Request body is too large.', 'payload_too_large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Expected an object.');
    return body;
  } catch {
    throw fail(400, 'Request body must be valid JSON.', 'invalid_json');
  }
}

function assertSameOrigin(request) {
  if (request.headers.origin !== appOrigin) {
    throw fail(403, 'Request origin is not allowed.', 'origin_rejected');
  }
}

function readCookie(request, name) {
  const header = String(request.headers.cookie || '');
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

function sessionCookie(token) {
  const flags = [
    cookieName + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=' + (production ? 'Strict' : 'Lax'),
    'Max-Age=' + sessionMaxAgeSeconds,
  ];
  if (production) flags.push('Secure');
  return flags.join('; ');
}

function clearSessionCookie() {
  const flags = [cookieName + '=', 'Path=/', 'HttpOnly', 'SameSite=' + (production ? 'Strict' : 'Lax'), 'Max-Age=0'];
  if (production) flags.push('Secure');
  return flags.join('; ');
}

async function findSession(request) {
  const token = readCookie(request, cookieName);
  if (!token || token.length > 128) return null;
  const result = await pool.query(
    'SELECT s.token_hash, s.csrf_token, s.expires_at, u.id, u.tenant_id, u.email, u.full_name, u.role, u.officer_id, u.avatar_mime, u.phone, u.timezone, t.name AS tenant_name, t.slug AS tenant_slug ' +
    'FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = s.tenant_id ' +
    'WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active = true',
    [digestToken(token)],
  );
  if (!result.rowCount) return { invalid: true };
  const row = result.rows[0];
  return {
    tokenHash: row.token_hash,
    csrfToken: row.csrf_token,
    user: {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      name: row.full_name,
      role: row.role,
      officerId: row.officer_id,
      avatarUrl: row.avatar_mime ? '/api/profile/avatar/' + row.id : '',
      phone: row.phone || '',
      timezone: row.timezone || 'America/Toronto',
      tenantName: row.tenant_name,
      tenantSlug: row.tenant_slug,
    },
  };
}

async function requireSession(request, response) {
  const session = await findSession(request);
  if (!session || session.invalid) {
    if (session && session.invalid) response.setHeader('Set-Cookie', clearSessionCookie());
    throw fail(401, 'Please sign in to continue.', 'authentication_required');
  }
  return session;
}

function requireMutationAccess(request, session) {
  assertSameOrigin(request);
  const csrfToken = request.headers['x-csrf-token'];
  if (!csrfToken || !timingSafeTextEqual(csrfToken, session.csrfToken)) {
    throw fail(403, 'Request verification failed. Reload the page and try again.', 'csrf_rejected');
  }
  if (!['admin', 'dispatcher', 'supervisor'].includes(session.user.role)) {
    throw fail(403, 'Your account cannot change incident records.', 'insufficient_role');
  }
}

function requireCsrf(request, session) {
  assertSameOrigin(request);
  const csrfToken = request.headers['x-csrf-token'];
  if (!csrfToken || !timingSafeTextEqual(csrfToken, session.csrfToken)) {
    throw fail(403, 'Request verification failed. Reload the page and try again.', 'csrf_rejected');
  }
}

function requireAdminAccess(request, session) {
  requireCsrf(request, session);
  requireAdminRole(session);
}

function requireAdminRole(session) {
  if (session.user.role !== 'admin') throw fail(404, 'Resource was not found.', 'not_found');
}

function requireGuardReportAccess(request, session) {
  requireCsrf(request, session);
  if (session.user.role !== 'guard' || !session.user.officerId) {
    throw fail(403, 'Your account cannot submit a guard report.', 'insufficient_role');
  }
}

function requireDemoAdmin(request, session) {
  assertSameOrigin(request);
  const csrfToken = request.headers['x-csrf-token'];
  if (!csrfToken || !timingSafeTextEqual(csrfToken, session.csrfToken)) {
    throw fail(403, 'Request verification failed. Reload the page and try again.', 'csrf_rejected');
  }
  if (production) throw fail(404, 'Resource was not found.', 'not_found');
  if (session.user.role !== 'admin' || session.user.tenantSlug !== 'northstar') {
    throw fail(403, 'Only the Northstar workspace administrator can manage demo records.', 'insufficient_role');
  }
}

function validateText(value, label, maxLength, required = true) {
  if (typeof value !== 'string') throw fail(400, label + ' must be text.', 'invalid_input');
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !normalized) throw fail(400, label + ' is required.', 'invalid_input');
  if (normalized.length > maxLength) throw fail(400, label + ' is too long.', 'invalid_input');
  return normalized;
}

function incidentFromRow(row) {
  const minutes = Math.max(0, Number(row.minutes_ago || 0));
  let opened = 'Just now';
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    opened = hours === 1 ? '1 hour ago' : hours + ' hours ago';
  } else if (minutes >= 1) {
    opened = minutes + ' min ago';
  }
  return {
    id: row.incident_code,
    title: row.title,
    type: row.incident_type,
    severity: row.severity,
    site: row.site_name,
    siteId: row.site_id,
    location: row.location,
    opened,
    status: row.status,
    assignedOfficer: row.assigned_officer_name,
    description: row.description,
  };
}

async function getState(user) {
  return inTransaction(pool, user.tenantId, async (client) => {
    const incidentResult = await client.query(
      'SELECT i.incident_code, i.title, i.incident_type, i.severity, i.location, i.description, i.status, i.site_id, s.name AS site_name, o.name AS assigned_officer_name, floor(extract(epoch FROM (now() - i.opened_at)) / 60)::integer AS minutes_ago ' +
      'FROM incidents i JOIN sites s ON s.id = i.site_id LEFT JOIN officers o ON o.id = i.assigned_officer_id ' +
      "WHERE i.tenant_id = $1 AND ($2 <> 'guard' OR i.assigned_officer_id = $3) ORDER BY i.opened_at DESC LIMIT 200",
      [user.tenantId, user.role, user.officerId],
    );
    const officerResult = await client.query(
      "SELECT o.id AS uuid, o.officer_code AS id, o.name, o.initials, o.role, o.status, o.post, o.battery, o.color, s.name AS site, CASE WHEN o.last_seen_at IS NULL THEN 'No check-in' WHEN now() - o.last_seen_at < interval '1 minute' THEN 'Just now' ELSE floor(extract(epoch FROM (now() - o.last_seen_at)) / 60)::integer || ' min ago' END AS ping " +
      "FROM officers o LEFT JOIN sites s ON s.id = o.site_id WHERE o.tenant_id = $1 AND o.is_active = true AND ($2 <> 'guard' OR o.id = $3) ORDER BY o.name LIMIT 500",
      [user.tenantId, user.role, user.officerId],
    );
    const siteResult = await client.query(
      "SELECT id, name, address, city, region, site_type, client_name, contact_name, contact_phone, timezone, geofence_m, contract_window, status FROM sites s WHERE tenant_id = $1 AND ($2 <> 'guard' OR EXISTS (SELECT 1 FROM officers o WHERE o.tenant_id = $1 AND o.id = $3 AND o.site_id = s.id) OR EXISTS (SELECT 1 FROM patrol_tours p WHERE p.tenant_id = $1 AND p.officer_id = $3 AND p.site_id = s.id)) ORDER BY name LIMIT 250",
      [user.tenantId, user.role, user.officerId],
    );
    const tourResult = await client.query(
      "SELECT p.name, p.shift_label, p.window_label, p.checkpoint_names, p.completed_checkpoints, p.status, s.name AS site, o.name AS officer FROM patrol_tours p LEFT JOIN sites s ON s.id = p.site_id LEFT JOIN officers o ON o.id = p.officer_id WHERE p.tenant_id = $1 AND ($2 <> 'guard' OR p.officer_id = $3) ORDER BY p.created_at DESC LIMIT 250",
      [user.tenantId, user.role, user.officerId],
    );
    const activityResult = await client.query(
      "SELECT title, detail, icon, occurred_at FROM activity_events WHERE tenant_id = $1 AND ($2 <> 'guard' OR actor_user_id = $3) ORDER BY occurred_at DESC LIMIT 20",
      [user.tenantId, user.role, user.id],
    );
    return {
      incidents: incidentResult.rows.map(incidentFromRow),
      officers: officerResult.rows,
      sites: siteResult.rows,
      tours: tourResult.rows.map((row) => ({
        name: row.name,
        site: [row.site, row.shift_label].filter(Boolean).join(' · '),
        officer: row.officer || 'Unassigned',
        window: row.window_label,
        complete: row.completed_checkpoints,
        total: Array.isArray(row.checkpoint_names) ? row.checkpoint_names.length : 0,
        checkpoints: Array.isArray(row.checkpoint_names) ? row.checkpoint_names : [],
        status: row.status,
      })),
      activity: activityResult.rows.map((row) => ({
        title: row.title,
        detail: row.detail,
        icon: row.icon,
        time: new Date(row.occurred_at).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }),
      })),
      demoDataControls: !production && user.role === 'admin' && user.tenantSlug === 'northstar',
      isGuard: user.role === 'guard',
    };
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error('OIDC provider returned an unsuccessful response.');
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json') && !contentType.includes('+json')) throw new Error('OIDC provider response was not JSON.');
  return response.json();
}

function validOidcEndpoint(value, label) {
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('Invalid OIDC ' + label + ' endpoint.');
  }
  if (production && endpoint.protocol !== 'https:') throw new Error('OIDC endpoints must use HTTPS in production.');
  return endpoint.href;
}

async function getCasdoorMetadata() {
  if (!casdoorEnabled) throw fail(404, 'Casdoor sign-in is not configured.', 'sso_not_configured');
  if (casdoorMetadataCache && casdoorMetadataCache.until > Date.now()) return casdoorMetadataCache.value;
  const issuerUrl = new URL(casdoorIssuer);
  const discoveryUrl = process.env.CASDOOR_DISCOVERY_URL
    ? validOidcEndpoint(process.env.CASDOOR_DISCOVERY_URL, 'discovery')
    : (issuerUrl.pathname.includes('/.well-known/')
      ? new URL(issuerUrl.href.replace(/\/$/, '') + '/openid-configuration').href
      : new URL('/.well-known/openid-configuration', issuerUrl).href);
  const metadata = await fetchJson(discoveryUrl);
  if (metadata.issuer !== casdoorIssuer) throw new Error('Casdoor discovery issuer does not match CASDOOR_ISSUER.');
  if (!Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes('code')) {
    throw new Error('Casdoor discovery does not advertise the authorization code flow.');
  }
  const value = {
    authorization_endpoint: validOidcEndpoint(metadata.authorization_endpoint, 'authorization'),
    token_endpoint: validOidcEndpoint(metadata.token_endpoint, 'token'),
    jwks_uri: validOidcEndpoint(metadata.jwks_uri, 'JWKS'),
    userinfo_endpoint: metadata.userinfo_endpoint ? validOidcEndpoint(metadata.userinfo_endpoint, 'userinfo') : '',
    issuer: metadata.issuer,
  };
  casdoorMetadataCache = { value, until: Date.now() + 5 * 60 * 1000 };
  return value;
}

function base64UrlJson(value) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new Error('OIDC token is malformed.'); }
}

async function verifyCasdoorIdToken(token, nonceHash, metadata) {
  if (typeof token !== 'string' || token.length > 16_384) throw new Error('OIDC token is missing or too large.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('OIDC token is malformed.');
  const header = base64UrlJson(parts[0]);
  const claims = base64UrlJson(parts[1]);
  if (header.crit || header.b64 === false || (header.kid !== undefined && (typeof header.kid !== 'string' || header.kid.length > 256)) || !['RS256', 'PS256', 'ES256', 'EdDSA'].includes(header.alg)) {
    throw new Error('OIDC token uses an unsupported signing algorithm.');
  }
  if (!casdoorJwksCache || casdoorJwksCache.until < Date.now()) {
    const jwks = await fetchJson(metadata.jwks_uri);
    if (!Array.isArray(jwks.keys)) throw new Error('Casdoor JWKS response is invalid.');
    casdoorJwksCache = { keys: jwks.keys, until: Date.now() + 5 * 60 * 1000 };
  }
  const findJwk = (keys) => {
    const matches = keys.filter((key) => (!header.kid || key.kid === header.kid) && (!key.use || key.use === 'sig') && (!key.alg || key.alg === header.alg));
    return matches.length === 1 ? matches[0] : null;
  };
  let jwk = findJwk(casdoorJwksCache.keys);
  if (!jwk) {
    casdoorJwksCache = null;
    const jwks = await fetchJson(metadata.jwks_uri);
    if (!Array.isArray(jwks.keys)) throw new Error('Casdoor JWKS response is invalid.');
    casdoorJwksCache = { keys: jwks.keys, until: Date.now() + 5 * 60 * 1000 };
    jwk = findJwk(jwks.keys);
  }
  if (!jwk) throw new Error('No matching Casdoor signing key was found.');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const signedContent = Buffer.from(parts[0] + '.' + parts[1]);
  const signature = Buffer.from(parts[2], 'base64url');
  let valid = false;
  if (header.alg === 'RS256') valid = verifySignature('RSA-SHA256', signedContent, key, signature);
  else if (header.alg === 'PS256') valid = verifySignature('sha256', signedContent, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
  else if (header.alg === 'ES256') valid = verifySignature('sha256', signedContent, { key, dsaEncoding: 'ieee-p1363' }, signature);
  else valid = verifySignature(null, signedContent, key, signature);
  if (!valid) throw new Error('Casdoor ID token signature validation failed.');

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== casdoorIssuer || !audiences.includes(casdoorClientId) ||
      (claims.azp !== undefined && claims.azp !== casdoorClientId) ||
      (audiences.length > 1 && claims.azp !== casdoorClientId) ||
      typeof claims.exp !== 'number' || claims.exp <= now ||
      (typeof claims.nbf === 'number' && claims.nbf > now + 60) ||
      typeof claims.iat !== 'number' || claims.iat > now + 60 ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256 ||
      typeof claims.nonce !== 'string' || !timingSafeTextEqual(digestToken(claims.nonce), nonceHash)) {
    throw new Error('Casdoor ID token claims did not pass validation.');
  }
  return claims;
}

async function getVerifiedCasdoorEmail(claims, accessToken, metadata) {
  let profile = claims;
  if ((!profile.email || profile.email_verified !== true) && metadata.userinfo_endpoint && accessToken) {
    const userinfo = await fetchJson(metadata.userinfo_endpoint, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (userinfo.sub !== claims.sub) throw new Error('Casdoor user information did not match the signed identity.');
    profile = { ...claims, ...userinfo };
  }
  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || profile.email_verified !== true) {
    throw new Error('Casdoor must provide a verified email address for the pre-provisioned account.');
  }
  return email;
}

async function createUserSession(request, userRow) {
  const token = newToken();
  const csrfToken = newToken();
  const priorToken = readCookie(request, cookieName);
  if (priorToken && priorToken.length <= 128) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [digestToken(priorToken)]);
  await pool.query(
    "INSERT INTO sessions(token_hash, user_id, tenant_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4, now() + interval '8 hours')",
    [digestToken(token), userRow.id, userRow.tenant_id, csrfToken],
  );
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  return {
    user: {
      id: userRow.id,
      tenantId: userRow.tenant_id,
      email: userRow.email,
      name: userRow.full_name,
      role: userRow.role,
      officerId: userRow.officer_id,
      avatarUrl: userRow.avatar_mime ? '/api/profile/avatar/' + userRow.id : '',
      phone: userRow.phone || '',
      timezone: userRow.timezone || 'America/Toronto',
      tenantName: userRow.tenant_name,
      tenantSlug: userRow.tenant_slug,
    },
    csrfToken,
    cookie: sessionCookie(token),
  };
}

function redirect(response, location, cookie) {
  response.writeHead(303, { Location: location, ...(cookie ? { 'Set-Cookie': cookie } : {}), 'Cache-Control': 'no-store' });
  response.end();
}

async function startCasdoorLogin(response) {
  const metadata = await getCasdoorMetadata();
  const state = newToken();
  const nonce = newToken();
  const codeVerifier = newToken() + newToken();
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  await pool.query('DELETE FROM oidc_auth_requests WHERE expires_at < now()');
  await pool.query(
    "INSERT INTO oidc_auth_requests(state_hash, nonce_hash, code_verifier, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')",
    [digestToken(state), digestToken(nonce), codeVerifier],
  );
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: casdoorClientId,
    response_type: 'code',
    redirect_uri: casdoorCallback,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  redirect(response, authorize.href);
}

async function completeCasdoorLogin(request, response, url) {
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (url.searchParams.has('error') || !code || code.length > 2_048 || !state || state.length > 256) {
    throw new Error('Casdoor authorization was not completed.');
  }
  const authRequest = await pool.query(
    'DELETE FROM oidc_auth_requests WHERE state_hash = $1 AND expires_at > now() RETURNING nonce_hash, code_verifier',
    [digestToken(state)],
  );
  if (!authRequest.rowCount) throw new Error('Casdoor login state was expired or already used.');
  const metadata = await getCasdoorMetadata();
  const tokenResponse = await fetchJson(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: casdoorClientId,
      client_secret: casdoorClientSecret,
      code,
      redirect_uri: casdoorCallback,
      code_verifier: authRequest.rows[0].code_verifier,
    }),
  });
  const claims = await verifyCasdoorIdToken(tokenResponse.id_token, authRequest.rows[0].nonce_hash, metadata);
  const email = await getVerifiedCasdoorEmail(claims, tokenResponse.access_token, metadata);
  const userResult = await pool.query(
    'SELECT u.id, u.tenant_id, u.email, u.full_name, u.role, u.is_active, u.officer_id, u.avatar_mime, u.phone, u.timezone, t.name AS tenant_name, t.slug AS tenant_slug ' +
    'FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email) = $1 ORDER BY u.id LIMIT 2', [email],
  );
  if (userResult.rowCount !== 1 || !userResult.rows[0].is_active) throw new Error('No active pre-provisioned account matches this Casdoor identity.');
  const session = await createUserSession(request, userResult.rows[0]);
  redirect(response, '/', session.cookie);
}

async function appendActivity(client, user, title, detail, icon) {
  await client.query(
    'INSERT INTO activity_events(tenant_id, actor_user_id, title, detail, icon) VALUES ($1, $2, $3, $4, $5)',
    [user.tenantId, user.id, title, detail, icon],
  );
}

async function createIncident(user, body) {
  const title = validateText(body.title, 'Summary', 100);
  const location = validateText(body.location, 'Location', 90);
  const description = validateText(body.description || '', 'Notes', 800, false) || 'No additional dispatch notes.';
  const siteId = validateText(body.siteId, 'Site', 64);
  const allowedTypes = new Set(['ALARM RESPONSE', 'MEDICAL EMERGENCY', 'NOISE COMPLAINT', 'ACCESS CONTROL', 'SUSPICIOUS PERSON', 'PROPERTY DAMAGE']);
  const type = validateText(body.type, 'Incident type', 40).toUpperCase();
  if (!allowedTypes.has(type)) throw fail(400, 'Choose a supported incident type.', 'invalid_input');
  const severity = validateText(body.severity, 'Priority', 16).toLowerCase();
  if (!['critical', 'high', 'medium', 'low'].includes(severity)) throw fail(400, 'Choose a valid priority.', 'invalid_input');
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw fail(400, 'Choose a valid site.', 'invalid_input');
  const isGuard = user.role === 'guard';
  if (isGuard && !user.officerId) throw fail(403, 'Link this guard account to an active officer record first.', 'officer_link_required');
  return inTransaction(pool, user.tenantId, async (client) => {
    const site = await client.query(
      "SELECT s.id FROM sites s WHERE s.id = $1 AND s.tenant_id = $2 AND s.status = 'Active' AND ($3::boolean = false OR EXISTS (SELECT 1 FROM officers o WHERE o.id = $4 AND o.tenant_id = $2 AND o.site_id = s.id AND o.is_active = true))",
      [siteId, user.tenantId, isGuard, user.officerId || null],
    );
    if (!site.rowCount) throw fail(400, 'That site is not available to your account.', 'invalid_site');
    const codeNumber = await client.query("SELECT nextval('incident_code_seq') AS value");
    const code = 'INC-' + String(codeNumber.rows[0].value).padStart(4, '0');
    await client.query(
      "INSERT INTO incidents(tenant_id, incident_code, site_id, assigned_officer_id, title, incident_type, severity, location, description, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [user.tenantId, code, siteId, isGuard ? user.officerId : null, title, type, severity, location, description, isGuard ? 'assigned' : 'open', user.id],
    );
    await appendActivity(client, user, isGuard ? 'Guard report submitted' : 'Dispatch ticket created', code + ' · ' + title, '!');
    return { id: code };
  });
}

async function updateIncident(user, code, action) {
  if (!['assign', 'resolve'].includes(action)) throw fail(400, 'Choose a valid incident action.', 'invalid_action');
  return inTransaction(pool, user.tenantId, async (client) => {
    const incidentResult = await client.query(
      'SELECT id, incident_code, status, title, location, assigned_officer_id FROM incidents WHERE tenant_id = $1 AND incident_code = $2 FOR UPDATE',
      [user.tenantId, code],
    );
    if (!incidentResult.rowCount) throw fail(404, 'Incident was not found.', 'not_found');
    const incident = incidentResult.rows[0];
    if (incident.status === 'resolved') throw fail(409, 'This incident is already resolved.', 'conflict');
    if (action === 'assign') {
      if (incident.assigned_officer_id) throw fail(409, 'This incident already has an assigned officer.', 'conflict');
      const officer = await client.query(
        "SELECT id, name FROM officers WHERE tenant_id = $1 AND status = 'Available' AND is_active = true ORDER BY name LIMIT 1 FOR UPDATE SKIP LOCKED",
        [user.tenantId],
      );
      if (!officer.rowCount) throw fail(409, 'No officer is currently available for assignment.', 'no_available_officer');
      await client.query(
        "UPDATE officers SET status = 'Responding', post = $1 WHERE id = $2 AND tenant_id = $3",
        [incident.location, officer.rows[0].id, user.tenantId],
      );
      await client.query(
        "UPDATE incidents SET status = 'assigned', assigned_officer_id = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3",
        [officer.rows[0].id, incident.id, user.tenantId],
      );
      await appendActivity(client, user, 'Dispatch ticket assigned', code + ' · ' + officer.rows[0].name, '↗');
      return { message: 'Incident assigned in the operations database.' };
    }
    await client.query(
      "UPDATE incidents SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2",
      [incident.id, user.tenantId],
    );
    if (incident.assigned_officer_id) {
      await client.query(
        "UPDATE officers SET status = 'Available' WHERE id = $1 AND tenant_id = $2 AND status = 'Responding'",
        [incident.assigned_officer_id, user.tenantId],
      );
    }
    await appendActivity(client, user, 'Incident marked resolved', code + ' · ' + incident.title, '✓');
    return { message: 'Incident resolution saved in the operations database.' };
  });
}

async function recordLoginAttempt(ip, email) {
  const keyHash = digestToken(ip + '\n' + email);
  const result = await pool.query(
    "INSERT INTO login_attempt_limits(key_hash, window_started_at, attempts) VALUES ($1, now(), 1) " +
    "ON CONFLICT (key_hash) DO UPDATE SET " +
    "attempts = CASE WHEN login_attempt_limits.window_started_at < now() - interval '15 minutes' THEN 1 ELSE login_attempt_limits.attempts + 1 END, " +
    "blocked_until = CASE WHEN login_attempt_limits.window_started_at < now() - interval '15 minutes' THEN NULL WHEN login_attempt_limits.attempts + 1 >= 10 THEN now() + interval '15 minutes' ELSE login_attempt_limits.blocked_until END, " +
    "window_started_at = CASE WHEN login_attempt_limits.window_started_at < now() - interval '15 minutes' THEN now() ELSE login_attempt_limits.window_started_at END " +
    'RETURNING attempts, blocked_until',
    [keyHash],
  );
  return result.rows[0];
}

function safeAvatar(body) {
  if (body.clear === true) return { mime: null, bytes: null };
  if (typeof body.dataUrl !== 'string' || body.dataUrl.length > 1_400_000) {
    throw fail(400, 'Choose a JPEG, PNG, or WebP image no larger than 1 MB.', 'invalid_avatar');
  }
  const match = body.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw fail(400, 'Choose a JPEG, PNG, or WebP image.', 'invalid_avatar');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 1_048_576) throw fail(413, 'Profile images must be 1 MB or smaller.', 'payload_too_large');
  const valid = match[1] === 'image/jpeg'
    ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : match[1] === 'image/png'
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw fail(400, 'The image contents do not match the selected file type.', 'invalid_avatar');
  return { mime: match[1], bytes };
}

async function listAdminUsers(user) {
  return inTransaction(pool, user.tenantId, async (client) => {
    const result = await client.query(
      'SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.officer_id, u.avatar_mime, o.name AS officer_name FROM users u LEFT JOIN officers o ON o.id = u.officer_id AND o.tenant_id = u.tenant_id WHERE u.tenant_id = $1 ORDER BY u.full_name LIMIT 250',
      [user.tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.full_name,
      role: row.role,
      active: row.is_active,
      officerId: row.officer_id,
      officerName: row.officer_name,
      avatarUrl: row.avatar_mime ? '/api/profile/avatar/' + row.id : '',
    }));
  });
}

async function createAdminUser(user, body) {
  const name = validateText(body.name, 'Full name', 100);
  const email = validateText(body.email, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address.', 'invalid_input');
  const role = validateText(body.role, 'Role', 20).toLowerCase();
  if (!['admin', 'dispatcher', 'supervisor', 'viewer', 'guard'].includes(role)) throw fail(400, 'Choose a supported account role.', 'invalid_input');
  const password = body.password;
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw fail(400, 'Use a unique password with at least 16 characters.', 'invalid_input');
  }
  const officerId = body.officerId ? validateText(body.officerId, 'Officer', 64) : null;
  if (officerId && !/^[0-9a-f-]{36}$/i.test(officerId)) throw fail(400, 'Choose a valid officer record.', 'invalid_input');
  if (role === 'guard' && !officerId) throw fail(400, 'Guard accounts must be linked to an officer record.', 'officer_link_required');
  const passwordHash = await hashPassword(password);
  try {
    return await inTransaction(pool, user.tenantId, async (client) => {
      if (officerId) {
        const officer = await client.query('SELECT id FROM officers WHERE id = $1 AND tenant_id = $2 AND is_active = true', [officerId, user.tenantId]);
        if (!officer.rowCount) throw fail(400, 'Choose an active officer from this workspace.', 'invalid_officer');
      }
      const result = await client.query(
        'INSERT INTO users(tenant_id, email, full_name, password_hash, role, officer_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [user.tenantId, email, name, passwordHash, role, officerId],
      );
      await appendActivity(client, user, 'Workspace account created', name + ' · ' + role, '♙');
      return { id: result.rows[0].id };
    });
  } catch (error) {
    if (error?.code === '23505') throw fail(409, 'That email address or officer is already linked to an account.', 'account_conflict');
    throw error;
  }
}

async function updateAdminUser(user, id, body) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail(404, 'Account was not found.', 'not_found');
  const role = validateText(body.role, 'Role', 20).toLowerCase();
  if (!['admin', 'dispatcher', 'supervisor', 'viewer', 'guard'].includes(role)) throw fail(400, 'Choose a supported account role.', 'invalid_input');
  if (typeof body.active !== 'boolean') throw fail(400, 'Choose whether the account is active.', 'invalid_input');
  const officerId = body.officerId ? validateText(body.officerId, 'Officer', 64) : null;
  if (officerId && !/^[0-9a-f-]{36}$/i.test(officerId)) throw fail(400, 'Choose a valid officer record.', 'invalid_input');
  if (role === 'guard' && !officerId) throw fail(400, 'Guard accounts must be linked to an officer record.', 'officer_link_required');
  if (id === user.id && (!body.active || role !== 'admin')) throw fail(400, 'You cannot deactivate or demote your own administrator account.', 'self_lockout');
  try {
    await inTransaction(pool, user.tenantId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [user.tenantId]);
      const current = await client.query('SELECT id, role, is_active FROM users WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, user.tenantId]);
      if (!current.rowCount) throw fail(404, 'Account was not found.', 'not_found');
      if (officerId) {
        const officer = await client.query('SELECT id FROM officers WHERE id = $1 AND tenant_id = $2 AND is_active = true', [officerId, user.tenantId]);
        if (!officer.rowCount) throw fail(400, 'Choose an active officer from this workspace.', 'invalid_officer');
      }
      const account = current.rows[0];
      if (account.role === 'admin' && account.is_active && (role !== 'admin' || !body.active)) {
        const admins = await client.query("SELECT count(*)::integer AS count FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true", [user.tenantId]);
        if (admins.rows[0].count <= 1) throw fail(409, 'The last active administrator cannot be demoted or disabled.', 'last_admin');
      }
      await client.query(
        'UPDATE users SET role = $3, is_active = $4, officer_id = $5 WHERE id = $1 AND tenant_id = $2',
        [id, user.tenantId, role, body.active, officerId],
      );
      if (!body.active) await client.query('DELETE FROM sessions WHERE user_id = $1 AND tenant_id = $2', [id, user.tenantId]);
      await appendActivity(client, user, 'Workspace account updated', current.rows[0].id + ' · ' + role + (body.active ? ' · active' : ' · disabled'), '♙');
    });
  } catch (error) {
    if (error?.code === '23505') throw fail(409, 'That officer is already linked to an account.', 'account_conflict');
    throw error;
  }
  return { ok: true };
}

async function queryAdminRecords(user, body) {
  const dataset = validateText(body.dataset, 'Record type', 24);
  const search = validateText(body.search || '', 'Search', 100, false);
  const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
  const queries = {
    incidents: ['SELECT incident_code AS reference, title, incident_type AS type, severity, status, location FROM incidents WHERE tenant_id = $1 AND (incident_code ILIKE $2 OR title ILIKE $2 OR location ILIKE $2) ORDER BY opened_at DESC LIMIT 100', pattern],
    officers: ['SELECT officer_code AS reference, name, role, status, post FROM officers WHERE tenant_id = $1 AND is_active = true AND (officer_code ILIKE $2 OR name ILIKE $2 OR post ILIKE $2) ORDER BY name LIMIT 100', pattern],
    sites: ['SELECT name, address, city, region, status FROM sites WHERE tenant_id = $1 AND (name ILIKE $2 OR address ILIKE $2 OR city ILIKE $2) ORDER BY name LIMIT 100', pattern],
    patrols: ['SELECT name, shift_label AS shift, window_label AS window, status FROM patrol_tours WHERE tenant_id = $1 AND (name ILIKE $2 OR shift_label ILIKE $2 OR window_label ILIKE $2) ORDER BY created_at DESC LIMIT 100', pattern],
    activity: ['SELECT title, detail, occurred_at FROM activity_events WHERE tenant_id = $1 AND (title ILIKE $2 OR detail ILIKE $2) ORDER BY occurred_at DESC LIMIT 100', pattern],
  };
  if (!Object.hasOwn(queries, dataset)) throw fail(400, 'Choose a supported record type.', 'invalid_input');
  return inTransaction(pool, user.tenantId, async (client) => {
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const result = await client.query(queries[dataset][0], [user.tenantId, queries[dataset][1]]);
    return { columns: result.fields.map((field) => field.name), rows: result.rows, limited: result.rowCount === 100 };
  });
}

function allowedCandidateDatabaseUrl(value) {
  let candidate;
  let current;
  try {
    candidate = new URL(value);
    current = new URL(process.env.DATABASE_URL);
  } catch { throw fail(400, 'Enter a valid database connection URL.', 'invalid_database_url'); }
  if (!['postgres:', 'postgresql:'].includes(candidate.protocol) || candidate.hash || candidate.search || !candidate.hostname || !candidate.username || !candidate.password) {
    throw fail(400, 'The candidate must be a PostgreSQL URL with credentials and no query options.', 'invalid_database_url');
  }
  const allowedHosts = String(process.env.DATABASE_ALLOWED_HOSTS || '').split(',').map((hostName) => hostName.trim().toLowerCase()).filter(Boolean);
  if (candidate.hostname.toLowerCase() !== current.hostname.toLowerCase() && !allowedHosts.includes(candidate.hostname.toLowerCase())) {
    throw fail(400, 'This database host is not approved. Add it to DATABASE_ALLOWED_HOSTS on the server first.', 'database_host_not_allowed');
  }
  return candidate;
}

async function testCandidateDatabase(connectionString) {
  const candidate = allowedCandidateDatabaseUrl(connectionString);
  const candidatePool = createDbPool(connectionString);
  candidatePool.on('error', () => {});
  try {
    const result = await candidatePool.query("SELECT current_database() AS database, current_setting('server_version_num') AS version");
    return { ok: true, host: candidate.hostname, port: Number(candidate.port || 5432), database: result.rows[0].database, serverVersion: result.rows[0].version };
  } catch {
    throw fail(400, 'Connection failed. Check the credentials, database, network access, and TLS configuration.', 'database_connection_failed');
  } finally {
    await candidatePool.end();
  }
}

async function handleApi(request, response, url) {
  const method = request.method || 'GET';
  const path = url.pathname;

  if (path === '/api/health' && method === 'GET') {
    await pool.query('SELECT 1');
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  if (path === '/api/auth/casdoor/status' && method === 'GET') {
    sendJson(response, 200, { enabled: casdoorEnabled });
    return;
  }

  if (path === '/api/auth/casdoor/login' && method === 'GET') {
    await startCasdoorLogin(response);
    return;
  }

  if (path === '/api/auth/casdoor/callback' && method === 'GET') {
    try {
      await completeCasdoorLogin(request, response, url);
    } catch (error) {
      console.warn('Casdoor sign-in failed. Check the provider configuration and pre-provisioned account.');
      redirect(response, '/?sso=failed');
    }
    return;
  }

  if (path === '/api/auth/session' && method === 'GET') {
    const session = await findSession(request);
    if (!session || session.invalid) {
      sendJson(response, 200, { user: null }, session && session.invalid ? { 'Set-Cookie': clearSessionCookie() } : {});
      return;
    }
    sendJson(response, 200, { user: session.user, csrfToken: session.csrfToken });
    return;
  }

  if (path === '/api/auth/login' && method === 'POST') {
    assertSameOrigin(request);
    const body = await readJson(request);
    const email = validateText(body.email || '', 'Email', 254).toLowerCase();
    const password = body.password;
    if (typeof password !== 'string' || password.length < 1 || password.length > 1024 || /[\u0000-\u001f\u007f]/.test(password)) {
      throw fail(400, 'Password is invalid.', 'invalid_input');
    }
    const limit = await recordLoginAttempt(request.socket.remoteAddress || 'unknown', email);
    if (limit.blocked_until && new Date(limit.blocked_until) > new Date()) {
      throw fail(429, 'Too many sign-in attempts. Wait 15 minutes and try again.', 'login_limited');
    }
    const result = await pool.query(
      'SELECT u.id, u.tenant_id, u.email, u.full_name, u.password_hash, u.role, u.is_active, u.officer_id, u.avatar_mime, u.phone, u.timezone, t.name AS tenant_name, t.slug AS tenant_slug ' +
      'FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = $1 LIMIT 1',
      [email],
    );
    const userRow = result.rows[0];
    if (!userRow) {
      if (!globalThis.__northstarDummyPasswordHash) globalThis.__northstarDummyPasswordHash = await hashPassword(newToken());
      await verifyPassword(password, globalThis.__northstarDummyPasswordHash);
      throw fail(401, 'Email or password is incorrect.', 'invalid_credentials');
    }
    const validPassword = await verifyPassword(password, userRow.password_hash);
    if (!userRow.is_active || !validPassword) throw fail(401, 'Email or password is incorrect.', 'invalid_credentials');
    const keyHash = digestToken((request.socket.remoteAddress || 'unknown') + '\n' + email);
    await pool.query('DELETE FROM login_attempt_limits WHERE key_hash = $1', [keyHash]);
    const session = await createUserSession(request, userRow);
    sendJson(response, 200, { user: session.user, csrfToken: session.csrfToken }, { 'Set-Cookie': session.cookie });
    return;
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const session = await requireSession(request, response);
    requireCsrf(request, session);
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [session.tokenHash]);
    sendJson(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  const avatarMatch = path.match(/^\/api\/profile\/avatar\/([0-9a-f-]{36})$/i);
  if (avatarMatch && method === 'GET') {
    const session = await requireSession(request, response);
    if (avatarMatch[1].toLowerCase() !== session.user.id.toLowerCase() && session.user.role !== 'admin') {
      throw fail(404, 'Resource was not found.', 'not_found');
    }
    const result = await pool.query('SELECT avatar_mime, avatar_data FROM users WHERE id = $1 AND tenant_id = $2', [avatarMatch[1], session.user.tenantId]);
    if (!result.rowCount || !result.rows[0].avatar_mime) throw fail(404, 'Resource was not found.', 'not_found');
    const image = result.rows[0].avatar_data;
    response.writeHead(200, {
      'Content-Type': result.rows[0].avatar_mime,
      'Content-Length': String(image.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(image);
    return;
  }

  if (path === '/api/profile' && method === 'PATCH') {
    const session = await requireSession(request, response);
    requireCsrf(request, session);
    const body = await readJson(request);
    const name = validateText(body.name, 'Full name', 100);
    const phone = validateText(body.phone ?? '', 'Contact phone', 40, false);
    const timezone = validateText(body.timezone ?? 'America/Toronto', 'Time zone', 64);
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
    catch { throw fail(400, 'Choose a valid time zone.', 'invalid_input'); }
    await pool.query('UPDATE users SET full_name = $1, phone = $2, timezone = $3 WHERE id = $4 AND tenant_id = $5', [name, phone, timezone, session.user.id, session.user.tenantId]);
    sendJson(response, 200, { name, phone, timezone });
    return;
  }

  if (path === '/api/profile/password' && method === 'POST') {
    const session = await requireSession(request, response);
    requireCsrf(request, session);
    const body = await readJson(request);
    if (typeof body.currentPassword !== 'string' || !body.currentPassword.length || body.currentPassword.length > 1024 || /[\u0000-\u001f\u007f]/.test(body.currentPassword)) {
      throw fail(400, 'Enter your current password.', 'invalid_input');
    }
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 16 || body.newPassword.length > 1024 || /[\u0000-\u001f\u007f]/.test(body.newPassword)) {
      throw fail(400, 'New passwords must be 16–1024 characters and contain no control characters.', 'invalid_input');
    }
    const passwordResult = await pool.query('SELECT password_hash FROM users WHERE id = $1 AND tenant_id = $2 AND is_active = true', [session.user.id, session.user.tenantId]);
    if (!passwordResult.rowCount || !await verifyPassword(body.currentPassword, passwordResult.rows[0].password_hash)) {
      throw fail(403, 'The current password is incorrect.', 'invalid_current_password');
    }
    const previousHash = passwordResult.rows[0].password_hash;
    const nextHash = await hashPassword(body.newPassword);
    await inTransaction(pool, session.user.tenantId, async (client) => {
      const updated = await client.query('UPDATE users SET password_hash = $1 WHERE id = $2 AND tenant_id = $3 AND password_hash = $4', [nextHash, session.user.id, session.user.tenantId, previousHash]);
      if (!updated.rowCount) throw fail(409, 'The password changed in another session. Sign in again and retry.', 'password_changed');
      await client.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [session.user.id, session.tokenHash]);
      await appendActivity(client, session.user, 'Password changed', 'The account password was updated and other active sessions were revoked.', '🔐');
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (path === '/api/profile/avatar' && method === 'POST') {
    const session = await requireSession(request, response);
    requireCsrf(request, session);
    const body = await readJson(request, 1_450_000);
    const avatar = safeAvatar(body);
    await pool.query('UPDATE users SET avatar_mime = $1, avatar_data = $2 WHERE id = $3 AND tenant_id = $4', [avatar.mime, avatar.bytes, session.user.id, session.user.tenantId]);
    sendJson(response, 200, { avatarUrl: avatar.mime ? '/api/profile/avatar/' + session.user.id : '' });
    return;
  }

  if (path === '/api/state' && method === 'GET') {
    const session = await requireSession(request, response);
    sendJson(response, 200, await getState(session.user));
    return;
  }

  if (path === '/api/admin/users' && method === 'GET') {
    const session = await requireSession(request, response);
    requireAdminRole(session);
    sendJson(response, 200, { users: await listAdminUsers(session.user) });
    return;
  }

  if (path === '/api/admin/users' && method === 'POST') {
    const session = await requireSession(request, response);
    requireAdminAccess(request, session);
    sendJson(response, 201, await createAdminUser(session.user, await readJson(request)));
    return;
  }

  const userMatch = path.match(/^\/api\/admin\/users\/([0-9a-f-]{36})$/i);
  if (userMatch && method === 'PATCH') {
    const session = await requireSession(request, response);
    requireAdminAccess(request, session);
    sendJson(response, 200, await updateAdminUser(session.user, userMatch[1], await readJson(request)));
    return;
  }

  if (path === '/api/admin/query' && method === 'POST') {
    const session = await requireSession(request, response);
    requireAdminAccess(request, session);
    sendJson(response, 200, await queryAdminRecords(session.user, await readJson(request)));
    return;
  }

  if (path === '/api/admin/database/status' && method === 'GET') {
    const session = await requireSession(request, response);
    requireAdminRole(session);
    const configured = new URL(process.env.DATABASE_URL);
    sendJson(response, 200, {
      host: configured.hostname,
      port: Number(configured.port || 5432),
      database: decodeURIComponent(configured.pathname.replace(/^\//, '')),
      username: decodeURIComponent(configured.username),
      sslMode: process.env.DATABASE_SSL || 'disable',
    });
    return;
  }

  if (path === '/api/admin/database/test' && method === 'POST') {
    const session = await requireSession(request, response);
    requireAdminAccess(request, session);
    const body = await readJson(request);
    const candidateUrl = validateText(body.connectionString, 'Connection URL', 2048);
    sendJson(response, 200, await testCandidateDatabase(candidateUrl));
    return;
  }

  if (path === '/api/demo-data/load' && method === 'POST') {
    const session = await requireSession(request, response);
    requireDemoAdmin(request, session);
    const body = await readJson(request);
    if (body.confirm !== 'LOAD') throw fail(400, 'Confirm that you want to load fictional demo records.', 'confirmation_required');
    try {
      const counts = await seedDemoData(pool, session.user.tenantId);
      sendJson(response, 200, { counts });
    } catch (error) {
      if (String(error?.message || '').startsWith('A sample ')) throw fail(409, error.message, 'demo_data_conflict');
      throw error;
    }
    return;
  }

  if (path === '/api/demo-data/remove' && method === 'POST') {
    const session = await requireSession(request, response);
    requireDemoAdmin(request, session);
    const body = await readJson(request);
    if (body.confirm !== 'REMOVE') throw fail(400, 'Confirm that you want to remove fictional demo records.', 'confirmation_required');
    try {
      const counts = await removeDemoData(pool, session.user);
      sendJson(response, 200, { counts });
    } catch (error) {
      if (String(error?.message || '').startsWith('Some sample ')) throw fail(409, error.message, 'demo_data_in_use');
      throw error;
    }
    return;
  }

  if (path === '/api/incidents' && method === 'POST') {
    const session = await requireSession(request, response);
    if (session.user.role === 'guard') requireGuardReportAccess(request, session);
    else requireMutationAccess(request, session);
    const body = await readJson(request);
    sendJson(response, 201, await createIncident(session.user, body));
    return;
  }

  const incidentMatch = path.match(/^\/api\/incidents\/(INC-[0-9]{4,10})$/);
  if (incidentMatch && method === 'PATCH') {
    const session = await requireSession(request, response);
    requireMutationAccess(request, session);
    const body = await readJson(request);
    sendJson(response, 200, await updateIncident(session.user, incidentMatch[1], body.action));
    return;
  }

  throw fail(404, 'Resource was not found.', 'not_found');
}

async function handleStatic(request, response, url) {
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) throw fail(405, 'Method is not allowed.', 'method_not_allowed');
  const filename = publicFiles.get(url.pathname);
  if (!filename) throw fail(404, 'Resource was not found.', 'not_found');
  const filePath = resolve(root, filename);
  if (filePath !== root && !filePath.startsWith(root + sep)) throw fail(404, 'Resource was not found.', 'not_found');
  const body = await readFile(filePath);
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
    'Content-Length': String(body.length),
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  try {
    const url = new URL(request.url || '/', appOrigin);
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else await handleStatic(request, response, url);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(response, error.status, error.message, error.code);
      return;
    }
    if (error?.code === 'ENOENT') {
      sendError(response, 404, 'Resource was not found.', 'not_found');
      return;
    }
    console.error('Request failed:', error?.message || 'unknown error');
    sendError(response, 500, 'The request could not be completed.', 'internal_error');
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
let databaseReady = false;
try {
  await pool.query('SELECT 1');
  databaseReady = true;
} catch {
  console.error('PostgreSQL readiness check failed. The web server was not started.');
  await pool.end();
  process.exitCode = 1;
}

if (databaseReady) {
  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') console.error('The Northstar Web GUI port ' + host + ':' + port + ' is already in use. Choose a free PORT in .env and update APP_ORIGIN to match.');
    else console.error('The Northstar Web GUI could not listen on its configured address.');
    pool.end().finally(() => process.exit(1));
  });
  server.listen(port, host, () => {
    console.log('Northstar Web GUI listening on ' + host + ':' + port + ' (origin ' + appOrigin + ')');
  });
}

function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
