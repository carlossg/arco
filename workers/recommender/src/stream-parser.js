/**
 * Incremental Stream Parser
 *
 * Watches LLM token stream for === boundaries and yields
 * complete JSON section objects as they are produced.
 */

/**
 * Parse a JSON string into a section or suggestions object.
 * Returns null if parsing fails.
 */
function tryParseJson(str) {
  const trimmed = str.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    console.warn('[StreamParser] Failed to parse JSON segment:', trimmed.substring(0, 100));
    return null;
  }
}

// eslint-disable-next-line import/prefer-default-export
export class StreamParser {
  constructor() {
    this.buffer = '';
  }

  /**
   * Feed a chunk of LLM output into the parser.
   * Returns an array of completed section objects (may be empty).
   *
   * @param {string} chunk - New text from the LLM stream
   * @returns {Object[]} Array of parsed section objects with `block` field
   */
  feed(chunk) {
    this.buffer += chunk;
    const sections = [];

    // Split on === separator (on its own line, tolerant of whitespace)
    const parts = this.buffer.split(/^===\s*$/m);

    // All parts except the last are complete segments
    for (let i = 0; i < parts.length - 1; i += 1) {
      const parsed = tryParseJson(parts[i]);
      if (parsed && parsed.block) {
        sections.push(parsed);
      }
      // Skip non-section objects (e.g. suggestions) during streaming —
      // they'll be picked up in finalize() if they're the last segment
    }

    // Keep the last (potentially incomplete) part in the buffer
    this.buffer = parts[parts.length - 1];

    return sections;
  }

  /**
   * Finalize parsing after the LLM stream ends.
   * Parses the remaining buffer and returns the last section and/or suggestions.
   *
   * @returns {{ section?: Object, suggestions?: Object[] }}
   */
  finalize() {
    const result = {};
    const trimmed = this.buffer.trim();

    if (!trimmed) return result;

    const parsed = tryParseJson(trimmed);
    if (!parsed) return result;

    if (parsed.block) {
      result.section = parsed;
    } else if (parsed.suggestions) {
      result.suggestions = parsed.suggestions;
    }

    this.buffer = '';
    return result;
  }
}
