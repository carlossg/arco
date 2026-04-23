/**
 * JSON-to-EDS Converter
 *
 * Converts structured JSON block definitions into pre-decoration EDS HTML.
 * The output matches what AEM's markdown-to-HTML transformer produces:
 * nested div structure that decorateMain() → decorateSections() → decorateBlocks()
 * → loadBlock() → block decorators expect as input.
 */

/**
 * Escape HTML special characters to prevent XSS from LLM text content.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize a string for use as a CSS class name.
 * Only allows lowercase alphanumeric and hyphens.
 */
function toSafeClass(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/**
 * Convert a single content item to HTML.
 */
function contentItemToHtml(item) {
  if (!item || !item.type) return '';

  switch (item.type) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `<${item.type}>${escapeHtml(item.text)}</${item.type}>`;

    case 'p':
      return `<p>${escapeHtml(item.text)}</p>`;

    case 'image':
      // Token string — resolved later by images.js
      return item.token || '';

    case 'token':
      // Content token — expands to multi-element HTML via images.js
      return item.value || '';

    case 'link': {
      const href = escapeHtml(item.href || '#');
      const text = escapeHtml(item.text);
      const anchor = `<a href="${href}">${text}</a>`;

      switch (item.style) {
        case 'primary':
          return `<p><strong>${anchor}</strong></p>`;
        case 'accent':
          return `<p><strong><em>${anchor}</em></strong></p>`;
        case 'text':
          return `<p><em>${anchor}</em></p>`;
        case 'outline':
        default:
          return `<p>${anchor}</p>`;
      }
    }

    case 'ul':
      if (!Array.isArray(item.items)) return '';
      return `<ul>${item.items.map((li) => `<li>${escapeHtml(li)}</li>`).join('')}</ul>`;

    case 'ol':
      if (!Array.isArray(item.items)) return '';
      return `<ol>${item.items.map((li) => `<li>${escapeHtml(li)}</li>`).join('')}</ol>`;

    case 'blockquote': {
      let bq = `<blockquote><p>${escapeHtml(item.text)}</p>`;
      if (item.attribution) {
        bq += `<p><strong>${escapeHtml(item.attribution)}</strong></p>`;
      }
      bq += '</blockquote>';
      return bq;
    }

    case 'strong':
      return `<p><strong>${escapeHtml(item.text)}</strong></p>`;

    case 'hr':
      return '<hr>';

    default:
      // Unknown type — fallback to paragraph
      console.warn(`[json-to-eds] Unknown content item type: ${item.type}`);
      return item.text ? `<p>${escapeHtml(item.text)}</p>` : '';
  }
}

/**
 * Convert a cell (array of content items) to HTML.
 */
function cellToHtml(cell) {
  // Normalize: bare content item object → wrap in array
  if (cell && !Array.isArray(cell) && cell.type) return contentItemToHtml(cell);
  if (!Array.isArray(cell)) return '';
  return cell.map(contentItemToHtml).join('\n');
}

/**
 * Convert section metadata to EDS section-metadata block HTML.
 */
function sectionMetaToHtml(meta) {
  if (!meta || typeof meta !== 'object') return '';

  const rows = [];
  if (meta.style) {
    rows.push(`    <div>\n      <div>style</div>\n      <div>${escapeHtml(meta.style)}</div>\n    </div>`);
  }
  if (meta.collapse) {
    rows.push(`    <div>\n      <div>collapse</div>\n      <div>${escapeHtml(meta.collapse)}</div>\n    </div>`);
  }
  if (meta.background) {
    rows.push(`    <div>\n      <div>background</div>\n      <div>${escapeHtml(meta.background)}</div>\n    </div>`);
  }

  if (rows.length === 0) return '';

  return `\n<div class="section-metadata">\n${rows.join('\n')}\n</div>`;
}

/**
 * A row is heading-only when its single cell contains only heading items.
 * The testimonials block-guide tells the LLM to emit such a row as the section
 * label, but testimonials.js doesn't treat it specially — it becomes a card
 * with no quote. Stripping these rows prevents that.
 */
