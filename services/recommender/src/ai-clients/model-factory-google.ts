/**
 * Model Factory (Google-Only) - Pure Google Cloud AI stack
 *
 * Uses only Gemini and Vertex AI Model Garden models.
 * NO external providers (Anthropic, Cerebras, OpenAI).
 * Passwordless authentication via Application Default Credentials.
 */

import type { Env, ModelRole, ModelConfig, ModelPreset, ModelProvider } from '../types';
import { VertexAIClient, createVertexAIClient } from './vertex-ai-client';
import { ModelGardenClient } from './model-garden-client';

// ============================================
// Google-Only Model Presets
// ============================================

// Helper to build a preset where one model fills all 4 roles
function purePreset(provider: ModelProvider, model: string): ModelPreset {
	return {
		reasoning:       { provider, model, maxTokens: 2048, temperature: 0.7 },
		content:         { provider, model, maxTokens: 1536, temperature: 0.8 },
		classification:  { provider, model, maxTokens: 512,  temperature: 0.3 },
		validation:      { provider, model, maxTokens: 256,  temperature: 0.2 },
	};
}

// Helper to build a mixed preset: heavier model for reasoning, lighter for the rest
function mixedPreset(
	reasoningProvider: ModelProvider, reasoningModel: string,
	restProvider: ModelProvider, restModel: string,
): ModelPreset {
	return {
		reasoning:       { provider: reasoningProvider, model: reasoningModel, maxTokens: 2048, temperature: 0.7 },
		content:         { provider: restProvider,      model: restModel,      maxTokens: 1536, temperature: 0.8 },
		classification:  { provider: restProvider,      model: restModel,      maxTokens: 512,  temperature: 0.3 },
		validation:      { provider: restProvider,      model: restModel,      maxTokens: 256,  temperature: 0.2 },
	};
}

// Helper to build a Gemma preset: Gemini reasoning + Vertex endpoint content + Flash lite classification/validation
function gemmaPreset(gemmaModel: string): ModelPreset {
	return {
		reasoning:       { provider: 'google',          model: 'gemini-2.0-flash',      maxTokens: 2048, temperature: 0.7 },
		content:         { provider: 'vertex-endpoint',  model: gemmaModel,              maxTokens: 1536, temperature: 0.8 },
		classification:  { provider: 'google',          model: 'gemini-2.0-flash-lite', maxTokens: 512,  temperature: 0.3 },
		validation:      { provider: 'google',          model: 'gemini-2.0-flash-lite', maxTokens: 256,  temperature: 0.2 },
	};
}

const MODEL_PRESETS: Record<string, ModelPreset> = {
	// -- Pure presets (single model for all roles) ────────────────────────
	'gemini-3-pro':        purePreset('google', 'gemini-3-pro-preview'),
	'gemini-3-flash':      purePreset('google', 'gemini-3-flash-preview'),
	'gemini-2.5-pro':      purePreset('google', 'gemini-2.5-pro'),
	'gemini-2.5-flash':    purePreset('google', 'gemini-2.5-flash'),
	'gemini-2.0-flash':    purePreset('google', 'gemini-2.0-flash'),
	'gemini-2.0-flash-lite': purePreset('google', 'gemini-2.0-flash-lite'),
	'llama':               purePreset('model-garden', 'llama-3.3-70b-instruct-maas'),

	// -- Mixed presets (Pro/heavier reasoning + Flash/lighter rest) ───────
	'gemini-3-mixed':      mixedPreset('google', 'gemini-3-pro-preview',  'google', 'gemini-3-flash-preview'),
	'gemini-2.5-mixed':    mixedPreset('google', 'gemini-2.5-pro',        'google', 'gemini-2.5-flash'),
	'gemini-2.0-mixed':    mixedPreset('google', 'gemini-2.0-flash',      'google', 'gemini-2.0-flash-lite'),

	// -- Production alias (Gemini 3 Pro reasoning + 2.0 Flash Lite rest) ─
	'production':          mixedPreset('google', 'gemini-3-pro-preview',  'google', 'gemini-2.0-flash-lite'),

	// -- Model Garden MaaS presets (serverless open models) ──────────────
	'llama-3.2-3b':    mixedPreset('google', 'gemini-2.0-flash', 'model-garden', 'llama-3.2-3b-instruct-maas'),
	'mistral-small':   mixedPreset('google', 'gemini-2.0-flash', 'model-garden', 'mistral-small-2503'),

	// -- Gemma presets (require running Vertex AI endpoint — see deploy-gemma.sh) ─
	'gemma-3-4b':      gemmaPreset('gemma-3-4b-it'),
	'gemma-3-12b':     gemmaPreset('gemma-3-12b-it'),
};

// ============================================
// Message Types
// ============================================

