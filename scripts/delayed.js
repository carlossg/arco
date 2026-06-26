import { collectBrowsingSignals } from './browsing-signals.js';
import { initForYouPrefetch } from './for-you-prefetch.js';
import { initContextInspector } from './context-inspector.js';

collectBrowsingSignals();
initForYouPrefetch();
initContextInspector();
