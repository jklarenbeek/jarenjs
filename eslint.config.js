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
      'no-unused-vars': 'warn',
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
    ignores: ['dist', 'build', '**/_*', '**/*.no-lint.*'],
  },
];