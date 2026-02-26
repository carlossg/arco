/**
 * Espresso Ratio Calculator
 *
 * Calculates brew ratio, evaluates extraction time against target windows,
 * predicts taste profile, and provides actionable adjustment recommendations.
 *
 * @param {object} inputs
 * @param {number} inputs.dose - Coffee dose in grams (6-25)
 * @param {number} inputs.target_yield - Beverage yield in grams (15-80)
 * @param {number} inputs.actual_time - Extraction time in seconds (10-60)
 * @returns {object} result
 */
export function calculate({ dose, target_yield: yield_, actual_time: time }) {
  const ratio = yield_ / dose;
  const ratioLabel = `1:${ratio.toFixed(2)}`;

  // Determine shot style based on ratio
  let shotStyle;
  if (ratio <= 1.5) shotStyle = 'ristretto';
  else if (ratio <= 2.5) shotStyle = 'normale';
  else if (ratio <= 3.0) shotStyle = 'lungo';
  else shotStyle = 'extra-lungo';

  // Ideal time windows shift with ratio
  const idealTimeMin = shotStyle === 'ristretto' ? 20 : 24;
  const idealTimeMax = shotStyle === 'lungo' || shotStyle === 'extra-lungo' ? 35 : 30;
  const timeInRange = time >= idealTimeMin && time <= idealTimeMax;

  // Taste prediction logic
  let tastePrediction;
  let confidence;
  const recommendations = [];

  const timeDelta = time < idealTimeMin
    ? idealTimeMin - time
    : time > idealTimeMax
      ? time - idealTimeMax
      : 0;

  if (timeInRange && ratio >= 1.8 && ratio <= 2.5) {
    tastePrediction = 'balanced';
    confidence = 'high';
  } else if (time < idealTimeMin) {
    // Fast shot — under-extracted
    tastePrediction = 'under-extracted';
    confidence = timeDelta > 5 ? 'high' : 'moderate';
    if (timeDelta > 8) {
      recommendations.push('Grind significantly finer — your shot is channeling or the grind is far too coarse.');
    } else if (timeDelta > 4) {
      recommendations.push('Grind 2-3 steps finer to slow the flow and increase extraction.');
    } else {
      recommendations.push('Grind 1 step finer. You are close to the target window.');
    }
    if (ratio > 2.5) {
      recommendations.push('Consider reducing yield to 2x dose for a more concentrated, balanced shot.');
    }
  } else if (time > idealTimeMax) {
    // Slow shot — over-extracted
    tastePrediction = 'over-extracted';
    confidence = timeDelta > 5 ? 'high' : 'moderate';
    if (timeDelta > 8) {
      recommendations.push('Grind significantly coarser — the puck is choking the machine.');
    } else if (timeDelta > 4) {
      recommendations.push('Grind 2-3 steps coarser to speed up flow and reduce bitterness.');
    } else {
      recommendations.push('Grind 1 step coarser. You are nearly dialed in.');
    }
    if (ratio < 1.8) {
      recommendations.push('Consider increasing yield to 2x dose to dilute intensity and reduce harshness.');
    }
  } else {
    // Time is fine but ratio is outside the sweet spot
    if (ratio < 1.5) {
      tastePrediction = 'intense-possibly-under';
      confidence = 'moderate';
      recommendations.push('Your ristretto ratio is very tight. If the shot tastes sour, increase yield by 3-5g.');
    } else if (ratio > 3.0) {
      tastePrediction = 'dilute-possibly-over';
      confidence = 'moderate';
      recommendations.push('Your lungo ratio may cause over-extraction. Reduce yield or try a coarser grind with shorter contact time.');
    } else {
      tastePrediction = 'balanced';
      confidence = 'moderate';
    }
  }

  if (recommendations.length === 0 && tastePrediction === 'balanced') {
    recommendations.push('Your shot parameters look well balanced. Taste it — if it is sweet with pleasant acidity and no harshness, lock in this recipe.');
  }

  // Extraction estimate (simplified Brix approximation)
  const estimatedExtraction = Math.min(
    26,
    Math.max(14, 18 + (time - 27) * 0.3 + (ratio - 2) * 1.2),
  );

  return {
    ratio: parseFloat(ratio.toFixed(2)),
    ratio_label: ratioLabel,
    shot_style: shotStyle,
    time_in_range: timeInRange,
    ideal_time_window: `${idealTimeMin}-${idealTimeMax}s`,
    taste_prediction: tastePrediction,
    confidence,
    estimated_extraction_pct: parseFloat(estimatedExtraction.toFixed(1)),
    adjustment_recommendations: recommendations,
  };
}
