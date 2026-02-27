/**
 * Vector Search Service — Firestore Native Vector Search + Vertex AI Embeddings
 *
 * Provides semantic search (RAG) over products, brew guides, and FAQs using:
 *   - Vertex AI text-embedding-005 for generating embeddings
 *   - Firestore native vector search (findNearest) for similarity queries
 *
 * Embeddings are stored in Firestore collections alongside metadata,
 * enabling cosine-distance nearest-neighbour lookups without an external
 * vector database.
 */

import { VertexAIClient } from '../ai-clients/vertex-ai-client';

// ============================================
// Types
// ============================================

/** Task type hint passed to the Vertex AI embeddings model. */
export type EmbeddingTaskType = 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT';

/** A single result returned from a vector similarity search. */
export interface VectorSearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, any>;
}

// ============================================
// Constants
// ============================================

/** Maximum texts per single embeddings API call. */
const EMBED_BATCH_SIZE = 100;

/** Firestore collection names for each entity type. */
const COLLECTIONS = {
  products: 'product_embeddings',
  brewGuides: 'brewguide_embeddings',
  faqs: 'faq_embeddings',
} as const;

// ============================================
// VectorSearchService
// ============================================

/**
 * Semantic vector search backed by Firestore native vector search
 * and Vertex AI text-embedding-005.
 *
 * Uses lazy Firestore initialisation (dynamic import) so the module
 * can be loaded without an immediate dependency on @google-cloud/firestore.
 */
export class VectorSearchService {
  private projectId: string;
  private location: string;
  private vertexClient: VertexAIClient;

  constructor(projectId: string, location: string = 'us-central1') {
    this.projectId = projectId;
    this.location = location;
    this.vertexClient = new VertexAIClient(projectId, location);
  }

  // ------------------------------------------
  // Firestore helpers (lazy init)
  // ------------------------------------------

  /**
   * Get a Firestore instance (lazy initialisation via dynamic import).
   * Mirrors the pattern used in firestore-client.ts.
   */
  private async getFirestore() {
    const { Firestore } = await import('@google-cloud/firestore');
    return new Firestore({ projectId: this.projectId });
  }

  /**
   * Get the FieldValue helper from the Firestore SDK.
   */
  private async getFieldValue() {
    const { FieldValue } = await import('@google-cloud/firestore');
    return FieldValue;
  }

  // ------------------------------------------
  // Embedding methods
  // ------------------------------------------

  /**
   * Embed a single text string.
   *
   * @param text - The text to embed.
   * @param taskType - Optional embedding task type hint (defaults to `'RETRIEVAL_QUERY'`).
   * @returns A single embedding vector (array of numbers).
   */
  async embedText(
    text: string,
    taskType: EmbeddingTaskType = 'RETRIEVAL_QUERY',
  ): Promise<number[]> {
    const embeddings = await this.vertexClient.generateEmbeddings([text], taskType);

    if (!embeddings || embeddings.length === 0) {
      throw new Error('[VectorSearch] Failed to generate embedding for text');
    }

    return embeddings[0];
  }

  /**
   * Embed multiple texts in batches.
   *
   * Vertex AI text-embedding-005 supports up to 250 texts per request,
   * but we chunk at 100 for reliability and memory reasons.
   *
   * @param texts - Array of texts to embed.
   * @param taskType - Optional embedding task type hint (defaults to `'RETRIEVAL_QUERY'`).
   * @returns Array of embedding vectors, one per input text.
   */
  async embedBatch(
    texts: string[],
    taskType: EmbeddingTaskType = 'RETRIEVAL_QUERY',
  ): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      const embeddings = await this.vertexClient.generateEmbeddings(batch, taskType);
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  // ------------------------------------------
  // Search
  // ------------------------------------------

