/**
 * Calculator Block — generic calculator wrapper that loads specific JS modules.
 * Renders input form from authored content and displays calculated results.
 *
 * Expected authored structure:
 *   Row 1: Col 1 = "Title", Col 2 = Calculator title
 *   Row 2: Col 1 = "Description", Col 2 = Calculator description
 *   Row 3: Col 1 = "Module", Col 2 = JS module path
 *   Row 4+: Col 1 = input label, Col 2 = input config
 *           (type:number|select, min, max, step, options, default)
 */

/**
 * Parses input configuration from a cell's text.
 * Format: "type:number, min:0, max:100, step:0.1, default:18"
 * or "type:select, options:Macinino|Preciso|Zero|Filtro, default:Macinino"
 * @param {string} text
 * @returns {object}
 */
function parseInputConfig(text) {
  const config = {};
  text.split(',').forEach((part) => {
    const [key, ...vals] = part.split(':');
    const k = key.trim().toLowerCase();
    const v = vals.join(':').trim();
    if (k === 'options') {
      config[k] = v.split('|').map((o) => o.trim());
    } else if (['min', 'max', 'step', 'default'].includes(k) && !Number.isNaN(Number(v))) {
      config[k] = Number(v);
    } else {
      config[k] = v;
    }
  });
  return config;
}

/**
 * Creates a form input element from config.
 * @param {string} label
 * @param {object} config
 * @param {string} id
 * @returns {Element}
 */
function createInput(label, config, id) {
  const group = document.createElement('div');
  group.className = 'calculator-input-group';

  const labelEl = document.createElement('label');
  labelEl.htmlFor = id;
  labelEl.textContent = label;
  group.append(labelEl);

  if (config.type === 'select' && config.options) {
    const select = document.createElement('select');
    select.id = id;
    select.name = id;
    config.options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      if (config.default && String(config.default) === opt) option.selected = true;
      select.append(option);
    });
    group.append(select);
  } else {
    const input = document.createElement('input');
    input.type = config.type || 'number';
    input.id = id;
    input.name = id;
    if (config.min !== undefined) input.min = config.min;
    if (config.max !== undefined) input.max = config.max;
    if (config.step !== undefined) input.step = config.step;
    if (config.default !== undefined) input.value = config.default;
    if (config.placeholder) input.placeholder = config.placeholder;
    group.append(input);
  }

  return group;
}

export default async function decorate(block) {
  const rows = [...block.children];
  const config = {};
  const inputs = [];

  rows.forEach((row) => {
    const cols = [...row.children];
    const key = cols[0]?.textContent.trim().toLowerCase();
    const value = cols[1]?.textContent.trim() || '';

    if (key === 'title') config.title = value;
    else if (key === 'description') config.description = value;
    else if (key === 'module') config.module = value;
    else if (key && value) {
      inputs.push({ label: cols[0].textContent.trim(), config: parseInputConfig(value) });
    }
  });

  block.replaceChildren();

  // Header
  if (config.title) {
    const title = document.createElement('h2');
    title.className = 'calculator-title';
    title.textContent = config.title;
    block.append(title);
  }

  if (config.description) {
    const desc = document.createElement('p');
    desc.className = 'calculator-description';
    desc.textContent = config.description;
    block.append(desc);
  }

  // Form
  const form = document.createElement('form');
  form.className = 'calculator-form';
  form.addEventListener('submit', (e) => e.preventDefault());

  inputs.forEach((inp, i) => {
    const id = `calc-input-${i}`;
    form.append(createInput(inp.label, inp.config, id));
  });

  const calcBtn = document.createElement('button');
  calcBtn.type = 'button';
  calcBtn.className = 'calculator-submit';
  calcBtn.textContent = 'Calculate';
  form.append(calcBtn);

  block.append(form);

  // Results area
  const results = document.createElement('div');
  results.className = 'calculator-results';
  results.setAttribute('aria-live', 'polite');
  block.append(results);

  // Load calculator module and bind
  if (config.module) {
    try {
      const mod = await import(config.module);
      calcBtn.addEventListener('click', () => {
        const values = {};
        inputs.forEach((inp, i) => {
          const el = form.querySelector(`#calc-input-${i}`);
          values[inp.label.toLowerCase().replace(/\s+/g, '_')] = el.tagName === 'SELECT' ? el.value : Number(el.value);
        });

        const output = mod.calculate ? mod.calculate(values) : mod.default?.(values);
        if (output) {
          results.innerHTML = '';
          Object.entries(output).forEach(([key, val]) => {
            const row = document.createElement('div');
            row.className = 'calculator-result-row';
            const label = document.createElement('span');
            label.className = 'calculator-result-label';
            label.textContent = key.replace(/_/g, ' ');
            const value = document.createElement('span');
            value.className = 'calculator-result-value';
            value.textContent = typeof val === 'number' ? val.toFixed(2) : val;
            row.append(label, value);
            results.append(row);
          });
        }
      });
    } catch (e) {
      // Module not available — show message
      calcBtn.addEventListener('click', () => {
        results.textContent = 'Calculator module not loaded. Please check the module path.';
      });
    }
  }
}
