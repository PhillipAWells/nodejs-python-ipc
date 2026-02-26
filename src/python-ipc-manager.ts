import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { EventHandler } from '@pawells/rxjs-events';
import { Logger } from '@pawells/logger';
import { resolvePython, checkPythonVersion, checkPythonPackages } from './python-resolver';

/**
 * Request structure for Python IPC communication
 */
export interface PythonRequest {
	type: string;
	data: unknown;
	requestId: string;
}

/**
 * Response structure from Python IPC communication
 */
export interface PythonResponse {
	success: boolean;
	requestId: string;
	data?: unknown;
	error?: string;
}

/**
 * Process lifecycle event discriminated union type
 */
export type ProcessLifecycleEvent =
	| { type: 'exit'; exitCode: number | null; stderr: string }
	| { type: 'error'; error: string; stderr: string };

/**
 * Base class for managing long-lived Python child processes with JSON IPC
 */
/**
 * Configuration options for PythonIpcManager
 */
export interface PythonIpcManagerOptions {
	requestTimeoutMs?: number;
	maxConcurrent?: number;
	logger?: Logger;
}

/* eslint-disable no-magic-numbers */
export abstract class PythonIpcManager {
	private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 60000;
	private static readonly DEFAULT_MAX_CONCURRENT = 2;
	private static readonly DESTROY_TIMEOUT_MS = 5000;
	private static readonly SPAWN_TIMEOUT_MS = 10000;
	/* eslint-enable no-magic-numbers */

	private process: ChildProcess | null = null;

	private readline: ReadlineInterface | null = null;

	private initializePromise: Promise<void> | null = null;

	private readonly pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (reason: unknown) => void;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();

	private initialized = false;

	private readonly requestTimeoutMs: number;

	private inFlightCount = 0;

	private readonly maxConcurrent: number;

	private readonly waitQueue: Array<() => void> = [];

	private readonly logger?: Logger;

	/**
	 * Event handler for process lifecycle events (exit and error)
	 */
	public readonly ProcessEvents = new EventHandler<ProcessLifecycleEvent, { ProcessLifecycle: ProcessLifecycleEvent }>('ProcessLifecycle');

	/**
	 * Get the minimum required Python version
	 * @example "3.10" or "3.9.0"
	 */
	protected abstract getMinPythonVersion(): string;

	/**
	 * Get required pip packages to verify
	 * @example ["numpy", "pandas"]
	 */
	protected abstract getRequiredPackages(): string[];

	/**
	 * Get the absolute path to the Python worker script
	 * @example "/path/to/worker.py"
	 */
	protected abstract getScriptPath(): string;

	/**
	 * Constructor with optional configuration
	 * @param options Configuration options for timeout and concurrency
	 */
	constructor(options?: PythonIpcManagerOptions) {
		this.requestTimeoutMs = options?.requestTimeoutMs ?? PythonIpcManager.DEFAULT_REQUEST_TIMEOUT_MS;
		this.maxConcurrent = options?.maxConcurrent ?? PythonIpcManager.DEFAULT_MAX_CONCURRENT;
		this.logger = options?.logger;
	}

	/**
	 * Acquire a slot in the concurrency limiter
	 * If at capacity, waits in queue until a slot becomes available
	 */
	private async acquireSlot(): Promise<void> {
		if (this.inFlightCount < this.maxConcurrent) {
			this.inFlightCount++;
			return;
		}
		await new Promise<void>((resolve) => {
			this.waitQueue.push(resolve);
		});
		this.inFlightCount++;
	}

	/**
	 * Release a slot in the concurrency limiter
	 * Processes next waiter in queue if any
	 */
	private releaseSlot(): void {
		this.inFlightCount--;
		const next = this.waitQueue.shift();
		if (next) {
			next();
		}
	}

	/**
	 * Centralized debug logging that uses logger if available, otherwise DEBUG env var fallback.
	 * @param message The debug message
	 * @param metadata Optional structured metadata to include with the log
	 */
	private logDebug(message: string, metadata?: Record<string, unknown>): void {
		if (this.logger) {
			this.logger.debug(message, metadata).catch(console.error);
		} else if (process.env['DEBUG']?.includes('nodejs-python-ipc')) {
			console.error(`[Debug] ${message}`, metadata ?? '');
		}
	}

	/**
	 * Initialize the Python process and validate environment.
	 * Safe to call multiple times — idempotent and handles concurrent calls.
	 */
	public async initialize(): Promise<void> {
		if (this.initialized) return;
		if (this.initializePromise) {
			await this.initializePromise;
			return;
		}

		this.initializePromise = this._doInitialize().finally(() => {
			this.initializePromise = null;
		});
		await this.initializePromise;
	}