  /**
   * Search for similar documents using Firestore native vector search.
   *
   * Uses `findNearest()` with cosine distance to find the most similar
   * documents in the specified collection.
   *
   * @param queryEmbedding - The query embedding vector.
   * @param collection - Firestore collection to search.
   * @param limit - Maximum number of results to return (defaults to 10).
   * @returns Array of search results sorted by similarity.
   */
  async searchSimilar(
    queryEmbedding: number[],
    collection: string,
    limit: number = 10,
  ): Promise<VectorSearchResult[]> {
    const firestore = await this.getFirestore();
    const FieldValue = await this.getFieldValue();

    const collectionRef = firestore.collection(collection);
    const vectorQuery = collectionRef.findNearest('embedding', FieldValue.vector(queryEmbedding), {
      limit,
      distanceMeasure: 'COSINE',
    });

    const snapshot = await vectorQuery.get();

    const results: VectorSearchResult[] = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      // Extract metadata (everything except content, embedding, and indexedAt)
      const { content, embedding, indexedAt, ...metadata } = data;

      results.push({
        id: doc.id,
        content: content || '',
        score: 0, // Firestore findNearest does not expose scores directly
        metadata,
      });
    });

    return results;
  }

  // ------------------------------------------
  // Indexing — single document
  // ------------------------------------------

  /**
   * Embed and store a single document in Firestore.
   *
   * The document is stored with its embedding vector (using `FieldValue.vector()`),
   * the original text content, arbitrary metadata, and an `indexedAt` timestamp.
   *
   * @param collection - Target Firestore collection.
   * @param id - Document ID.
   * @param text - Text to embed and store.
   * @param metadata - Additional metadata to store alongside the embedding.
   */
  async indexDocument(
    collection: string,
    id: string,
    text: string,
    metadata: Record<string, any>,
  ): Promise<void> {
    const firestore = await this.getFirestore();
    const FieldValue = await this.getFieldValue();

    const embedding = await this.embedText(text, 'RETRIEVAL_DOCUMENT');

    const docRef = firestore.collection(collection).doc(id);
    await docRef.set({
      content: text,
      embedding: FieldValue.vector(embedding),
      ...metadata,
      indexedAt: new Date(),
    });

    console.log(`[VectorSearch] Indexed document ${id} in ${collection}`);
  }

  // ------------------------------------------
  // Indexing — batch
  // ------------------------------------------

  /**
   * Batch-embed and store multiple documents in Firestore.
   *
   * Documents are embedded in groups of 100 (to respect the Vertex AI
   * batch limit) and written to Firestore using batch commits of the
   * same size.
   *
   * @param collection - Target Firestore collection.
   * @param items - Array of items to index, each with an `id`, `text`, and `metadata`.
   */
  async indexBatch(
    collection: string,
    items: Array<{ id: string; text: string; metadata: Record<string, any> }>,
  ): Promise<void> {
    const firestore = await this.getFirestore();
    const FieldValue = await this.getFieldValue();

    for (let i = 0; i < items.length; i += EMBED_BATCH_SIZE) {
      const batch = items.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((item) => item.text);

      // Generate embeddings for the batch
      const embeddings = await this.vertexClient.generateEmbeddings(texts, 'RETRIEVAL_DOCUMENT');

      // Write to Firestore using a batch commit
      const writeBatch = firestore.batch();
      for (let j = 0; j < batch.length; j++) {
        const docRef = firestore.collection(collection).doc(batch[j].id);
        writeBatch.set(docRef, {
          content: batch[j].text,
          embedding: FieldValue.vector(embeddings[j]),
          ...batch[j].metadata,
          indexedAt: new Date(),
        });
      }

      await writeBatch.commit();
      console.log(
        `[VectorSearch] Indexed batch ${i / EMBED_BATCH_SIZE + 1} `
        + `(${batch.length} docs) in ${collection}`,
      );
    }
  }

  // ------------------------------------------
  // Full content indexing
  // ------------------------------------------

  /**
   * Index all content from the content service into Firestore vector collections.
   *
   * Imports products, brew guides, and FAQs from the content service, formats
   * each entity into an embedding-friendly text representation, and stores
   * the resulting embeddings in Firestore.
   *
   * @returns Counts of indexed entities per type.
   */
  async indexAllContent(): Promise<{ products: number; brewGuides: number; faqs: number }> {
    const {
      getAllProducts,
      getAllBrewGuides,
      getAllFAQs,
    } = await import('../content/content-service');

    // ---- Products ----
    const products = getAllProducts();
    const productItems = products.map((product) => ({
      id: product.id,
      text: formatProductText(product),
      metadata: {
        name: product.name,
        series: product.series,
        price: product.price,
        url: product.url,
      },
    }));

    console.log(`[VectorSearch] Indexing ${productItems.length} products...`);
    await this.indexBatch(COLLECTIONS.products, productItems);

    // ---- Brew Guides ----
    const brewGuides = getAllBrewGuides();
    const brewGuideItems = brewGuides.map((guide) => ({
      id: guide.id,
      text: formatBrewGuideText(guide),
      metadata: {
        name: guide.name,
        category: guide.category,
        difficulty: guide.difficulty || '',
        url: guide.url || '',
      },
    }));

    console.log(`[VectorSearch] Indexing ${brewGuideItems.length} brew guides...`);
    await this.indexBatch(COLLECTIONS.brewGuides, brewGuideItems);

    // ---- FAQs ----
    const faqs = getAllFAQs();
    const faqItems = faqs.map((faq) => ({
      id: faq.id,
      text: formatFAQText(faq),
      metadata: {
        category: faq.category,
        question: faq.question,
        relatedProducts: faq.relatedProducts || [],
      },
    }));

    console.log(`[VectorSearch] Indexing ${faqItems.length} FAQs...`);
    await this.indexBatch(COLLECTIONS.faqs, faqItems);

    const counts = {
      products: productItems.length,
      brewGuides: brewGuideItems.length,
      faqs: faqItems.length,
    };

    console.log(
      `[VectorSearch] Indexing complete — `
      + `${counts.products} products, ${counts.brewGuides} brew guides, ${counts.faqs} FAQs`,
    );

    return counts;
  }
}

