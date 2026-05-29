import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Standard data-fetching pattern (reset a loading flag at the top of a
      // fetch effect). React 19's new rule flags it, but it's intentional here.
      'react-hooks/set-state-in-effect': 'off',
      // Context files legitimately export a provider + a hook.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // Vite config runs in Node.
    files: ['vite.config.js'],
    languageOptions: { globals: globals.node },
  },
])
