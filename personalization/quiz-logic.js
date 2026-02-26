/**
 * Quiz Logic — 4-question persona identification quiz
 * Implements the 6-persona scoring system for Arco personalization.
 * Vanilla ES6+, no framework dependencies.
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
 * Scoring matrix: each question has options, each option awards points to personas.
 * Index: [personaIndex] = points
 * Persona order: morning-minimalist(0), upgrader(1), craft-barista(2), traveller(3), non-barista(4), office-manager(5)
 */
const SCORING = [
  // Q1: "When do you usually have your first coffee?"
  [
    [2, 0, 0, 0, 1, 0], // a) Before 7am → +2 morning-minimalist, +1 non-barista
    [1, 1, 0, 0, 0, 0], // b) 7–9am → +1 morning-minimalist, +1 upgrader
    [0, 0, 1, 1, 0, 0], // c) After 9am → +1 craft-barista, +1 traveller
    [0, 0, 0, 0, 2, 0], // d) "I lose track" → +2 non-barista
  ],
  // Q2: "How do you feel about the brewing process?"
  [
    [1, 0, 0, 0, 2, 0], // a) "I want it fast" → +2 non-barista, +1 morning-minimalist
    [2, 1, 0, 0, 0, 0], // b) "I enjoy the ritual" → +2 morning-minimalist, +1 upgrader
    [0, 1, 2, 0, 0, 0], // c) "I want to master it" → +2 craft-barista, +1 upgrader
    [0, 0, 0, 0, 2, 1], // d) "I just want it to work" → +2 non-barista, +1 office-manager
  ],
  // Q3: "Where do you mostly brew?"
  [
    [1, 1, 0, 0, 0, 0], // a) Home kitchen → +1 morning-minimalist, +1 upgrader
    [1, 0, 0, 0, 1, 0], // b) Home office → +1 morning-minimalist, +1 non-barista
    [0, 0, 0, 3, 0, 0], // c) Travelling → +3 traveller
    [0, 0, 0, 0, 0, 3], // d) At the office → +3 office-manager
  ],
  // Q4: "What's your current setup?"
  [
    [1, 0, 0, 0, 1, 0], // a) No machine yet → +1 non-barista, +1 morning-minimalist
    [0, 1, 0, 0, 2, 0], // b) A capsule/pod machine → +2 non-barista, +1 upgrader
    [0, 2, 1, 0, 0, 0], // c) A basic espresso machine → +2 upgrader, +1 craft-barista
    [0, 0, 3, 0, 0, 0], // d) A proper espresso setup → +3 craft-barista
  ],
];

/**
 * Calculates the persona tag from an array of answer indices.
 * @param {number[]} answers Array of 4 answer indices (0-based)
 * @returns {string} The winning persona tag
 */
export function calculatePersona(answers) {
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

  // Find the highest-scoring persona
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
 * Returns the redirect URL for a given persona tag.
 * @param {string} personaTag The persona identifier
 * @returns {string} The experience page URL
 */
export function getResultPage(personaTag) {
  const slugMap = {
    'morning-minimalist': 'morning-minimalist',
    upgrader: 'the-upgrade-path',
    'craft-barista': 'craft-at-home',
    traveller: 'espresso-anywhere',
    'non-barista': 'the-non-barista',
    'office-manager': 'the-non-barista',
  };
  const slug = slugMap[personaTag] || 'morning-minimalist';
  return `/experiences/core/${slug}`;
}

/**
 * Sets the arco_persona cookie with a 90-day expiry.
 * @param {string} personaTag The persona identifier
 */
export function setPersonaCookie(personaTag) {
  const date = new Date();
  date.setTime(date.getTime() + 90 * 24 * 60 * 60 * 1000);
  document.cookie = `arco_persona=${encodeURIComponent(personaTag)};expires=${date.toUTCString()};path=/;SameSite=Lax`;
}

/**
 * Reads and returns the current persona tag from the cookie, or null.
 * @returns {string|null} The persona tag or null
 */
export function getPersonaFromCookie() {
  const match = document.cookie.match(/(?:^|;\s*)arco_persona=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}
