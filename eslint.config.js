import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const s3EmitSyntax = [
  {
    selector:
      "CallExpression[callee.name='emit'][arguments.0.type=/^(Literal|TemplateLiteral)$/]",
    message:
      "S-3: тип события — только сгенерированная константа, не строковый литерал",
  },
  {
    selector:
      "CallExpression[callee.property.name='emit'][arguments.0.type=/^(Literal|TemplateLiteral)$/]",
    message:
      "S-3: тип события — только сгенерированная константа, не строковый литерал",
  },
  {
    selector:
      "CallExpression[callee.name='on'][arguments.0.raw=/^['\"`][a-z]+\\./]",
    message:
      "S-3: подписка на событие — только сгенерированная константа, не строковый литерал",
  },
  {
    selector:
      "CallExpression[callee.property.name='on'][arguments.0.raw=/^['\"`][a-z]+\\./]",
    message:
      "S-3: подписка на событие — только сгенерированная константа, не строковый литерал",
  },
];

const s10DateSyntax = [
  {
    selector:
      "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: "S-10: Date.now() запрещён в домене; используйте clock",
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message: "S-10: new Date() запрещён в домене; используйте clock",
  },
];

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...s3EmitSyntax],
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...s3EmitSyntax, ...s10DateSyntax],
      "no-magic-numbers": [
        "error",
        {
          ignore: [0, 1, -1],
          ignoreArrayIndexes: true,
          detectObjects: true,
        },
      ],
    },
  },
);
