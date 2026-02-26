/**
 * Grinder Setting Guide Calculator
 *
 * Recommends a starting grind setting for an Arco grinder based on
 * brew method, bean origin, and roast level. Provides adjustment
 * direction and expected brew time targets.
 *
 * @param {object} inputs
 * @param {string} inputs.grinder_model - Arco grinder identifier
 * @param {string} inputs.brew_method - Brewing method
 * @param {string} inputs.bean_origin_type - Geographic origin category
 * @param {string} inputs.roast_level - Roast darkness level
 * @returns {object} result
 */
export function calculate({ grinder_model, brew_method, bean_origin_type, roast_level }) {
  // Grinder profiles: total_steps and base espresso setting
  const grinders = {
    'arco-macinino-pro': {
      label: 'Arco Macinino Pro',
      totalSteps: 120,
      burrSize: '64mm flat',
      baseSettings: {
        espresso: 25,
        v60: 58,
        chemex: 65,
        aeropress: 48,
        'french-press': 85,
        'cold-brew': 95,
      },
    },
    'arco-macinino-home': {
      label: 'Arco Macinino Home',
      totalSteps: 80,
      burrSize: '50mm flat',
      baseSettings: {
        espresso: 16,
        v60: 38,
        chemex: 43,
        aeropress: 32,
        'french-press': 56,
        'cold-brew': 64,
      },
    },
    'arco-conico': {
      label: 'Arco Conico',
      totalSteps: 60,
      burrSize: '58mm conical',
      baseSettings: {
        espresso: 10,
        v60: 26,
        chemex: 30,
        aeropress: 22,
        'french-press': 40,
        'cold-brew': 46,
      },
    },
    'arco-mini-grinder': {
      label: 'Arco Mini Grinder',
      totalSteps: 40,
      burrSize: '38mm flat',
      baseSettings: {
        espresso: 8,
        v60: 18,
        chemex: 21,
        aeropress: 15,
        'french-press': 28,
        'cold-brew': 33,
      },
    },
  };

  // Roast level offset: lighter = finer (negative offset), darker = coarser (positive)
  const roastOffsets = {
    light: -3,
    'medium-light': -1,
    medium: 0,
    'medium-dark': 2,
    dark: 4,
  };

  // Origin density offset: denser beans benefit from slightly finer grind
  const originOffsets = {
    african: -2,
    'central-american': -1,
    'south-american': 0,
    asian: 1,
    blend: 0,
  };

  const grinder = grinders[grinder_model] || grinders['arco-macinino-home'];
  const baseSetting = grinder.baseSettings[brew_method] || grinder.baseSettings.espresso;

  // Scale offsets relative to grinder step resolution
  const scaleFactor = grinder.totalSteps / 80; // normalize to 80-step reference
  const roastOffset = Math.round((roastOffsets[roast_level] || 0) * scaleFactor);
  const originOffset = Math.round((originOffsets[bean_origin_type] || 0) * scaleFactor);

  let recommended = baseSetting + roastOffset + originOffset;
  recommended = Math.max(1, Math.min(grinder.totalSteps, recommended));

  const adjustmentRange = Math.max(2, Math.round(3 * scaleFactor));
  const settingMin = Math.max(1, recommended - adjustmentRange);
  const settingMax = Math.min(grinder.totalSteps, recommended + adjustmentRange);

  // Expected brew time targets
  const brewTimeTargets = {
    espresso: { dose: '18g', yield: '36g', time: '25-30s' },
    v60: { dose: '15g', yield: '250ml', time: '2:30-3:00' },
    chemex: { dose: '30g', yield: '500ml', time: '3:30-4:30' },
    aeropress: { dose: '15g', yield: '200ml', time: '1:30-2:30' },
    'french-press': { dose: '30g', yield: '500ml', time: '4:00 steep' },
    'cold-brew': { dose: '70g', yield: '500ml', time: '12-18h steep' },
  };

  const target = brewTimeTargets[brew_method] || brewTimeTargets.espresso;

  // Adjustment guidance
  const adjustmentNotes = [];

  if (roast_level === 'light' || roast_level === 'medium-light') {
    adjustmentNotes.push(
      'Light roasts are denser and harder to extract. If the cup tastes sour or tea-like, go 1-2 steps finer.',
    );
  }
  if (roast_level === 'dark') {
    adjustmentNotes.push(
      'Dark roasts extract quickly and can become ashy. If bitter, go 1-2 steps coarser or reduce contact time.',
    );
  }
  if (bean_origin_type === 'african') {
    adjustmentNotes.push(
      'African beans (especially Ethiopian naturals) can produce more fines. If your V60 stalls, go 1 step coarser.',
    );
  }
  if (bean_origin_type === 'asian') {
    adjustmentNotes.push(
      'Indonesian and Sumatran beans are often low-density. They extract easily — err on the coarser side.',
    );
  }
  if (brew_method === 'espresso') {
    adjustmentNotes.push(
      'For espresso: if the shot runs fast and tastes sour, grind finer. If it chokes and tastes bitter, grind coarser.',
    );
  }
  if (brew_method === 'french-press') {
    adjustmentNotes.push(
      'French press requires an even, coarse grind to avoid silt. If your cup is muddy, go 2-3 steps coarser.',
    );
  }

  return {
    grinder: grinder.label,
    burr_size: grinder.burrSize,
    total_steps: grinder.totalSteps,
    recommended_setting: recommended,
    setting_range: `${settingMin} - ${settingMax}`,
    brew_target: target,
    adjustment_direction: 'Finer if sour/weak, coarser if bitter/astringent',
    adjustment_notes: adjustmentNotes,
  };
}
