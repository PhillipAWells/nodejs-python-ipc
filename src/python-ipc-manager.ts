import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { EventHandler } from '@pawells/rxjs-events';
import type { Logger } from '@pawells/logger';
import { resolvePython, checkPythonVersion, checkPythonPackages } from './python-resolver';

/**
 * Request structure for Python IPC communication.
 *
 * Represents a single request sent to a Python worker process over stdio.
 * Each request is assigned a unique requestId for response correlation.
 */
export interface PythonRequest {
	/** Type identifier for the request (e.g., "process_image", "compute_stats"). */
	type: string;
	/** Payload data associated with the request (can be any JSON-serializable value). */
	data: unknown;
	/** Unique identifier to correlate this request with its response. */
	requestId: string;
}

/**
 * Response structure from Python IPC communication.
 *
 * Represents the response received from a Python worker process in reply to a request.
 * Includes the requestId to enable response correlation with the original request.
 */
export interface PythonResponse {
	/** Whether the request was processed successfully. */
	success: boolean;
	/** The requestId from the corresponding request (for correlation). */
	requestId: string;
	/** Response payload when success is true (can be any JSON-serializable value). */
	data?: unknown;
	/** Error message when success is false. */
	error?: string;
}

/**
 * Process lifecycle event discriminated union type.
 *
 * Represents events that occur during the Python process lifecycle.
 * Subscribe to `PythonIpcManager.ProcessEvents` to receive these events.
 */
export type ProcessLifecycleEvent =
	| {
		/** Process exited event. */
		type: 'exit';
		/** Exit code (null if process was killed by signal). */
		exitCode: number | null;
		/** Accumulated stderr output from the process. */
		stderr: string;
	}
	| {
		/** Process error event. */
		type: 'error';
		/** Error message describing what went wrong. */
		error: string;
		/** Accumulated stderr output from the process. */
		stderr: string;
	};

/**
 * Configuration options for PythonIpcManager.
 */
export interface PythonIpcManagerOptions {
	/** Request timeout in milliseconds (defaults to 60000). */
	requestTimeoutMs?: number;
	/** Maximum number of concurrent requests to allow (defaults to 2). */
	maxConcurrent?: number;
	/** Logger instance for debug output (uses DEBUG env var if not provided). */
	logger?: Logger;
}

/**
 * Abstract base class for managing long-lived Python worker processes with JSON IPC.
 *
 * Provides a framework for spawning Python subprocesses and communicating with them
 * via line-delimited JSON over stdin/stdout. Key features:
 *
 * - **Auto-initialization**: The first call to `send()` automatically initializes
 *   the Python process if not already running.
 * - **Concurrency control**: Enforces a maximum number of concurrent requests using
 *   a semaphore pattern (configurable, defaults to 2).
 * - **Request/response correlation**: Each request receives a unique requestId for
 *   matching responses.
 * - **Timeout handling**: Requests timeout after a configurable duration (defaults to
 *   60 seconds). When the Python process exits unexpectedly, all pending requests
 *   are immediately rejected.
 * - **Process lifecycle events**: Emits events when the Python process exits or errors.
 * - **Graceful shutdown**: `destroy()` cleanly shuts down the Python process and rejects
 *   all pending requests.
 *
 * Subclasses must implement three abstract methods:
 * - `getMinPythonVersion()`: Minimum Python version (e.g., "3.9")
 * - `getRequiredPackages()`: Array of pip packages to verify
 * - `getScriptPath()`: Absolute path to the Python worker script
 *
 * The Python worker script should:
 * 1. Read line-delimited JSON from stdin
 * 2. For each request, perform work and write a JSON response to stdout
 * 3. Each response must include the requestId from the corresponding request
 *
 * @example
 * ```typescript
 * class MyPythonWorker extends PythonIpcManager {
 *   protected getMinPythonVersion(): string { return '3.9'; }
 *   protected getRequiredPackages(): string[] { return ['numpy']; }
 *   protected getScriptPath(): string { return '/path/to/worker.py'; }
 *
 *   async processImage(imageData: Buffer): Promise<string> {
 *     return this.send('process', { image: imageData.toString('base64') });
 *   }
 * }
 *
 * const worker = new MyPythonWorker();
 * const result = await worker.processImage(imageBuffer);
 * await worker.destroy();
 * ```
 */
