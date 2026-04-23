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
  ],
};
