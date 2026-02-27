/**
 * Evaluation prompts for the multi-model analytics engine.
 *
 * Builds a structured prompt that asks an LLM to score a generated
 * recommender page across four quality dimensions and return
 * actionable improvement suggestions.
 */

/**
 * Build the evaluation prompt sent to each model in the analytics
 * ensemble.  The prompt includes the full generated HTML together with
 * the original user query and classified intent so the evaluator has
 * complete context.
 *
 * The response is requested as JSON matching the ModelEvaluation shape
 * (without the `model` and `duration` fields which are added by the
 * caller).
 */
export function buildEvaluationPrompt(
	html: string,
	query: string,
	intent: string,
): string {
	return `You are a quality evaluator for an AI-generated web page.

Given the HTML of a page generated in response to a user query, score the page on four dimensions (1-10 each) and suggest improvements.

## User Query
${query}

## Classified Intent
${intent}

## Scoring Rubric

**contentQuality** (1-10)
- Does the content directly address the query?
- Are product recommendations relevant to the intent?
- Is the copy engaging, clear, and free of filler?
- 1 = completely off-topic, 10 = perfectly targeted and compelling

**layoutEffectiveness** (1-10)
- Are the chosen blocks appropriate for this intent?
- Is the information hierarchy logical (most important content first)?
- Does the visual flow guide the reader naturally?
- 1 = confusing layout, 10 = optimal structure for the intent

**conversionPotential** (1-10)
- Are calls-to-action clear and well-placed?
- Does the page guide the user toward a next step?
- Is the level of persuasion appropriate for the journey stage?
- 1 = no clear path forward, 10 = compelling, stage-appropriate guidance

**factualAccuracy** (1-10)
- Are product names, prices, and specifications correct?
- Are there any hallucinated features or invented data?
- Do links and references appear valid?
- 1 = multiple factual errors, 10 = fully accurate

## Instructions
1. Read the HTML carefully.
2. Score each dimension using the rubric above.
3. Provide 3-5 concrete improvement suggestions. For each suggestion include:
   - "text": a short actionable description
   - "dimension": which scoring dimension it relates to
   - "impact": "high", "medium", or "low"
   - "effort": "high", "medium", or "low"
4. Respond with ONLY valid JSON (no markdown fencing, no explanation).

## Required JSON Shape
{
  "contentQuality": <number 1-10>,
  "layoutEffectiveness": <number 1-10>,
  "conversionPotential": <number 1-10>,
  "factualAccuracy": <number 1-10>,
  "suggestions": [
    { "text": "...", "dimension": "...", "impact": "high|medium|low", "effort": "high|medium|low" }
  ]
}

## Generated Page HTML
${html}`;
}
