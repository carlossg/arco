import { Firestore, FieldValue } from '@google-cloud/firestore';
import { VertexAI } from '@google-cloud/vertexai';
import type { Request, Response } from '@google-cloud/functions-framework';

const firestore = new Firestore();
const COLLECTION = 'analytics_events';

const PROJECT_ID = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'arco-coffee';
const LOCATION = process.env.GCP_LOCATION || 'us-central1';

const vertexAI = new VertexAI({ project: PROJECT_ID, location: LOCATION });

function setCorsHeaders(res: Response): void {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
}

function handleCorsPreflght(req: Request, res: Response): boolean {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.status(204).send('');
    return true;
  }
  setCorsHeaders(res);
  return false;
}

/**
 * trackEvent - POST endpoint for event tracking.
 * Accepts: sessionId, eventType, query, intent, blocks[], metadata.
 * Stores events in Firestore `analytics_events` collection.
 */
export async function trackEvent(req: Request, res: Response): Promise<void> {
  if (handleCorsPreflght(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    const {
      sessionId,
      eventType,
      query,
      intent,
      blocks,
      metadata,
    } = req.body;

    if (!sessionId || !eventType) {
      res.status(400).json({ error: 'sessionId and eventType are required.' });
      return;
    }

    const event = {
      sessionId,
      eventType,
      query: query || null,
      intent: intent || null,
      blocks: blocks || [],
      metadata: metadata || {},
      timestamp: FieldValue.serverTimestamp(),
      source: 'arco-website',
    };

    const docRef = await firestore.collection(COLLECTION).add(event);

    res.status(200).json({
      success: true,
      eventId: docRef.id,
      message: 'Event tracked successfully.',
    });
  } catch (error) {
    console.error('Error tracking event:', error);
    res.status(500).json({ error: 'Failed to track event.' });
  }
}

/**
 * analyzeQueries - GET endpoint for query analysis using Gemini.
 * Reads recent analytics events and generates insights about user behavior,
 * popular products, and common intents.
 */
export async function analyzeQueries(req: Request, res: Response): Promise<void> {
  if (handleCorsPreflght(req, res)) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return;
  }

  try {
    const limit = parseInt(req.query.limit as string, 10) || 100;
    const daysBack = parseInt(req.query.days as string, 10) || 7;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);

    const snapshot = await firestore
      .collection(COLLECTION)
      .where('timestamp', '>=', cutoffDate)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    if (snapshot.empty) {
      res.status(200).json({
        insights: 'No recent analytics events found.',
        eventCount: 0,
      });
      return;
    }

    const events = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        eventType: data.eventType,
        query: data.query,
        intent: data.intent,
        blocks: data.blocks,
        timestamp: data.timestamp?.toDate?.()?.toISOString() || null,
      };
    });

    const queries = events
      .filter((e) => e.query)
      .map((e) => e.query);

    const intents = events
      .filter((e) => e.intent)
      .map((e) => e.intent);

    const eventTypes = events.map((e) => e.eventType);

    const prompt = `Analyze the following user interaction data from the Arco coffee equipment website and provide insights:

Event Types: ${JSON.stringify([...new Set(eventTypes)])}
User Queries (${queries.length} total): ${JSON.stringify(queries.slice(0, 50))}
User Intents (${intents.length} total): ${JSON.stringify(intents.slice(0, 50))}

Please provide:
1. Most popular products or categories users are interested in
2. Common user intents and what they're looking for
3. Brew guide topics that are most requested
4. Suggestions for content improvements based on user behavior
5. Any notable patterns or trends

Format the response as a structured JSON object with keys: popularProducts, commonIntents, brewGuideTopics, contentSuggestions, patterns.`;

    const model = vertexAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || 'No analysis generated.';

    let insights;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      insights = jsonMatch ? JSON.parse(jsonMatch[0]) : { rawAnalysis: text };
    } catch {
      insights = { rawAnalysis: text };
    }

    res.status(200).json({
      insights,
      eventCount: events.length,
      queryCount: queries.length,
      periodDays: daysBack,
    });
  } catch (error) {
    console.error('Error analyzing queries:', error);
    res.status(500).json({ error: 'Failed to analyze queries.' });
  }
}

/**
 * getSessionAnalytics - GET endpoint for session stats.
 * Returns aggregate stats or per-session breakdown.
 * Accepts optional sessionId query param.
 */
export async function getSessionAnalytics(req: Request, res: Response): Promise<void> {
  if (handleCorsPreflght(req, res)) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return;
  }

  try {
    const { sessionId } = req.query;

    if (sessionId) {
      // Per-session breakdown
      const snapshot = await firestore
        .collection(COLLECTION)
        .where('sessionId', '==', sessionId)
        .orderBy('timestamp', 'asc')
        .get();

      if (snapshot.empty) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }

      const events = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          eventId: doc.id,
          eventType: data.eventType,
          query: data.query,
          intent: data.intent,
          blocks: data.blocks,
          metadata: data.metadata,
          timestamp: data.timestamp?.toDate?.()?.toISOString() || null,
        };
      });

      const eventTypeCounts: Record<string, number> = {};
      events.forEach((e) => {
        eventTypeCounts[e.eventType] = (eventTypeCounts[e.eventType] || 0) + 1;
      });

      res.status(200).json({
        sessionId,
        totalEvents: events.length,
        eventTypeCounts,
        events,
        firstEvent: events[0]?.timestamp || null,
        lastEvent: events[events.length - 1]?.timestamp || null,
      });
    } else {
      // Aggregate stats
      const daysBack = parseInt(req.query.days as string, 10) || 7;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysBack);

      const snapshot = await firestore
        .collection(COLLECTION)
        .where('timestamp', '>=', cutoffDate)
        .orderBy('timestamp', 'desc')
        .get();

      const sessionMap: Record<string, number> = {};
      const eventTypeCounts: Record<string, number> = {};
      const intentCounts: Record<string, number> = {};

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        sessionMap[data.sessionId] = (sessionMap[data.sessionId] || 0) + 1;
        eventTypeCounts[data.eventType] = (eventTypeCounts[data.eventType] || 0) + 1;
        if (data.intent) {
          intentCounts[data.intent] = (intentCounts[data.intent] || 0) + 1;
        }
      });

      const totalSessions = Object.keys(sessionMap).length;
      const totalEvents = snapshot.size;
      const avgEventsPerSession = totalSessions > 0
        ? Math.round((totalEvents / totalSessions) * 100) / 100
        : 0;

      res.status(200).json({
        periodDays: daysBack,
        totalSessions,
        totalEvents,
        avgEventsPerSession,
        eventTypeCounts,
        intentCounts,
        topSessions: Object.entries(sessionMap)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([id, count]) => ({ sessionId: id, eventCount: count })),
      });
    }
  } catch (error) {
    console.error('Error getting session analytics:', error);
    res.status(500).json({ error: 'Failed to get session analytics.' });
  }
}
