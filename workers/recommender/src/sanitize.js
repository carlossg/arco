/**
 * HTML sanitization — strips dangerous content from AI-generated HTML.
 */

const DANGEROUS_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select'];
const DANGEROUS_ATTRS = /^on\w+|formaction/i;
const DANGEROUS_URLS = /^\s*javascript:/i;

/**
 * Sanitizes HTML string by removing dangerous tags, attributes, and URLs.
 */
export default function sanitizeHTML(html) {
  // Remove dangerous tags and their content
  let clean = html;
  DANGEROUS_TAGS.forEach((tag) => {
    const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    clean = clean.replace(regex, '');
    // Also remove self-closing variants
    const selfClose = new RegExp(`<${tag}[^>]*\\/?>`, 'gi');
    clean = clean.replace(selfClose, '');
  });

  // Remove dangerous attributes (event handlers)
  clean = clean.replace(/<([a-z][a-z0-9]*)\s+([^>]*?)>/gi, (match, tag, attrs) => {
    const cleanAttrs = attrs.replace(/([a-z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, (attrMatch, name, value) => {
      if (DANGEROUS_ATTRS.test(name)) return '';
      // Check for javascript: URLs in href/src/action
      if (/^(href|src|action)$/i.test(name) && DANGEROUS_URLS.test(value.replace(/["']/g, ''))) {
        return '';
      }
      return attrMatch;
    });
    return `<${tag} ${cleanAttrs.trim()}>`;
  });

  // Remove style attributes that could contain expressions
  clean = clean.replace(/\bstyle\s*=\s*"[^"]*expression\s*\([^"]*"/gi, '');
  clean = clean.replace(/\bstyle\s*=\s*'[^']*expression\s*\([^']*'/gi, '');

  return clean;
}
