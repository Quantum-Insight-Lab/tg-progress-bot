// Инварианты сборки S-3, S-8, S-10 (docs/pda/09-structural-invariants.md).
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const s3 = ['emit', 'on'].flatMap((name) => [
  {
    selector: `CallExpression[callee.name='${name}'][arguments.0.type=/^(Literal|TemplateLiteral)$/]`,
    message: 'S-3: тип события — только сгенерированная константа EVENT_TYPES, не строка',
  },
  {
    selector: `CallExpression[callee.property.name='${name}'][arguments.0.type=/^(Literal|TemplateLiteral)$/]`,
    message: 'S-3: тип события — только сгенерированная константа EVENT_TYPES, не строка',
  },
]);

const s10 = [
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'S-10: Date.now() в домене запрещён, время — через Clock' },
  { selector: "NewExpression[callee.name='Date']", message: 'S-10: new Date() в домене запрещён, время — через Clock' },
];

const s8 = [{ selector: 'Literal[raw=/^(?!(0|1)$)[0-9]/]', message: 'S-8: число в домене — только константа из src/config (разрешены 0, 1, -1)' }];

export default defineConfig(
  { ignores: ['node_modules/**'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...s3] },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...s3, ...s8, ...s10] },
  },
);
