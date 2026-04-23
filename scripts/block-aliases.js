/**
 * Alias map for LLM-generated block types.
 * Keys are block names that may appear in LLM output; values are either:
 *   - a string: the canonical block name to swap in
 *   - false:    strip the block wrapper entirely (render as default content)
 *
 * Shared by live streaming (scripts/scripts.js) and stored-run replay
 * (blocks/admin/admin.js) so both render identically.
 */
// eslint-disable-next-line import/prefer-default-export
export const BLOCK_ALIASES = {
  'use-case-cards': 'cards',
  'feature-highlights': 'cards',
  text: false,
  'how-to-steps': 'recipe-steps',
};
