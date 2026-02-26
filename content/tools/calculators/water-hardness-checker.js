/**
 * Water Hardness Checker
 *
 * Evaluates water hardness from TDS or °dH, calculates a personalized
 * descaling schedule based on machine model and daily usage, and recommends
 * appropriate filtration.
 *
 * @param {object} inputs
 * @param {number|null} inputs.tds_ppm - Total dissolved solids in ppm
 * @param {number|null} inputs.hardness_dh - German hardness degrees (°dH)
 * @param {string} inputs.machine_model - Arco machine identifier
 * @param {number} inputs.cups_per_day - Average cups brewed per day
 * @returns {object} result
 */
export function calculate({ tds_ppm, hardness_dh, machine_model, cups_per_day }) {
  // Convert to °dH as the canonical unit
  const DH_TO_PPM = 17.8;
  let dh;
  if (hardness_dh != null && hardness_dh > 0) {
    dh = hardness_dh;
  } else if (tds_ppm != null) {
    dh = tds_ppm / DH_TO_PPM;
  } else {
    return { error: 'Please provide either TDS (ppm) or water hardness (°dH).' };
  }

  const ppm = dh * DH_TO_PPM;

  // Hardness category
  let hardnessCategory;
  if (dh < 7) hardnessCategory = 'soft';
  else if (dh < 14) hardnessCategory = 'medium';
  else if (dh < 21) hardnessCategory = 'hard';
  else hardnessCategory = 'very hard';

  // Machine-specific boiler volumes and scale sensitivity
  const machineProfiles = {
    'arco-maestro': { boilerLitres: 2.0, sensitivity: 1.3, type: 'heat-exchange' },
    'arco-classica': { boilerLitres: 1.0, sensitivity: 1.0, type: 'single-boiler' },
    'arco-nano': { boilerLitres: 0.5, sensitivity: 0.8, type: 'thermoblock' },
    'arco-automatico': { boilerLitres: 1.2, sensitivity: 1.1, type: 'automatic' },
    'arco-barista-pro': { boilerLitres: 1.5, sensitivity: 1.2, type: 'single-boiler' },
    'arco-dual-boiler': { boilerLitres: 2.5, sensitivity: 1.4, type: 'dual-boiler' },
    'arco-lever': { boilerLitres: 0.8, sensitivity: 0.9, type: 'lever' },
    'arco-steam': { boilerLitres: 0.3, sensitivity: 0.7, type: 'steam-driven' },
  };

  const profile = machineProfiles[machine_model] || machineProfiles['arco-classica'];

  // Descaling interval calculation
  // Base interval: 12 weeks at 10 °dH, 3 cups/day, sensitivity 1.0
  const baseWeeks = 12;
  const hardnessFactor = Math.max(0.3, 10 / Math.max(dh, 1));
  const usageFactor = Math.max(0.4, 3 / Math.max(cups_per_day, 1));
  const sensitivityFactor = 1 / profile.sensitivity;

  let descalingWeeks = Math.round(baseWeeks * hardnessFactor * usageFactor * sensitivityFactor);
  descalingWeeks = Math.max(2, Math.min(52, descalingWeeks));

  // Risk level
  let riskLevel;
  let riskExplanation;
  if (dh < 5) {
    riskLevel = 'low';
    riskExplanation = 'Your water is soft. Scale buildup will be minimal, but very soft water can be slightly corrosive to brass components over many years. A small amount of mineral content is actually beneficial for taste.';
  } else if (dh < 12) {
    riskLevel = 'moderate';
    riskExplanation = 'Your water is in a good range for espresso. Moderate mineral content enhances flavour extraction. Follow the recommended descaling schedule and your machine will perform well.';
  } else if (dh < 21) {
    riskLevel = 'high';
    riskExplanation = 'Hard water accelerates limescale deposits on heating elements and in boilers. Without regular descaling and filtration, you risk flow restriction, temperature instability, and premature component failure.';
  } else {
    riskLevel = 'critical';
    riskExplanation = 'Very hard water will cause rapid scale buildup. A quality water filter is essential — not optional. Without one, internal components can clog within weeks of heavy use, potentially voiding your warranty.';
  }

  // Filter recommendation
  let recommendedFilter;
  let filterNotes;
  if (dh < 5) {
    recommendedFilter = 'Arco Taste Optimiser Filter';
    filterNotes = 'Your water is already soft. This filter balances mineral content for optimal espresso flavour without further softening.';
  } else if (dh < 14) {
    recommendedFilter = 'Arco Standard Water Filter Cartridge';
    filterNotes = 'Reduces hardness to the ideal 4-8 °dH range while preserving enough minerals for great-tasting espresso. Replace every 2 months or 50 litres.';
  } else if (dh < 25) {
    recommendedFilter = 'Arco Pro Water Filter Cartridge';
    filterNotes = 'High-capacity ion exchange filter designed for hard water areas. Reduces hardness by up to 80%. Replace monthly or every 40 litres at this hardness level.';
  } else {
    recommendedFilter = 'Arco Max Protection Filter + Pre-filter';
    filterNotes = 'For very hard water, a two-stage filtration system is recommended. The pre-filter handles sediment and chlorine; the main cartridge targets calcium and magnesium. Replace the pre-filter quarterly, main cartridge monthly.';
  }

  // Ideal water spec for espresso (SCA guideline)
  const idealRange = { min_tds: 75, max_tds: 250, ideal_tds: 150, min_dh: 4, max_dh: 8 };

  return {
    measured_dh: parseFloat(dh.toFixed(1)),
    measured_ppm: Math.round(ppm),
    hardness_category: hardnessCategory,
    descaling_frequency_weeks: descalingWeeks,
    descaling_frequency_label: descalingWeeks <= 4
      ? `Every ${descalingWeeks} weeks`
      : `Every ${Math.round(descalingWeeks / 4)} months`,
    recommended_filter: recommendedFilter,
    filter_notes: filterNotes,
    risk_level: riskLevel,
    risk_explanation: riskExplanation,
    machine_type: profile.type,
    ideal_water_range: idealRange,
    in_ideal_range: dh >= idealRange.min_dh && dh <= idealRange.max_dh,
  };
}
