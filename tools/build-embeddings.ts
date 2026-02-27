#!/usr/bin/env npx ts-node
/**
 * Embedding Index Builder
 *
 * Generates text embeddings for products, brew guides, and FAQs using
 * Vertex AI text-embedding-005 and stores them in Firestore for
 * native vector search.
 *
 * Usage:
 *   npx ts-node tools/build-embeddings.ts
 *   npx ts-node tools/build-embeddings.ts --type products
 *   npx ts-node tools/build-embeddings.ts --type all --dry-run
 *   npx ts-node tools/build-embeddings.ts --project my-gcp-project --location europe-west1
 *
 * Options:
 *   --type <products|brewguides|faqs|all>  Content types to index (default: all)
 *   --dry-run                              Print what would be indexed without writing
 *   --project <projectId>                  GCP project ID (default: env GCP_PROJECT_ID or arco-recommender)
 *   --location <location>                  GCP location (default: env GCP_LOCATION or us-central1)
 */

import {
  getAllProducts,
  getAllBrewGuides,
  getAllFAQs,
} from '../services/recommender/src/content/content-service';
import type {
  Product,
  BrewGuide,
  FAQ,
} from '../services/recommender/src/content/content-service';
import { createVectorSearchService } from '../services/recommender/src/lib/vector-search';

// ============================================
// CLI Argument Parsing
// ============================================

type ContentType = 'products' | 'brewguides' | 'faqs' | 'all';

