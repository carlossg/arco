/**
 * Arco Recommender Types
 * Core type definitions for the AI-driven recommendation system
 */

// ============================================
// Product Types
// ============================================

export interface Product {
  id: string;
  sku?: string;
  name: string;
  series: string;
  url: string;
  price: number;
  originalPrice?: number | null;
  availability?: 'in-stock' | 'out-of-stock' | 'limited';
  description?: string;
  tagline?: string;
  features?: string[];
  bestFor?: string[];
  warranty?: string;
  specs?: CoffeeProductSpecs;
  images?: ProductImages;
  crawledAt?: string;
  sourceUrl?: string;
  contentHash?: string;
}

export interface CoffeeProductSpecs {
  // Espresso Machine Specs
  boilers?: number;
  boilerMaterial?: string;
  pumpType?: string;
  groupHead?: string;
  groupHeadSize?: string;
  pid?: boolean;
  heating?: string;
  pressure?: string;
  waterTank?: string;
  beanHopper?: string;
  dailyCapacity?: string;
  waterConnection?: string;
  display?: string;
  // Grinder Specs
  burrType?: string;
  burrSize?: string;
  burrMaterial?: string;
  adjustmentType?: string;
  adjustmentSteps?: number;
  retention?: string;
  rpm?: number;
  dosing?: string;
  // Common Specs
  dimensions?: string;
  weight?: string;
}

export interface ProductImages {
  primary: string;
  gallery: string[];
  remoteUrls: string[];
}

// ============================================
// Brew Guide Types (replaces Recipe)
// ============================================

export interface BrewGuide {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  description?: string;
  difficulty?: 'easy' | 'medium' | 'advanced';
  time?: string;
  grindSize?: string;
  dose?: string;
  yield?: string;
  extractionTime?: string;
  temperature?: string;
  pressure?: string;
  technique?: string[];
  requiredEquipment?: string[];
  pairsWith?: string[];
  tips?: string[];
  totalTime?: string;
  servings?: number;
  recommendedProducts?: string[];
  requiredFeatures?: string[];
  url?: string;
  crawledAt?: string;
  contentHash?: string;
}

// ============================================
// Accessory Types
// ============================================

export interface Accessory {
  id: string;
  name: string;
  type: 'tamper' | 'scale' | 'pitcher' | 'cleaning' | 'cups' | 'storage' | 'preparation' | 'dosing';
  url: string;
  price: number;
  originalPrice?: number | null;
  availability?: 'in-stock' | 'out-of-stock' | 'limited';
  description?: string;
  features?: string[];
  specs?: AccessorySpecs;
  compatibility?: AccessoryCompatibility;
  includedItems?: string[];
  images?: ProductImages;
  crawledAt?: string;
  sourceUrl?: string;
}

export interface AccessorySpecs {
  capacity?: string;
  dimensions?: string;
  weight?: string;
  material?: string;
  dishwasherSafe?: boolean;
}

export interface AccessoryCompatibility {
  series?: string[];
  machines?: string[];
}

// ============================================
// Use Case Types
// ============================================

export interface UseCase {
  id: string;
  name: string;
  description: string;
  icon: string;
  relevantFeatures: string[];
  recommendedSeries: string[];
  difficultyLevel?: string;
  timeInvestment?: string;
  popularBrewGuides?: string[];
}

// ============================================
// Feature Types
// ============================================

export interface Feature {
  id: string;
  name: string;
  description: string;
  benefit: string;
  availableIn: string[];
}

// ============================================
// Review Types
// ============================================

export interface Review {
  id: string;
  productId?: string;
  author: string;
  authorTitle?: string;
  rating?: number;
  title?: string;
  content: string;
  verifiedPurchase?: boolean;
  useCase?: string;
  date?: string;
  sourceUrl?: string;
  sourceType?: 'bazaarvoice' | 'editorial' | 'chef' | 'customer-story' | 'third-party';
}

// ============================================
// User Persona Types
// ============================================

