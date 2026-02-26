/**
 * Error thrown when Python executable cannot be found.
 *
 * Thrown when the Python resolver cannot locate a valid Python 3 installation
 * via the PYTHON_PATH environment variable or standard command-line paths
 * (python3, python).
 *
 * @example
 * ```typescript
 * try {
 *   const pythonPath = await resolvePython();
 * } catch (error) {
 *   if (error instanceof PythonNotFoundError) {
 *     console.error('Python is not installed or not in PATH');
 *   }
 * }
 * ```
 */
export class PythonNotFoundError extends Error {
	/** Error name for instanceof checks and error handling. */
	public override readonly name = 'PythonNotFoundError';

	/**
	 * Creates a PythonNotFoundError.
	 * @param message - Custom error message (defaults to a descriptive message about Python not being found)
	 */
	constructor(
		message = 'Python executable not found. Ensure Python is installed and available in PATH.',
	) {
		super(message);
		Object.setPrototypeOf(this, PythonNotFoundError.prototype);
	}
}

/**
 * Error thrown when Python version does not meet minimum requirements.
 *
 * Thrown when the installed Python version is older than the minimum required
 * version for the application or worker script.
 *
 * @example
 * ```typescript
 * try {
 *   await checkPythonVersion('/usr/bin/python3', '3.10');
 * } catch (error) {
 *   if (error instanceof PythonVersionError) {
 *     console.error(`Found ${error.foundVersion}, need ${error.requiredVersion}`);
 *   }
 * }
 * ```
 */
export class PythonVersionError extends Error {
	/** Error name for instanceof checks and error handling. */
	public override readonly name = 'PythonVersionError';

	/**
	 * Creates a PythonVersionError.
	 * @param foundVersion - The installed Python version string (e.g., "3.8.5")
	 * @param requiredVersion - The minimum required Python version string (e.g., "3.10")
	 * @param message - Custom error message (defaults to a descriptive message comparing versions)
	 */
	constructor(
		/** The installed Python version string (e.g., "3.8.5"). */
		public readonly foundVersion: string,
		/** The minimum required Python version string (e.g., "3.10"). */
		public readonly requiredVersion: string,
		message?: string,
	) {
		super(
			message ?? `Python ${requiredVersion} or higher is required, but found ${foundVersion}.`,
		);
		Object.setPrototypeOf(this, PythonVersionError.prototype);
	}
}

/**
 * Error thrown when a required Python dependency is missing.
 *
 * Thrown when a pip package checked via `pip show` is not installed in the
 * Python environment.
 *
 * @example
 * ```typescript
 * try {
 *   await checkPythonPackages('/usr/bin/python3', ['numpy', 'pandas']);
 * } catch (error) {
 *   if (error instanceof PythonDependencyError) {
 *     console.error(`Missing dependency: ${error.dependency}`);
 *   }
 * }
 * ```
 */
export class PythonDependencyError extends Error {
	/** Error name for instanceof checks and error handling. */
	public override readonly name = 'PythonDependencyError';

	/**
	 * Creates a PythonDependencyError.
	 * @param dependency - The name of the missing pip package (e.g., "numpy")
	 * @param message - Custom error message (defaults to a message with installation instructions)
	 */
	constructor(
		/** The name of the missing pip package (e.g., "numpy"). */
		public readonly dependency: string,
		message?: string,
	) {
		super(
			message ??
				`Required Python dependency '${dependency}' is not installed. Run: pip install ${dependency}`,
		);
		Object.setPrototypeOf(this, PythonDependencyError.prototype);
	}
}
