/*
 * Quiz Block — 4-Question Persona Identification Quiz
 * Interactive multi-step quiz using the 6-persona scoring system.
 * Sets arco_persona cookie (90 days) and redirects to experience page.
 */

/**
 * 6 persona tags matching personalization/persona-profiles.json
 */
const PERSONAS = [
  'morning-minimalist',
  'upgrader',
  'craft-barista',
  'traveller',
  'non-barista',
  'office-manager',
];

/**
 * Scoring matrix: [question][option][persona scores]
 * Persona order: morning-minimalist(0), upgrader(1), craft-barista(2),
 *                traveller(3), non-barista(4), office-manager(5)
 */
const SCORING = [
  // Q1: "When do you usually have your first coffee?"
  [
    [2, 0, 0, 0, 1, 0], // Before 7am
    [1, 1, 0, 0, 0, 0], // 7–9am
    [0, 0, 1, 1, 0, 0], // After 9am
    [0, 0, 0, 0, 2, 0], // "I lose track"
  ],
  // Q2: "How do you feel about the brewing process?"
  [
    [1, 0, 0, 0, 2, 0], // "I want it fast"
    [2, 1, 0, 0, 0, 0], // "I enjoy the ritual"
    [0, 1, 2, 0, 0, 0], // "I want to master it"
    [0, 0, 0, 0, 2, 1], // "I just want it to work"
  ],
  // Q3: "Where do you mostly brew?"
  [
    [1, 1, 0, 0, 0, 0], // Home kitchen
    [1, 0, 0, 0, 1, 0], // Home office
    [0, 0, 0, 3, 0, 0], // Travelling
    [0, 0, 0, 0, 0, 3], // At the office
  ],
  // Q4: "What's your current setup?"
  [
    [1, 0, 0, 0, 1, 0], // No machine yet
    [0, 1, 0, 0, 2, 0], // A capsule/pod machine
    [0, 2, 1, 0, 0, 0], // A basic espresso machine
    [0, 0, 3, 0, 0, 0], // A proper espresso setup
  ],
];

/**
 * Maps persona tag to experience page slug.
 */
const RESULT_PAGES = {
  'morning-minimalist': '/experiences/core/morning-minimalist',
  upgrader: '/experiences/core/the-upgrade-path',
  'craft-barista': '/experiences/core/craft-at-home',
  traveller: '/experiences/core/espresso-anywhere',
  'non-barista': '/experiences/core/the-non-barista',
  'office-manager': '/experiences/core/the-non-barista',
};

/**
 * Parses authored block rows into an array of question objects.
 * Each row has two cells: question text and comma-separated (or paragraph-separated) options.
 * @param {Element} block The quiz block element
 * @returns {Array<{text: string, options: string[]}>}
 */
function parseQuestions(block) {
  const rows = [...block.querySelectorAll(':scope > div')];
  return rows.map((row) => {
    const cells = [...row.querySelectorAll(':scope > div')];
    const text = cells[0]?.textContent.trim() || '';
    const optionCell = cells[1];
    let options = [];

    if (optionCell) {
      const paragraphs = [...optionCell.querySelectorAll('p')];
      if (paragraphs.length > 1) {
        options = paragraphs.map((p) => p.textContent.trim()).filter(Boolean);
      } else {
        options = optionCell.textContent
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);
      }
    }

    return { text, options };
  });
}

/**
 * Calculates the winning persona from answer indices using the scoring matrix.
 * @param {number[]} answers Array of selected option indices (0-based)
 * @returns {string} The winning persona tag
 */
function calculatePersona(answers) {
  const scores = [0, 0, 0, 0, 0, 0];

  answers.forEach((answerIndex, questionIndex) => {
    if (questionIndex < SCORING.length && answerIndex >= 0) {
      const questionScoring = SCORING[questionIndex];
      const optionScoring = questionScoring[Math.min(answerIndex, questionScoring.length - 1)];
      optionScoring.forEach((points, personaIndex) => {
        scores[personaIndex] += points;
      });
    }
  });

  let maxScore = 0;
  let winnerIndex = 0;
  scores.forEach((score, index) => {
    if (score > maxScore) {
      maxScore = score;
      winnerIndex = index;
    }
  });

  return PERSONAS[winnerIndex];
}

