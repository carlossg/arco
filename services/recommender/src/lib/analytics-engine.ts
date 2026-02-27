/**
 * Multi-model analytics engine for evaluating AI-generated recommender pages.
 *
 * Runs three models in parallel (Gemini 2.5 Pro, Gemini 2.5 Flash, and
 * Llama 3.3 70B) to score a generated page across four quality dimensions.
 * Individual model evaluations are synthesised into a single consensus
 * result using median scoring and weighted dimension averages.
 */

import { VertexAIClient } from '../ai-clients/vertex-ai-client';
import { ModelGardenClient } from '../ai-clients/model-garden-client';
import { buildEvaluationPrompt } from './analytics-prompts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyticsResult {
	pageId: string;
	query: string;
	intent: string;
	overallScore: number;
	dimensions: {
		contentQuality: number;
		layoutEffectiveness: number;
		conversionPotential: number;
		factualAccuracy: number;
	};
	suggestions: AnalyticsSuggestion[];
	modelResults: { model: string; status: 'success' | 'failed'; duration?: number }[];
	analyzedAt: string;
}

export interface AnalyticsSuggestion {
	text: string;
	dimension: string;
	impact: 'high' | 'medium' | 'low';
	effort: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ModelEvaluation {
	model: string;
	contentQuality: number;
	layoutEffectiveness: number;
	conversionPotential: number;
	factualAccuracy: number;
	suggestions: AnalyticsSuggestion[];
	duration: number;
}

/** Describes which AI client and method to use for a given model. */
interface ModelSpec {
	name: string;
	provider: 'google' | 'model-garden';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Models used for the multi-model evaluation ensemble. */
const EVALUATION_MODELS: ModelSpec[] = [
	{ name: 'gemini-2.5-pro', provider: 'google' },
	{ name: 'gemini-2.5-flash', provider: 'google' },
	{ name: 'llama-3.3-70b-instruct-maas', provider: 'model-garden' },
];

/** Dimension weights for the overall score (must sum to 1.0). */
const DIMENSION_WEIGHTS: Record<string, number> = {
	contentQuality: 0.3,
	layoutEffectiveness: 0.2,
	conversionPotential: 0.2,
	factualAccuracy: 0.3,
};

// ---------------------------------------------------------------------------
// AnalyticsEngine
// ---------------------------------------------------------------------------

export class AnalyticsEngine {
	private vertexClient: VertexAIClient;
	private gardenClient: ModelGardenClient;