// ============================================
// Text Formatting Helpers
// ============================================

/**
 * Format a product into embedding-friendly text.
 *
 * Template: "{name}. {description}. Best for: {bestFor joined}. Features: {features joined}"
 */
function formatProductText(product: { name: string; description?: string; bestFor?: string[]; features?: string[] }): string {
  const parts = [product.name];

  if (product.description) {
    parts.push(product.description);
  }

  if (product.bestFor && product.bestFor.length > 0) {
    parts.push(`Best for: ${product.bestFor.join(', ')}`);
  }

  if (product.features && product.features.length > 0) {
    parts.push(`Features: ${product.features.join(', ')}`);
  }

  return parts.join('. ');
}

/**
 * Format a brew guide into embedding-friendly text.
 *
 * Template: "{name}. {category}. {description}. Equipment: {requiredEquipment joined}"
 */
function formatBrewGuideText(guide: { name: string; category: string; description?: string; requiredEquipment?: string[] }): string {
  const parts = [guide.name, guide.category];

  if (guide.description) {
    parts.push(guide.description);
  }

  if (guide.requiredEquipment && guide.requiredEquipment.length > 0) {
    parts.push(`Equipment: ${guide.requiredEquipment.join(', ')}`);
  }

  return parts.join('. ');
}

/**
 * Format an FAQ into embedding-friendly text.
 *
 * Template: "{question}. {answer}"
 */
function formatFAQText(faq: { question: string; answer: string }): string {
  return `${faq.question}. ${faq.answer}`;
}

// ============================================
// Factory
// ============================================

/**
 * Create a VectorSearchService instance.
 *
 * @param projectId - Google Cloud project ID.
 * @param location - GCP region for Vertex AI (defaults to `'us-central1'`).
 * @returns A configured VectorSearchService.
 */
export function createVectorSearchService(
  projectId: string,
  location: string = 'us-central1',
): VectorSearchService {
  return new VectorSearchService(projectId, location);
}