export interface UserPersona {
  personaId: string;
  name: string;
  demographics: {
    householdType: string;
    typicalAge?: string;
    timeAvailability: string;
    coffeeSkill: string;
  };
  primaryGoals: string[];
  keyBarriers: string[];
  emotionalState: {
    frustrations: string[];
    hopes: string[];
    fears: string[];
  };
  productPriorities: { attribute: string; importance: string }[];
  effectiveMessaging: {
    validationPhrases: string[];
    benefitEmphasis: string[];
    proofPoints: string[];
    visualizations: string[];
  };
  triggerPhrases: string[];
  recommendedProducts: string[];
}

// ============================================
// Product Profile Types
// ============================================

export interface ProductProfile {
  useCaseScores: Record<string, number>;
  priceTier: 'budget' | 'mid' | 'premium';
  householdFit: ('solo' | 'couple' | 'family')[];
  standoutFeatures: string[];
  notIdealFor: string[];
}

// ============================================
// Intent & Classification Types
// ============================================

export interface IntentClassification {
  intentType: IntentType;
  confidence: number;
  entities: {
    products: string[];
    useCases: string[];
    features: string[];
    priceRange?: string;
    coffeeTerms?: string[];  // Coffee terms detected in query
  };
  journeyStage: JourneyStage;
}

export type IntentType =
  | 'discovery'
  | 'comparison'
  | 'product-detail'
  | 'use-case'
  | 'specs'
  | 'reviews'
  | 'price'
  | 'recommendation'
  | 'support'        // Product issues, warranty, returns
  | 'gift'           // Buying for someone else
  | 'beginner'       // New to espresso/coffee equipment
  | 'upgrade'        // Upgrading from existing equipment
  | 'technique';     // Brewing technique focus

// User mode for adapting response style
export type UserMode =
  | 'quick'      // Wants fast answer
  | 'research'   // Wants depth
  | 'gift'       // Buying for others
  | 'support'    // Has a problem
  | 'commercial'; // B2B inquiry

export type JourneyStage = 'exploring' | 'comparing' | 'deciding';

// ============================================
// Block Selection Types
// ============================================

export interface BlockSelection {
  type: BlockType;
  variant?: string;
  priority: number;
  rationale: string;
  contentGuidance: string;
}

export type BlockType =
  | 'hero'
  | 'cards'
  | 'columns'
  | 'accordion'
  | 'tabs'
  | 'table'
  | 'testimonials'
  | 'product-detail'
  | 'product-list'
  | 'carousel'
  | 'quote'
  | 'video'
  | 'quiz'
  | 'follow-up'
  | 'quick-answer'
  | 'support-triage'
  | 'budget-breakdown'
  | 'best-pick'
  | 'comparison-table'
  | 'feature-highlights'
  | 'use-case-cards'
  | 'text';

// ============================================
// Block Recommendation (from reasoning engine)
// ============================================

export interface BlockRecommendation {
  type: string;
  priority: number;
  content: Record<string, unknown>;
}

// ============================================
// User Query (input to reasoning engine)
// ============================================

export interface UserQuery {
  text: string;
  sessionContext?: SessionContext;
}

// ============================================
// Reasoning Types
// ============================================

export interface ReasoningResult {
  selectedBlocks?: BlockSelection[];
  blocks: BlockRecommendation[];
  reasoning: string;
  userJourney?: UserJourneyPlan;
  confidence?: number;
}

export interface ReasoningTrace {
  intentAnalysis: string;
  userNeedsAssessment: string;
  blockSelectionRationale: BlockRationale[];
  alternativesConsidered: string[];
  finalDecision: string;
}

export interface BlockRationale {
  blockType: BlockType;
  reason: string;
  contentFocus: string;
}

export interface UserJourneyPlan {
  currentStage: JourneyStage;
  nextBestAction: string;
  suggestedFollowUps: string[];
}

// ============================================
// Session Context Types
// ============================================

export interface BrowsingHistoryItem {
	path: string;
	title?: string;
	blocks?: string[];
	intent?: string;
	stage?: JourneyStage;
	timestamp?: number;
	timeSpent?: number;
	scrollDepth?: number;
}

