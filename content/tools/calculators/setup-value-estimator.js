/**
 * Setup Value Estimator
 *
 * Estimates the resale value of the user's current coffee equipment,
 * calculates a trade-in credit, recommends an Arco upgrade path, and
 * shows the budget delta after trade-in.
 *
 * @param {object} inputs
 * @param {string} inputs.current_machine - Current machine category or model
 * @param {string} inputs.current_grinder - Current grinder category or model
 * @param {string[]} inputs.accessories_owned - Array of accessory identifiers
 * @returns {object} result
 */
export function calculate({ current_machine, current_grinder, accessories_owned = [] }) {
  // Resale value estimates (typical secondary market value)
  const machineValues = {
    none: 0,
    'moka-pot': 10,
    'pod-machine': 25,
    'entry-espresso': 80,
    'mid-espresso': 250,
    'prosumer-espresso': 650,
    commercial: 1400,
    'arco-nano': 280,
    'arco-classica': 550,
    'arco-automatico': 430,
    'arco-barista-pro': 750,
    'arco-maestro': 1100,
    'arco-dual-boiler': 1450,
    'arco-lever': 980,
  };

  const grinderValues = {
    none: 0,
    blade: 5,
    'entry-burr': 30,
    'mid-burr': 120,
    'prosumer-burr': 350,
    'commercial-burr': 600,
    'arco-mini-grinder': 90,
    'arco-macinino-home': 190,
    'arco-conico': 260,
    'arco-macinino-pro': 330,
  };

  const accessoryValues = {
    tamper: 25,
    scale: 35,
    distributor: 20,
    'knock-box': 15,
    'milk-pitcher': 12,
    'water-filter': 30,
    'bottomless-pf': 28,
    'dosing-cup': 10,
  };

  // Calculate current setup value
  const machineResale = machineValues[current_machine] || 0;
  const grinderResale = grinderValues[current_grinder] || 0;
  const accessoriesResale = accessories_owned.reduce(
    (sum, a) => sum + (accessoryValues[a] || 0),
    0,
  );
  const totalResale = machineResale + grinderResale + accessoriesResale;

  // Trade-in credit: Arco offers 12% of estimated value
  const tradeInRate = 0.12;
  const tradeInCredit = Math.round(totalResale * tradeInRate);

  // Determine user's current tier
  const tierOrder = [
    'none', 'moka-pot', 'pod-machine', 'entry-espresso', 'mid-espresso',
    'arco-nano', 'arco-automatico', 'arco-classica', 'arco-barista-pro',
    'prosumer-espresso', 'arco-maestro', 'arco-lever', 'arco-dual-boiler', 'commercial',
  ];
  const currentTierIndex = tierOrder.indexOf(current_machine);

  // Arco product catalog for recommendations
  const arcoSetups = [
    {
      id: 'starter',
      machine: 'Arco Nano',
      machineId: 'arco-nano',
      machinePrice: 449,
      grinder: 'Arco Mini Grinder',
      grinderId: 'arco-mini-grinder',
      grinderPrice: 149,
      tier: 'entry',
      portafilter: '53mm',
    },
    {
      id: 'convenient',
      machine: 'Arco Automatico',
      machineId: 'arco-automatico',
      machinePrice: 699,
      grinder: 'Built-in (included)',
      grinderId: null,
      grinderPrice: 0,
      tier: 'mid',
      portafilter: 'n/a',
    },
    {
      id: 'classic',
      machine: 'Arco Classica',
      machineId: 'arco-classica',
      machinePrice: 899,
      grinder: 'Arco Macinino Home',
      grinderId: 'arco-macinino-home',
      grinderPrice: 299,
      tier: 'mid-high',
      portafilter: '58mm',
    },
    {
      id: 'enthusiast',
      machine: 'Arco Barista Pro',
      machineId: 'arco-barista-pro',
      machinePrice: 1199,
      grinder: 'Arco Macinino Home',
      grinderId: 'arco-macinino-home',
      grinderPrice: 299,
      tier: 'prosumer',
      portafilter: '58mm',
    },
    {
      id: 'artisan',
      machine: 'Arco Lever',
      machineId: 'arco-lever',
      machinePrice: 1499,
      grinder: 'Arco Conico',
      grinderId: 'arco-conico',
      grinderPrice: 399,
      tier: 'prosumer',
      portafilter: '58mm',
    },
    {
      id: 'pro',
      machine: 'Arco Maestro',
      machineId: 'arco-maestro',
      machinePrice: 1699,
      grinder: 'Arco Macinino Pro',
      grinderId: 'arco-macinino-pro',
      grinderPrice: 499,
      tier: 'high-end',
      portafilter: '58mm',
    },
    {
      id: 'ultimate',
      machine: 'Arco Dual Boiler',
      machineId: 'arco-dual-boiler',
      machinePrice: 2199,
      grinder: 'Arco Macinino Pro',
      grinderId: 'arco-macinino-pro',
      grinderPrice: 499,
      tier: 'high-end',
      portafilter: '58mm',
    },
  ];

  // Pick the right upgrade: at least one tier above current
  let recommended;
  if (currentTierIndex <= 3) {
    // Coming from nothing, moka, pods, or entry espresso — recommend starter or classic
    recommended = arcoSetups.find((s) => s.id === 'classic');
  } else if (currentTierIndex <= 5) {
    // Mid-range or Arco entry — recommend enthusiast
    recommended = arcoSetups.find((s) => s.id === 'enthusiast');
  } else if (currentTierIndex <= 8) {
    // Prosumer tier — recommend pro
    recommended = arcoSetups.find((s) => s.id === 'pro');
  } else {
    // Already high-end — recommend ultimate
    recommended = arcoSetups.find((s) => s.id === 'ultimate');
  }

  // Check if user already has a compatible Arco grinder
  const arcoGrinderOwned = current_grinder.startsWith('arco-');
  let grinderNeeded = true;
  let grinderCost = recommended.grinderPrice;

  if (arcoGrinderOwned && recommended.grinderId) {
    // Check if owned grinder is adequate for the recommended setup
    const grinderTier = {
      'arco-mini-grinder': 1,
      'arco-macinino-home': 2,
      'arco-conico': 3,
      'arco-macinino-pro': 4,
    };
    const ownedTier = grinderTier[current_grinder] || 0;
    const neededTier = grinderTier[recommended.grinderId] || 0;
    if (ownedTier >= neededTier) {
      grinderNeeded = false;
      grinderCost = 0;
    }
  }

  const totalSetupPrice = recommended.machinePrice + grinderCost;
  const budgetDelta = totalSetupPrice - tradeInCredit;

  // Determine which accessories carry over (58mm portafilter compatibility)
  const portafilterAccessories = ['tamper', 'distributor', 'bottomless-pf', 'dosing-cup'];
  const universalAccessories = ['scale', 'knock-box', 'milk-pitcher', 'water-filter'];

  const carryOver = [];
  const needToReplace = [];

  accessories_owned.forEach((acc) => {
    if (universalAccessories.includes(acc)) {
      carryOver.push(acc);
    } else if (portafilterAccessories.includes(acc)) {
      if (recommended.portafilter === '58mm') {
        // Assume existing accessories might be 58mm — they carry over
        carryOver.push(acc);
      } else {
        needToReplace.push(acc);
      }
    }
  });

  const upgradeRationale = [];
  if (current_machine === 'none' || current_machine === 'pod-machine') {
    upgradeRationale.push('Moving from capsules or no machine to a real espresso setup is the single biggest quality leap you can make.');
  }
  if (current_machine === 'entry-espresso') {
    upgradeRationale.push('Entry-level machines often lack PID temperature control and consistent pressure. The Arco Classica addresses both.');
  }
  if (current_machine === 'mid-espresso' || current_machine.startsWith('arco-')) {
    upgradeRationale.push('Upgrading within the prosumer range gives you faster heat-up, better temperature stability, and improved steam power for milk drinks.');
  }
  if (current_grinder === 'none' || current_grinder === 'blade') {
    upgradeRationale.push('A quality burr grinder is the most impactful upgrade for any espresso setup. Blade grinders produce inconsistent particle sizes that lead to uneven extraction.');
  }

  return {
    estimated_current_value: totalResale,
    machine_resale: machineResale,
    grinder_resale: grinderResale,
    accessories_resale: accessoriesResale,
    trade_in_credit: tradeInCredit,
    recommended_upgrade: {
      machine: recommended.machine,
      machine_price: recommended.machinePrice,
      grinder: grinderNeeded ? recommended.grinder : `Keep your ${current_grinder.replace(/-/g, ' ')}`,
      grinder_price: grinderCost,
      total_setup_price: totalSetupPrice,
    },
    budget_delta: budgetDelta,
    accessories_carry_over: carryOver,
    accessories_to_replace: needToReplace,
    grinder_upgrade_needed: grinderNeeded,
    upgrade_rationale: upgradeRationale,
  };
}
