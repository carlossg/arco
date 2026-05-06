/**
 * Minimal AWS SigV4 signer using the WebCrypto API.
 * Signs a pre-built fetch Request in place, returning a new Request with
 * Authorization, x-amz-date, and x-amz-security-token headers added.
 *
 * Only supports POST with a JSON body (sufficient for Bedrock InvokeModel).
 */

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export async function signRequest(
  request: Request,
  credentials: AwsCredentials,
  service: string,
  region: string,
): Promise<Request> {
  const url = new URL(request.url);
  const body = await request.clone().text();
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const datePart = dateStamp.slice(0, 8);

  const payloadHash = await sha256Hex(body);

  // Build canonical headers (must be sorted)
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': dateStamp,
    'x-amz-content-sha256': payloadHash,
  };
  if (credentials.sessionToken) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }
  // Copy Content-Type from original request
  const ct = request.headers.get('Content-Type');
  if (ct) headers['content-type'] = ct;

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    'POST',
    url.pathname,
    url.search.slice(1), // query string without leading '?'
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${datePart}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateStamp,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // Derive signing key
  const kDate = await hmacSha256(
    new TextEncoder().encode(`AWS4${credentials.secretAccessKey}`),
    datePart,
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');

  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const newHeaders = new Headers(request.headers);
  newHeaders.set('Authorization', authorization);
  newHeaders.set('x-amz-date', dateStamp);
  newHeaders.set('x-amz-content-sha256', payloadHash);
  if (credentials.sessionToken) {
    newHeaders.set('x-amz-security-token', credentials.sessionToken);
  }

  return new Request(request.url, {
    method: request.method,
    headers: newHeaders,
    body,
  });
}
