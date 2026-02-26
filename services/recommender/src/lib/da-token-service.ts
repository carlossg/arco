/**
 * Document Authoring IMS Token Service
 *
 * Manages authentication for Adobe Document Authoring API using S2S credentials.
 * Supports two authentication methods (in priority order):
 * 1. Service account (DA_CLIENT_ID, DA_CLIENT_SECRET, DA_SERVICE_TOKEN) - For S2S operations
 * 2. Direct token (DA_TOKEN) - Legacy/fallback static token
 *
 * Tokens are cached in memory and refreshed on expiration (401 errors or 23h timeout).
 */

import type { Env } from '../types';

// Adobe IMS token endpoint for OAuth 2.0 authorization access token exchange
const IMS_TOKEN_ENDPOINT = 'https://ims-na1.adobelogin.com/ims/token/v3';

// Token cache for service account tokens (module-level for persistence across requests)
interface TokenCache {
  token: string;
  obtainedAt: number;
}

let cachedToken: TokenCache | null = null;

/**
 * Check if service account credentials are configured
 */
function hasServiceAccountConfig(env: Env): boolean {
  return !!(
    env.DA_CLIENT_ID &&
    env.DA_CLIENT_SECRET &&
    env.DA_SERVICE_TOKEN
  );
}

/**
 * Exchange Adobe IMS credentials for an access token using OAuth 2.0 authorization code flow
 */
async function exchangeForAccessToken(
  clientId: string,
  clientSecret: string,
  serviceToken: string,
): Promise<string> {
  console.log('[DATokenService] Exchanging IMS credentials for access token...');

  // Prepare form-encoded data (matching the working curl request)
  const formParams = new URLSearchParams();
  formParams.append('grant_type', 'authorization_code');
  formParams.append('client_id', clientId);
  formParams.append('client_secret', clientSecret);
  formParams.append('code', serviceToken);

  const response = await fetch(IMS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formParams.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[DATokenService] IMS token exchange failed:', {
      status: response.status,
      error: errorText,
    });
    throw new Error(`Failed to exchange IMS credentials: ${response.status} - ${errorText}`);
  }

  const tokenData = (await response.json()) as { access_token?: string; expires_in?: number };

  if (!tokenData.access_token) {
    throw new Error('No access token received from IMS');
  }

  console.log('[DATokenService] Successfully obtained access token from IMS', {
    expiresIn: tokenData.expires_in,
  });
  return tokenData.access_token;
}

/**
 * Get DA authentication token
 * Priority:
 * 1. Service account token (with caching and refresh) - S2S flow
 * 2. Legacy DA_TOKEN env var (fallback)
 * 3. Error if none available
 */
export async function getDAToken(env: Env): Promise<string> {
  // Priority 1: Service account with cached token
  if (cachedToken) {
    const age = Date.now() - cachedToken.obtainedAt;
    const maxAge = 23 * 60 * 60 * 1000; // 23 hours (token expires in 24h, refresh before)

    if (age < maxAge) {
      console.log('[DATokenService] Using cached service account IMS token');
      return cachedToken.token;
    } else {
      console.log('[DATokenService] Cached token expired, refreshing');
      cachedToken = null;
    }
  }

  // Priority 1b: Service account - generate new token
  if (hasServiceAccountConfig(env)) {
    console.log('[DATokenService] Generating new service account IMS token');
    const clientId = env.DA_CLIENT_ID!;
    const clientSecret = env.DA_CLIENT_SECRET!;
    const serviceToken = env.DA_SERVICE_TOKEN!;

    const accessToken = await exchangeForAccessToken(clientId, clientSecret, serviceToken);

    // Cache the token
    cachedToken = {
      token: accessToken,
      obtainedAt: Date.now(),
    };

    return accessToken;
  }

  // Priority 2: Legacy direct token (fallback)
  if (env.DA_TOKEN) {
    console.log('[DATokenService] Using legacy DA_TOKEN env var');
    return env.DA_TOKEN;
  }

  // No authentication configured
  throw new Error(
    'Document Authoring authentication not configured. ' +
      'Please configure DA service account credentials ' +
      '(DA_CLIENT_ID, DA_CLIENT_SECRET, DA_SERVICE_TOKEN) or provide DA_TOKEN.',
  );
}

/**
 * Clear cached token (called on authentication errors like 401)
 */
export function clearCachedToken(): void {
  console.log('[DATokenService] Clearing cached IMS token');
  cachedToken = null;
}

/**
 * Check if we have valid cached token
 */
export function hasCachedToken(): boolean {
  if (!cachedToken) return false;
  const age = Date.now() - cachedToken.obtainedAt;
  const maxAge = 23 * 60 * 60 * 1000;
  return age < maxAge;
}
