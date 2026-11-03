const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const list = (maxItems, maxLength) => ({
  type: 'array', maxItems, items: text(maxLength),
});

export const CONVERSATION_CONTEXT_SCHEMA = {
  type: 'object',
  description: 'Summarize relevant coffee preferences explicitly shared in this conversation. '
    + 'Include this when available, even if the latest message only names products. '
    + 'Do not invent facts or send names, contact details, sensitive information, or the full transcript.',
  additionalProperties: false,
  properties: {
    summary: text(2000),
    preferences: {
      type: 'object',
      additionalProperties: false,
      properties: {
        budgetUsd: { type: 'number', minimum: 1, maximum: 100000 },
        drinks: list(10, 100),
        people: { type: 'integer', minimum: 1, maximum: 100 },
        priorities: list(10, 200),
      },
    },
    productsDiscussed: list(20, 100),
  },
};

function validate(value, schema, path) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path} must be an object.`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      const rule = schema.properties[key];
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown context field: ${path}.${key}`);
      return [key, validate(entry, rule, `${path}.${key}`)];
    }));
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) {
      throw new Error(`${path} must be a list of at most ${schema.maxItems} items.`);
    }
    return value.map((entry) => validate(entry, schema.items, path));
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length > schema.maxLength) {
      throw new Error(`${path} must be nonempty text of at most ${schema.maxLength} characters.`);
    }
    return value.trim();
  }
  if (!Number.isFinite(value) || value < schema.minimum || value > schema.maximum
    || (schema.type === 'integer' && !Number.isInteger(value))) {
    throw new Error(`${path} must be ${schema.type} between ${schema.minimum} and ${schema.maximum}.`);
  }
  return value;
}

export function normalizeConversationContext(value) {
  if (value === undefined) return undefined;
  return validate(value, CONVERSATION_CONTEXT_SCHEMA, 'conversationContext');
}

export function conversationSearchText(context) {
  if (!context) return '';
  const { preferences = {} } = context;
  return [
    ...(preferences.drinks || []),
    ...(preferences.priorities || []),
    ...(preferences.budgetUsd ? [`budget ${preferences.budgetUsd} USD`] : []),
    ...(preferences.people ? [`for ${preferences.people} people`] : []),
    ...(context.productsDiscussed || []),
    context.summary,
  ].filter(Boolean).join('; ');
}
