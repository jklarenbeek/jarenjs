import globals from 'globals';
import js from '@eslint/js';
// import importPlugin from 'eslint-plugin-import';
// import json from 'eslint-plugin-json';

export default [
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
      ecmaVersion: 'latest',
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
          modules: true,
        }
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'error',
      'no-duplicate-imports': 'error',
      // 'import/no-dynamic-require': 'warn',
      // 'import/no-nodejs-modules': 'warn',
    },
    settings: {
      // 'import/extensions': [
      //   '.js',
      //   '.jsx'
      // ]
    }
  },
  {
    // the website runs in the browser: allow DOM globals there
    files: ['packages/website/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // CLI tooling: console output is intentional here
    files: ['scripts/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // benchmark/ is vendored (qt3, third-party) + CLI tooling: its no-console /
    // no-undef output is intentional and must stay out of the gate.
    ignores: ['**/dist', 'build', '**/_*', '**/*.no-lint.*', 'benchmark/**'],
  },
];