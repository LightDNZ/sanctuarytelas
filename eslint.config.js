/**
 * Lint do workspace inteiro, num arquivo só.
 *
 * O projeto roda em dois mundos e o mesmo `.js` significa coisas diferentes em
 * cada um: `server/` e `scripts/` são Node, `client/src/`, `server/public/` e
 * `shared/` são navegador. Sem essa separação o `no-undef` fica inútil — ou
 * acusa `window` no servidor, ou deixa passar `process` no cliente, que é
 * justamente o erro que ele existe para pegar.
 */
import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['client/dist/', 'coverage/', '.cache/', 'site/']),

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      // Argumento que sobra depois de uma assinatura mudar é resto; o `_` na
      // frente é como se diz "este eu sei que não uso".
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', 'client/vite.config.js', 'vitest.*.js'],
    ignores: ['server/public/**'],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['client/src/**/*.js', 'server/public/**/*.js', 'shared/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },

  // Por último: desliga o que o Prettier já decide. Duas ferramentas opinando
  // sobre a mesma vírgula é conflito, não verificação dobrada.
  prettier,
]);
