/**
 * Capsule vs. Bean Cost Comparison Calculator
 *
 * Compares the ongoing cost of capsule coffee against whole-bean espresso
 * with an Arco machine, accounting for equipment investment. Returns
 * break-even timeline, monthly costs, and five-year projections.
 *
 * @param {object} inputs
 * @param {number} inputs.cups_per_day - Daily cup consumption
 * @param {number} inputs.capsule_cost_per_cup - Price per single capsule
 * @param {string} inputs.target_machine - Arco machine identifier
 * @param {number} inputs.coffee_budget_per_kg - Price per kilogram of beans
 * @returns {object} result
 */
export function calculate({ cups_per_day, capsule_cost_per_cup, target_machine, coffee_budget_per_kg }) {
  const DAYS_PER_MONTH = 30.44;
  const GRAMS_PER_CUP = 16; // double-shot average
  const MONTHS_IN_FIVE_YEARS = 60;

  // Machine prices
  const machinePrices = {
    'arco-nano': 449,
    'arco-automatico': 699,
    'arco-classica': 899,
    'arco-barista-pro': 1199,
    'arco-maestro': 1699,
    'arco-dual-boiler': 2199,
    'arco-lever': 1499,
  };

  // Recommended grinder pairing and cost
  const grinderPairings = {
    'arco-nano': { grinder: 'Arco Mini Grinder', price: 149 },
    'arco-automatico': { grinder: 'Built-in grinder (included)', price: 0 },
    'arco-classica': { grinder: 'Arco Macinino Home', price: 299 },
    'arco-barista-pro': { grinder: 'Arco Macinino Home', price: 299 },
    'arco-maestro': { grinder: 'Arco Macinino Pro', price: 499 },
    'arco-dual-boiler': { grinder: 'Arco Macinino Pro', price: 499 },
    'arco-lever': { grinder: 'Arco Conico', price: 399 },
  };

  const machinePrice = machinePrices[target_machine] || 699;
  const grinder = grinderPairings[target_machine] || grinderPairings['arco-automatico'];
  const totalEquipmentCost = machinePrice + grinder.price;

  // Annual maintenance costs (descaling solution, gaskets, filters)
  const annualMaintenanceCost = 45;
  const monthlyMaintenance = annualMaintenanceCost / 12;

  // Monthly capsule cost
  const monthlyCapsuleCost = cups_per_day * DAYS_PER_MONTH * capsule_cost_per_cup;

  // Monthly bean cost
  const monthlyBeanKg = (cups_per_day * DAYS_PER_MONTH * GRAMS_PER_CUP) / 1000;
  const monthlyBeanCost = monthlyBeanKg * coffee_budget_per_kg;

  // Total monthly bean cost including maintenance
  const monthlyBeanTotal = monthlyBeanCost + monthlyMaintenance;

  // Cost per cup with beans
  const beanCostPerCup = (GRAMS_PER_CUP / 1000) * coffee_budget_per_kg;

  // Monthly savings
  const monthlySavings = monthlyCapsuleCost - monthlyBeanTotal;

  // Break-even calculation
  let breakEvenMonths;
  let breakEvenLabel;
  if (monthlySavings <= 0) {
    breakEvenMonths = null;
    breakEvenLabel = 'Capsules are cheaper at this bean price. Consider less expensive beans or you are paying a premium for quality and freshness.';
  } else {
    breakEvenMonths = Math.ceil(totalEquipmentCost / monthlySavings);
    if (breakEvenMonths <= 6) {
      breakEvenLabel = `${breakEvenMonths} months — you will recoup your investment very quickly.`;
    } else if (breakEvenMonths <= 18) {
      breakEvenLabel = `${breakEvenMonths} months — a solid return within the first year and a half.`;
    } else if (breakEvenMonths <= 36) {
      breakEvenLabel = `${breakEvenMonths} months — roughly ${(breakEvenMonths / 12).toFixed(1)} years. Most espresso machines last 8-15 years.`;
    } else {
      breakEvenLabel = `${breakEvenMonths} months — a longer payback, but you gain freshness and quality from day one.`;
    }
  }

  // Five-year projection
  const fiveYearCapsule = monthlyCapsuleCost * MONTHS_IN_FIVE_YEARS;
  const fiveYearBean = monthlyBeanTotal * MONTHS_IN_FIVE_YEARS + totalEquipmentCost;
  const fiveYearNetSavings = fiveYearCapsule - fiveYearBean;

  // Environmental note
  const capsuleWastePerYear = Math.round(cups_per_day * 365);

  // Summary
  let summary;
  if (fiveYearNetSavings > 2000) {
    summary = `Switching to beans saves you a significant amount over five years. At ${cups_per_day} cups per day, the ${target_machine.replace('arco-', 'Arco ').replace(/-/g, ' ')} pays for itself in ${breakEvenMonths || '?'} months and saves ${fiveYearNetSavings.toFixed(0)} over five years.`;
  } else if (fiveYearNetSavings > 0) {
    summary = `You will save money over five years, plus enjoy fresher, better-tasting coffee. The investment breaks even in ${breakEvenMonths || '?'} months.`;
  } else {
    summary = 'At your current pricing, capsules are cost-competitive. However, whole beans deliver superior freshness and flavour, and you eliminate single-use capsule waste.';
  }

  return {
    monthly_capsule_cost: parseFloat(monthlyCapsuleCost.toFixed(2)),
    monthly_bean_cost: parseFloat(monthlyBeanCost.toFixed(2)),
    monthly_bean_total_with_maintenance: parseFloat(monthlyBeanTotal.toFixed(2)),
    monthly_savings: parseFloat(monthlySavings.toFixed(2)),
    cost_per_cup_capsule: parseFloat(capsule_cost_per_cup.toFixed(2)),
    cost_per_cup_bean: parseFloat(beanCostPerCup.toFixed(2)),
    equipment_cost: totalEquipmentCost,
    recommended_grinder: grinder.grinder,
    grinder_cost: grinder.price,
    break_even_months: breakEvenMonths,
    break_even_label: breakEvenLabel,
    five_year_capsule_spend: parseFloat(fiveYearCapsule.toFixed(2)),
    five_year_bean_spend: parseFloat(fiveYearBean.toFixed(2)),
    five_year_net_savings: parseFloat(fiveYearNetSavings.toFixed(2)),
    capsules_avoided_per_year: capsuleWastePerYear,
    summary,
  };
}
