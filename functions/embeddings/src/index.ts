import { Firestore, FieldValue } from '@google-cloud/firestore';
import { VertexAI } from '@google-cloud/vertexai';
import { Storage } from '@google-cloud/storage';
import type { Request, Response } from '@google-cloud/functions-framework';
import type { CloudEvent } from '@google-cloud/functions-framework';

const firestore = new Firestore();
const storage = new Storage();

const PROJECT_ID = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'arco-coffee';
const LOCATION = process.env.GCP_LOCATION || 'us-central1';
const BUCKET_NAME = process.env.BUCKET_NAME || `${PROJECT_ID}-brew-guides`;
const COLLECTION = 'brew_guides';
const EMBEDDING_MODEL = 'text-embedding-005';

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

interface StorageEventData {
  bucket: string;
  name: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
}

interface BrewGuide {
  title: string;
  slug?: string;
  description?: string;
  method?: string;
  equipment?: string[];
  grindSize?: string;
  waterTemperature?: string;
  brewTime?: string;
  ratio?: string;
  steps?: string[];
  tips?: string[];
  [key: string]: unknown;
}

/**
 * Generates a text embedding using Vertex AI text-embedding-005 model.
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const model = vertexAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  // Use the Vertex AI prediction API for embeddings
  const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${await getAccessToken()}`,
    },
    body: JSON.stringify({
      instances: [{ content: text }],
      parameters: { outputDimensionality: 768 },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.predictions[0].embeddings.values;
}

/**
 * Gets an access token for authenticated API calls.
 */
