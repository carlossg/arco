import { SessionContextManager } from './session-context.js';

export default function showExternalContext(report) {
  const panel = document.createElement('details');
  panel.className = 'external-context';
  const summary = document.createElement('summary');
  summary.textContent = report.errors.length
    ? 'Inspect incoming app context (validation warning)' : 'Inspect incoming app context';
  const note = document.createElement('p');
  note.textContent = 'This shows the context shared with Arco, not your full Gemini conversation. '
    + 'A link may load an expiring summary from Arco. Shared preferences are unverified inputs, not catalog facts.';
  const output = document.createElement('pre');
  let sentContext = null;
  const render = () => {
    output.textContent = JSON.stringify({
      ...report,
      attribution: Object.fromEntries([...new URLSearchParams(window.location.search)]
        .filter(([key]) => ['utm_source', 'utm_medium', 'utm_campaign'].includes(key))),
      generationContext: sentContext,
      currentSessionContext: SessionContextManager.buildContextParam(),
    }, null, 2);
  };
  window.addEventListener('arco-generation-context', (event) => {
    sentContext = event.detail;
    render();
  });
  panel.addEventListener('toggle', render);
  panel.append(summary, note, output);
  document.querySelector('main')?.before(panel);
  render();
}
