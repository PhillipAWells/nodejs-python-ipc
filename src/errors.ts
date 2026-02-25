/**
 * Error thrown when Python executable cannot be found
 */
export class PythonNotFoundError extends Error {
	public override readonly name = 'PythonNotFoundError';

	constructor(
		message = 'Python executable not found. Ensure Python is installed and available in PATH.'
	) {
		super(message);
		Object.setPrototypeOf(this, PythonNotFoundError.prototype);
	}
}

/**
 * Error thrown when Python version does not meet minimum requirements
 */
export class PythonVersionError extends Error {
	public override readonly name = 'PythonVersionError';

	constructor(
		public readonly foundVersion: string,
		public readonly requiredVersion: string,
		message?: string
	) {
		super(
			message ?? `Python ${requiredVersion} or higher is required, but found ${foundVersion}.`
		);
		Object.setPrototypeOf(this, PythonVersionError.prototype);
	}
}

/**
 * Error thrown when required Python dependency is missing
 */
export class PythonDependencyError extends Error {
	public override readonly name = 'PythonDependencyError';

	constructor(
		public readonly dependency: string,
		message?: string
	) {
		super(
			message ??
				`Required Python dependency '${dependency}' is not installed. Run: pip install ${dependency}`
		);
		Object.setPrototypeOf(this, PythonDependencyError.prototype);
	}
}
