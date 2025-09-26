import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import stylistic from '@stylistic/eslint-plugin'
import eslintPluginYml from 'eslint-plugin-yml'

/** @type {import('eslint').Linter.Config[]} */
export default [
  { files: ['**/*.{js,mjs,cjs,ts}'] },
  { ignores: ['dist', 'pnpm-lock.yaml'] },
  { languageOptions: { globals: { ...globals.browser } } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  { plugins: { '@stylistic': stylistic } },
  stylistic.configs['recommended'],
  ...eslintPluginYml.configs['flat/standard'],
  {
    rules: {
      'yml/no-empty-mapping-value': 'off',
      '@stylistic/spaced-comment': 'off',
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/arrow-parens': ['error', 'always'],
      'no-console': ['error'],
      '@stylistic/lines-between-class-members': ['error', {
        enforce: [
          { blankLine: 'never', prev: 'field', next: 'field' },
          { blankLine: 'always', prev: 'method', next: 'method' },
          { blankLine: 'always', prev: 'field', next: 'method' },
          { blankLine: 'always', prev: 'method', next: 'method' },
        ],
      }],
      '@typescript-eslint/member-ordering': ['error', {
        default: {
          memberTypes: ['field', 'constructor', 'method'],
          order: 'as-written',
        },
      }],
    },
  },
]
