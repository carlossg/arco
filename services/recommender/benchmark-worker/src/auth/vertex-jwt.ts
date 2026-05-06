interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const OAUTH2_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Converts a PEM private key string to a CryptoKey using the WebCrypto API.
 * Cloudflare Workers support RSASSA-PKCS1-v1_5 (RS256) natively.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');

  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function base64url(data: ArrayBuffer | string): string {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);

  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function buildJWT(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: OAUTH2_TOKEN_URL,
      scope: VERTEX_SCOPE,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signingInput = `${header}.${payload}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64url(sig)}`;
}

/**
 * Exchanges a service account JWT for a short-lived OAuth2 access token.
 * Call once per benchmark run; token is valid for 1 hour.
 */
export async function getVertexAccessToken(serviceAccountJsonBase64: string): Promise<string> {
  const sa: ServiceAccount = JSON.parse(atob(serviceAccountJsonBase64));
  const jwt = await buildJWT(sa);

  const resp = await fetch(OAUTH2_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Vertex OAuth2 failed: ${resp.status} ${body.slice(0, 200)}`);
  }

  const { access_token } = (await resp.json()) as { access_token: string };
  return access_token;
}
