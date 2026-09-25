import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default defineConfig([
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended]
  },
  globalIgnores(['node_modules', 'dist']),
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'indent': ['error', 2],
      'linebreak-style': ['error', 'unix'],
      'quotes': ['error', 'single'],
      'semi': ['error', 'never'],
      'no-trailing-spaces': ['error'],
      'no-shadow': ['error'],
      'no-unused-vars': [
        'error',
        {
          'caughtErrors': 'none'
        }
      ],
      'no-use-before-define': [
        'error',
        {
          'functions': false
        }
      ],
      'eol-last': ['error'],
      'no-console': ['error'],
      'no-var': ['error']
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      'no-unused-vars': 'off',
      'no-shadow': 'off',
      'no-use-before-define': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          'caughtErrors': 'none'
        }
      ],
      '@typescript-eslint/no-shadow': ['error'],
      '@typescript-eslint/no-use-before-define': [
        'error',
        {
          'functions': false
        }
      ]
    }
  }
])
