/**
 * Arco - Stream Renderer
 *
 * Framework-agnostic Server-Sent Events (SSE) handler for streaming
 * generative AI responses. Handles connection management, chunked
 * rendering, and error recovery.
 */

import { getAPIEndpoint } from './api-config.js';
import { SessionContextManager } from './session-context.js';

// Session context adapter functions
function getContextSummary() {
  return SessionContextManager.buildContextParam();
}
function addMessage(role, content) {
  if (role === 'user') {
    SessionContextManager.addQuery({ query: content });
  }
}

// ============================================
// Constants
// ============================================

const STREAM_TIMEOUT_MS = 30000;
const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 3;

// Generative page path patterns
const GENERATIVE_PATHS = [
  '/espresso/',
  '/guides/',
  '/products/',
  '/compare/',
  '/tips/',
];

// ============================================
// Utility Functions
// ============================================

/**
 * Check if the current page is a generative content page
 * @param {string} [pathname] - Optional pathname to check (defaults to window.location.pathname)
 * @returns {boolean} True if the page uses generative streaming
 */
export function isGenerativePage(pathname) {
  const path = pathname || window.location.pathname;
  return GENERATIVE_PATHS.some((p) => path.includes(p));
}

/**
 * Extract the stream path from the current URL
 * @returns {string} The path segment used for API routing
 */
export function getStreamPath() {
  const { pathname } = window.location;

  // Find which generative path matches
  const matchedBase = GENERATIVE_PATHS.find((p) => pathname.includes(p));
  if (!matchedBase) return pathname;

  // Extract the portion after the matched base path
  const baseIndex = pathname.indexOf(matchedBase);
  const relativePath = pathname.slice(baseIndex);

  // Remove trailing slash and return
  return relativePath.endsWith('/') ? relativePath.slice(0, -1) : relativePath;
}

/**
 * Build the full stream URL for the API
 * @param {string} query - The user query
 * @returns {string} The full SSE endpoint URL
 */
export function getStreamUrl(query) {
  const baseUrl = getAPIEndpoint('recommender');
  const path = getStreamPath();
  const contextSummary = getContextSummary();

  const params = new URLSearchParams({
    q: query,
    path,
    sessionId: contextSummary.sessionId,
  });

  // Add context if available
  if (contextSummary.coffeeTerms.length > 0) {
    params.set('coffeeTerms', contextSummary.coffeeTerms.join(','));
  }

  return `${baseUrl}/stream?${params.toString()}`;
}

// ============================================
// SSE Connection Manager
// ============================================

/**
 * @typedef {Object} StreamCallbacks
 * @property {function(string): void} onChunk - Called for each text chunk received
 * @property {function(): void} [onStart] - Called when the stream connection opens
 * @property {function(string): void} [onComplete] - Called with full text when stream ends
 * @property {function(Error): void} [onError] - Called when an error occurs
 * @property {function(Object): void} [onMetadata] - Called with metadata events
 */

/**
 * Create an SSE connection and stream the response
 * @param {string} query - The user query to stream
 * @param {StreamCallbacks} callbacks - Event callbacks
 * @returns {Object} Controller with abort() method
 */
