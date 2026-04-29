-- Add time_to_first_token_ms to experiment_variants.
-- Records how long (ms) elapsed from the LLM request start until the
-- first token was received from the provider.

ALTER TABLE experiment_variants ADD COLUMN time_to_first_token_ms INTEGER;
