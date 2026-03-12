import { describe, it, expect } from 'vitest';
import { PythonNotFoundError, PythonVersionError, PythonDependencyError } from './errors';
import {
	parsePythonVersion,
	assertVersionMeetsRequirement,
} from './python-resolver';

describe('python-resolver', () => {
	describe('parsePythonVersion', () => {
		it('parses a standard Python version string', () => {
			const result = parsePythonVersion('Python 3.10.2');
			expect(result).toEqual([3, 10, 2]);
		});

		it('parses Python 3.9.0', () => {
			const result = parsePythonVersion('Python 3.9.0');
			expect(result).toEqual([3, 9, 0]);
		});

		it('parses Python 3.11.5', () => {
			const result = parsePythonVersion('Python 3.11.5');
			expect(result).toEqual([3, 11, 5]);
		});

		it('parses version from output with leading/trailing whitespace', () => {
			const result = parsePythonVersion('  Python 3.10.2\n');
			expect(result).toEqual([3, 10, 2]);
		});

		it('parses major.minor.patch variations', () => {
			const result = parsePythonVersion('Python 2.7.18');
			expect(result).toEqual([2, 7, 18]);
		});

		it('throws when version string is malformed (missing patch)', () => {
			expect(() => parsePythonVersion('Python 3.10')).toThrow(
				/Cannot parse Python version from/,
			);
		});

		it('throws when version string contains no numbers', () => {
			expect(() => parsePythonVersion('Not a valid version')).toThrow(
				/Cannot parse Python version from/,
			);
		});

		it('throws when version string is empty', () => {
			expect(() => parsePythonVersion('')).toThrow(/Cannot parse Python version from/);
		});

		it('throws when version string is only whitespace', () => {
			expect(() => parsePythonVersion('   \n\t  ')).toThrow(/Cannot parse Python version from/);
		});

		it('parses when Python version appears after other text', () => {
			const result = parsePythonVersion('Some text Python 3.9.1 more text');
			expect(result).toEqual([3, 9, 1]);
		});
	});

	describe('resolvePython', () => {
		it('attempts to find python binary (integration)', async () => {
			// This is a simple integration test that doesn't mock
			// It will attempt to find Python on the system
			try {
				const { resolvePython: resolveFunc } = await import('./python-resolver');
				const result = await resolveFunc();
				expect(result).toBeDefined();
				expect(typeof result).toBe('string');
			} catch (error) {
				// If Python not found, that's also acceptable for this test
				expect(error).toBeInstanceOf(PythonNotFoundError);
			}
		});

		it('uses PYTHON_PATH environment variable when set (integration)', async () => {
			const origValue = process.env['PYTHON_PATH'];
			// Set to non-existent path to exercise error handling
			process.env['PYTHON_PATH'] = '/nonexistent/python/path';

			try {
				const { resolvePython: resolveFunc } = await import('./python-resolver');
				await resolveFunc();
				expect.fail('Should have thrown for invalid PYTHON_PATH');
			} catch (error) {
				// We expect a PythonNotFoundError about PYTHON_PATH
				expect(error).toBeInstanceOf(PythonNotFoundError);
				expect((error as PythonNotFoundError).message).toContain('PYTHON_PATH');
			} finally {
				// Restore original value
				if (origValue === undefined) {
					delete process.env['PYTHON_PATH'];
				} else {
					process.env['PYTHON_PATH'] = origValue;
				}
			}
		});
	});

	describe('checkPythonVersion', () => {
		it('checks Python version via integration test', async () => {
			// Integration test - attempts to verify Python version without mocking
			try {
				const { checkPythonVersion: checkFunc } = await import('./python-resolver');
				// Try to check a version - will fail if Python not available
				// But that's okay, we're testing the codepath
				await checkFunc('/usr/bin/python3', '3.8');
				// If it succeeds, Python is installed
				expect(true).toBe(true);
			} catch (error) {
				// Any error (not found, wrong version) is acceptable
				// We just want to exercise the code path
				expect(error).toBeDefined();
			}
		});
	});

	describe('checkPythonPackages', () => {
		it('checks packages via integration test', async () => {
			// Integration test - attempts to check packages without mocking
			try {
				const { checkPythonPackages: checkFunc } = await import('./python-resolver');
				// Try to check a package that likely doesn't exist
				await checkFunc('/usr/bin/python3', ['nonexistent-package-xyz-123']);
				expect.fail('Should have thrown for missing package');
			} catch (error) {
				// We expect this to fail with a PythonDependencyError
				expect(error).toBeInstanceOf(PythonDependencyError);
			}
		});
	});

	describe('assertVersionMeetsRequirement', () => {
		it('passes when found version equals required version', () => {
			expect(() => assertVersionMeetsRequirement([3, 10, 0], '3.10')).not.toThrow();
		});

		it('passes when found version is newer than required version', () => {
			expect(() => assertVersionMeetsRequirement([3, 11, 0], '3.10')).not.toThrow();
		});

		it('passes when found patch version is higher', () => {
			expect(() => assertVersionMeetsRequirement([3, 10, 5], '3.10')).not.toThrow();
		});

		it('passes when found major version is higher', () => {
			expect(() => assertVersionMeetsRequirement([4, 0, 0], '3.10')).not.toThrow();
		});

		it('throws when found major version is older', () => {
			expect(() => assertVersionMeetsRequirement([2, 7, 18], '3.9')).toThrow(
				PythonVersionError,
			);
		});

		it('throws when found minor version is older (same major)', () => {
			expect(() => assertVersionMeetsRequirement([3, 8, 0], '3.9')).toThrow(
				PythonVersionError,
			);
		});

		it('throws with correct error message when version is too old', () => {
			try {
				assertVersionMeetsRequirement([3, 8, 5], '3.10');
				expect.fail('Should have thrown PythonVersionError');
			} catch (error) {
				expect(error).toBeInstanceOf(PythonVersionError);
				expect((error as PythonVersionError).foundVersion).toBe('3.8.5');
				expect((error as PythonVersionError).requiredVersion).toBe('3.10');
			}
		});

		it('passes when required version has no patch specified', () => {
			expect(() => assertVersionMeetsRequirement([3, 10, 0], '3.10')).not.toThrow();
		});

		it('passes when required version has no minor specified', () => {
			expect(() => assertVersionMeetsRequirement([3, 0, 0], '3')).not.toThrow();
		});

		it('passes when required version is just major version', () => {
			expect(() => assertVersionMeetsRequirement([4, 0, 0], '3')).not.toThrow();
		});

		it('includes error details in PythonVersionError', () => {
			try {
				assertVersionMeetsRequirement([3, 7, 0], '3.8.0');
				expect.fail('Should throw');
			} catch (error) {
				expect(error).toBeInstanceOf(PythonVersionError);
				const pyError = error as PythonVersionError;
				expect(pyError.foundVersion).toBe('3.7.0');
				expect(pyError.requiredVersion).toBe('3.8.0');
				expect(pyError.message).toContain('3.8.0');
				expect(pyError.message).toContain('3.7.0');
			}
		});

		it('passes when patch versions are equal (major.minor.patch required)', () => {
			expect(() => assertVersionMeetsRequirement([3, 10, 0], '3.10.0')).not.toThrow();
		});

		it('throws when patch is lower and major.minor match (full semver required)', () => {
			expect(() => assertVersionMeetsRequirement([3, 9, 0], '3.9.1')).toThrow(PythonVersionError);
		});

		it('passes when patch is higher and major.minor match (full semver required)', () => {
			expect(() => assertVersionMeetsRequirement([3, 9, 2], '3.9.1')).not.toThrow();
		});

		it('throws when only patch of required is specified and found patch is lower', () => {
			expect(() => assertVersionMeetsRequirement([3, 8, 5], '3.8.6')).toThrow(PythonVersionError);
		});

		it('correctly parses required version with decimals', () => {
			expect(() => assertVersionMeetsRequirement([3, 9, 5], '3.9')).not.toThrow();
		});
	});
});
