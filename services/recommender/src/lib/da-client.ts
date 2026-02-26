import type { Env } from '../types';
import { getDAToken, clearCachedToken } from './da-token-service';

/**
 * DA (Document Authoring) API Client
 *
 * Handles creating and publishing pages in AEM's Document Authoring system.
 * Uses S2S token authentication with automatic refresh on 401 errors.
 */

export class DAClient {
  private baseUrl = 'https://admin.da.live';
  private org: string;
  private repo: string;
  private env: Env;

  constructor(env: Env) {
    this.org = env.DA_ORG;
    this.repo = env.DA_REPO;
    this.env = env;
  }

  /**
   * Get authentication token (fetched dynamically via S2S or fallback)
   */
  private async getToken(): Promise<string> {
    return getDAToken(this.env);
  }

  /**
   * Check if a page exists at the given path
   */
  async exists(path: string): Promise<boolean> {
    try {
      const token = await this.getToken();
      const response = await this.requestWithToken('HEAD', `/source/${this.org}/${this.repo}${path}.html`, token);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Create a new page with HTML content
   * Includes retry logic for 401 errors (token refresh)
   */
  async createPage(path: string, htmlContent: string): Promise<{ success: boolean; error?: string }> {
    const url = `${this.baseUrl}/source/${this.org}/${this.repo}${path}.html`;
    console.log(`[DAClient] Creating page at: ${url}`);
    console.log(`[DAClient] HTML content length: ${htmlContent.length}`);

    // Try up to 2 times (initial + retry on 401)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await this.getToken();
        console.log(`[DAClient] Token obtained, length: ${token?.length || 0} (attempt ${attempt + 1})`);

        const formData = new FormData();
        formData.append('data', new Blob([htmlContent], { type: 'text/html' }), 'index.html');

        const response = await fetch(url, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        });

        const responseText = await response.text();
        console.log(`[DAClient] Response status: ${response.status}`);
        console.log(`[DAClient] Response body: ${responseText.substring(0, 500)}`);

        // On 401, clear cache and retry
        if (response.status === 401 && attempt === 0) {
          console.log('[DAClient] Got 401, clearing token cache and retrying...');
          clearCachedToken();
          continue;
        }

        if (!response.ok) {
          return { success: false, error: `Failed to create page: ${response.status} - ${responseText}` };
        }

        return { success: true };
      } catch (error) {
        console.error(`[DAClient] Fetch error:`, error);
        return { success: false, error: (error as Error).message };
      }
    }