/**
 * Sets a cookie with the given name, value, and expiry in days.
 * @param {string} name Cookie name
 * @param {string} value Cookie value
 * @param {number} days Days until expiry
 */
function setCookie(name, value, days) {
  const date = new Date();
  date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${date.toUTCString()};path=/;SameSite=Lax`;
}

/**
 * Renders a single question step into the quiz container.
 * @param {Element} container The quiz inner container
 * @param {object} question The question object { text, options }
 * @param {number} index Current question index (0-based)
 * @param {number} total Total number of questions
 * @param {Function} onAnswer Callback when an option is selected
 */
function renderQuestion(container, question, index, total, onAnswer) {
  container.setAttribute('aria-live', 'polite');

  // Progress indicator
  const progress = document.createElement('div');
  progress.className = 'quiz-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuenow', index + 1);
  progress.setAttribute('aria-valuemin', 1);
  progress.setAttribute('aria-valuemax', total);
  progress.setAttribute('aria-label', `Question ${index + 1} of ${total}`);

  const progressTrack = document.createElement('div');
  progressTrack.className = 'quiz-progress-track';
  const progressFill = document.createElement('div');
  progressFill.className = 'quiz-progress-fill';
  progressFill.style.width = `${((index + 1) / total) * 100}%`;
  progressTrack.append(progressFill);

  const progressLabel = document.createElement('span');
  progressLabel.className = 'quiz-progress-label';
  progressLabel.textContent = `${index + 1} of ${total}`;

  progress.append(progressTrack, progressLabel);

  // Question text
  const heading = document.createElement('h3');
  heading.className = 'quiz-question';
  heading.id = `quiz-question-${index}`;
  heading.textContent = question.text;

  // Options grid
  const optionsGrid = document.createElement('div');
  optionsGrid.className = 'quiz-options';
  optionsGrid.setAttribute('role', 'group');
  optionsGrid.setAttribute('aria-labelledby', heading.id);

  question.options.forEach((option, optIdx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quiz-option';
    btn.textContent = option;
    btn.setAttribute('aria-label', `${option} — option ${optIdx + 1} of ${question.options.length}`);
    btn.addEventListener('click', () => {
      optionsGrid.querySelectorAll('.quiz-option').forEach((b) => {
        b.classList.remove('quiz-option-selected');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('quiz-option-selected');
      btn.setAttribute('aria-pressed', 'true');

      optionsGrid.querySelectorAll('.quiz-option').forEach((b) => {
        b.disabled = true;
      });

      setTimeout(() => onAnswer(optIdx), 400);
    });
    btn.setAttribute('aria-pressed', 'false');
    optionsGrid.append(btn);
  });

  // Build the step
  const step = document.createElement('div');
  step.className = 'quiz-step';
  step.append(progress, heading, optionsGrid);

  // Transition: fade out old content, fade in new
  const existing = container.querySelector('.quiz-step');
  if (existing) {
    existing.classList.add('quiz-step-exit');
    setTimeout(() => {
      existing.remove();
      step.classList.add('quiz-step-enter');
      container.append(step);
      requestAnimationFrame(() => {
        step.classList.remove('quiz-step-enter');
      });
    }, 300);
  } else {
    container.append(step);
  }
}

/**
 * Loads and decorates the quiz block.
 * @param {Element} block The quiz block element
 */
export default async function decorate(block) {
  const questions = parseQuestions(block);

  if (questions.length === 0) return;

  // Clear authored content
  block.textContent = '';

  // Create inner container for transitions
  const container = document.createElement('div');
  container.className = 'quiz-container';
  block.append(container);

  const answers = [];
  const total = questions.length;

  const showQuestion = (index) => {
    renderQuestion(container, questions[index], index, total, (optIdx) => {
      answers.push(optIdx);

      if (index + 1 < total) {
        showQuestion(index + 1);
      } else {
        // Quiz complete — calculate persona using 6-persona scoring
        const persona = calculatePersona(answers);
        // Set both cookies: the new arco_persona (90 days) and legacy arco-brew-style (30 days)
        setCookie('arco_persona', persona, 90);
        setCookie('arco-brew-style', persona, 30);
        // Redirect to experience page
        const resultUrl = RESULT_PAGES[persona] || '/experiences/core/morning-minimalist';
        window.location.href = resultUrl;
      }
    });
  };

  showQuestion(0);
}
