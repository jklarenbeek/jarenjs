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
    // CLI tooling: reporting to stdout is the whole point of these programs
    files: ['scripts/**/*.js', 'benchmark/**/*.js', 'esbuild.config.js',
      'packages/emit/src/cli.js', 'packages/db/src/cli.js', 'packages/contract/src/cli.js'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: [
      '**/dist', 'build', '**/_*', '**/*.no-lint.*',
      // git submodules under benchmark/ (JSON-Schema-Test-Suite, qt3tests,
      // jsonpath-compliance-test-suite, toml-test, commonmark-spec) plus the
      // artifacts generated from them: third-party sources we do not style.
      'benchmark/suite/**', 'benchmark/qt3tests/**', 'benchmark/jsonpath-suite/**',
      'benchmark/toml-test-suite/**', 'benchmark/commonmark-spec/**',
      'benchmark/qt3-json/**', 'benchmark/results/**',
    ],
  },
];