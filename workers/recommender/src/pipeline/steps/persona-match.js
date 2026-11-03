/**
 * Persona Match Step — matches query against persona trigger phrases.
 * When a quizPersona is present in the request context, it is used as an
 * authoritative override (more accurate than keyword matching). Otherwise
 * falls back to keyword matching against the query string.
 * Writes ctx.rag.persona.
 */

import { matchPersona, getPersonaBySlug } from '../../context.js';

// Maps client-side quiz persona IDs to worker persona slugs (data/metadata/personas.json)
const QUIZ_PERSONA_MAP = {
  'morning-minimalist': 'morning-minimalist',
  'non-barista': 'morning-minimalist', // automatico-first persona in worker data
  upgrader: 'upgrade-seeker',
  'craft-barista': 'craft-home-barista',
  traveller: 'traveling-professional',
  'office-manager': 'office-manager',
};

// eslint-disable-next-line import/prefer-default-export, no-unused-vars
export async function personaMatch(ctx, config = {}, env = {}) {
  const start = Date.now();

  const quizTag = ctx.request.quizPersona?.persona || ctx.request.quizPersona;
  if (quizTag) {
    const persona = getPersonaBySlug(QUIZ_PERSONA_MAP[quizTag] || quizTag);
    if (persona) {
      ctx.rag.persona = persona;
      ctx.timings.persona = Date.now() - start;
      return;
    }
  }

  ctx.rag.persona = matchPersona(ctx.request.query);
  ctx.timings.persona = Date.now() - start;
}
