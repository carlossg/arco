/**
 * Section-metadata processor — shared by live streaming (scripts/scripts.js)
 * and stored-run replay (blocks/admin/admin.js) so they render identically.
 *
 * An EDS section may contain a `div.section-metadata` child whose children are
 * key/value rows. The `style` key is applied as classes on the section; every
 * other key is copied to `section.dataset.<camelCase>`. The metadata element
 * is removed from the DOM after processing.
 */
// eslint-disable-next-line import/prefer-default-export
export function processSectionMetadata(section) {
  const meta = section.querySelector('div.section-metadata');
  if (!meta) return;
  [...meta.querySelectorAll(':scope > div')].forEach((row) => {
    const cols = [...row.children];
    if (cols.length < 2) return;
    const key = cols[0].textContent.trim().toLowerCase();
    const val = cols[1].textContent.trim();
    if (key === 'style') {
      val.split(',').filter(Boolean).forEach((style) => {
        section.classList.add(style.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      });
      return;
    }
    const camel = key.replace(/[^a-z0-9]+/g, '-').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    section.dataset[camel] = val;
  });
  meta.remove();
}
