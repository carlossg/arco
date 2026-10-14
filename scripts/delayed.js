import { collectBrowsingSignals } from './browsing-signals.js';
import { initForYouPrefetch } from './for-you-prefetch.js';
import { initContextInspector } from './context-inspector.js';
import { initEventTracking } from './analytics-events.js';

collectBrowsingSignals();
initForYouPrefetch();
initContextInspector();
// Runs on every page (including /discover/ and ?q=), unlike the signal
// collector — conversion attribution has to span the whole journey.
initEventTracking();