	constructor(projectId: string, location: string = 'us-central1') {
		this.vertexClient = new VertexAIClient(projectId, location);
		this.gardenClient = new ModelGardenClient(projectId, location);
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/**
	 * Run a multi-model evaluation of a generated recommender page.
	 *
	 * Each model in the ensemble evaluates the page independently and in
	 * parallel.  Results are synthesised into a single {@link AnalyticsResult}
	 * via median scoring and suggestion deduplication.
	 */
	async analyzeGeneratedPage(
		html: string,
		query: string,
		intent: string,
	): Promise<AnalyticsResult> {
		const prompt = buildEvaluationPrompt(html, query, intent);

		// Run all models in parallel — failures are captured, not thrown.
		const settled = await Promise.allSettled(
			EVALUATION_MODELS.map((spec) => this.callModel(spec.name, spec.provider, prompt)),
		);

		const evaluations: ModelEvaluation[] = [];
		const modelResults: AnalyticsResult['modelResults'] = [];

		settled.forEach((outcome, idx) => {
			const modelName = EVALUATION_MODELS[idx].name;

			if (outcome.status === 'fulfilled' && outcome.value !== null) {
				evaluations.push(outcome.value);
				modelResults.push({
					model: modelName,
					status: 'success',
					duration: outcome.value.duration,
				});
			} else {
				const reason = outcome.status === 'rejected'
					? (outcome.reason as Error)?.message ?? 'unknown error'
					: 'null evaluation';
				console.error(`[AnalyticsEngine] ${modelName} failed: ${reason}`);
				modelResults.push({ model: modelName, status: 'failed' });
			}
		});

		// If every model failed, return a zeroed-out result.
		if (evaluations.length === 0) {
			return {
				pageId: this.generatePageId(query),
				query,
				intent,
				overallScore: 0,
				dimensions: {
					contentQuality: 0,
					layoutEffectiveness: 0,
					conversionPotential: 0,
					factualAccuracy: 0,
				},
				suggestions: [],
				modelResults,
				analyzedAt: new Date().toISOString(),
			};
		}

		const result = this.synthesizeResults(evaluations);

		return {
			pageId: this.generatePageId(query),
			query,
			intent,
			...result,
			modelResults,
			analyzedAt: new Date().toISOString(),
		};
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/**
	 * Call a single model, parse the JSON response, and return a
	 * {@link ModelEvaluation}.  Returns `null` when the model response
	 * cannot be parsed.
	 */
	private async callModel(
		modelName: string,
		provider: string,
		prompt: string,
	): Promise<ModelEvaluation | null> {
		const start = Date.now();

		try {
			let rawText: string;

			if (provider === 'google') {
				const response = await this.vertexClient.generateContent(
					modelName,
					[{ role: 'user', content: prompt }],
					{ temperature: 0.3, maxTokens: 2048 },
				);
				rawText = response.content;
			} else {
				// model-garden provider — use Llama via ModelGardenClient
				rawText = await this.gardenClient.generateWithLlama(prompt, {
					temperature: 0.3,
					maxTokens: 2048,
				});
			}

			const duration = Date.now() - start;
			const parsed = this.parseModelResponse(rawText, modelName, duration);
			return parsed;
		} catch (error) {
			console.error(
				`[AnalyticsEngine] Error calling ${modelName}:`,
				error instanceof Error ? error.message : error,
			);
			return null;
		}
	}

	/**
	 * Parse the raw text returned by a model into a {@link ModelEvaluation}.
	 * Handles responses that may be wrapped in markdown code fences.
	 */
	private parseModelResponse(
		raw: string,
		model: string,
		duration: number,
	): ModelEvaluation | null {
		try {
			// Strip optional markdown code fences
			let cleaned = raw.trim();
			if (cleaned.startsWith('```')) {
				cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
			}

			const json = JSON.parse(cleaned);

			const clamp = (v: unknown): number => {
				const n = Number(v);
				if (Number.isNaN(n)) return 0;
				return Math.max(1, Math.min(10, Math.round(n)));
			};

			const suggestions: AnalyticsSuggestion[] = Array.isArray(json.suggestions)
				? json.suggestions.map((s: any) => ({
					text: String(s.text ?? ''),
					dimension: String(s.dimension ?? ''),
					impact: ['high', 'medium', 'low'].includes(s.impact) ? s.impact : 'medium',
					effort: ['high', 'medium', 'low'].includes(s.effort) ? s.effort : 'medium',
				}))
				: [];

			return {
				model,
				contentQuality: clamp(json.contentQuality),
				layoutEffectiveness: clamp(json.layoutEffectiveness),
				conversionPotential: clamp(json.conversionPotential),
				factualAccuracy: clamp(json.factualAccuracy),
				suggestions,
				duration,
			};
		} catch (error) {
			console.error(
				`[AnalyticsEngine] Failed to parse response from ${model}:`,
				error instanceof Error ? error.message : error,
			);
			return null;
		}
	}

	/**
	 * Synthesise individual model evaluations into a single consensus result.
	 *
	 * - Dimension scores: median across all models.
	 * - Overall score: weighted average of dimension medians, scaled to 0-100.
	 * - Suggestions: deduplicated by textual similarity and merged.
	 */
	private synthesizeResults(
		results: ModelEvaluation[],
	): Pick<AnalyticsResult, 'overallScore' | 'dimensions' | 'suggestions'> {
		const dimensionKeys = [
			'contentQuality',
			'layoutEffectiveness',
			'conversionPotential',
			'factualAccuracy',
		] as const;

		// Compute median for each dimension.
		const dimensions: Record<string, number> = {};
		for (const key of dimensionKeys) {
			const values = results.map((r) => r[key]).sort((a, b) => a - b);
			dimensions[key] = this.median(values);
		}

		// Weighted average scaled to 0-100.
		let overallScore = 0;
		for (const key of dimensionKeys) {
			overallScore += dimensions[key] * (DIMENSION_WEIGHTS[key] ?? 0);
		}
		overallScore = Math.round(overallScore * 10); // 1-10 => 10-100

		// Merge and deduplicate suggestions.
		const allSuggestions: AnalyticsSuggestion[] = results.flatMap((r) => r.suggestions);
		const suggestions = this.deduplicateSuggestions(allSuggestions);

		return {
			overallScore,
			dimensions: {
				contentQuality: dimensions.contentQuality,
				layoutEffectiveness: dimensions.layoutEffectiveness,
				conversionPotential: dimensions.conversionPotential,
				factualAccuracy: dimensions.factualAccuracy,
			},
			suggestions,
		};
	}

	/** Compute the median of a sorted numeric array. */
	private median(sorted: number[]): number {
		if (sorted.length === 0) return 0;
		const mid = Math.floor(sorted.length / 2);
		if (sorted.length % 2 === 1) return sorted[mid];
		return (sorted[mid - 1] + sorted[mid]) / 2;
	}

	/**
	 * Deduplicate suggestions by comparing normalised text.  When two
	 * suggestions are deemed similar (>60 % token overlap), the one with the
	 * higher impact is kept.
	 */
	private deduplicateSuggestions(
		suggestions: AnalyticsSuggestion[],
	): AnalyticsSuggestion[] {
		const impactRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
		const kept: AnalyticsSuggestion[] = [];

		for (const suggestion of suggestions) {
			const isDuplicate = kept.some((existing) => this.isSimilar(existing.text, suggestion.text));

			if (!isDuplicate) {
				kept.push(suggestion);
			} else {
				// Replace the existing entry if the new one has higher impact.
				const idx = kept.findIndex((e) => this.isSimilar(e.text, suggestion.text));
				if (idx !== -1 && (impactRank[suggestion.impact] ?? 0) > (impactRank[kept[idx].impact] ?? 0)) {
					kept[idx] = suggestion;
				}
			}
		}

		return kept;
	}

	/**
	 * Simple token-overlap similarity check.  Returns `true` when the two
	 * strings share more than 60 % of their tokens.
	 */
	private isSimilar(a: string, b: string): boolean {
		const tokenize = (s: string): Set<string> => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));

		const tokensA = tokenize(a);
		const tokensB = tokenize(b);
		if (tokensA.size === 0 || tokensB.size === 0) return false;

		let overlap = 0;
		for (const t of tokensA) {
			if (tokensB.has(t)) overlap += 1;
		}

		const minSize = Math.min(tokensA.size, tokensB.size);
		return overlap / minSize > 0.6;
	}

	/** Generate a deterministic page ID from the query string. */
	private generatePageId(query: string): string {
		// Simple hash: use first 12 hex chars of a basic string hash.
		let hash = 0;
		for (let i = 0; i < query.length; i++) {
			const chr = query.charCodeAt(i);
			hash = ((hash << 5) - hash) + chr;
			hash |= 0; // Convert to 32-bit integer
		}
		const hex = Math.abs(hash).toString(16).padStart(8, '0');
		return `page-${hex}`;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link AnalyticsEngine} instance.
 *
 * @param projectId - Google Cloud project ID.
 * @param location  - GCP region (defaults to `us-central1`).
 */
export function createAnalyticsEngine(
	projectId: string,
	location: string = 'us-central1',
): AnalyticsEngine {
	return new AnalyticsEngine(projectId, location);
}
