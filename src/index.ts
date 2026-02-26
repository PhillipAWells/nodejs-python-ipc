/**
 * @module nodejs-python-ipc
 *
 * Node.js to Python inter-process communication (IPC) framework.
 *
 * Provides utilities for spawning and managing long-lived Python worker processes
 * with JSON-based request/response communication over stdin/stdout. Includes:
 *
 * - **Error types**: Custom errors for Python resolution and dependency validation
 * - **Python resolver**: Functions to locate Python executables and validate versions/packages
 * - **IPC manager**: Abstract base class for building Python worker clients
 *
 * ## Quick Start
 *
 * ```typescript
 * import { PythonIpcManager } from '@pawells/nodejs-python-ipc';
 *
 * class MyWorker extends PythonIpcManager {
 *   protected getMinPythonVersion(): string { return '3.9'; }
 *   protected getRequiredPackages(): string[] { return ['numpy']; }
 *   protected getScriptPath(): string { return '/path/to/worker.py'; }
 *
 *   async compute(values: number[]): Promise<number> {
 *     return this.send('compute', { values });
 *   }
 * }
 *
 * const worker = new MyWorker();
 * try {
 *   const result = await worker.compute([1, 2, 3]);
 *   console.log(result);
 * } finally {
 *   await worker.destroy();
 * }
 * ```
 *
 * @see {@link PythonIpcManager} for the main API
 * @see {@link resolvePython} for Python executable resolution
 * @see {@link checkPythonVersion} for version validation
 */

// Error types
export {
	PythonNotFoundError,
	PythonVersionError,
	PythonDependencyError,
} from './errors';

// Python utilities
export {
	resolvePython,
	checkPythonVersion,
	checkPythonPackages,
	parsePythonVersion,
	assertVersionMeetsRequirement,
} from './python-resolver';

// IPC Manager
export type {
	PythonRequest,
	PythonResponse,
	PythonIpcManagerOptions,
	ProcessLifecycleEvent,
} from './python-ipc-manager';

export {
	PythonIpcManager,
} from './python-ipc-manager';