	/**
	 * Internal implementation of initialization
	 */
	private async _doInitialize(): Promise<void> {
		const pythonPath = await resolvePython();
		await checkPythonVersion(pythonPath, this.getMinPythonVersion());

		const requiredPackages = this.getRequiredPackages();
		if (requiredPackages.length > 0) {
			await checkPythonPackages(pythonPath, requiredPackages);
		}

		const scriptPath = this.getScriptPath();
		this.process = spawn(pythonPath, [scriptPath], {
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: PythonIpcManager.SPAWN_TIMEOUT_MS,
		});

		if (!this.process.stdout) {
			throw new Error('Failed to establish stdout stream from Python process');
		}

		// Set up readline interface to read line-delimited JSON from stdout
		this.readline = createInterface({
			input: this.process.stdout,
			crlfDelay: Infinity,
		});

		// Buffer stderr output for error reporting
		let stderrBuffer = '';

		this.process.stderr?.on('data', (data: Buffer) => {
			const output = data.toString();
			stderrBuffer += output;
			// Also log in real-time if logger or DEBUG is enabled
			this.logDebug('Python stderr output', { output });
		});

		this.readline.on('line', (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;

			try {
				const response = JSON.parse(trimmed) as PythonResponse;
				const pending = this.pending.get(response.requestId);
				if (pending) {
					this.pending.delete(response.requestId);
					clearTimeout(pending.timeout);

					if (response.success) {
						pending.resolve(response.data);
					} else {
						pending.reject(
							new Error(response.error ?? 'Python process returned an error'),
						);
					}
				}
			} catch {
				// Log unparseable lines if DEBUG is enabled
				this.logDebug('Unparseable JSON from Python', { line });
			}
		});

		this.process.on('exit', (code) => {
			// Emit lifecycle event
			this.ProcessEvents.Trigger({
				type: 'exit',
				exitCode: code,
				stderr: stderrBuffer,
			});

			// Reject all pending requests if process dies unexpectedly (Fix B)
			// This enables fast failure instead of 30s timeout for in-flight requests
			if (code !== 0 && code !== null) {
				const entries = Array.from(this.pending.entries());
				const errorMsg = stderrBuffer.trim()
					? `Python process exited with code ${code}\nstderr:\n${stderrBuffer}`
					: `Python process exited with code ${code}`;
				for (const [id, { reject, timeout }] of entries) {
					this.pending.delete(id);
					clearTimeout(timeout);
					reject(new Error(errorMsg));
				}
			}
		});

		this.process.on('error', (err) => {
			// Emit lifecycle event
			this.ProcessEvents.Trigger({
				type: 'error',
				error: err.message,
				stderr: stderrBuffer,
			});

			// Reject all pending requests if process encounters an error
			// This handles spawn errors and other process-level failures
			const entries = Array.from(this.pending.entries());
			const errorMsg = `Python process error: ${err.message}`;
			for (const [id, { reject, timeout }] of entries) {
				this.pending.delete(id);
				clearTimeout(timeout);
				reject(new Error(errorMsg));
			}
		});

		this.initialized = true;
	}

	/**
	 * Sends a request to the Python process and awaits the response.
	 * Auto-initializes if not already initialized.
	 * Enforces concurrency limits through a semaphore pattern.
	 */
	protected async send<TData = unknown, TResult = unknown>(
		type: string,
		data: TData,
	): Promise<TResult> {
		if (!type || type.trim() === '') {
			throw new Error('Request type cannot be empty or falsy');
		}

		if (!this.initialized) {
			await this.initialize();
		}

		// Acquire a concurrency slot
		await this.acquireSlot();

		try {
			const requestId = randomUUID();
			const request: PythonRequest = { type, data, requestId };

			this.logDebug('Sending request', { requestId, type });

			return await new Promise<TResult>((resolve, reject) => {
				const timeout = setTimeout(() => {
					this.pending.delete(requestId);
					this.logDebug('Request timed out', { requestId, timeoutMs: this.requestTimeoutMs });
					reject(new Error(`Request ${requestId} timed out after ${this.requestTimeoutMs}ms`));
				}, this.requestTimeoutMs);

				this.pending.set(requestId, {
					resolve: resolve as (value: unknown) => void,
					reject,
					timeout,
				});

				// Fix C: Check if stdin is writable before attempting to write
				// This prevents "write after end" errors when the process is shutting down
				// Fix C: Check if stdin is writable before attempting to write
				// This prevents "write after end" errors when the process is shutting down
				if (!this.process?.stdin?.writable) {
					this.pending.delete(requestId);
					clearTimeout(timeout);
					this.initialized = false;
					reject(new Error('Python process stdin is not writable; process may have crashed'));
					return;
				}
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				const stdin = this.process.stdin!;

				const line = JSON.stringify(request) + '\n';
				stdin.write(line, (err) => {
					if (err) {
						this.pending.delete(requestId);
						clearTimeout(timeout);
						reject(err);
					}
				});
			});
		} finally {
			// Always release the slot, even if the request fails
			this.releaseSlot();
		}
	}

	/**
	 * Gracefully shuts down the Python process.
	 * Closes stdin and waits for the process to exit (with a timeout).
	 * Rejects all pending requests with a shutdown error.
	 */
	public async destroy(): Promise<void> {
		if (!this.process) return;

		// Reject all pending requests with a descriptive error (Fix A)
		// This prevents orphaned requests from timing out after 30s
		for (const [_id, { reject, timeout }] of this.pending) {
			clearTimeout(timeout);
			reject(new Error('Python IPC process destroyed'));
		}
		this.pending.clear();

		// Close stdin to signal shutdown
		this.process.stdin?.end();

		// Close readline interface
		if (this.readline) {
			this.readline.close();
			this.readline = null;
		}

		// Wait for process to exit, with fallback to SIGKILL
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill('SIGKILL');
				resolve();
			}, PythonIpcManager.DESTROY_TIMEOUT_MS);

			if (this.process) {
				this.process.on('exit', () => {
					clearTimeout(timeout);
					resolve();
				});
			}
		});

		this.process = null;
		this.initialized = false;

		// Clean up event handler
		this.ProcessEvents.Destroy();
	}

	/**
	 * Register signal handlers to gracefully destroy the Python process
	 * Useful in CLI applications to clean up on SIGTERM/SIGINT
	 */
	public setupSignalHandlers(): void {
		const destroy = (): void => {
			this.destroy().catch((err) => {
				console.error('Error during signal-based shutdown:', err);
			});
		};
		process.on('SIGTERM', destroy);
		process.on('SIGINT', destroy);
	}

	/**
	 * Whether the manager has been initialized
	 */
	public get isInitialized(): boolean {
		return this.initialized;
	}
}
