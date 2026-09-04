// ESLint v9 flat config (migrasi dari .eslintrc.json)
// Docs: https://eslint.org/docs/latest/use/configure/migration-guide

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    // Base config: recommended rules
    js.configs.recommended,

    // Global settings untuk file JS di src/ dan index.js
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node
            }
        },
        rules: {
            // Formatting (indent, semi, quotes, dll) di-handle Prettier.
            // ESLint fokus ke code quality rules aja biar gak konflik.

            // Best practices
            'no-unused-vars': [
                'warn',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_' // ignore catch (_) {} pattern
                }
            ],
            'no-console': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-prototype-builtins': 'warn',
            'no-useless-escape': 'warn',
            'prefer-const': 'warn',
            eqeqeq: ['warn', 'smart'],
            'no-var': 'error',
            'no-redeclare': 'error',
            'no-unreachable': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
            'no-debugger': 'error',
            'no-alert': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-script-url': 'error'
        }
    },

    // Ignore patterns (sama kayak .eslintrc.json lama)
    {
        ignores: ['node_modules/', 'backups/', 'coverage/', 'data/', '*.json', '.env*', 'docs/', 'tests/', 'scripts/']
    }
];