    return { success: false, error: 'Failed after retry' };
  }

  /**
   * Upload a media file (image)
   * Includes retry logic for 401 errors (token refresh)
   */
  async uploadMedia(
    hash: string,
    ext: string,
    buffer: ArrayBuffer,
    contentType: string,
    folderPath: string,
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    // Media files use ./media_<hash>.<ext> naming convention
    const filename = `media_${hash}.${ext}`;

    // Build full path including folder
    const fullPath = `${folderPath}${filename}`.replace(/\/+/g, '/');
    const uploadUrl = `${this.baseUrl}/source/${this.org}/${this.repo}${fullPath}`;
    console.log(`[DAClient] Uploading media to: ${fullPath}`);
    console.log(`[DAClient] Upload URL: ${uploadUrl}`);

    // Try up to 2 times (initial + retry on 401)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await this.getToken();
        const formData = new FormData();
        formData.append('data', new Blob([buffer], { type: contentType }), filename);

        const response = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        });

        const responseText = await response.text();
        console.log(`[DAClient] Upload response: ${response.status} - ${responseText.substring(0, 200)}`);

        // On 401, clear cache and retry
        if (response.status === 401 && attempt === 0) {
          console.log('[DAClient] Got 401, clearing token cache and retrying...');
          clearCachedToken();
          continue;
        }

        if (!response.ok) {
          return { success: false, error: `Failed to upload media: ${response.status} - ${responseText}` };
        }

        // Return simple relative path - media is in same folder as page
        console.log(`[DAClient] Media upload successful, URL: ./${filename}`);
        return {
          success: true,
          url: `./${filename}`,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }

    return { success: false, error: 'Failed after retry' };
  }

  /**
   * Delete a page
   */
  async deletePage(path: string): Promise<boolean> {
    try {
      const token = await this.getToken();
      const response = await this.requestWithToken('DELETE', `/source/${this.org}/${this.repo}${path}.html`, token);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Make an authenticated request to the DA API with a specific token
   */
  private async requestWithToken(method: string, endpoint: string, token: string): Promise<Response> {
    return fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }
}

/**
 * AEM Admin API Client
 *
 * Handles preview/publish operations.
 * Uses S2S token authentication with automatic refresh on 401 errors.
 */
export class AEMAdminClient {
  private baseUrl = 'https://admin.hlx.page';
  private org: string;
  private site: string;
  private ref: string;
  private env: Env;

  constructor(env: Env, ref: string = 'main') {
    this.org = env.DA_ORG;
    this.site = env.DA_REPO;
    this.ref = ref;
    this.env = env;
  }

  /**
   * Get authentication token (fetched dynamically via S2S or fallback)
   */
  private async getToken(): Promise<string> {
    return getDAToken(this.env);
  }

  /**
   * Trigger preview for a path
   * Includes retry logic for 401 errors (token refresh)
   */
  async preview(path: string): Promise<{ success: boolean; url?: string; error?: string }> {
    const endpoint = `/preview/${this.org}/${this.site}/${this.ref}${path}`;
    console.log(`[AEMAdmin] Preview request: ${this.baseUrl}${endpoint}`);

    // Try up to 2 times (initial + retry on 401)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await this.getToken();
        const response = await this.requestWithToken('POST', endpoint, token);
        const responseText = await response.text();
        console.log(`[AEMAdmin] Preview response: ${response.status} - ${responseText.substring(0, 200)}`);

        // On 401, clear cache and retry
        if (response.status === 401 && attempt === 0) {
          console.log('[AEMAdmin] Got 401, clearing token cache and retrying...');
          clearCachedToken();
          continue;
        }

        if (!response.ok) {
          return { success: false, error: `Preview failed: ${response.status} - ${responseText}` };
        }

        return {
          success: true,
          url: `https://${this.ref}--${this.site}--${this.org}.aem.page${path}`,
        };
      } catch (error) {
        console.error(`[AEMAdmin] Preview error:`, error);
        return { success: false, error: (error as Error).message };
      }
    }

    return { success: false, error: 'Failed after retry' };
  }

  /**
   * Publish to live
   * Includes retry logic for 401 errors (token refresh)
   */
  async publish(path: string): Promise<{ success: boolean; url?: string; error?: string }> {
    const endpoint = `/live/${this.org}/${this.site}/${this.ref}${path}`;
    console.log(`[AEMAdmin] Publish request: ${this.baseUrl}${endpoint}`);

    // Try up to 2 times (initial + retry on 401)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await this.getToken();
        const response = await this.requestWithToken('POST', endpoint, token);
        const responseText = await response.text();
        console.log(`[AEMAdmin] Publish response: ${response.status} - ${responseText.substring(0, 200)}`);

        // On 401, clear cache and retry
        if (response.status === 401 && attempt === 0) {
          console.log('[AEMAdmin] Got 401, clearing token cache and retrying...');
          clearCachedToken();
          continue;
        }

        if (!response.ok) {
          return { success: false, error: `Publish failed: ${response.status} - ${responseText}` };
        }

        return {
          success: true,
          url: `https://${this.ref}--${this.site}--${this.org}.aem.live${path}`,
        };
      } catch (error) {
        console.error(`[AEMAdmin] Publish error:`, error);
        return { success: false, error: (error as Error).message };
      }
    }

    return { success: false, error: 'Failed after retry' };
  }

  /**
   * Purge CDN cache for a path
   */
  async purgeCache(path: string): Promise<boolean> {
    try {
      const token = await this.getToken();
      const response = await this.requestWithToken('POST', `/cache/${this.org}/${this.site}/${this.ref}${path}`, token);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Wait for preview to be available
   */
  async waitForPreview(path: string, maxAttempts: number = 10, interval: number = 1000): Promise<boolean> {
    const previewUrl = `https://${this.ref}--${this.site}--${this.org}.aem.page${path}`;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(previewUrl, { method: 'HEAD' });
        if (response.ok) {
          return true;
        }
      } catch {
        // Continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    return false;
  }

  /**
   * Make an authenticated request to the Admin API with a specific token
   */
  private async requestWithToken(method: string, endpoint: string, token: string): Promise<Response> {
    return fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Unescape HTML entities back to their characters
 * This is the inverse of escapeHtml - used when extracting text from HTML
 */
export function unescapeHtml(str: string): string {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Build HTML page from blocks for DA persistence
 */
export function buildPageHtml(
  title: string,
  description: string,
  blocks: Array<{ html: string; sectionStyle?: string }>,
): string {
  const sectionsHtml = blocks.map((block) => {
    let sectionContent = block.html;

    // Add section-metadata block if there's a non-default style
    if (block.sectionStyle && block.sectionStyle !== 'default') {
      sectionContent += `
      <div class="section-metadata">
        <div>
          <div>style</div>
          <div>${escapeHtml(block.sectionStyle)}</div>
        </div>
      </div>`;
    }

    return `    <div>
${sectionContent}
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
</head>
<body>
  <header></header>
  <main>
${sectionsHtml}
  </main>
  <footer></footer>
</body>
</html>`;
}

/**
 * Generate a content-based hash for media files
 * Creates a hash similar to what AEM uses (hex string from image content)
 */
async function generateContentHash(buffer: ArrayBuffer): Promise<string> {
  // Use SHA-256 and return first 40 chars (similar to SHA-1 length used by AEM)
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  // Return first 40 chars prefixed with 1 (matching AEM format like "1d970deb539...")
  return '1' + hashHex.substring(0, 39);
}

/**
 * Get file extension from URL or content-type
 */
function getImageExtension(url: string, contentType?: string): string {
  // Try to get from content-type first
  if (contentType) {
    const match = contentType.match(/image\/(\w+)/);
    if (match) {
      const ext = match[1].toLowerCase();
      if (ext === 'jpeg') return 'jpg';
      return ext;
    }
  }

  // Fall back to URL
  const urlPath = new URL(url).pathname;
  const ext = urlPath.split('.').pop()?.toLowerCase() || 'jpg';
  return ext.split('?')[0]; // Remove query params
}

/**
 * Download an image and upload it to DA media folder
 */
export async function processExternalImage(
  imageUrl: string,
  daClient: DAClient,
  folderPath: string,
): Promise<string | null> {
  try {
    console.log(`[DAClient] Downloading image: ${imageUrl}`);

    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    console.log(`[DAClient] Download response: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      console.error(`[DAClient] Failed to download image: ${response.status} - URL: ${imageUrl}`);
      return null;
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.arrayBuffer();
    console.log(`[DAClient] Downloaded ${buffer.byteLength} bytes, type: ${contentType}`);

    const ext = getImageExtension(imageUrl, contentType);
    const hash = await generateContentHash(buffer);

    console.log(`[DAClient] Uploading image as: media_${hash}.${ext} (${buffer.byteLength} bytes)`);

    const uploadResult = await daClient.uploadMedia(hash, ext, buffer, contentType, folderPath);

    if (uploadResult.success && uploadResult.url) {
      console.log(`[DAClient] Image uploaded successfully: ${uploadResult.url}`);
      return uploadResult.url;
    }

    console.error(`[DAClient] Failed to upload image: ${uploadResult.error}`);
    return null;
  } catch (error) {
    console.error(`[DAClient] Image processing error:`, error);
    return null;
  }
}

/**
 * Complete persist and publish flow
 */
export async function persistAndPublish(
  path: string,
  html: string,
  env: Env,
): Promise<{ success: boolean; urls?: { preview: string; live: string }; error?: string }> {
  const daClient = new DAClient(env);
  const adminClient = new AEMAdminClient(env);

  try {
    // 1. Create page in DA
    const createResult = await daClient.createPage(path, html);
    if (!createResult.success) {
      return { success: false, error: createResult.error };
    }

    // 2. Trigger preview
    const previewResult = await adminClient.preview(path);
    if (!previewResult.success) {
      return { success: false, error: previewResult.error };
    }

    // 3. Wait for preview to be available
    const previewReady = await adminClient.waitForPreview(path);
    if (!previewReady) {
      console.warn('Preview not ready within timeout, continuing to publish');
    }

    // 4. Publish to live
    const publishResult = await adminClient.publish(path);
    if (!publishResult.success) {
      return { success: false, error: publishResult.error };
    }

    // 5. Purge cache
    await adminClient.purgeCache(path);

    return {
      success: true,
      urls: {
        preview: previewResult.url!,
        live: publishResult.url!,
      },
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
