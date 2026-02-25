import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolvePython, checkPythonVersion, checkPythonPackages } from './python-resolver.ts';

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
 * Base class for managing long-lived Python child processes with JSON IPC
 */
/**
 * Configuration options for PythonIpcManager
 */
export interface PythonIpcManagerOptions {
	requestTimeoutMs?: number;
	maxConcurrent?: number;
}

export abstract class PythonIpcManager {
	private process: ChildProcess | null = null;

	private readline: ReadlineInterface | null = null;

	private readonly pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (reason: unknown) => void;
			timeout: NodeJS.Timeout;
		}
	>();

	private initialized = false;

	private readonly requestTimeoutMs: number;

	private inFlightCount = 0;

	private readonly maxConcurrent: number;

	private readonly waitQueue: Array<() => void> = [];

	/**
	 * Get the minimum required Python version
	 */
	protected abstract getMinPythonVersion(): string;

	/**
	 * Get required pip packages to verify
	 */
	protected abstract getRequiredPackages(): string[];

	/**
	 * Get the absolute path to the Python worker script
	 */
	protected abstract getScriptPath(): string;

	/**
	 * Constructor with optional configuration
	 * @param options Configuration options for timeout and concurrency
	 */
	constructor(options?: PythonIpcManagerOptions) {
		this.requestTimeoutMs = options?.requestTimeoutMs ?? 60000;
		this.maxConcurrent = options?.maxConcurrent ?? 2;
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
	 * Initialize the Python process and validate environment.
	 * Safe to call multiple times — idempotent.
	 */
	public async initialize(): Promise<void> {
		if (this.initialized) return;

		const pythonPath = await resolvePython();
		await checkPythonVersion(pythonPath, this.getMinPythonVersion());

		const requiredPackages = this.getRequiredPackages();
		if (requiredPackages.length > 0) {
			await checkPythonPackages(pythonPath, requiredPackages);
		}

		const scriptPath = this.getScriptPath();
		this.process = spawn(pythonPath, [scriptPath], {
			stdio: ['pipe', 'pipe', 'pipe']
		});

		// Set up readline interface to read line-delimited JSON from stdout
		this.readline = createInterface({
			input: this.process.stdout!,
			crlfDelay: Infinity
		});

		// Buffer stderr output for error reporting
		let stderrBuffer = '';
		this.process.stderr?.on('data', (data: Buffer) => {
			const output = data.toString();
			stderrBuffer += output;
			// Also log in real-time if DEBUG is enabled
			if (process.env['DEBUG']) {
				console.error(`[Python Process] ${output}`);
			}
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
					}
					else {
						pending.reject(
							new Error(response.error ?? 'Python process returned an error')
						);
					}
				}
			}
			catch {
				// Ignore unparseable lines (could be debug output)
			}
		});

		this.process.on('exit', (code) => {
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
		data: TData
	): Promise<TResult> {
		if (!this.initialized) {
			await this.initialize();
		}

		// Acquire a concurrency slot
		await this.acquireSlot();

		try {
			const requestId = randomUUID();
			const request: PythonRequest = { type, data, requestId };

			return await new Promise<TResult>((resolve, reject) => {
				const timeout = setTimeout(() => {
					this.pending.delete(requestId);
					reject(new Error(`Request ${requestId} timed out after ${this.requestTimeoutMs}ms`));
				}, this.requestTimeoutMs);

				this.pending.set(requestId, {
					resolve: resolve as (value: unknown) => void,
					reject,
					timeout
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

				const line = JSON.stringify(request) + '\n';
				this.process!.stdin!.write(line, (err) => {
					if (err) {
						this.pending.delete(requestId);
						clearTimeout(timeout);
						reject(err);
					}
				});
			});
		}
		finally {
			// Always release the slot, even if the request fails
			this.releaseSlot();
		}
	}

	/**
	 * Gracefully shuts down the Python process.
	 * Closes stdin and waits for the process to exit (with a 5-second timeout).
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
				if (this.process) {
					this.process.kill('SIGKILL');
				}
				resolve();
			}, 5000);

			this.process!.on('exit', () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.initialized = false;
	}

	/**
	 * Whether the manager has been initialized
	 */
	public get isInitialized(): boolean {
		return this.initialized;
	}
}