interface CLIArgs {
  type: ContentType;
  dryRun: boolean;
  project: string;
  location: string;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const parsed: CLIArgs = {
    type: 'all',
    dryRun: false,
    project: process.env.GCP_PROJECT_ID || 'arco-recommender',
    location: process.env.GCP_LOCATION || 'us-central1',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type':
        i++;
        if (!args[i] || !['products', 'brewguides', 'faqs', 'all'].includes(args[i])) {
          console.error(`Error: --type must be one of: products, brewguides, faqs, all`);
          process.exit(1);
        }
        parsed.type = args[i] as ContentType;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--project':
        i++;
        if (!args[i]) {
          console.error('Error: --project requires a value');
          process.exit(1);
        }
        parsed.project = args[i];
        break;
      case '--location':
        i++;
        if (!args[i]) {
          console.error('Error: --location requires a value');
          process.exit(1);
        }
        parsed.location = args[i];
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: npx ts-node tools/build-embeddings.ts [options]

Options:
  --type <products|brewguides|faqs|all>  Content types to index (default: all)
  --dry-run                              Print what would be indexed without writing
  --project <projectId>                  GCP project ID (default: env GCP_PROJECT_ID or arco-recommender)
  --location <location>                  GCP location (default: env GCP_LOCATION or us-central1)
  --help, -h                             Show this help message
`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return parsed;
}

// ============================================
// Embedding Text Formatters
// ============================================

function formatProductText(product: Product): string {
  const parts: string[] = [product.name];

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

function formatBrewGuideText(guide: BrewGuide): string {
  const parts: string[] = [guide.name, guide.category];

  if (guide.description) {
    parts.push(guide.description);
  }

  if (guide.requiredEquipment && guide.requiredEquipment.length > 0) {
    parts.push(`Equipment: ${guide.requiredEquipment.join(', ')}`);
  }

  return parts.join('. ');
}

function formatFAQText(faq: FAQ): string {
  return `${faq.question}. ${faq.answer}`;
}

// ============================================
// Indexing Logic
// ============================================

interface IndexResult {
  type: string;
  total: number;
  indexed: number;
  errors: number;
  duration: number;
}

async function indexProducts(
  vectorSearch: ReturnType<typeof createVectorSearchService>,
  dryRun: boolean,
): Promise<IndexResult> {
  const startTime = Date.now();
  const products = getAllProducts();
  let indexed = 0;
  let errors = 0;

  console.log(`\n--- Products ---`);
  console.log(`  Found ${products.length} products`);

  const items = products.map((product) => {
    const text = formatProductText(product);
    return {
      id: product.id,
      text,
      metadata: {
        contentType: 'product',
        name: product.name,
        series: product.series,
        price: product.price,
        url: product.url,
      },
    };
  });

  if (dryRun) {
    for (const item of items) {
      console.log(`  [dry-run] Would index: ${item.id} — "${item.text.substring(0, 80)}..."`);
    }
    indexed = items.length;
  } else {
    try {
      await vectorSearch.indexBatch('product_embeddings', items);
      indexed = items.length;
      console.log(`  Indexed: ${indexed}`);
    } catch (error) {
      console.error(`  Error indexing products batch:`, error instanceof Error ? error.message : error);
      errors = items.length;
    }
  }

  return {
    type: 'products',
    total: products.length,
    indexed,
    errors,
    duration: Date.now() - startTime,
  };
}

async function indexBrewGuides(
  vectorSearch: ReturnType<typeof createVectorSearchService>,
  dryRun: boolean,
): Promise<IndexResult> {
  const startTime = Date.now();
  const guides = getAllBrewGuides();
  let indexed = 0;
  let errors = 0;

  console.log(`\n--- Brew Guides ---`);
  console.log(`  Found ${guides.length} brew guides`);

  const items = guides.map((guide) => {
    const text = formatBrewGuideText(guide);
    return {
      id: guide.id,
      text,
      metadata: {
        contentType: 'brewguide',
        name: guide.name,
        category: guide.category,
        difficulty: guide.difficulty || 'unknown',
        url: guide.url || '',
      },
    };
  });

  if (dryRun) {
    for (const item of items) {
      console.log(`  [dry-run] Would index: ${item.id} — "${item.text.substring(0, 80)}..."`);
    }
    indexed = items.length;
  } else {
    try {
      await vectorSearch.indexBatch('brewguide_embeddings', items);
      indexed = items.length;
      console.log(`  Indexed: ${indexed}`);
    } catch (error) {
      console.error(`  Error indexing brew guides batch:`, error instanceof Error ? error.message : error);
      errors = items.length;
    }
  }

  return {
    type: 'brewguides',
    total: guides.length,
    indexed,
    errors,
    duration: Date.now() - startTime,
  };
}

async function indexFAQs(
  vectorSearch: ReturnType<typeof createVectorSearchService>,
  dryRun: boolean,
): Promise<IndexResult> {
  const startTime = Date.now();
  const faqs = getAllFAQs();
  let indexed = 0;
  let errors = 0;

  console.log(`\n--- FAQs ---`);
  console.log(`  Found ${faqs.length} FAQs`);

  const items = faqs.map((faq) => {
    const text = formatFAQText(faq);
    return {
      id: faq.id,
      text,
      metadata: {
        contentType: 'faq',
        category: faq.category,
        question: faq.question,
      },
    };
  });

  if (dryRun) {
    for (const item of items) {
      console.log(`  [dry-run] Would index: ${item.id} — "${item.text.substring(0, 80)}..."`);
    }
    indexed = items.length;
  } else {
    try {
      await vectorSearch.indexBatch('faq_embeddings', items);
      indexed = items.length;
      console.log(`  Indexed: ${indexed}`);
    } catch (error) {
      console.error(`  Error indexing FAQs batch:`, error instanceof Error ? error.message : error);
      errors = items.length;
    }
  }

  return {
    type: 'faqs',
    total: faqs.length,
    indexed,
    errors,
    duration: Date.now() - startTime,
  };
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const args = parseArgs();
  const overallStart = Date.now();

  // Print banner
  console.log('='.repeat(60));
  console.log('  Arco Embedding Index Builder');
  console.log('='.repeat(60));
  console.log(`  Project:   ${args.project}`);
  console.log(`  Location:  ${args.location}`);
  console.log(`  Type:      ${args.type}`);
  console.log(`  Dry Run:   ${args.dryRun}`);
  console.log('='.repeat(60));

  // Initialize vector search service
  const vectorSearch = createVectorSearchService(args.project, args.location);

  const shouldIndex = (type: ContentType): boolean =>
    args.type === 'all' || args.type === type;

  const results: IndexResult[] = [];

  // Index each content type
  if (shouldIndex('products')) {
    try {
      const result = await indexProducts(vectorSearch, args.dryRun);
      results.push(result);
    } catch (error) {
      console.error(`\nFailed to index products:`, error instanceof Error ? error.message : error);
      results.push({ type: 'products', total: 0, indexed: 0, errors: 1, duration: 0 });
    }
  }

  if (shouldIndex('brewguides')) {
    try {
      const result = await indexBrewGuides(vectorSearch, args.dryRun);
      results.push(result);
    } catch (error) {
      console.error(`\nFailed to index brew guides:`, error instanceof Error ? error.message : error);
      results.push({ type: 'brewguides', total: 0, indexed: 0, errors: 1, duration: 0 });
    }
  }

  if (shouldIndex('faqs')) {
    try {
      const result = await indexFAQs(vectorSearch, args.dryRun);
      results.push(result);
    } catch (error) {
      console.error(`\nFailed to index FAQs:`, error instanceof Error ? error.message : error);
      results.push({ type: 'faqs', total: 0, indexed: 0, errors: 1, duration: 0 });
    }
  }

  // Print summary
  const totalDuration = Date.now() - overallStart;
  const totalIndexed = results.reduce((sum, r) => sum + r.indexed, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
  const totalItems = results.reduce((sum, r) => sum + r.total, 0);

  console.log('\n' + '='.repeat(60));
  console.log('  Summary');
  console.log('='.repeat(60));
  for (const result of results) {
    const status = result.errors > 0 ? '(with errors)' : 'OK';
    console.log(`  ${result.type.padEnd(12)} ${result.indexed}/${result.total} indexed  ${(result.duration / 1000).toFixed(1)}s  ${status}`);
  }
  console.log('-'.repeat(60));
  console.log(`  Total:     ${totalIndexed}/${totalItems} indexed, ${totalErrors} errors`);
  console.log(`  Duration:  ${(totalDuration / 1000).toFixed(1)}s`);
  console.log('='.repeat(60));

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nFatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
