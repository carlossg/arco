import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTrack } from '../../../workers/recommender/src/events.js';

test('Google event storage failures cannot return a successful tracking response', async () => {
  const request = new Request('https://demo.run.app/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: '96c49b94-444b-405c-ad22-d28a084bb9aa',
      events: [{ eventType: 'page_view', path: '/' }],
    }),
  });
  await assert.rejects(handleTrack(request, {
    GCP_STORAGE: {
      async persistEvents() { throw new Error('Firestore unavailable'); },
    },
  }), /Firestore unavailable/);
});
