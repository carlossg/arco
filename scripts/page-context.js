import { SessionContextManager } from './session-context.js';

const PATH_RULES = [
  { pattern: /^\/products\/espresso-machines\/[^/]+/, intent: 'product-detail', stage: 'comparing' },
  { pattern: /^\/products\/grinders\/[^/]+/, intent: 'product-detail', stage: 'comparing' },
  { pattern: /^\/stories\//, intent: 'technique', stage: 'exploring' },
  { pattern: /^\/experiences\//, intent: 'use-case', stage: 'exploring' },
  { pattern: /^\/support/, intent: 'support', stage: 'deciding' },
  { pattern: /^\/warranty/, intent: 'support', stage: 'deciding' },
];

export function classifyFromPath(pathname) {
  const matched = PATH_RULES.find((rule) => rule.pattern.test(pathname));
  if (matched) return { intent: matched.intent, stage: matched.stage };
  return { intent: 'discovery', stage: 'exploring' };
}

let recorded = false;

export function recordPageVisit(blocks) {
  const params = new URLSearchParams(window.location.search);
  if (params.has('q') || params.has('query') || window.location.pathname.startsWith('/discover/')) return;

  if (recorded) {
    if (blocks) SessionContextManager.updateLastPageVisit({ blocks });
    return;
  }
  const { intent, stage } = classifyFromPath(window.location.pathname);
  SessionContextManager.addPageVisit({
    path: window.location.pathname,
    title: document.title,
    blocks,
    intent,
    stage,
  });
  recorded = true;
}