export interface Message {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ModelResponse {
	content: string;
	model: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
	duration?: number;
}

// ============================================
// Model Factory Class (Google-Only)
// ============================================

export class GoogleModelFactory {
	private preset: ModelPreset;
	private presetName: string;
	private vertexAIClient: VertexAIClient;
	private modelGardenClient: ModelGardenClient;

	constructor(presetName: string = 'production', projectId?: string, location?: string) {
		this.presetName = presetName;
		this.preset = MODEL_PRESETS[presetName] || MODEL_PRESETS.production;

		// Initialize Google clients with passwordless auth
		const pid = projectId || process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
		const loc = location || process.env.GCP_LOCATION || 'us-central1';

		this.vertexAIClient = new VertexAIClient(pid, loc);
		this.modelGardenClient = new ModelGardenClient(pid, loc);
	}

	/**
	 * Get the configuration for a specific role
	 */
	getConfig(role: ModelRole): ModelConfig {
		return this.preset[role];
	}

	/**
	 * Call a model for a specific role
	 */
	async call(role: ModelRole, messages: Message[]): Promise<ModelResponse> {
		const config = this.preset[role];
		const startTime = Date.now();

		let response: ModelResponse;

		switch (config.provider) {
			case 'google':
				response = await this.callGemini(config, messages);
				break;
			case 'model-garden':
				response = await this.callModelGarden(config, messages);
				break;
			case 'vertex-endpoint':
				response = await this.callVertexEndpoint(config, messages);
				break;
			default:
				throw new Error(`Unknown provider: ${config.provider}`);
		}

		response.duration = Date.now() - startTime;
		return response;
	}

	/**
	 * Call Gemini via Vertex AI (passwordless)
	 */
	private async callGemini(
		config: ModelConfig,
		messages: Message[]
	): Promise<ModelResponse> {
		try {
			const response = await this.vertexAIClient.generateContent(
				config.model,
				messages,
				{
					temperature: config.temperature,
					maxTokens: config.maxTokens,
					stream: false,
				}
			);

			return {
				content: response.content,
				model: response.model,
				usage: response.usage,
			};
		} catch (error) {
			console.error('[GoogleModelFactory] Gemini error:', error);
			throw new Error(`Gemini generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Call Model Garden (Llama MaaS) via Vertex AI generateContent API.
	 * Llama on MaaS supports the same generateContent endpoint as Gemini,
	 * routed through publishers/meta/models/{model-id}.
	 */
	private async callModelGarden(
		config: ModelConfig,
		messages: Message[]
	): Promise<ModelResponse> {
		try {
			const response = await this.vertexAIClient.generateContent(
				config.model,
				messages,
				{
					temperature: config.temperature,
					maxTokens: config.maxTokens,
					stream: false,
				}
			);

			return {
				content: response.content,
				model: response.model,
				usage: response.usage,
			};
		} catch (error) {
			console.error('[GoogleModelFactory] Model Garden error:', error);
			throw new Error(`Model Garden generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Call a Gemma model on a dedicated Vertex AI Endpoint (GPU).
	 * Requires GEMMA_ENDPOINT_ID env var pointing to an active endpoint
	 * deployed via infrastructure/vertex-ai/deploy-gemma.sh.
	 */
	private async callVertexEndpoint(
		config: ModelConfig,
		messages: Message[]
	): Promise<ModelResponse> {
		const endpointId = process.env.GEMMA_ENDPOINT_ID;
		if (!endpointId) {
			throw new Error(
				'GEMMA_ENDPOINT_ID environment variable is not set. '
				+ 'Deploy a Gemma endpoint first: ./infrastructure/vertex-ai/deploy-gemma.sh 4b|12b'
			);
		}

		try {
			const response = await this.vertexAIClient.callEndpoint(
				endpointId,
				config.model,
				messages,
				{
					temperature: config.temperature,
					maxTokens: config.maxTokens,
				}
			);

			return {
				content: response.content,
				model: response.model,
				usage: response.usage,
			};
		} catch (error) {
			console.error('[GoogleModelFactory] Vertex Endpoint error:', error);
			throw new Error(`Vertex AI Endpoint generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Get the current preset name
	 */
	getPresetName(): string {
		return this.presetName;
	}

	/**
	 * Get available presets
	 */
	static getAvailablePresets(): string[] {
		return Object.keys(MODEL_PRESETS);
	}
}

/**
 * Create a GoogleModelFactory instance
 * @param presetOverride - Optional preset override from query parameter
 */
export function createGoogleModelFactory(
	presetOverride?: string,
	projectId?: string,
	location?: string
): GoogleModelFactory {
	// Get preset from parameter or environment
	const preset = presetOverride || process.env.MODEL_PRESET || 'production';

	return new GoogleModelFactory(preset, projectId, location);
}
