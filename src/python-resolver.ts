import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PythonNotFoundError, PythonVersionError, PythonDependencyError } from './errors';

const execFileAsync = promisify(execFile);

/**
 * Parses a Python version string and extracts version components.
 *
 * Extracts major, minor, and patch version numbers from the output of
 * `python --version` (e.g., "Python 3.10.2").
 *
 * @param versionOutput - The raw output from `python --version`
 * @returns A tuple of [major, minor, patch] version numbers
 * @throws When the version string does not contain a parseable version pattern
 *
 * @example
 * ```typescript
 * const version = parsePythonVersion('Python 3.10.2');
 * console.log(version); // [3, 10, 2]
 * ```
 */
export function parsePythonVersion(versionOutput: string): [number, number, number] {
	const match = /Python (\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
	if (!match?.[1] || !match?.[2] || !match?.[3]) {
		throw new Error(`Cannot parse Python version from: ${versionOutput}`);
	}
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	return [parseInt(match[1]!, 10), parseInt(match[2]!, 10), parseInt(match[3]!, 10)];
}

/**
 * Asserts that a found Python version meets the minimum required version.
 *
 * Compares a parsed version tuple against a required version string
 * (e.g., "3.10"). Throws if the found version is older than required.
 * Only major and minor version components are compared.
 *
 * @param found - A tuple of [major, minor, patch] version numbers
 * @param required - The minimum required version string (e.g., "3.10")
 * @throws {PythonVersionError} When the found version is older than required
 *
 * @example
 * ```typescript
 * assertVersionMeetsRequirement([3, 10, 2], '3.9'); // Passes
 * assertVersionMeetsRequirement([3, 8, 0], '3.10'); // Throws PythonVersionError
 * ```
 */
export function assertVersionMeetsRequirement(
	found: [number, number, number],
	required: string,
): void {
	const parts = required.split('.').map((p) => parseInt(p, 10));
	const [reqMajor = 0, reqMinor = 0] = parts;
	const [foundMajor, foundMinor] = found;

	if (foundMajor < reqMajor || (foundMajor === reqMajor && foundMinor < reqMinor)) {
		const foundStr = found.join('.');
		throw new PythonVersionError(foundStr, required);
	}
}

/**
 * Resolves the path to a Python 3 executable.
 *
 * Attempts to find a valid Python 3 executable by checking in order:
 * 1. The PYTHON_PATH environment variable (if set)
 * 2. The `python3` command
 * 3. The `python` command
 *
 * Each candidate is validated by running `python --version` to confirm
 * it is a Python 3 installation.
 *
 * @returns The path to a working Python 3 executable
 * @throws {PythonNotFoundError} When no valid Python 3 installation is found
 *
 * @example
 * ```typescript
 * const pythonPath = await resolvePython();
 * console.log(pythonPath); // "/usr/bin/python3"
 * ```
 */
export async function resolvePython(): Promise<string> {
	const pythonPathEnv = process.env['PYTHON_PATH'];
	const candidates: string[] = [];

	if (pythonPathEnv) {
		candidates.push(pythonPathEnv);
	}
	candidates.push('python3', 'python');

	for (const candidate of candidates) {
		try {
			const { stdout, stderr } = await execFileAsync(candidate, ['--version'], {
				encoding: 'utf8',
			});
			const output = (stdout + stderr).trim();
			if (output.startsWith('Python 3')) {
				return candidate;
			}
		} catch {
			// If PYTHON_PATH was explicitly set but failed, throw a specific error
			if (candidate === pythonPathEnv) {
				throw new PythonNotFoundError(
					`PYTHON_PATH environment variable is set to "${pythonPathEnv}", but the executable is not found or is not a valid Python 3 installation.`,
				);
			}
			// Otherwise try next candidate
		}
	}
	throw new PythonNotFoundError();
}

/**
 * Validates that a Python installation meets the minimum version requirement.
 *
 * Runs `python --version` on the given Python path and compares the result
 * against the minimum required version string.
 *
 * @param pythonPath - The path to the Python executable to check
 * @param minVersion - The minimum required version string (e.g., "3.10")
 * @throws {PythonVersionError} When the Python version is older than minVersion
 * @throws When unable to run the Python executable
 *
 * @example
 * ```typescript
 * await checkPythonVersion('/usr/bin/python3', '3.9');
 * ```
 */
export async function checkPythonVersion(pythonPath: string, minVersion: string): Promise<void> {
	const { stdout, stderr } = await execFileAsync(pythonPath, ['--version'], {
		encoding: 'utf8',
	});
	const versionOutput = (stdout + stderr).trim();
	const found = parsePythonVersion(versionOutput);
	assertVersionMeetsRequirement(found, minVersion);
}

/**
 * Validates that all required pip packages are installed.
 *
 * Checks for the presence of each package by running `python -m pip show <package>`.
 * This method verifies installation in the Python environment associated with pythonPath.
 *
 * @param pythonPath - The path to the Python executable to use for package checks
 * @param packages - Array of pip package names to verify (e.g., ["numpy", "pandas"])
 * @throws {PythonDependencyError} When any required package is not installed
 *
 * @example
 * ```typescript
 * await checkPythonPackages('/usr/bin/python3', ['numpy', 'pandas']);
 * ```
 */
export async function checkPythonPackages(pythonPath: string, packages: string[]): Promise<void> {
	for (const pkg of packages) {
		try {
			await execFileAsync(pythonPath, ['-m', 'pip', 'show', pkg], {
				encoding: 'utf8',
			});
		} catch {
			throw new PythonDependencyError(pkg);
		}
	}
}
