import {
	PythonNotFoundError,
	PythonVersionError,
	PythonDependencyError,
} from './errors';

describe('PythonNotFoundError', () => {
	it('extends Error', () => {
		const error = new PythonNotFoundError();
		expect(error).toBeInstanceOf(Error);
	});

	it('has correct name property', () => {
		const error = new PythonNotFoundError();
		expect(error.name).toBe('PythonNotFoundError');
	});

	it('has default message when no message provided', () => {
		const error = new PythonNotFoundError();
		expect(error.message).toBe(
			'Python executable not found. Ensure Python is installed and available in PATH.',
		);
	});

	it('accepts custom message', () => {
		const customMessage = 'Custom error message';
		const error = new PythonNotFoundError(customMessage);
		expect(error.message).toBe(customMessage);
	});

	it('preserves prototype chain', () => {
		const error = new PythonNotFoundError();
		expect(Object.getPrototypeOf(error)).toBe(PythonNotFoundError.prototype);
	});
});

describe('PythonVersionError', () => {
	it('extends Error', () => {
		const error = new PythonVersionError('3.8.0', '3.9.0');
		expect(error).toBeInstanceOf(Error);
	});

	it('has correct name property', () => {
		const error = new PythonVersionError('3.8.0', '3.9.0');
		expect(error.name).toBe('PythonVersionError');
	});

	it('stores foundVersion and requiredVersion properties', () => {
		const foundVersion = '3.8.0';
		const requiredVersion = '3.9.0';
		const error = new PythonVersionError(foundVersion, requiredVersion);
		expect(error.foundVersion).toBe(foundVersion);
		expect(error.requiredVersion).toBe(requiredVersion);
	});

	it('has default message when no custom message provided', () => {
		const error = new PythonVersionError('3.8.0', '3.9.0');
		expect(error.message).toBe(
			'Python 3.9.0 or higher is required, but found 3.8.0.',
		);
	});

	it('accepts custom message', () => {
		const customMessage = 'Custom version error';
		const error = new PythonVersionError('3.8.0', '3.9.0', customMessage);
		expect(error.message).toBe(customMessage);
	});

	it('preserves prototype chain', () => {
		const error = new PythonVersionError('3.8.0', '3.9.0');
		expect(Object.getPrototypeOf(error)).toBe(PythonVersionError.prototype);
	});

	it('formats message correctly with different versions', () => {
		const error = new PythonVersionError('2.7.18', '3.10.5');
		expect(error.message).toContain('3.10.5');
		expect(error.message).toContain('2.7.18');
	});
});

describe('PythonDependencyError', () => {
	it('extends Error', () => {
		const error = new PythonDependencyError('numpy');
		expect(error).toBeInstanceOf(Error);
	});

	it('has correct name property', () => {
		const error = new PythonDependencyError('numpy');
		expect(error.name).toBe('PythonDependencyError');
	});

	it('stores dependency property', () => {
		const dependency = 'numpy';
		const error = new PythonDependencyError(dependency);
		expect(error.dependency).toBe(dependency);
	});

	it('has default message when no custom message provided', () => {
		const error = new PythonDependencyError('numpy');
		expect(error.message).toBe(
			'Required Python dependency \'numpy\' is not installed. Run: pip install numpy',
		);
	});

	it('accepts custom message', () => {
		const customMessage = 'Custom dependency error';
		const error = new PythonDependencyError('numpy', customMessage);
		expect(error.message).toBe(customMessage);
	});

	it('preserves prototype chain', () => {
		const error = new PythonDependencyError('numpy');
		expect(Object.getPrototypeOf(error)).toBe(PythonDependencyError.prototype);
	});

	it('formats message correctly with different dependencies', () => {
		const error = new PythonDependencyError('tensorflow');
		expect(error.message).toContain('tensorflow');
		expect(error.message).toContain('pip install');
	});

	it('handles dependency names with special characters', () => {
		const error = new PythonDependencyError('scikit-learn');
		expect(error.message).toContain('scikit-learn');
	});
});
