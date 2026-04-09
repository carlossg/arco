/**
 * Persona Match Step — matches query against persona trigger phrases.
 * Writes ctx.rag.persona.
 */

import { matchPersona } from '../../context.js';

// eslint-disable-next-line import/prefer-default-export
export async function personaMatch(ctx) {
  const start = Date.now();
  ctx.rag.persona = matchPersona(ctx.request.query);
  ctx.timings.persona = Date.now() - start;
}
