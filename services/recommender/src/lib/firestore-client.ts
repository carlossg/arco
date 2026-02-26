/**
 * Firestore Client - Session and Analytics storage
 *
 * Replaces Cloudflare KV with Firestore Native mode.
 * Uses Application Default Credentials (passwordless auth).
 */

import type { SessionContext } from '../types';

/**
 * Firestore Session Manager
 * Stores user session data with TTL (30 days)
 */
export class FirestoreSessionManager {
  private projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  /**
   * Get Firestore instance (lazy initialization)
   */
  private async getFirestore() {
    const { Firestore } = await import('@google-cloud/firestore');

    // Initialize with ADC - no credentials needed
    return new Firestore({
      projectId: this.projectId,
    });
  }

  /**
   * Store session context
   */
  async putSession(sessionId: string, context: SessionContext): Promise<void> {
    const firestore = await this.getFirestore();

    try {
      // Calculate TTL expiration (30 days)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await firestore.collection('sessions').doc(sessionId).set({
        ...context,
        expiresAt,
        updatedAt: new Date(),
      });

      console.log(`[Firestore] Stored session: ${sessionId}`);
    } catch (error) {
      console.error('[Firestore] putSession error:', error);
      throw error;
    }
  }

  /**
   * Retrieve session context
   */
  async getSession(sessionId: string): Promise<SessionContext | null> {
    const firestore = await this.getFirestore();

    try {
      const doc = await firestore.collection('sessions').doc(sessionId).get();

      if (!doc.exists) {
        return null;
      }

      const data = doc.data();
      if (!data) {
        return null;
      }

      // Check if expired
      if (data.expiresAt && data.expiresAt.toDate() < new Date()) {
        // Expired - delete it
        await this.deleteSession(sessionId);
        return null;
      }

      return {
        sessionId: data.sessionId,
        sessionStart: data.sessionStart,
        previousQueries: data.previousQueries || [],
      };
    } catch (error) {
      console.error('[Firestore] getSession error:', error);
      return null;
    }
  }

  /**
   * Delete session
   */
  async deleteSession(sessionId: string): Promise<void> {
    const firestore = await this.getFirestore();

    try {
      await firestore.collection('sessions').doc(sessionId).delete();
      console.log(`[Firestore] Deleted session: ${sessionId}`);
    } catch (error) {
      console.error('[Firestore] deleteSession error:', error);
    }
  }
}

/**
 * Firestore Analytics Manager
 * Stores analytics events with BigQuery export
 */
export class FirestoreAnalyticsManager {
  private projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  /**
   * Get Firestore instance
   */
  private async getFirestore() {
    const { Firestore } = await import('@google-cloud/firestore');
    return new Firestore({ projectId: this.projectId });
  }

  /**
   * Track query event
   */
  async trackQuery(event: {
    sessionId: string;
    query: string;
    intent: any;
    blocks: string[];
    timestamp: number;
  }): Promise<void> {
    const firestore = await this.getFirestore();

    try {
      await firestore.collection('analytics_events').add({
        type: 'query',
        ...event,
        createdAt: new Date(),
      });
    } catch (error) {
      console.error('[Firestore] trackQuery error:', error);
    }
  }

  /**
   * Track session start
   */
  async trackSessionStart(sessionId: string): Promise<void> {
    const firestore = await this.getFirestore();

    try {
      await firestore.collection('analytics_sessions').doc(sessionId).set({
        sessionId,
        startedAt: new Date(),
        queryCount: 0,
      });
    } catch (error) {
      console.error('[Firestore] trackSessionStart error:', error);
    }
  }

  /**
   * Increment session query count
   */
  async incrementSessionQueryCount(sessionId: string): Promise<void> {
    const firestore = await this.getFirestore();

    try {
      const { FieldValue } = await import('@google-cloud/firestore');

      await firestore
        .collection('analytics_sessions')
        .doc(sessionId)
        .update({
          queryCount: FieldValue.increment(1),
          lastActivityAt: new Date(),
        });
    } catch (error) {
      console.error('[Firestore] incrementSessionQueryCount error:', error);
    }
  }
}

/**
 * Create Firestore session manager
 */
export function createFirestoreSessionManager(projectId: string): FirestoreSessionManager {
  return new FirestoreSessionManager(projectId);
}

/**
 * Create Firestore analytics manager
 */
export function createFirestoreAnalyticsManager(projectId: string): FirestoreAnalyticsManager {
  return new FirestoreAnalyticsManager(projectId);
}