export interface InferredBrowsingProfile {
	productsViewed: string[];
	categoriesViewed: string[];
	contentTypes: string[];
	inferredIntent: string;
	journeyStage: JourneyStage;
	interests: string[];
	quizAnswers?: Record<string, string>;
	pagesVisited: number;
	totalTimeOnSite: number;
}

export interface SessionContext {
	sessionId?: string;
	sessionStart?: number;
	previousQueries: QueryHistoryItem[];
	profile?: UserProfile;
	browsingHistory?: BrowsingHistoryItem[];
	inferredProfile?: InferredBrowsingProfile;
}

export interface QueryHistoryItem {
  query: string;
  intent: string;
  entities?: {
    products: string[];
    coffeeTerms: string[];
    goals: string[];
  };
  // Enriched context fields
  recommendedProducts?: string[];
  recommendedBrewGuides?: string[];
  blockTypes?: string[];
  journeyStage?: JourneyStage;
  confidence?: number;
  nextBestAction?: string;
}

export interface UserProfile {
  useCases?: string[];
  priceRange?: 'budget' | 'mid' | 'premium';
  productsViewed?: string[];
  concerns?: string[];
  journeyStage: JourneyStage;
}

// ============================================
// RAG Context Types
// ============================================

export interface RAGContext {
  chunks: ContentChunk[];
  products: Product[];
  brewGuides: BrewGuide[];
}

export interface ContentChunk {
  id: string;
  text: string;
  metadata: {
    contentType: string;
    pageTitle: string;
    sourceUrl: string;
  };
  score: number;
}

// ============================================
// SSE Event Types
// ============================================

export type SSEEvent =
  | { event: 'generation-start'; data: { query: string; estimatedBlocks: number } }
  | { event: 'reasoning-start'; data: { model: string; preset?: string } }
  | { event: 'reasoning-step'; data: { stage: string; title: string; content: string } }
  | { event: 'reasoning-complete'; data: { confidence: number; duration: number } }
  | { event: 'block-start'; data: { blockType: BlockType; index: number } }
  | { event: 'block-content'; data: { html: string; sectionStyle?: string } }
  | { event: 'block-rationale'; data: { blockType: BlockType; rationale: string } }
  | { event: 'image-ready'; data: { imageId: string; url: string } }
  | { event: 'generation-complete'; data: GenerationCompleteData }
  | { event: 'analytics-available'; data: { pageId: string; overallScore: number } }
  | { event: 'complete'; data: { message?: string } }
  | { event: 'error'; data: { message: string; code?: string } }
  | { event: 'cache-hit'; data: { path: string; liveUrl: string; previewUrl: string } };

// Enriched generation-complete event data
export interface GenerationCompleteData {
  totalBlocks: number;
  duration: number;
  intent?: IntentClassification;
  reasoning?: {
    journeyStage: JourneyStage;
    confidence: number;
    nextBestAction: string;
    suggestedFollowUps: string[];
  };
  recommendations?: {
    products: string[];
    brewGuides: string[];
    blockTypes: string[];
  };
}

// ============================================
// Model Configuration Types
// ============================================

export type ModelRole = 'reasoning' | 'content' | 'classification' | 'validation';

export type ModelProvider = 'google' | 'model-garden' | 'vertex-endpoint';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelPreset {
  reasoning: ModelConfig;
  content: ModelConfig;
  classification: ModelConfig;
  validation: ModelConfig;
}

// ============================================
// Environment Bindings
// ============================================

export interface Env {
	// Google Cloud Services (passwordless via ADC)
	GCP_PROJECT_ID?: string;
	GCP_LOCATION?: string;

	// DA (Document Authoring) Configuration
	DA_ORG: string;
	DA_REPO: string;
	// S2S Authentication (stored in Secret Manager)
	DA_CLIENT_ID?: string;
	DA_CLIENT_SECRET?: string;
	DA_SERVICE_TOKEN?: string;
	// Legacy static token (fallback)
	DA_TOKEN?: string;

	// Vertex AI Endpoint (Gemma dedicated GPU)
	GEMMA_ENDPOINT_ID?: string;

	// Configuration
	MODEL_PRESET?: string;
	GEMINI_MODEL_VERSION?: string;
	DEBUG?: string;
}
