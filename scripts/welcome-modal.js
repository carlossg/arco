import { loadCSS } from './aem.js';
import { SessionContextManager } from './session-context.js';

const STORAGE_KEY = 'arco-welcome-shown';

const FEATURES = [
  {
    title: 'For You',
    desc: 'Browse products and stories and a personalized "For You" button will appear in the navigation bar — curated picks based on your activity.',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74z"/>
      <circle cx="12" cy="10" r="0"/>
    </svg>`,
  },
  {
    title: 'Ask Anything',
    desc: 'Use the search bar to ask a question about coffee or equipment and get a custom page built just for you.',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
    </svg>`,
  },
  {
    title: 'Keep Exploring',
    desc: 'On any recommendation page, tap "Keep Exploring" to load more content tailored to your interests.',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>
    </svg>`,
  },
];

function createDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'welcome-modal';
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Welcome to Arco');

  const featureItems = FEATURES.map(({ title, desc, icon }) => `
    <li class="welcome-modal-feature">
      <div class="welcome-modal-feature-icon">${icon}</div>
      <p class="welcome-modal-feature-title">${title}</p>
      <p class="welcome-modal-feature-desc">${desc}</p>
    </li>
  `).join('');

  dialog.innerHTML = `
    <div class="welcome-modal-inner">
      <header class="welcome-modal-header">
        <p class="welcome-modal-eyebrow">Generative Experience</p>
        <h2 class="welcome-modal-title">Welcome to Arco</h2>
        <p class="welcome-modal-subtitle">This site adapts to your interests the more you explore.</p>
      </header>
      <ul class="welcome-modal-features">${featureItems}</ul>
      <div class="welcome-modal-cta">
        <button type="button">Start Exploring</button>
      </div>
    </div>
  `;

  const btn = dialog.querySelector('.welcome-modal-cta button');
  btn.addEventListener('click', () => dialog.close());

  dialog.addEventListener('close', () => {
    sessionStorage.setItem(STORAGE_KEY, '1');
    dialog.remove();
  });

  dialog.addEventListener('click', (e) => {
    const rect = dialog.getBoundingClientRect();
    const outside = e.clientX < rect.left || e.clientX > rect.right
      || e.clientY < rect.top || e.clientY > rect.bottom;
    if (outside) dialog.close();
  });

  return dialog;
}

export default function showWelcomeModal() {
  if (sessionStorage.getItem(STORAGE_KEY)) return;
  if (SessionContextManager.hasContext()) return;

  loadCSS(`${window.hlx.codeBasePath}/styles/welcome-modal.css`).then(() => {
    const dialog = createDialog();
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
