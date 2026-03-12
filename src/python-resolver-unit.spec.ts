/**
 * Unit tests for python-resolver functions that require subprocesses.
 *
 * These tests mock node:child_process so they run without a real Python
 * installation and exercise specific code paths that the integration tests
 * in python-resolver.spec.ts cannot reach in a deterministic way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PythonNotFoundError, PythonVersionError, PythonDependencyError } from './errors';

vi.mock('node:child_process');
vi.mock('node:util', () => ({
	promisify: (fn: unknown) => fn,
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

// Import the resolver functions after mocking their dependencies.
// Dynamic import is used so the mocks are in place before module evaluation.
const { resolvePython, checkPythonVersion, checkPythonPackages } = await import('./python-resolver');

describe('resolvePython (unit)', () => {
	beforeEach(() => {
		mockExecFile.mockReset();
		delete process.env['PYTHON_PATH'];
	});

	it('returns python3 when it reports Python 3', async () => {
		mockExecFile.mockResolvedValue({ stdout: 'Python 3.11.2\n', stderr: '' } as any);
		const result = await resolvePython();
		expect(result).toBe('python3');
	});

	it('falls back to python when python3 is not found', async () => {
		mockExecFile
			.mockRejectedValueOnce(new Error('ENOENT')) // python3 fails
			.mockResolvedValueOnce({ stdout: 'Python 3.9.0\n', stderr: '' } as any); // python succeeds
		const result = await resolvePython();
		expect(result).toBe('python');
	});

	it('throws PythonNotFoundError when no candidate works', async () => {
		mockExecFile.mockRejectedValue(new Error('ENOENT'));
		await expect(resolvePython()).rejects.toBeInstanceOf(PythonNotFoundError);
	});

	it('throws PythonNotFoundError when all candidates return Python 2', async () => {
		mockExecFile.mockResolvedValue({ stdout: 'Python 2.7.18\n', stderr: '' } as any);
		await expect(resolvePython()).rejects.toBeInstanceOf(PythonNotFoundError);
	});

	it('uses PYTHON_PATH when set and it reports Python 3', async () => {
		process.env['PYTHON_PATH'] = '/opt/custom/python3';
		mockExecFile.mockResolvedValueOnce({ stdout: 'Python 3.10.4\n', stderr: '' } as any);
		const result = await resolvePython();
		expect(result).toBe('/opt/custom/python3');
		expect(mockExecFile).toHaveBeenCalledWith(
			'/opt/custom/python3',
			['--version'],
			expect.anything(),
		);
	});

	it('throws specific PythonNotFoundError mentioning PYTHON_PATH when it fails', async () => {
		process.env['PYTHON_PATH'] = '/bad/python';
		mockExecFile.mockRejectedValue(new Error('ENOENT'));
		await expect(resolvePython()).rejects.toSatisfy(
			(e: unknown) =>
				e instanceof PythonNotFoundError && e.message.includes('PYTHON_PATH'),
		);
	});

	it('reads version from stderr when stdout is empty (older Python versions)', async () => {
		// Some Python versions print to stderr rather than stdout
		mockExecFile.mockResolvedValue({ stdout: '', stderr: 'Python 3.8.10\n' } as any);
		const result = await resolvePython();
		expect(result).toBe('python3');
	});
});

describe('checkPythonVersion (unit)', () => {
	beforeEach(() => {
		mockExecFile.mockReset();
	});

	it('resolves when version meets requirement', async () => {
		mockExecFile.mockResolvedValue({ stdout: 'Python 3.11.2\n', stderr: '' } as any);
		await expect(checkPythonVersion('/usr/bin/python3', '3.9')).resolves.toBeUndefined();
	});

	it('throws PythonVersionError when version is too old', async () => {
		mockExecFile.mockResolvedValue({ stdout: 'Python 3.7.9\n', stderr: '' } as any);
		await expect(checkPythonVersion('/usr/bin/python3', '3.9')).rejects.toBeInstanceOf(PythonVersionError);
	});

	it('throws PythonVersionError including versions in message', async () => {
		mockExecFile.mockResolvedValue({ stdout: 'Python 3.8.5\n', stderr: '' } as any);
		try {
			await checkPythonVersion('/usr/bin/python3', '3.9.1');
			expect.fail('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(PythonVersionError);
			const err = e as PythonVersionError;
			expect(err.foundVersion).toBe('3.8.5');
			expect(err.requiredVersion).toBe('3.9.1');
		}
	});

	it('propagates exec errors (e.g. binary not found)', async () => {
		mockExecFile.mockRejectedValue(new Error('spawn ENOENT'));
		await expect(checkPythonVersion('/nonexistent', '3.9')).rejects.toThrow('spawn ENOENT');
	});
});

describe('checkPythonPackages (unit)', () => {
	beforeEach(() => {
		mockExecFile.mockReset();
	});

	it('resolves when all packages are present', async () => {
		mockExecFile.mockResolvedValue({ stdout: 'Name: numpy\n', stderr: '' } as any);
		await expect(
			checkPythonPackages('/usr/bin/python3', ['numpy', 'pandas']),
		).resolves.toBeUndefined();
		expect(mockExecFile).toHaveBeenCalledTimes(2);
	});

	it('throws PythonDependencyError for first missing package', async () => {
		mockExecFile
			.mockResolvedValueOnce({ stdout: 'Name: numpy\n', stderr: '' } as any) // numpy present
			.mockRejectedValueOnce(new Error('exit code 1')); // pandas missing
		await expect(
			checkPythonPackages('/usr/bin/python3', ['numpy', 'pandas']),
		).rejects.toBeInstanceOf(PythonDependencyError);
	});

	it('throws PythonDependencyError with the correct package name', async () => {
		mockExecFile.mockRejectedValue(new Error('exit code 1'));
		try {
			await checkPythonPackages('/usr/bin/python3', ['scikit-learn']);
			expect.fail('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(PythonDependencyError);
			expect((e as PythonDependencyError).dependency).toBe('scikit-learn');
		}
	});

	it('resolves immediately when packages list is empty', async () => {
		await expect(checkPythonPackages('/usr/bin/python3', [])).resolves.toBeUndefined();
		expect(mockExecFile).not.toHaveBeenCalled();
	});

	it('uses the correct python executable path for pip', async () => {
		mockExecFile.mockResolvedValue({ stdout: 'Name: requests\n', stderr: '' } as any);
		await checkPythonPackages('/custom/python', ['requests']);
		expect(mockExecFile).toHaveBeenCalledWith(
			'/custom/python',
			['-m', 'pip', 'show', 'requests'],
			expect.anything(),
		);
	});
});