export function createStream(query, callbacks) {
  let aborted = false;
  let reconnectAttempts = 0;
  let fullText = '';
  let eventSource = null;
  let timeoutId = null;

  const {
    onChunk,
    onStart,
    onComplete,
    onError,
    onMetadata,
  } = callbacks;

  function cleanup() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  function handleError(error) {
    cleanup();
    if (aborted) return;

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts += 1;
      // eslint-disable-next-line no-console
      console.warn(`[Arco] Stream reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      // eslint-disable-next-line no-use-before-define
      setTimeout(() => connect(), RECONNECT_DELAY_MS * reconnectAttempts);
    } else if (onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function connect() {
    if (aborted) return;

    const url = getStreamUrl(query);

    try {
      eventSource = new EventSource(url);
    } catch (e) {
      handleError(e);
      return;
    }

    // Set connection timeout
    timeoutId = setTimeout(() => {
      if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
        // eslint-disable-next-line no-console
        console.warn('[Arco] Stream timed out');
        cleanup();
        if (onError) onError(new Error('Stream connection timed out'));
      }
    }, STREAM_TIMEOUT_MS);

    eventSource.onopen = () => {
      reconnectAttempts = 0;
      if (onStart) onStart();
    };

    eventSource.onmessage = (event) => {
      if (aborted) {
        cleanup();
        return;
      }

      // Reset timeout on each message
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          cleanup();
          if (onError) onError(new Error('Stream timed out between chunks'));
        }, STREAM_TIMEOUT_MS);
      }

      try {
        const data = JSON.parse(event.data);

        if (data.type === 'chunk' && data.text) {
          fullText += data.text;
          onChunk(data.text);
        } else if (data.type === 'done') {
          cleanup();
          addMessage('assistant', fullText);
          if (onComplete) onComplete(fullText);
        } else if (data.type === 'error') {
          cleanup();
          if (onError) onError(new Error(data.message || 'Stream error'));
        } else if (data.type === 'metadata' && onMetadata) {
          onMetadata(data);
        }
      } catch (e) {
        // If not JSON, treat as plain text chunk
        fullText += event.data;
        onChunk(event.data);
      }
    };

    eventSource.onerror = (e) => {
      // EventSource auto-reconnects on transient errors
      // Only handle if the connection is fully closed
      if (eventSource && eventSource.readyState === EventSource.CLOSED) {
        handleError(e);
      }
    };
  }

  // Add user message to session before starting stream
  addMessage('user', query);
  connect();

  return {
    abort() {
      aborted = true;
      cleanup();
    },
    isActive() {
      return !aborted && eventSource !== null;
    },
  };
}

// ============================================
// Fetch-based Streaming (for POST requests)
// ============================================

/**
 * Stream a response using fetch with ReadableStream
 * Useful when you need to send a POST body (e.g., conversation context)
 * @param {string} query - The user query
 * @param {StreamCallbacks} callbacks - Event callbacks
 * @param {Object} [options] - Additional fetch options
 * @returns {Object} Controller with abort() method
 */
export function createFetchStream(query, callbacks, options = {}) {
  const abortController = new AbortController();
  let fullText = '';

  const {
    onChunk,
    onStart,
    onComplete,
    onError,
    onMetadata,
  } = callbacks;

  function processSSELine(line) {
    if (!line.startsWith('data: ')) return;
    const dataStr = line.slice(6);
    try {
      const data = JSON.parse(dataStr);
      if (data.type === 'chunk' && data.text) {
        fullText += data.text;
        onChunk(data.text);
      } else if (data.type === 'done') {
        addMessage('assistant', fullText);
        if (onComplete) onComplete(fullText);
      } else if (data.type === 'error') {
        if (onError) onError(new Error(data.message || 'Stream error'));
      } else if (data.type === 'metadata' && onMetadata) {
        onMetadata(data);
      }
    } catch (e) {
      // Plain text data
      fullText += dataStr;
      onChunk(dataStr);
    }
  }

  async function run() {
    const baseUrl = getAPIEndpoint('recommender');
    const path = getStreamPath();
    const contextSummary = getContextSummary();

    try {
      const response = await fetch(`${baseUrl}/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          query,
          path,
          context: contextSummary,
          ...options.body,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Stream request failed: ${response.status} ${response.statusText}`);
      }

      if (onStart) onStart();

      addMessage('user', query);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(processSSELine);
      }

      // If we finished without a 'done' event, complete now
      if (fullText && onComplete) {
        addMessage('assistant', fullText);
        onComplete(fullText);
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (onError) onError(e);
    }
  }

  run();

  return {
    abort() {
      abortController.abort();
    },
    isActive() {
      return !abortController.signal.aborted;
    },
  };
}

// ============================================
// DOM Rendering Helpers
// ============================================

/**
 * Create a streaming text renderer that appends chunks to a DOM element
 * @param {Element} container - The DOM element to render into
 * @param {Object} [options] - Rendering options
 * @param {boolean} [options.markdown=false] - Whether to parse markdown
 * @param {string} [options.cursorClass='stream-cursor'] - CSS class for the typing cursor
 * @returns {StreamCallbacks} Callbacks to pass to createStream or createFetchStream
 */
export function createDOMRenderer(container, options = {}) {
  const { cursorClass = 'stream-cursor' } = options;
  let cursor = null;

  function ensureCursor() {
    if (!cursor) {
      cursor = document.createElement('span');
      cursor.className = cursorClass;
      cursor.setAttribute('aria-hidden', 'true');
      container.appendChild(cursor);
    }
  }

  function removeCursor() {
    if (cursor && cursor.parentNode) {
      cursor.parentNode.removeChild(cursor);
      cursor = null;
    }
  }

  return {
    onStart() {
      container.textContent = '';
      ensureCursor();
    },
    onChunk(text) {
      // Insert text before the cursor
      const textNode = document.createTextNode(text);
      if (cursor && cursor.parentNode) {
        cursor.parentNode.insertBefore(textNode, cursor);
      } else {
        container.appendChild(textNode);
        ensureCursor();
      }
    },
    onComplete() {
      removeCursor();
      container.classList.add('stream-complete');
    },
    onError(error) {
      removeCursor();
      container.classList.add('stream-error');
      // eslint-disable-next-line no-console
      console.error('[Arco] Stream rendering error:', error);
    },
  };
}