function isHeadingOnlyRow(row) {
  if (!Array.isArray(row) || row.length !== 1) return false;
  const cell = row[0];
  if (!Array.isArray(cell) || cell.length === 0) return false;
  return cell.every((item) => item && /^h[1-6]$/.test(item.type));
}

/**
 * Is this a substantive quote paragraph? Rating digits (1–5), attribution
 * lines ("Purchased: …"), and star-only paragraphs are skeleton fragments,
 * not the actual quote.
 */
function isQuoteParagraph(item) {
  if (!item || item.type !== 'p') return false;
  const text = (item.text || '').trim();
  if (!text) return false;
  if (/^[1-5]$/.test(text)) return false;
  if (/^[★☆\s]+$/.test(text)) return false;
  if (/^purchased:/i.test(text)) return false;
  return true;
}

/**
 * Does a testimonial row carry a real quote?
 */
function testimonialRowHasQuote(row) {
  if (!Array.isArray(row)) return false;
  return row.some((cell) => Array.isArray(cell) && cell.some(isQuoteParagraph));
}

/**
 * Strip empty testimonial rows and drop the section entirely when nothing useful
 * remains. Returns the cleaned section, or null to signal "skip this section".
 */
function sanitizeTestimonialsSection(section) {
  const kept = section.rows.filter((row) => (
    isHeadingOnlyRow(row) || testimonialRowHasQuote(row)
  ));
  const testimonialCount = kept.filter(testimonialRowHasQuote).length;
  if (testimonialCount === 0) return null;
  return { ...section, rows: kept };
}

/**
 * Post-generation sanity check for block content. Strips malformed rows
 * (e.g. empty testimonials) and returns null to signal the whole section
 * should be skipped. Extend per-block as new cases show up.
 */
export function sanitizeBlockContent(section) {
  if (!section || !Array.isArray(section.rows)) return section;
  if (section.block === 'testimonials') return sanitizeTestimonialsSection(section);
  return section;
}

/**
 * Convert a JSON section object to pre-decoration EDS HTML string.
 *
 * Produces the same nested-div structure that AEM's transformer would:
 *   <div class="blockname variant1 variant2">
 *     <div>          ← row
 *       <div>...</div>  ← cell
 *       <div>...</div>  ← cell
 *     </div>
 *   </div>
 *
 * @param {Object} section - JSON section object with block, rows, variants, meta
 * @returns {string} HTML string
 */
// eslint-disable-next-line import/prefer-default-export
export function sectionToHtml(section) {
  if (!section || !section.block) {
    console.warn('[json-to-eds] Section missing block name:', section);
    return '';
  }

  const blockName = toSafeClass(section.block);
  const variants = Array.isArray(section.variants)
    ? section.variants.map(toSafeClass).filter(Boolean)
    : [];
  const className = [blockName, ...variants].join(' ');

  // Emit data-* attributes from section.data (e.g. {"recommended":"X"} → data-recommended="X")
  const dataAttrs = section.data
    ? Object.entries(section.data)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => ` data-${toSafeClass(k)}="${String(v).replace(/"/g, '&quot;')}"`)
      .join('')
    : '';

  let html = `<div class="${className}"${dataAttrs}>`;

  if (Array.isArray(section.rows)) {
    section.rows.forEach((row) => {
      if (!Array.isArray(row)) return;

      // Token-only row: single cell with a single token item.
      // Token items ({{product:ID}}, {{recipe:Name}}) resolve to full row HTML
      // with their own div structure, so we emit them without cell/row wrapping.
      if (row.length === 1 && row[0].length === 1 && row[0][0].type === 'token') {
        html += `\n  ${row[0][0].value || ''}`;
        return;
      }

      html += '\n  <div>';
      row.forEach((cell) => {
        const cellContent = cellToHtml(cell);
        html += `\n    <div>${cellContent}</div>`;
      });
      html += '\n  </div>';
    });
  }

  html += '\n</div>';

  // Append section metadata if present
  html += sectionMetaToHtml(section.meta);

  return html;
}
