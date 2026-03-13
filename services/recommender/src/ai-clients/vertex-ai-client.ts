/**
 * Vertex AI Client - Google Cloud Gemini integration with passwordless auth
 *
 * Uses Application Default Credentials (ADC) for authentication.
 * Supports both Gemini models and Vertex AI Model Garden.
 */

import type { Env } from '../types';

// Message types for chat completions
export interface Message {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface VertexAIResponse {
	content: string;
	model: string;
	stopReason?: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

/**
 * Vertex AI Client using @google-cloud/vertexai SDK
 * Authenticates via Application Default Credentials (passwordless)
 */
export class VertexAIClient {
	private projectId: string;
	private location: string;

	constructor(projectId: string, location: string = 'us-central1') {
		this.projectId = projectId;
		this.location = location;
	}

	/** Known Model Garden MaaS publishers (non-Google) */
	private static readonly MAAS_PUBLISHERS: Record<string, string> = {
		'llama': 'meta',
		'mistral': 'mistralai',
	};

	/**
	 * Determine the correct Vertex AI location for a model.
	 * Use the global endpoint for all Gemini models to maximize quota availability.
	 * Fall back to the configured regional endpoint for non-Gemini models (e.g. MaaS).
	 */
	private getLocationForModel(model: string): string {
		if (model.startsWith('gemini')) {
			return 'global';
		}
		return this.location;
	}

	/**
	 * Build the model resource name.
	 * Google models use short IDs (e.g. "gemini-3-pro-preview").
	 * Model Garden MaaS models need the full resource path with their publisher
	 * (e.g. "projects/.../publishers/meta/models/llama-3.3-70b-instruct-maas").
	 */
	private getModelResourceName(model: string, location: string): string {
		for (const [prefix, publisher] of Object.entries(VertexAIClient.MAAS_PUBLISHERS)) {
			if (model.startsWith(prefix)) {
				return `projects/${this.projectId}/locations/${location}/publishers/${publisher}/models/${model}`;
			}
		}
		return model;
	}

