/**
 * ESLint flat config for @pawells/nodejs-python-ipc
 *
 * Node.js + TypeScript library. No React, no monorepo tooling.
 *
 * Plugins used:
 *   @typescript-eslint     — TypeScript-aware lint rules
 *   @stylistic             — formatting rules (replaces deprecated core formatting rules)
 *   eslint-plugin-import   — import order, extensions, cycle detection
 *   eslint-plugin-unused-imports — prune unused imports automatically
 *   globals                — canonical Node.js global definitions
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** TypeScript import resolver — points at this project's tsconfig.eslint.json */
const IMPORT_RESOLVER = {
	typescript: {
		alwaysTryTypes: true,
		project: './tsconfig.eslint.json',
	},
	node: {
		extensions: ['.js', '.ts'],
	},
};

export default [
	// ============================================
	// GLOBAL IGNORES
	// ============================================
	{
		ignores: ['build/**', '**/*.d.ts', 'node_modules/**'],
	},

	// ============================================
	// BASE RECOMMENDED RULES (all files)
	// ============================================
	js.configs.recommended,

	// ============================================
	// TYPESCRIPT SOURCE FILES
	// ============================================
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: __dirname,
			},
			globals: {
				...globals.node,
			},
		},
		plugins: {
			'@typescript-eslint': typescriptEslint,
			'@stylistic': stylistic,
			'import': importPlugin,
			'unused-imports': unusedImports,
		},
		settings: {
			'import/resolver': IMPORT_RESOLVER,
		},
		rules: {

			// ---- Unused variables and imports ----
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
			'unused-imports/no-unused-imports': 'error',
			'unused-imports/no-unused-vars': [
				'warn',
				{
					vars: 'all',
					varsIgnorePattern: '^_',
					args: 'after-used',
					argsIgnorePattern: '^_',
				},
			],

			// ---- Import rules ----
			// TypeScript ESM writes `.js` imports that resolve to `.ts` files.
			// `import/extensions` fights this convention and is enforced by the TS compiler
			// itself (via moduleResolution), so we leave it off here.
			'import/no-duplicates': 'error',
			'import/no-cycle': 'warn',
			'import/no-self-import': 'error',

			// ---- TypeScript: explicit type annotations ----
			'@typescript-eslint/explicit-function-return-type': [
				'warn',
				{
					allowExpressions: true,
					allowTypedFunctionExpressions: true,
					allowHigherOrderFunctions: true,
				},
			],
			'@typescript-eslint/explicit-member-accessibility': [
				'warn',
				{
					accessibility: 'explicit',
					overrides: { constructors: 'no-public' },
				},
			],
			'@typescript-eslint/no-explicit-any': 'off',       // codebase uses `any` intentionally
			'@typescript-eslint/no-inferrable-types': 'off',   // verbose but harmless

			// ---- TypeScript: type-checked rules (require parserOptions.project) ----
			'@typescript-eslint/prefer-nullish-coalescing': 'warn',
			'@typescript-eslint/prefer-optional-chain': 'warn',
			'@typescript-eslint/prefer-for-of': 'warn',
			'@typescript-eslint/prefer-includes': 'warn',
			'@typescript-eslint/prefer-string-starts-ends-with': 'warn',
			'@typescript-eslint/prefer-readonly': 'warn',
			'@typescript-eslint/promise-function-async': ['warn', { checkArrowFunctions: false }],
			'@typescript-eslint/return-await': 'error',
			'@typescript-eslint/no-non-null-assertion': 'warn',

			// ---- TypeScript: naming conventions ----
			// Configured to match the existing codebase style:
			//   - camelCase for most identifiers (including exported functions and singletons)
			//   - PascalCase for classes, interfaces, type aliases, and enums
			//   - No I/T prefix requirements on interfaces or type aliases
			//   - snake_case allowed on type properties (external API shapes)
			'@typescript-eslint/naming-convention': [
				'warn',
				// Classes — PascalCase
				{
					selector: 'class',
					format: ['PascalCase'],
				},
				// Interfaces — PascalCase, no prefix
				{
					selector: 'interface',
					format: ['PascalCase'],
				},
				// Type aliases — PascalCase, no prefix
				{
					selector: 'typeAlias',
					format: ['PascalCase'],
				},
				// Enum names — PascalCase
				{
					selector: 'enum',
					format: ['PascalCase'],
				},
				// Enum members — UPPER_CASE or PascalCase
				{
					selector: 'enumMember',
					format: ['UPPER_CASE', 'PascalCase'],
				},
				// Type parameters — single uppercase letter or PascalCase (T, K, V, TResult…)
				{
					selector: 'typeParameter',
					format: ['PascalCase'],
					custom: { regex: '^[A-Z]', match: true },
				},
				// Type properties — any format (external API shapes may use snake_case)
				{
					selector: 'typeProperty',
					format: null,
				},
				// Object literal properties — any format (snake_case used for external API shapes)
				{
					selector: 'objectLiteralProperty',
					format: null,
				},
				// Object literal methods — any format (mock field names use PascalCase)
				{
					selector: 'objectLiteralMethod',
					format: null,
				},
				// Class properties — camelCase, UPPER_CASE, or PascalCase.
				// UPPER_CASE is used for class-level constants (e.g. SMALL_MODEL, WORKSPACE_PATTERN).
				{
					selector: 'classProperty',
					format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
					leadingUnderscore: 'allow',
				},
				// Class methods — camelCase or PascalCase (public API methods use PascalCase)
				{
					selector: 'classMethod',
					format: ['camelCase', 'PascalCase'],
					leadingUnderscore: 'allow',
				},
				// Functions — camelCase, UPPER_CASE, or PascalCase
				// PascalCase is used for exported utility functions (e.g. ArrayChunk, CamelCase)
				{
					selector: 'function',
					format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
					leadingUnderscore: 'allow',
				},
				// Getters and setters — camelCase, UPPER_CASE, or PascalCase (public API getters use PascalCase)
				{
					selector: 'accessor',
					format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
					leadingUnderscore: 'allow',
				},
				// Default imports — allow PascalCase (e.g. import MyLib from 'my-lib')
				{
					selector: 'import',
					modifiers: ['default'],
					format: ['camelCase', 'PascalCase'],
				},
				// Destructured variables — any format (must mirror source shape)
				{
					selector: 'variable',
					modifiers: ['destructured'],
					format: null,
				},
				// Variables — camelCase, UPPER_CASE, or PascalCase.
				// PascalCase is used for schema/constant identifiers.
				{
					selector: 'variable',
					format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
					leadingUnderscore: 'allow',
				},
				// Parameters — camelCase
				{
					selector: 'parameter',
					format: ['camelCase'],
					leadingUnderscore: 'allow',
				},
				// Default fallback — camelCase
				{
					selector: 'default',
					format: ['camelCase'],
					leadingUnderscore: 'allow',
					trailingUnderscore: 'allow',
				},
			],

			// ---- Best practices: variable declarations ----
			'no-var': 'error',
			'prefer-const': 'warn',
			'one-var': ['warn', 'never'],
			'object-shorthand': ['warn', 'always'],
			'prefer-destructuring': [
				'warn',
				{
					VariableDeclarator: { array: true, object: true },
					AssignmentExpression: { array: true, object: false },
				},
			],

			// ---- Best practices: equality and comparisons ----
			'eqeqeq': ['error', 'always'],
			'no-self-compare': 'error',
			'use-isnan': ['error', { enforceForSwitchCase: true, enforceForIndexOf: true }],

			// ---- Best practices: functions ----
			'prefer-arrow-callback': 'warn',
			'no-param-reassign': ['warn', { props: false }],
			'prefer-rest-params': 'warn',
			'require-await': 'warn',

			// ---- Best practices: error handling ----
			'no-throw-literal': 'error',
			'prefer-promise-reject-errors': 'error',
			'no-empty': ['error', { allowEmptyCatch: true }],

			// ---- Best practices: control flow ----
			'consistent-return': 'warn',
			'default-case-last': 'error',
			'no-fallthrough': 'error',
			'guard-for-in': 'warn',

			// ---- Best practices: code quality ----
			'no-magic-numbers': ['warn', { ignore: [0, 1, -1, 2], ignoreArrayIndexes: true }],
			'no-unused-private-class-members': 'error',
			// TypeScript handles redeclaration; disable the JS rule to avoid false positives
			// on function overloads
			'no-redeclare': 'off',

			// ---- Stylistic: indentation and whitespace ----
			'@stylistic/indent': [
				'error',
				'tab',
				{
					SwitchCase: 1,
					flatTernaryExpressions: false,
					offsetTernaryExpressions: false,
					ignoreComments: false,
				},
			],
			'@stylistic/no-tabs': 'off',
			'@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
			'@stylistic/padded-blocks': ['error', 'never'],
			'@stylistic/eol-last': 'error',
			'@stylistic/no-extra-semi': 'error',

			// ---- Stylistic: quotes and punctuation ----
			'@stylistic/quotes': ['error', 'single'],
			'@stylistic/semi': ['error', 'always'],
			// Trailing commas on multi-line constructs (matches existing code style)
			'@stylistic/comma-dangle': ['error', 'always-multiline'],

			// ---- Stylistic: braces and blocks ----
			// 1tbs: `} else {` / `} catch {` on same line as closing brace (existing code style)
			'@stylistic/brace-style': ['error', '1tbs'],
			'@stylistic/space-before-blocks': 'error',
			'@stylistic/space-before-function-paren': [
				'error',
				{ anonymous: 'never', named: 'never', asyncArrow: 'always' },
			],

			// ---- Stylistic: spacing ----
			'@stylistic/space-infix-ops': 'error',
			'@stylistic/space-unary-ops': ['error', { words: true, nonwords: false }],
			'@stylistic/object-curly-spacing': ['error', 'always'],
			'@stylistic/array-bracket-spacing': ['error', 'never'],
			'@stylistic/spaced-comment': ['error', 'always'],

			// ---- Stylistic: miscellaneous ----
			'@stylistic/no-confusing-arrow': 'warn',
			'@stylistic/multiline-ternary': 'off',
			'@stylistic/max-len': 'off',
		},
	},

	// ============================================
	// TEST FILES — relaxed rules
	// ============================================
	{
		files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
		languageOptions: {
			parserOptions: {
				// Disable projectService (set by the base config) and use the
				// spec tsconfig directly, so spec files are properly included.
				projectService: false,
				project: './tsconfig.test.json',
				tsconfigRootDir: __dirname,
			},
			globals: {
				// Vitest globals (enabled via vitest.config.ts `globals: true`)
				...globals.jest,
				vi: 'readonly',
			},
		},
		rules: {
			// Magic numbers are common in test data and mock configs
			'no-magic-numbers': 'off',
			// Non-null assertions are fine after expect() calls
			'@typescript-eslint/no-non-null-assertion': 'off',
			// Test helpers and mock objects don't need to follow naming conventions
			'@typescript-eslint/naming-convention': 'off',
			// Inline test helpers rarely need explicit return types
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/explicit-member-accessibility': 'off',
			// Async test callbacks often don't use await (e.g. waiting on Promises via other means)
			'require-await': 'off',
		},
	},

	// ============================================
	// CONFIG FILES — allow outside tsconfig project
	// ============================================
	{
		files: ['*.config.ts', '*.config.mjs', '*.config.js', 'vitest.config.*'],
		languageOptions: {
			parserOptions: {
				allowDefaultProject: true,
			},
		},
		rules: {
			// Config files may import dev-only tooling
			'import/no-cycle': 'off',
		},
	},
];
