import { loadCSS } from './aem.js';
import { SessionContextManager } from './session-context.js';

const STORAGE_KEY = 'arco-welcome-shown';

const ALL_TIPS = [
  {
    id: 'foryou',
    desktopOnly: true,
    title: 'Your personalized feed',
    text: 'Browse a few pages and "For You" becomes active — a personalized feed curated from your activity.',
    alignRight: false,
    getTarget: () => document.querySelector('header .nav-foryou'),
    onActivate() {},
    onDeactivate() {},
  },
  {
    id: 'search',
    desktopOnly: false,
    title: 'Ask anything',
    text: 'Type a question — like "best grinder for pour-over" — and get a custom page built just for you, with recommendations matched to your interests.',
    alignRight: true,
    getTarget: () => document.querySelector('header .nav-search-form'),
    onActivate() {},
    onDeactivate() {},
  },
];

function buildCoachMarks(tips) {
  const scrim = document.createElement('div');
  scrim.className = 'coach-scrim';
  document.body.appendChild(scrim);

  const dots = [];
  const tooltips = [];
  let currentTip = -1;

  const TOOLTIP_WIDTH = 300;

  function positionTip(index) {
    const tip = tips[index];
    const target = tip.getTarget();
    if (!target) return;

    const rect = target.getBoundingClientRect();
    const dot = dots[index];
    const tooltip = tooltips[index];

    dot.style.left = `${rect.left + rect.width / 2 - 6}px`;
    dot.style.top = `${rect.bottom + 6}px`;

    let tooltipLeft = tip.alignRight
      ? Math.max(8, rect.right - TOOLTIP_WIDTH)
      : Math.max(8, rect.left - 20);
    tooltipLeft = Math.min(tooltipLeft, window.innerWidth - TOOLTIP_WIDTH - 8);

    tooltip.style.left = `${tooltipLeft}px`;
    tooltip.style.top = `${rect.bottom + 22}px`;
    tooltip.style.setProperty('--arrow-offset', `${Math.max(14, rect.left + rect.width / 2 - tooltipLeft - 7)}px`);
  }

  function dismiss() {
    if (currentTip >= 0) {
      tips[currentTip].onDeactivate(tips[currentTip].getTarget());
    }
    currentTip = -1;
    dots.forEach((d) => d.classList.add('hidden'));
    tooltips.forEach((t) => t.classList.remove('visible'));
    scrim.classList.remove('active');
    sessionStorage.setItem(STORAGE_KEY, '1');
  }

  function showTip(index) {
    if (currentTip >= 0) {
      tips[currentTip].onDeactivate(tips[currentTip].getTarget());
      dots[currentTip].classList.add('hidden');
      tooltips[currentTip].classList.remove('visible');
    }

    if (index < 0 || index >= tips.length) {
      dismiss();
      return;
    }

    currentTip = index;
    const tip = tips[index];
    tip.onActivate(tip.getTarget());
    positionTip(index);
    dots[index].classList.remove('hidden');
    tooltips[index].classList.add('visible');
    scrim.classList.add('active');
  }

  scrim.addEventListener('click', dismiss);

  tips.forEach((tip, index) => {
    const { isLast } = tip;

    const dot = document.createElement('div');
    dot.className = 'coach-dot hidden';
    dot.setAttribute('role', 'button');
    dot.setAttribute('tabindex', '0');
    dot.setAttribute('aria-label', `Show tip: ${tip.title}`);
    dot.addEventListener('click', (e) => { e.stopPropagation(); showTip(index); });
    document.body.appendChild(dot);
    dots.push(dot);

    const progressDots = tips.map((_, i) => `<span${i === index ? ' class="active"' : ''}></span>`).join('');
    const tooltip = document.createElement('div');
    tooltip.className = 'coach-tooltip';
    tooltip.innerHTML = `
      <div class="coach-tooltip-accent"></div>
      <div class="coach-tooltip-body">
        <div class="coach-tooltip-step">${tip.step}</div>
        <div class="coach-tooltip-title">${tip.title}</div>
        <div class="coach-tooltip-text">${tip.text}</div>
      </div>
      <div class="coach-tooltip-footer">
        <button class="coach-tooltip-dismiss" type="button">Dismiss</button>
        <div class="coach-tooltip-dots">${progressDots}</div>
        <button class="coach-tooltip-next" type="button">${isLast ? 'Got it <span aria-hidden="true">✓</span>' : 'Next <span aria-hidden="true">→</span>'}</button>
      </div>
    `;
    tooltip.querySelector('.coach-tooltip-dismiss').addEventListener('click', dismiss);
    tooltip.querySelector('.coach-tooltip-next').addEventListener('click', () => {
      if (isLast) dismiss();
      else showTip(index + 1);
    });
    document.body.appendChild(tooltip);
    tooltips.push(tooltip);
  });

  window.addEventListener('resize', () => { if (currentTip >= 0) positionTip(currentTip); });

  return { showTip };
}

export default function showWelcomeModal() {
  if (sessionStorage.getItem(STORAGE_KEY)) return;
  if (SessionContextManager.hasContext()) return;

  loadCSS(`${window.hlx.codeBasePath}/styles/welcome-modal.css`).then(() => {
    const isDesktop = window.matchMedia('(min-width: 900px)').matches;
    const tips = ALL_TIPS
      .filter((t) => !t.desktopOnly || isDesktop)
      .map((t, i, arr) => ({ ...t, step: `Tip ${i + 1} of ${arr.length}`, isLast: i === arr.length - 1 }));

    if (!tips.length) return;
    const marks = buildCoachMarks(tips);
    setTimeout(() => marks.showTip(0), 800);
  });
}