	/**
	 * Generate content using Gemini models
	 */
	async generateContent(
		model: string,
		messages: Message[],
		options: {
			temperature?: number;
			maxTokens?: number;
			stream?: boolean;
		} = {}
	): Promise<VertexAIResponse> {
		const { VertexAI } = await import('@google-cloud/vertexai');

		// Gemini 3 models require the "global" endpoint; others use configured location
		const location = this.getLocationForModel(model);
		const isGlobal = location === 'global';

		// Initialize Vertex AI with ADC (no API keys)
		const vertexAI = new VertexAI({
			project: this.projectId,
			location,
			...(isGlobal ? { apiEndpoint: 'aiplatform.googleapis.com' } : {}),
		});

		// Model Garden MaaS models (e.g. Llama) need the full resource path with publisher
		const modelId = this.getModelResourceName(model, location);

		// Thinking models (Gemini 3, Gemini 2.5 Pro) need a higher token budget
		// because thinking tokens count against maxOutputTokens.
		const isThinkingModel = model.startsWith('gemini-3') || model.startsWith('gemini-2.5');
		const maxOutputTokens = isThinkingModel
			? Math.max((options.maxTokens ?? 4096) * 4, 8192)
			: (options.maxTokens ?? 4096);

		const generativeModel = vertexAI.getGenerativeModel({
			model: modelId,
			generationConfig: {
				temperature: options.temperature ?? 0.7,
				maxOutputTokens,
			},
		});

		// Convert messages to Gemini format
		const contents = this.convertMessagesToGeminiFormat(messages);

		try {
			const result = await generativeModel.generateContent({ contents });
			const response = result.response;

			// Thinking models (e.g. Gemini 3 Pro) return multi-part responses:
			// parts[0] = thinking content (thought: true), parts[1] = actual output.
			// Extract the last non-thought part for the actual response text.
			const parts = response.candidates?.[0]?.content?.parts || [];
			let text = '';
			for (let i = parts.length - 1; i >= 0; i--) {
				if (!(parts[i] as any).thought && parts[i]?.text) {
					text = parts[i].text!;
					break;
				}
			}
			if (!text) {
				text = parts[0]?.text || '';
			}

			return {
				content: text,
				model: model,
				usage: {
					inputTokens: response.usageMetadata?.promptTokenCount || 0,
					outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
				},
			};
		} catch (error) {
			console.error('[VertexAI] Generation error:', error);
			throw new Error(`Vertex AI generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Convert standard messages to Gemini format
	 * Gemini uses a different message structure than OpenAI/Anthropic
	 */
	private convertMessagesToGeminiFormat(messages: Message[]): any[] {
		// Combine system messages into the first user message
		let systemContent = '';
		const contentMessages: Message[] = [];

		for (const msg of messages) {
			if (msg.role === 'system') {
				systemContent += msg.content + '\n\n';
			} else {
				contentMessages.push(msg);
			}
		}

		// If we have system content, prepend it to the first user message
		if (systemContent && contentMessages.length > 0 && contentMessages[0].role === 'user') {
			contentMessages[0] = {
				...contentMessages[0],
				content: systemContent + contentMessages[0].content,
			};
		}

		// Convert to Gemini format
		return contentMessages.map((msg) => ({
			role: msg.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: msg.content }],
		}));
	}

	/**
	 * Call a Vertex AI Endpoint (dedicated GPU deployment, e.g. Gemma via vLLM).
	 * vLLM exposes an OpenAI-compatible /v1/chat/completions route, but when
	 * accessed through the Vertex AI Endpoint proxy we use the :rawPredict RPC
	 * which forwards the request body directly to the container.
	 */
	async callEndpoint(
		endpointId: string,
		model: string,
		messages: Message[],
		options: {
			temperature?: number;
			maxTokens?: number;
		} = {}
	): Promise<VertexAIResponse> {
		const { GoogleAuth } = await import('google-auth-library');
		const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
		const client = await auth.getClient();
		const token = await client.getAccessToken();

		const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/endpoints/${endpointId}:rawPredict`;

		// vLLM serves OpenAI-compatible chat completions format
		const body = {
			model,
			messages: messages.map((m) => ({ role: m.role, content: m.content })),
			temperature: options.temperature ?? 0.7,
			max_tokens: options.maxTokens ?? 4096,
			stream: false,
		};

		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${token.token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Vertex AI Endpoint ${endpointId} returned ${res.status}: ${text}`);
			}

			const data = await res.json() as any;
			const content = data.choices?.[0]?.message?.content || '';
			const usage = data.usage || {};

			return {
				content,
				model,
				usage: {
					inputTokens: usage.prompt_tokens || 0,
					outputTokens: usage.completion_tokens || 0,
				},
			};
		} catch (error) {
			console.error('[VertexAI] Endpoint call error:', error);
			throw new Error(`Vertex AI Endpoint call failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Generate embeddings using Vertex AI Text Embeddings API.
	 *
	 * @param texts - Array of texts to embed.
	 * @param taskType - Optional task type hint for the embedding model.
	 *   Use `'RETRIEVAL_DOCUMENT'` when indexing content and
	 *   `'RETRIEVAL_QUERY'` when embedding a search query.
	 *   Defaults to `'RETRIEVAL_QUERY'`.
	 */
	async generateEmbeddings(
		texts: string[],
		taskType: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' = 'RETRIEVAL_QUERY',
	): Promise<number[][]> {
		const { PredictionServiceClient } = await import('@google-cloud/aiplatform');

		// Initialize client with ADC
		const client = new PredictionServiceClient({
			apiEndpoint: `${this.location}-aiplatform.googleapis.com`,
		});

		const endpoint = `projects/${this.projectId}/locations/${this.location}/publishers/google/models/text-embedding-005`;

		try {
			const instances = texts.map((text) => ({
				content: text,
				task_type: taskType,
			})) as any[];

			const response = await client.predict({
				endpoint,
				instances,
			});

			// Extract embeddings from predictions
			const embeddings: number[][] = [];
			const predictions = Array.isArray(response) ? response[0]?.predictions : (response as any).predictions;
			for (const prediction of predictions || []) {
				const embedding = (prediction as any).embeddings?.values || [];
				embeddings.push(embedding);
			}

			return embeddings;
		} catch (error) {
			console.error('[VertexAI] Embeddings error:', error);
			throw new Error(`Vertex AI embeddings failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}
}

/**
 * Create Vertex AI client instance
 * Automatically uses Application Default Credentials
 */
export function createVertexAIClient(env: Env): VertexAIClient {
	// Get project ID from environment or use default
	const projectId = env.GCP_PROJECT_ID || process.env.GCP_PROJECT_ID || 'arco-recommender';
	const location = env.GCP_LOCATION || process.env.GCP_LOCATION || 'us-central1';

	return new VertexAIClient(projectId, location);
}