/* eslint-disable no-magic-numbers */
export abstract class PythonIpcManager {
	private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 60000;
	private static readonly DEFAULT_MAX_CONCURRENT = 2;
	private static readonly DESTROY_TIMEOUT_MS = 5000;
	private static readonly SPAWN_TIMEOUT_MS = 10000;
	private static readonly MAX_STDERR_BUFFER_SIZE = 10 * 1024; // 10KB
	/* eslint-enable no-magic-numbers */

	private process: ChildProcess | null = null;

	private readline: ReadlineInterface | null = null;

	private initializePromise: Promise<void> | null = null;

	private destroyPromise: Promise<void> | null = null;

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

	private sigTermHandler?: () => void;

	private sigIntHandler?: () => void;

	/**
	 * Event handler for process lifecycle events (exit and error)
	 */
	public readonly ProcessEvents = new EventHandler<ProcessLifecycleEvent, { ProcessLifecycle: ProcessLifecycleEvent }>('ProcessLifecycle');

	/**
	 * Get the minimum required Python version.
	 *
	 * Subclasses must override this to specify the minimum Python version needed
	 * by the worker script.
	 *
	 * @returns Minimum Python version string (e.g., "3.9", "3.10.0")
	 */
	protected abstract getMinPythonVersion(): string;

	/**
	 * Get required pip packages to verify.
	 *
	 * Subclasses must override this to specify pip packages that must be installed
	 * in the Python environment. An empty array means no package validation is performed.
	 *
	 * @returns Array of pip package names to verify (e.g., ["numpy", "pandas"])
	 */
	protected abstract getRequiredPackages(): string[];

	/**
	 * Get the absolute path to the Python worker script.
	 *
	 * Subclasses must override this to specify the entry point for the Python worker.
	 * The path must be absolute and the file must exist.
	 *
	 * @returns Absolute path to the Python worker script (e.g., "/path/to/worker.py")
	 */
	protected abstract getScriptPath(): string;

	/**
	 * Creates a new PythonIpcManager instance.
	 * @param options Configuration options for timeout and concurrency
	 * @throws When maxConcurrent is not a positive integer
	 */
	constructor(options?: PythonIpcManagerOptions) {
		this.requestTimeoutMs = options?.requestTimeoutMs ?? PythonIpcManager.DEFAULT_REQUEST_TIMEOUT_MS;
		const maxConcurrent = options?.maxConcurrent ?? PythonIpcManager.DEFAULT_MAX_CONCURRENT;
		if (maxConcurrent <= 0) {
			throw new Error('maxConcurrent must be a positive integer');
		}
		this.maxConcurrent = maxConcurrent;
		this.logger = options?.logger;
	}

	/**
	 * Acquire a slot in the concurrency limiter.
	 *
	 * Implements a semaphore pattern: if at capacity, waits in queue until a slot
	 * becomes available. Each acquired slot must be released via releaseSlot().
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
	 * Release a slot in the concurrency limiter.
	 *
	 * Decrements the in-flight count and dequeues the next waiting request if any.
	 */
	private releaseSlot(): void {
		this.inFlightCount--;
		const next = this.waitQueue.shift();
		if (next) {
			next();
		}
	}

	/**
	 * Centralized debug logging.
	 *
	 * Uses the configured logger if available, otherwise falls back to the DEBUG
	 * environment variable. Logs are only emitted if logging is enabled.
	 *
	 * @param message - The debug message to log
	 * @param metadata - Optional structured metadata to include with the log
	 */
	private logDebug(message: string, metadata?: Record<string, unknown>): void {
		if (this.logger) {
			this.logger.debug(message, metadata).catch(console.error);
		} else if (process.env['DEBUG']?.includes('nodejs-python-ipc')) {
			console.error(`[Debug] ${message}`, metadata ?? '');
		}
	}

