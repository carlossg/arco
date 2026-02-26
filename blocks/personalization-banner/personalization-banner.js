/**
 * Personalization Banner Block — slim top-of-page banner showing current persona.
 * Hidden for users without arco_persona cookie. Dismissible with session persistence.
 *
 * Authored content is ignored — the block auto-generates content from the persona cookie.
 * If the block has authored rows, they can override the persona display labels:
 *   Row N: Col 1 = persona-tag, Col 2 = display label
 */

const PERSONA_LABELS = {
  'morning-minimalist': 'The Morning Minimalist',
  upgrader: 'The Upgrader',
  'craft-barista': 'The Craft Barista',
  traveller: 'The Traveller',
  'non-barista': 'The Non-Barista',
  'office-manager': 'The Office Manager',
};

const PERSONA_TAGLINES = {
  'morning-minimalist': 'Your setup is tuned for calm mornings and quality without effort.',
  upgrader: 'We\'re showing you content for someone ready to level up their setup.',
  'craft-barista': 'Advanced content and pro-level equipment, just for you.',
  traveller: 'Portable gear and travel guides, prioritized for you.',
  'non-barista': 'Simple setups and zero-effort solutions, just the way you like it.',
  'office-manager': 'Volume equipment and ROI tools, tailored for your team.',
};

/**
 * Reads the arco_persona cookie.
 * @returns {string|null}
 */
function getPersona() {
  const match = document.cookie.match(/(?:^|;\s*)arco_persona=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Checks if the banner has been dismissed this session.
 * @returns {boolean}
 */
function isDismissed() {
  try {
    return sessionStorage.getItem('arco_banner_dismissed') === 'true';
  } catch {
    return false;
  }
}

export default async function decorate(block) {
  const persona = getPersona();

  // Parse any authored label overrides
  const overrides = {};
  [...block.children].forEach((row) => {
    const cols = [...row.children];
    const key = cols[0]?.textContent.trim().toLowerCase();
    const value = cols[1]?.textContent.trim();
    if (key && value) overrides[key] = value;
  });

  block.replaceChildren();

  // Don't show if no persona or dismissed
  if (!persona || isDismissed()) {
    block.style.display = 'none';
    return;
  }

  const label = overrides[persona] || PERSONA_LABELS[persona] || persona;
  const tagline = PERSONA_TAGLINES[persona] || '';

  // Banner content
  const inner = document.createElement('div');
  inner.className = 'personalization-banner-inner';

  const text = document.createElement('div');
  text.className = 'personalization-banner-text';

  const personaLabel = document.createElement('span');
  personaLabel.className = 'personalization-banner-persona';
  personaLabel.textContent = label;
  text.append(personaLabel);

  if (tagline) {
    const taglineEl = document.createElement('span');
    taglineEl.className = 'personalization-banner-tagline';
    taglineEl.textContent = tagline;
    text.append(taglineEl);
  }

  inner.append(text);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'personalization-banner-actions';

  const retake = document.createElement('a');
  retake.href = '#quiz';
  retake.className = 'personalization-banner-retake';
  retake.textContent = 'Retake Quiz';
  retake.addEventListener('click', (e) => {
    e.preventDefault();
    const quizSection = document.querySelector('.quiz');
    if (quizSection) {
      quizSection.scrollIntoView({ behavior: 'smooth' });
    } else {
      window.location.href = '/#quiz';
    }
  });
  actions.append(retake);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'personalization-banner-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss personalization banner');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => {
    block.classList.add('personalization-banner-hiding');
    setTimeout(() => {
      block.style.display = 'none';
      try {
        sessionStorage.setItem('arco_banner_dismissed', 'true');
      } catch {
        // silent
      }
    }, 300);
  });
  actions.append(dismiss);

  inner.append(actions);
  block.append(inner);
}
