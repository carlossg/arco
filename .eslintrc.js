module.exports = {
  root: true,
  extends: 'airbnb-base',
  env: {
    browser: true,
  },
  parser: '@babel/eslint-parser',
  parserOptions: {
    allowImportExportEverywhere: true,
    sourceType: 'module',
    requireConfigFile: false,
  },
  rules: {
    'import/extensions': ['error', { js: 'always' }], // require js file extensions in imports
    'linebreak-style': ['error', 'unix'], // enforce unix linebreaks
    'no-param-reassign': [2, { props: false }], // allow modifying properties of param
  },
  overrides: [
    {
      // Node.js scripts that need sequential async iteration patterns
      files: [
        'scripts/generate-*.js',
        'workers/recommender/scripts/**/*.js',
        'tools/**/*.js',
      ],
      env: { node: true, browser: false },
      rules: {
        'no-restricted-syntax': 'off',
        'no-await-in-loop': 'off',
        'no-continue': 'off',
        'no-underscore-dangle': 'off',
      },
    },
    {
      // Cloudflare Worker source + tests run in the Workers/Node runtime, not
      // the browser. Their dependencies (nunjucks, yaml) and generated prompt
      // bundles live in the worker's own package and are not installed at the
      // repo root, so import resolution is delegated to the worker's tooling.
      files: ['workers/recommender/src/**/*.js', 'workers/recommender/tests/**/*.js'],
      env: {
        node: true, browser: false, 'shared-node-browser': true, es2022: true,
      },
      rules: {
        'no-restricted-syntax': 'off',
        'no-await-in-loop': 'off',
        'no-continue': 'off',
        'no-underscore-dangle': 'off',
        'import/no-unresolved': 'off',
        'import/extensions': 'off',
        // hoisted function declarations may be referenced before their definition
        'no-use-before-define': ['error', { functions: false }],
      },
    },
    {
      // Snapshot/unit tests favour compact single-line fixtures and stubs.
      files: ['workers/recommender/tests/**/*.js'],
      rules: {
        'max-len': 'off',
      },
    },
  ],
};