	/**
	 * Initialize the Python process and validate the environment.
	 *
	 * Performs the following steps:
	 * 1. Resolves the Python executable path (PYTHON_PATH → python3 → python)
	 * 2. Validates the Python version meets the minimum requirement
	 * 3. Validates all required pip packages are installed
	 * 4. Spawns the Python worker process with the script path
	 * 5. Sets up stdin/stdout communication and error handling
	 *
	 * This method is safe to call multiple times — it is idempotent and handles
	 * concurrent calls correctly. Subsequent calls will return immediately if
	 * already initialized.
	 *
	 * @throws When Python cannot be resolved, version check fails, packages are missing,
	 *         or the Python process fails to spawn
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
	 * Internal implementation of the initialization process.
	 *
	 * This is called by initialize() and contains the actual setup logic.
	 * It is separated to enable proper promise deduplication for concurrent calls.
	 */
	private async _doInitialize(): Promise<void> {
		const pythonPath = await resolvePython();
		await checkPythonVersion(pythonPath, this.getMinPythonVersion());

		const requiredPackages = this.getRequiredPackages();
		if (requiredPackages.length > 0) {
			await checkPythonPackages(pythonPath, requiredPackages);
		}

		const scriptPath = this.getScriptPath();
		if (!existsSync(scriptPath)) {
			throw new Error(`Python script not found: ${scriptPath}`);
		}
		this.process = spawn(pythonPath, [scriptPath], {
			stdio: ['pipe', 'pipe', 'pipe'],
			// NOTE: do NOT pass `timeout` here. spawn()'s timeout option kills the process
			// after N ms of *total runtime*, not after N ms of startup. A long-lived worker
			// process would be killed after SPAWN_TIMEOUT_MS regardless of whether it is
			// still handling requests. Startup failures surface immediately as 'error' events;
			// the Promise below also enforces a true startup deadline.
		});

		if (!this.process.stdout) {
			throw new Error('Failed to establish stdout stream from Python process');
		}

		// Guard against the process hanging indefinitely before emitting 'spawn'.
		// This is the correct way to enforce a startup deadline: race the 'spawn' event
		// (process started successfully) against 'error' (immediate failure, e.g. ENOENT)
		// and a wall-clock timeout.
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.process?.kill('SIGKILL');
				this.process = null;
				reject(new Error(`Python process did not start within ${PythonIpcManager.SPAWN_TIMEOUT_MS}ms`));
			}, PythonIpcManager.SPAWN_TIMEOUT_MS);

			const onSpawn = (): void => {
				clearTimeout(timer);
				// Remove the one-shot error listener so it does not shadow the permanent one.
				this.process?.removeListener('error', onError);
				resolve();
			};

			const onError = (err: Error): void => {
				clearTimeout(timer);
				this.process?.removeListener('spawn', onSpawn);
				this.process = null;
				reject(err);
			};

			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			this.process!.once('spawn', onSpawn);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			this.process!.once('error', onError);
		});

		// Set up readline interface to read line-delimited JSON from stdout
		this.readline = createInterface({
			input: this.process.stdout,
			// crlfDelay: Infinity tells readline to wait indefinitely after a bare \r
			// before deciding whether a \n follows, i.e. treat \r\n as one line ending
			// regardless of any delay between the two bytes.
			crlfDelay: Infinity,
		});

		// Buffer stderr output for error reporting
		let stderrBuffer = '';

		this.process.stderr?.on('data', (data: Buffer) => {
			const output = data.toString();
			if (stderrBuffer.length < PythonIpcManager.MAX_STDERR_BUFFER_SIZE) {
				stderrBuffer += output;
				if (stderrBuffer.length >= PythonIpcManager.MAX_STDERR_BUFFER_SIZE) {
					stderrBuffer += '\n... (stderr buffer truncated) ...';
				}
			}
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
							new Error(response.error ?? `Python request ${response.requestId} failed without error details`),
						);
					}
				}
			} catch {
				// Log unparseable lines if DEBUG is enabled
				this.logDebug('Unparseable JSON from Python', { line });
			}
		});

		this.process.on('exit', (code) => {
			// Mark as no longer running so isInitialized reflects reality immediately,
			// not only after the next send() detects an unwritable stdin.
			this.initialized = false;

			// Emit lifecycle event
			this.ProcessEvents.Trigger({
				type: 'exit',
				exitCode: code,
				stderr: stderrBuffer,
			});

			// Reject all in-flight requests regardless of exit code. Even a clean exit
			// (code 0) means no further responses will arrive, so pending requests must
			// not be left to hang until their individual timeouts fire.
			const entries = Array.from(this.pending.entries());
			if (entries.length > 0) {
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
			// Mark as no longer running immediately (mirrors the exit handler).
			this.initialized = false;

			// Emit lifecycle event
			this.ProcessEvents.Trigger({
				type: 'error',
				error: err.message,
				stderr: stderrBuffer,
			});

			// Reject all pending requests on any process-level error.
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
	 *
	 * Automatically initializes the Python process if not already initialized.
	 * Enforces concurrency limits through a semaphore pattern.
	 *
	 * The request is serialized to JSON and sent as a single line to the Python
	 * process stdin. The response is awaited and parsed from stdout.
	 *
	 * @param type - The request type identifier
	 * @param data - The request payload (must be JSON-serializable)
	 * @returns The response data from the Python process
	 * @throws When the request type is empty or falsy
	 * @throws When the request times out (after requestTimeoutMs)
	 * @throws When the Python process exits or encounters an error
	 * @throws When the process stdin is not writable
	 *
	 * @example
	 * ```typescript
	 * const result = await this.send('compute', { values: [1, 2, 3] });
	 * ```
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
	 *
	 * Performs the following steps:
	 * 1. Rejects all pending requests with a shutdown error
	 * 2. Closes stdin to signal shutdown to the Python process
	 * 3. Closes the readline interface
	 * 4. Waits up to 5 seconds for the process to exit naturally
	 * 5. Falls back to SIGKILL if the process doesn't exit in time
	 * 6. Cleans up event handlers
	 *
	 * This method is safe to call multiple times and on an uninitialized manager.
	 * All pending requests are immediately rejected to prevent orphaned requests.
	 *
	 * @example
	 * ```typescript
	 * try {
	 *   // Use the manager
	 * } finally {
	 *   await manager.destroy();
	 * }
	 * ```
	 */
	public async destroy(): Promise<void> {
		if (!this.process) return;
		if (this.destroyPromise) {
			await this.destroyPromise;
			return;
		}

		this.destroyPromise = this._doDestroy().finally(() => {
			this.destroyPromise = null;
		});
		await this.destroyPromise;
	}

	/**
	 * Internal implementation of the destroy process.
	 *
	 * This is called by destroy() and contains the actual shutdown logic.
	 * It is separated to enable proper promise deduplication for concurrent calls.
	 */
	private async _doDestroy(): Promise<void> {
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

		// Remove signal handlers registered by setupSignalHandlers() to prevent
		// accumulation across multiple manager instances or repeated destroy() calls.
		if (this.sigTermHandler) {
			process.off('SIGTERM', this.sigTermHandler);
			this.sigTermHandler = undefined;
		}
		if (this.sigIntHandler) {
			process.off('SIGINT', this.sigIntHandler);
			this.sigIntHandler = undefined;
		}

		// Clean up event handler
		this.ProcessEvents.Destroy();
	}

	/**
	 * Register signal handlers to gracefully destroy the Python process.
	 *
	 * Sets up handlers for SIGTERM and SIGINT signals that will trigger a graceful
	 * shutdown of the Python process. Useful in CLI applications and servers to ensure
	 * clean termination.
	 *
	 * Note: Errors during shutdown are logged to stderr but do not propagate.
	 *
	 * @example
	 * ```typescript
	 * const manager = new MyWorker();
	 * manager.setupSignalHandlers();
	 * // Now SIGTERM/SIGINT will cleanly shut down the Python process
	 * ```
	 */
	public setupSignalHandlers(): void {
		// Guard against duplicate registration if called more than once.
		if (this.sigTermHandler ?? this.sigIntHandler) {
			return;
		}

		const destroy = (): void => {
			this.destroy().catch((err) => {
				console.error('Error during signal-based shutdown:', err);
			});
		};

		this.sigTermHandler = destroy;
		this.sigIntHandler = destroy;
		process.on('SIGTERM', destroy);
		process.on('SIGINT', destroy);
	}

	/**
	 * Whether the manager has been initialized.
	 *
	 * @returns true if initialize() has completed successfully, false otherwise
	 */
	public get isInitialized(): boolean {
		return this.initialized;
	}
}