async function getAccessToken(): Promise<string> {
  const metadataUrl = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
  const response = await fetch(metadataUrl, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  const data = await response.json();
  return data.access_token;
}

/**
 * Converts a brew guide object into a text representation suitable for embedding.
 */
function brewGuideToText(guide: BrewGuide): string {
  const parts: string[] = [];

  if (guide.title) parts.push(`Title: ${guide.title}`);
  if (guide.description) parts.push(`Description: ${guide.description}`);
  if (guide.method) parts.push(`Brew Method: ${guide.method}`);
  if (guide.equipment?.length) parts.push(`Equipment: ${guide.equipment.join(', ')}`);
  if (guide.grindSize) parts.push(`Grind Size: ${guide.grindSize}`);
  if (guide.waterTemperature) parts.push(`Water Temperature: ${guide.waterTemperature}`);
  if (guide.brewTime) parts.push(`Brew Time: ${guide.brewTime}`);
  if (guide.ratio) parts.push(`Coffee to Water Ratio: ${guide.ratio}`);
  if (guide.steps?.length) parts.push(`Steps: ${guide.steps.join('. ')}`);
  if (guide.tips?.length) parts.push(`Tips: ${guide.tips.join('. ')}`);

  return parts.join('\n');
}

/**
 * onBrewGuideUpload - Cloud Storage trigger.
 * Processes brew-guides/*.json files uploaded to storage, generates text
 * embeddings using text-embedding-005, and stores them in Firestore
 * `brew_guides` collection with vector embeddings.
 */
export async function onBrewGuideUpload(cloudEvent: CloudEvent<StorageEventData>): Promise<void> {
  const data = cloudEvent.data;

  if (!data || !data.name) {
    console.error('No file data in cloud event.');
    return;
  }

  const filePath = data.name;

  // Only process files in the brew-guides/ directory
  if (!filePath.startsWith('brew-guides/') || !filePath.endsWith('.json')) {
    console.log(`Skipping file: ${filePath} (not a brew guide JSON file).`);
    return;
  }

  console.log(`Processing brew guide upload: ${filePath}`);

  try {
    const bucket = storage.bucket(data.bucket);
    const file = bucket.file(filePath);
    const [contents] = await file.download();
    const guide: BrewGuide = JSON.parse(contents.toString('utf8'));

    if (!guide.title) {
      console.error(`Brew guide at ${filePath} is missing a title. Skipping.`);
      return;
    }

    const text = brewGuideToText(guide);
    console.log(`Generating embedding for brew guide: ${guide.title}`);
    const embedding = await generateEmbedding(text);

    const docId = guide.slug || filePath.replace('brew-guides/', '').replace('.json', '');

    await firestore.collection(COLLECTION).doc(docId).set({
      ...guide,
      embedding: FieldValue.vector(embedding),
      embeddingText: text,
      embeddedAt: FieldValue.serverTimestamp(),
      sourceFile: filePath,
      source: 'arco-brew-guides',
    }, { merge: true });

    console.log(`Successfully embedded and stored brew guide: ${guide.title} (${docId})`);
  } catch (error) {
    console.error(`Error processing brew guide ${filePath}:`, error);
    throw error;
  }
}

/**
 * generateBrewGuideEmbeddings - HTTP endpoint for manual batch embedding generation.
 * Processes all brew guides from content/recipes/recipes.json, generates embeddings
 * in batches of 10, and stores them in Firestore. Skips recently embedded guides.
 */
export async function generateBrewGuideEmbeddings(req: Request, res: Response): Promise<void> {
  if (handleCorsPreflght(req, res)) return;

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
    return;
  }

  try {
    const forceRegenerate = req.query.force === 'true';
    const skipHours = parseInt(req.query.skipHours as string, 10) || 24;

    // Fetch brew guides from storage
    const bucket = storage.bucket(BUCKET_NAME);
    const [files] = await bucket.getFiles({ prefix: 'brew-guides/' });

    const jsonFiles = files.filter((f) => f.name.endsWith('.json'));

    if (jsonFiles.length === 0) {
      res.status(200).json({
        message: 'No brew guide files found in storage.',
        processed: 0,
      });
      return;
    }

    console.log(`Found ${jsonFiles.length} brew guide files to process.`);

    const BATCH_SIZE = 10;
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    const results: Array<{ title: string; status: string }> = [];

    for (let i = 0; i < jsonFiles.length; i += BATCH_SIZE) {
      const batch = jsonFiles.slice(i, i + BATCH_SIZE);

      const promises = batch.map(async (file) => {
        const filePath = file.name;
        const docId = filePath.replace('brew-guides/', '').replace('.json', '');

        try {
          // Check if recently embedded
          if (!forceRegenerate) {
            const existing = await firestore.collection(COLLECTION).doc(docId).get();
            if (existing.exists) {
              const data = existing.data();
              const embeddedAt = data?.embeddedAt?.toDate?.();
              if (embeddedAt) {
                const hoursSinceEmbed = (Date.now() - embeddedAt.getTime()) / (1000 * 60 * 60);
                if (hoursSinceEmbed < skipHours) {
                  skipped++;
                  results.push({ title: docId, status: 'skipped (recently embedded)' });
                  return;
                }
              }
            }
          }

          const [contents] = await file.download();
          const guide: BrewGuide = JSON.parse(contents.toString('utf8'));

          if (!guide.title) {
            skipped++;
            results.push({ title: docId, status: 'skipped (no title)' });
            return;
          }

          const text = brewGuideToText(guide);
          const embedding = await generateEmbedding(text);

          await firestore.collection(COLLECTION).doc(docId).set({
            ...guide,
            embedding: FieldValue.vector(embedding),
            embeddingText: text,
            embeddedAt: FieldValue.serverTimestamp(),
            sourceFile: filePath,
            source: 'arco-brew-guides',
          }, { merge: true });

          processed++;
          results.push({ title: guide.title, status: 'embedded' });
        } catch (err) {
          errors++;
          const errorMessage = err instanceof Error ? err.message : String(err);
          results.push({ title: docId, status: `error: ${errorMessage}` });
          console.error(`Error processing ${filePath}:`, err);
        }
      });

      await Promise.all(promises);

      // Brief pause between batches to avoid rate limiting
      if (i + BATCH_SIZE < jsonFiles.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    res.status(200).json({
      message: 'Brew guide embedding generation complete.',
      totalFiles: jsonFiles.length,
      processed,
      skipped,
      errors,
      results,
    });
  } catch (error) {
    console.error('Error generating brew guide embeddings:', error);
    res.status(500).json({ error: 'Failed to generate brew guide embeddings.' });
  }
}

/**
 * searchBrewGuides - HTTP endpoint for vector search.
 * Accepts `query` param, generates query embedding, performs Firestore vector
 * search with COSINE distance, and returns top-K similar brew guides.
 */
export async function searchBrewGuides(req: Request, res: Response): Promise<void> {
  if (handleCorsPreflght(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
    return;
  }

  try {
    const query = (req.method === 'GET' ? req.query.query : req.body?.query) as string;
    const topK = parseInt(
      (req.method === 'GET' ? req.query.topK : req.body?.topK) as string,
      10,
    ) || 5;

    if (!query) {
      res.status(400).json({ error: 'query parameter is required.' });
      return;
    }

    console.log(`Searching brew guides for: "${query}" (top ${topK})`);

    // Generate embedding for the search query
    const queryEmbedding = await generateEmbedding(query);

    // Perform vector search using Firestore
    const collectionRef = firestore.collection(COLLECTION);
    const vectorQuery = collectionRef.findNearest(
      'embedding',
      FieldValue.vector(queryEmbedding),
      {
        limit: topK,
        distanceMeasure: 'COSINE',
      },
    );

    const snapshot = await vectorQuery.get();

    if (snapshot.empty) {
      res.status(200).json({
        query,
        results: [],
        message: 'No matching brew guides found.',
      });
      return;
    }

    const results = snapshot.docs.map((doc) => {
      const data = doc.data();
      // Remove the embedding vector from the response to reduce payload size
      const { embedding, embeddingText, ...guideData } = data;
      return {
        id: doc.id,
        ...guideData,
      };
    });

    res.status(200).json({
      query,
      topK,
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('Error searching brew guides:', error);
    res.status(500).json({ error: 'Failed to search brew guides.' });
  }
}
