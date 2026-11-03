import { randomUUID } from 'node:crypto';
import {
  getAllProducts, getPersonaBySlug, matchPersona, matchUseCase,
  getRelevantProducts, getRelevantFeatures, getRelevantFaqs, searchContent,
  findComparison, extractProductIds,
} from '../../../workers/recommender/src/context.js';
import { createContext } from '../../../workers/recommender/src/pipeline/context.js';
import { executeFlow } from '../../../workers/recommender/src/pipeline/executor.js';
import { resolveFlow } from '../../../workers/recommender/src/pipeline/flows.js';
import { buildPageHtml, persistAndPublish } from '../../../workers/recommender/src/da-persist.js';
import {
  CONVERSATION_CONTEXT_SCHEMA, normalizeConversationContext, conversationSearchText,
} from '../../../scripts/conversation-context.js';
// eslint-disable-next-line import/extensions
import pairingGuide from '../../../data/guides/buying/machine-and-grinder-pairing-guide.json';

const STOREFRONT = 'https://main--arco--carlossg.aem.page';
const SERVER_INFO = { name: 'arco-coffee-concierge', version: '1.0.0' };
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const CONTEXT_TTL = 3600;
const PERSONAS = [
  'morning-minimalist', 'upgrade-seeker', 'craft-home-barista',
  'traveling-professional', 'budget-conscious-beginner', 'office-manager',
];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, MCP-Session-Id',
};
const stringInput = (description) => ({
  type: 'string', minLength: 1, maxLength: 2000, description,
});
const TOOLS = [
  {
    name: 'recommend_coffee_setup',
    description: 'Find real Arco coffee equipment, catalog prices and Firestore-retrieved content. '
      + 'Return a context-carrying storefront link. Publish a permanent page only when explicitly requested.',
    inputSchema: {
      type: 'object',
      properties: {
        query: stringInput('Natural-language coffee setup request'),
        persona: { type: 'string', enum: PERSONAS },
        useCase: stringInput('Optional intended use'),
        persistPage: { type: 'boolean', default: false },
        conversationContext: CONVERSATION_CONTEXT_SCHEMA,
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'compare_products',
    description: 'Compare two exact Arco products using current catalog specs and pre-authored editorial guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        productA: stringInput('Product ID or name'),
        productB: stringInput('Product ID or name'),
        contextQuery: stringInput('Optional preferences to guide the comparison'),
        conversationContext: CONVERSATION_CONTEXT_SCHEMA,
      },
      required: ['productA', 'productB'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'get_product_details',
    description: 'Get an exact Arco product, full specs, catalog price, accessories and authored grinder pairing guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        productIdOrName: stringInput('Product ID or name'),
        conversationContext: CONVERSATION_CONTEXT_SCHEMA,
      },
      required: ['productIdOrName'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

function deepLink(query, {
  persona, context, contextId, campaign = false,
} = {}) {
  const url = new URL('/', STOREFRONT);
  url.searchParams.set('q', query);
  if (persona) url.searchParams.set('persona', persona);
  if (contextId) url.searchParams.set('contextId', contextId);
  else if (context) url.searchParams.set('ctx', JSON.stringify(context));
  url.searchParams.set('utm_source', 'gemini');
  url.searchParams.set('utm_medium', 'connected_app');
  if (campaign) url.searchParams.set('utm_campaign', 'mcp_concierge');
  return url.href;
}

async function linkContext(context, env) {
  if (!context.conversationContext) return { context };
  const contextId = randomUUID();
  const expiresAt = new Date(Date.now() + CONTEXT_TTL * 1000).toISOString();
  await env.MCP_CONTEXT_STORE.put(contextId, JSON.stringify({ context, expiresAt }), {
    expirationTtl: CONTEXT_TTL,
  });
  return { contextId };
}

export async function handleMcpContext(request, env) {
  const headers = { ...CORS, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  const respond = (body, status) => Response.json(body, { status, headers });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, {
      status: 405, headers: { ...headers, Allow: 'GET, OPTIONS' },
    });
  }
  const id = new URL(request.url).pathname.split('/').at(-1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return respond({ error: 'Invalid context ID' }, 400);
  }
  try {
    const saved = await env.MCP_CONTEXT_STORE.get(id, 'json');
    if (!saved || Date.parse(saved.expiresAt) <= Date.now()) {
      return respond({ error: 'Conversation context expired or was not found. Request a new Arco link in Gemini.' }, 410);
    }
    return respond(saved, 200);
  } catch {
    console.error('[MCP context] Context storage unavailable');
    return respond({ error: 'Conversation context is temporarily unavailable. Please retry.' }, 503);
  }
}

function productDetails(product, options) {
  return {
    ...product,
    productUrl: new URL(product.url, STOREFRONT).href,
    recommenderUrl: deepLink(`Tell me about Arco ${product.name}`, options),
  };
}

function lookupProduct(value) {
  const normalized = value.trim().toLowerCase().replace(/^arco[-\s]+/, '').replace(/-/g, ' ');
  const product = getAllProducts().find((entry) => (
    entry.id.replace(/-/g, ' ') === normalized || entry.name.toLowerCase() === normalized
  ));
  if (!product) throw new Error(`Unknown Arco product: ${value}. Use an exact catalog ID or name.`);
  return product;
}

async function generatePage({ query, context, env }) {
  const writer = new WritableStream({ write() {} }).getWriter();
  try {
    const ctx = createContext({ query, context }, new Request(`${env.SERVICE_URL}/mcp`));
    const flow = resolveFlow('default');
    ctx.flowId = flow.id;
    ctx.flowName = flow.name;
    ctx.writer = writer;
    ctx.encoder = new TextEncoder();
    await executeFlow(flow.steps, ctx, env);
    if (ctx.earlyResponse || !ctx.llm.sections.length) {
      throw new Error('Generation was declined or returned no content; no page was published.');
    }
    return ctx.llm.sections;
  } finally {
    await writer.close();
  }
}

function validateArguments(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const schema = tool.inputSchema;
  if (schema.required.some((key) => !(key in args))) return 'Missing required tool arguments';
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (key === 'conversationContext') {
      try {
        normalizeConversationContext(value);
      } catch (error) {
        return error.message;
      }
      continue; // eslint-disable-line no-continue
    }
    // eslint-disable-next-line valid-typeof
    if (!rule || typeof value !== rule.type) return `Invalid argument: ${key}`;
    if (rule.type === 'string' && (!value.trim() || value.length > (rule.maxLength || 2000))) {
      return `Invalid string argument: ${key}`;
    }
    if (rule.enum && !rule.enum.includes(value)) return `Invalid argument: ${key}`;
  }
  return null;
}

// eslint-disable-next-line import/prefer-default-export
export function createMcpHandler({ generate = generatePage, publish = persistAndPublish } = {}) {
  async function callTool(name, args, env) {
    const conversationContext = normalizeConversationContext(args.conversationContext);
    if (name === 'recommend_coffee_setup') {
      const retrievalQuery = [args.query, args.useCase, conversationSearchText(conversationContext)]
        .filter(Boolean).join(' ');
      const matchedPersona = matchPersona(retrievalQuery);
      const persona = args.persona ? getPersonaBySlug(args.persona) : matchedPersona;
      const useCase = matchUseCase(args.useCase || retrievalQuery);
      const products = getRelevantProducts(retrievalQuery, persona, useCase);
      const content = await searchContent(retrievalQuery, env);
      if (content.timings.fallback) {
        throw new Error('Firestore content retrieval is unavailable. Please retry.');
      }
      const context = {
        ...(conversationContext ? { conversationContext } : {}),
        ...(persona ? { quizPersona: { persona: persona.slug } } : {}),
        inferredProfile: {
          interests: args.useCase ? [args.useCase] : [],
          inferredIntent: 'discovery',
          journeyStage: 'exploring',
        },
        shownProducts: products.map((product) => product.id),
      };
      const links = await linkContext(context, env);
      const result = {
        query: args.query,
        persona,
        useCase,
        products: products.map((product) => productDetails(product, links)),
        features: getRelevantFeatures(retrievalQuery, products),
        faqs: getRelevantFaqs(retrievalQuery),
        content,
        context,
        storefrontUrl: deepLink(args.query, { persona: persona?.slug, ...links, campaign: true }),
      };
      if (args.persistPage === true) {
        const path = `/discover/gemini-${randomUUID()}`;
        const blocks = await generate({ query: retrievalQuery, context, env });
        const html = buildPageHtml('Your Arco Coffee Setup', `Arco recommendations: ${args.query}`, blocks);
        const saved = await publish(path, html, env);
        if (!saved.success || !saved.urls?.live) throw new Error(saved.error || 'Page publication failed');
        result.liveUrl = saved.urls.live;
      }
      return result;
    }
    if (name === 'compare_products') {
      const a = lookupProduct(args.productA);
      const b = lookupProduct(args.productB);
      if (a.id === b.id) throw new Error('Choose two different products to compare.');
      const ids = extractProductIds(`Arco ${a.name} and Arco ${b.name}`)
        .filter((id) => id === `arco-${a.id}` || id === `arco-${b.id}`);
      const authored = findComparison(`arco-${a.id}`, `arco-${b.id}`);
      const query = `Compare ${a.name} and ${b.name}`;
      const context = {
        ...(conversationContext ? { conversationContext } : {}),
        shownProducts: [a.id, b.id],
        inferredProfile: {
          inferredIntent: 'comparison',
          journeyStage: 'comparing',
          interests: args.contextQuery ? [args.contextQuery] : [],
        },
      };
      const links = await linkContext(context, env);
      return {
        products: [a, b].map((product) => productDetails(product, links)),
        context,
        productIds: ids,
        contextQuery: args.contextQuery || null,
        comparison: Object.fromEntries([...new Set([
          'price', 'currency', ...Object.keys(a.specs || {}), ...Object.keys(b.specs || {}),
        ])].map((key) => [key, {
          [a.id]: a[key] ?? a.specs?.[key] ?? null,
          [b.id]: b[key] ?? b.specs?.[key] ?? null,
        }])),
        editorial: authored ? {
          title: authored.title,
          verdict: authored.verdict,
          recommendationByPersona: authored.recommendation_by_persona,
          sourceUrl: `${STOREFRONT}/products/comparison/${authored.slug}`,
          note: 'Editorial guidance may describe older product versions. Use the catalog comparison above for prices and specs.',
        } : null,
        storefrontUrl: deepLink(query, links),
      };
    }
    const product = lookupProduct(args.productIdOrName);
    const context = {
      ...(conversationContext ? { conversationContext } : {}),
      shownProducts: [product.id],
    };
    const links = conversationContext ? await linkContext(context, env) : undefined;
    const sections = pairingGuide.body.filter((section) => (
      extractProductIds(section.heading).includes(`arco-${product.id}`)
    ));
    const grinderIds = new Set(sections.flatMap((section) => extractProductIds(section.content)));
    return {
      ...productDetails(product, links),
      pairing: {
        guideUrl: `${STOREFRONT}/guides/buying/${pairingGuide.slug}`,
        guidance: sections,
        grinders: getAllProducts().filter((entry) => (
          entry.series === 'grinders' && grinderIds.has(`arco-${entry.id}`)
        )).map((entry) => productDetails(entry, links)),
        includedAccessories: product.includedAccessories || [],
      },
    };
  }

  return async (request, env) => {
    const started = Date.now();
    let rpcMethod = null;
    let toolName = null;
    const wantsEventStream = request.headers.get('accept')?.split(',')
      .some((type) => type.split(';')[0].trim().toLowerCase() === 'text/event-stream');
    const respond = (body, status = 200, extraHeaders = {}) => {
      console.log(JSON.stringify({
        component: 'mcp',
        httpMethod: request.method,
        rpcMethod,
        tool: toolName,
        status,
        rpcErrorCode: body?.error?.code || null,
        toolError: body?.result?.isError === true,
        acceptsEventStream: !!wantsEventStream,
        durationMs: Date.now() - started,
      }));
      return new Response(body == null ? null : JSON.stringify(body), {
        status, headers: { ...CORS, 'Content-Type': 'application/json', ...extraHeaders },
      });
    };
    const error = (id, code, message, status = 200) => respond({
      jsonrpc: '2.0', id, error: { code, message },
    }, status);
    if (new URL(request.url).pathname === '/.well-known/google-connected-apps') {
      if (request.method !== 'GET' || !env.GOOGLE_CONNECTED_VERIFICATION_TOKEN) {
        return respond({ error: 'Not found' }, 404);
      }
      return respond({ verification_tokens: [env.GOOGLE_CONNECTED_VERIFICATION_TOKEN] });
    }
    const origin = request.headers.get('origin');
    const allowedOrigins = [
      STOREFRONT, 'https://gemini.google.com', 'https://aistudio.google.com',
      'http://localhost:3000',
    ];
    if (origin && !allowedOrigins.includes(origin)) return respond({ error: 'Forbidden origin' }, 403);
    if (request.method === 'OPTIONS') return respond(null, 204);
    if (request.method === 'GET') {
      if (wantsEventStream) {
        return respond({ error: 'Standalone SSE streams are not supported; use POST for MCP requests.' }, 405, {
          Allow: 'GET, POST, OPTIONS',
        });
      }
      return respond({
        status: 'ok', protocolVersion: PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO,
      });
    }
    if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST, OPTIONS' });
    if (!request.headers.get('content-type')?.split(';')[0].trim().match(/^application\/json$/i)) {
      return error(null, -32600, 'Content-Type must be application/json', 415);
    }
    const protocol = request.headers.get('mcp-protocol-version');
    if (protocol && !PROTOCOLS.includes(protocol)) return error(null, -32600, 'Unsupported protocol version', 400);
    let message;
    try {
      message = await request.json();
    } catch {
      return error(null, -32700, 'Parse error', 400);
    }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0'
      || typeof message.method !== 'string'
      || ('id' in message && message.id !== null
        && typeof message.id !== 'string' && !Number.isFinite(message.id))
      || (message.params !== undefined && (!message.params || typeof message.params !== 'object'
        || Array.isArray(message.params)))) {
      return error(null, -32600, 'Invalid Request', 400);
    }
    const { id, method, params = {} } = message;
    rpcMethod = method;
    // Notifications never execute tools or produce JSON-RPC responses.
    if (id === undefined) return respond(null, 202);
    if (method === 'initialize') {
      return respond({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOLS.includes(params.protocolVersion)
            ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
    }
    if (method === 'ping') return respond({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return respond({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method !== 'tools/call') return error(id, -32601, 'Method not found');
    const tool = TOOLS.find((entry) => entry.name === params.name);
    if (!tool) return error(id, -32602, 'Unknown tool');
    toolName = tool.name;
    const invalid = validateArguments(tool, params.arguments || {});
    if (invalid) return error(id, -32602, invalid);
    try {
      const data = await callTool(tool.name, params.arguments, env);
      return respond({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          structuredContent: data,
          isError: false,
        },
      });
    } catch (failure) {
      console.error('[MCP]', tool.name, failure.message);
      return respond({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: failure.message }], isError: true,
        },
      });
    }
  };
}
