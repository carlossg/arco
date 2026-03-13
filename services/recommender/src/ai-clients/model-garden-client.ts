import { EndpointServiceClient, PredictionServiceClient } from '@google-cloud/aiplatform';
import { protos } from '@google-cloud/aiplatform';

/**
 * Vertex AI Model Garden client for open source models (Llama 3.3, Mistral)
 * Uses Application Default Credentials (passwordless)
 * Used for high-speed content generation
 */

export interface ModelGardenOptions {
	temperature?: number;
	topP?: number;
	topK?: number;
	maxTokens?: number;
}

export class ModelGardenClient {
	private predictionClient: PredictionServiceClient;
	private projectId: string;
	private location: string;

	// Model Garden endpoints (will be configured after deployment)
	private readonly LLAMA_33_70B_ENDPOINT = 'llama-3.3-70b-instruct-maas';
	private readonly MISTRAL_LARGE_ENDPOINT = 'mistral-large-2411';

	constructor(projectId?: string, location: string = 'us-central1') {
		// Passwordless - uses Application Default Credentials
		this.projectId = projectId || process.env.GOOGLE_CLOUD_PROJECT || '';
		this.location = location;

		this.predictionClient = new PredictionServiceClient({
			apiEndpoint: `${this.location}-aiplatform.googleapis.com`,
		});
	}

	/**
	 * Generate content using Llama 3.3 70B
	 */
	async generateWithLlama(
		prompt: string,
		options?: ModelGardenOptions
	): Promise<string> {
		return this.predict(this.LLAMA_33_70B_ENDPOINT, prompt, options);
	}

	/**
	 * Generate content using Mistral Large
	 */
	async generateWithMistral(
		prompt: string,
		options?: ModelGardenOptions
	): Promise<string> {
		return this.predict(this.MISTRAL_LARGE_ENDPOINT, prompt, options);
	}

	/**
	 * Core prediction method for Model Garden models
	 */
	private async predict(
		modelId: string,
		prompt: string,
		options?: ModelGardenOptions
	): Promise<string> {
		try {
			const endpoint = `projects/${this.projectId}/locations/${this.location}/publishers/meta/models/${modelId}`;

			// Prepare the request
			const instanceValue = {
				prompt,
				max_tokens: options?.maxTokens || 2048,
				temperature: options?.temperature || 0.7,
				top_p: options?.topP || 0.9,
				top_k: options?.topK || 40,
			};

			const instances = [instanceValue];
			const request = {
				endpoint,
				instances: instances.map(instance => ({
					structValue: this.toProtobufStruct(instance),
				})),
			};

			// Make prediction
			const [response] = await this.predictionClient.predict(request as any);

			// Extract generated text from response
			const predictions = response.predictions;
			if (predictions && predictions.length > 0) {
				const prediction = predictions[0];
				const text = (prediction as any).structValue?.fields?.generated_text?.stringValue || '';
				return text;
			}

			throw new Error('No predictions returned from model');
		} catch (error) {
			console.error(`Error predicting with ${modelId}:`, error);
			throw error;
		}
	}

	/**
	 * Generate block content using Llama 3.3 (high-speed generation)
	 */
	async generateBlockContent(
		blockType: string,
		config: any,
		productData?: any
	): Promise<string> {
		const prompt = `You are generating HTML content for an Arco coffee equipment page block.

Block Type: ${blockType}

Configuration:
${JSON.stringify(config, null, 2)}

${productData ? `Product/Brew Guide Data:\n${JSON.stringify(productData, null, 2)}\n` : ''}

Generate clean, semantic HTML for this block following AEM Edge Delivery Services conventions:
- Use appropriate div wrappers with class="${blockType}"
- Include tables for structured data if needed
- Add images with proper alt text
- Include CTAs where appropriate
- Keep HTML concise and accessible

Output ONLY the HTML, no explanations or markdown formatting.

HTML:`;

		return this.generateWithLlama(prompt, {
			temperature: 0.8,
			maxTokens: 4096,
		});
	}

	/**
	 * Convert JavaScript object to Protobuf Struct
	 */
	private toProtobufStruct(obj: any): protos.google.protobuf.IStruct {
		const fields: { [key: string]: protos.google.protobuf.IValue } = {};

		for (const [key, value] of Object.entries(obj)) {
			fields[key] = this.toProtobufValue(value);
		}

		return { fields };
	}

	/**
	 * Convert JavaScript value to Protobuf Value
	 */
	private toProtobufValue(value: any): protos.google.protobuf.IValue {
		if (value === null) {
			return { nullValue: 'NULL_VALUE' } as any;
		} else if (typeof value === 'number') {
			return { numberValue: value };
		} else if (typeof value === 'string') {
			return { stringValue: value };
		} else if (typeof value === 'boolean') {
			return { boolValue: value };
		} else if (Array.isArray(value)) {
			return {
				listValue: {
					values: value.map(v => this.toProtobufValue(v)),
				},
			};
		} else if (typeof value === 'object') {
			return { structValue: this.toProtobufStruct(value) };
		}

		return { stringValue: String(value) };
	}

	/**
	 * Check if a model endpoint is available
	 */
	async checkModelAvailability(modelId: string): Promise<boolean> {
		try {
			const endpoint = `projects/${this.projectId}/locations/${this.location}/publishers/meta/models/${modelId}`;

			// Try a simple prediction to check availability
			const testPrompt = 'Hello';
			await this.predict(modelId, testPrompt, { maxTokens: 10 });

			return true;
		} catch (error) {
			console.error(`Model ${modelId} is not available:`, error);
			return false;
		}
	}

	/**
	 * Get available Model Garden models
	 */
	async listAvailableModels(): Promise<string[]> {
		const models = [
			this.LLAMA_33_70B_ENDPOINT,
			this.MISTRAL_LARGE_ENDPOINT,
		];

		const available: string[] = [];

		for (const model of models) {
			if (await this.checkModelAvailability(model)) {
				available.push(model);
			}
		}

		return available;
	}
}
