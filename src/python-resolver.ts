import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PythonNotFoundError, PythonVersionError, PythonDependencyError } from './errors.ts';

const execFileAsync = promisify(execFile);

/**
 * Parses a version string like "Python 3.10.2" and returns [major, minor, patch].
 */
export function parsePythonVersion(versionOutput: string): [number, number, number] {
	const match = /Python (\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
	if (!match) {
		throw new Error(`Cannot parse Python version from: ${versionOutput}`);
	}
	return [parseInt(match[1]!, 10), parseInt(match[2]!, 10), parseInt(match[3]!, 10)];
}

/**
 * Compares a found version tuple against a required version string like "3.10".
 * Throws PythonVersionError if the found version is older.
 */
export function assertVersionMeetsRequirement(
	found: [number, number, number],
	required: string
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
 * Tries: PYTHON_PATH env var, then 'python3', then 'python'.
 * Throws PythonNotFoundError if none found.
 */
export async function resolvePython(): Promise<string> {
	const candidates = [
		process.env['PYTHON_PATH'],
		'python3',
		'python'
	].filter((c): c is string => Boolean(c));

	for (const candidate of candidates) {
		try {
			const { stdout, stderr } = await execFileAsync(candidate, ['--version'], {
				encoding: 'utf8'
			});
			const output = (stdout + stderr).trim();
			if (output.startsWith('Python 3')) {
				return candidate;
			}
		}
		catch {
			// Try next candidate
		}
	}
	throw new PythonNotFoundError();
}

/**
 * Validates that pythonPath meets minVersion requirement.
 * Runs `python --version` and compares.
 * Throws PythonVersionError if too old.
 */
export async function checkPythonVersion(pythonPath: string, minVersion: string): Promise<void> {
	const { stdout, stderr } = await execFileAsync(pythonPath, ['--version'], {
		encoding: 'utf8'
	});
	const versionOutput = (stdout + stderr).trim();
	const found = parsePythonVersion(versionOutput);
	assertVersionMeetsRequirement(found, minVersion);
}

/**
 * Checks that all required pip packages are installed.
 * Runs `python -m pip show <package>` for each package.
 * Throws PythonDependencyError if any package is missing.
 */
export async function checkPythonPackages(pythonPath: string, packages: string[]): Promise<void> {
	for (const pkg of packages) {
		try {
			await execFileAsync(pythonPath, ['-m', 'pip', 'show', pkg], {
				encoding: 'utf8'
			});
		}
		catch {
			throw new PythonDependencyError(pkg);
		}
	}
}
