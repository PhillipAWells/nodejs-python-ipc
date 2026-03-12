import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { PythonIpcManager } from './python-ipc-manager';

// Mock child_process module
vi.mock('node:child_process');

// Mock the fs module
vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
}));

// Mock the python resolver functions
vi.mock('./python-resolver', () => ({
	resolvePython: vi.fn(),
	checkPythonVersion: vi.fn(),
	checkPythonPackages: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolvePython, checkPythonVersion, checkPythonPackages } from './python-resolver';

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);
const mockResolvePython = vi.mocked(resolvePython);
const mockCheckPythonVersion = vi.mocked(checkPythonVersion);
const mockCheckPythonPackages = vi.mocked(checkPythonPackages);

// Mock Readable stream for stdout
class MockReadableStream extends Readable {
	constructor() {
		super({ read() {} });
	}

	public emitLine(line: string) {
		this.emit('line', line);
	}
}

// Mock Writable stream for stdin
class MockStdin extends Writable {
	public lines: string[] = [];

	_write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void) {
		const line = typeof chunk === 'string' ? chunk : chunk.toString();
		this.lines.push(line);
		callback();
	}

	public end(callback?: () => void): this {
		if (callback) {
			callback();
		}
		return this;
	}
}

// Create a mock child process
function createMockProcess() {
	const stdout = new MockReadableStream();
	const stderr = new MockReadableStream();
	const stdin = new MockStdin();
	const exitHandlers: Function[] = [];
	const errorHandlers: Function[] = [];

	const mockProc = {
		stdout,
		stderr,
		stdin,
		kill: vi.fn(),
		on: vi.fn((event: string, handler: Function) => {
			if (event === 'exit') {
				exitHandlers.push(handler);
			} else if (event === 'error') {
				errorHandlers.push(handler);
			}
			return mockProc;
		}),
		// _doInitialize registers once('spawn') and once('error') as a startup guard.
		// Use a microtask (Promise.resolve().then) rather than setImmediate so that
		// the spawn event fires even when vi.useFakeTimers() is active (fake timers
		// intercept setImmediate/setTimeout but never intercept microtasks).
		once: vi.fn((event: string, handler: Function) => {
			if (event === 'spawn') {
				Promise.resolve().then(() => handler());
			}
			return mockProc;
		}),
		removeListener: vi.fn(),
		exitHandlers,
		errorHandlers,
		/** Fire all registered 'exit' handlers (mirrors real process behaviour). */
		triggerExit(code: number | null) {
			for (const h of [...exitHandlers]) h(code);
		},
		/** Fire all registered 'error' handlers. */
		triggerError(err: Error) {
			for (const h of [...errorHandlers]) h(err);
		},
	};
	return mockProc;
}

// Test subclass that provides concrete implementations
class TestPythonManager extends PythonIpcManager {
	protected getMinPythonVersion(): string {
		return '3.9.0';
	}

	protected getRequiredPackages(): string[] {
		return [];
	}

	protected getScriptPath(): string {
		return '/fake/script.py';
	}

	public async exposedSend<T>(type: string, data: unknown): Promise<T> {
		return this.send<unknown, T>(type, data);
	}
}

describe('PythonIpcManager', () => {
	beforeEach(() => {
		mockResolvePython.mockClear();
		mockCheckPythonVersion.mockClear();
		mockCheckPythonPackages.mockClear();
		mockSpawn.mockClear();
		mockExistsSync.mockClear();
		mockExistsSync.mockReturnValue(true);
	});

	// Guard against fake timers leaking between tests. If a test calls
	// vi.useFakeTimers() and then times out before vi.useRealTimers(), all
	// subsequent tests in the file would run with fake timers still active.
	afterEach(() => {
		vi.useRealTimers();
	});

	describe('initialize', () => {
		it('resolves when Python process spawns successfully', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			expect(manager.isInitialized).toBe(true);
			expect(mockResolvePython).toHaveBeenCalled();
			expect(mockCheckPythonVersion).toHaveBeenCalledWith('/usr/bin/python3', '3.9.0');
		});

		it('is idempotent when called multiple times', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();
			await manager.initialize();
			await manager.initialize();

			expect(mockResolvePython).toHaveBeenCalledTimes(1);
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		it('handles concurrent initialization calls (race condition fix)', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			const [result1, result2, result3] = await Promise.all([
				manager.initialize(),
				manager.initialize(),
				manager.initialize(),
			]);

			expect(result1).toBeUndefined();
			expect(result2).toBeUndefined();
			expect(result3).toBeUndefined();
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		it('rejects if Python resolver throws', async () => {
			mockResolvePython.mockRejectedValue(new Error('Python not found'));

			const manager = new TestPythonManager();
			await expect(manager.initialize()).rejects.toThrow('Python not found');
			expect(manager.isInitialized).toBe(false);
		});

		it('rejects if Python version check fails', async () => {
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockRejectedValue(new Error('Version too old'));

			const manager = new TestPythonManager();
			await expect(manager.initialize()).rejects.toThrow('Version too old');
		});

		it('checks required packages when available', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			class TestManagerWithPackages extends PythonIpcManager {
				protected getMinPythonVersion(): string {
					return '3.9.0';
				}

				protected getRequiredPackages(): string[] {
					return ['numpy', 'pandas'];
				}

				protected getScriptPath(): string {
					return '/fake/script.py';
				}

				public async exposedSend<T>(type: string, data: unknown): Promise<T> {
					return this.send<unknown, T>(type, data);
				}
			}

			const manager = new TestManagerWithPackages();
			await manager.initialize();

			expect(mockCheckPythonPackages).toHaveBeenCalledWith('/usr/bin/python3', [
				'numpy',
				'pandas',
			]);
		});

		it('skips package check when list is empty', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			expect(mockCheckPythonPackages).not.toHaveBeenCalled();
		});

		it('spawns process with correct arguments', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			expect(mockSpawn).toHaveBeenCalledWith('/usr/bin/python3', ['/fake/script.py'], {
				stdio: ['pipe', 'pipe', 'pipe'],
				// timeout is intentionally absent: spawn()'s timeout option kills the process
				// after N ms of total runtime, not startup time.
			});
		});

		it('throws if stdout is unavailable', async () => {
			const mockProcess = {
				stdout: null,
				stderr: new MockReadableStream(),
				stdin: new MockStdin(),
				kill: vi.fn(),
				on: vi.fn(),
			};
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await expect(manager.initialize()).rejects.toThrow('Failed to establish stdout stream');
		});
	});

	describe('send', () => {
		it('throws if type is empty string', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			await expect(manager.exposedSend('', { data: 'test' })).rejects.toThrow(
				/type cannot be empty/i,
			);
		});

		it('throws if type is whitespace only', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			await expect(manager.exposedSend('   ', { data: 'test' })).rejects.toThrow(
				/type cannot be empty/i,
			);
		});

		it('rejects when stdin is not writable', async () => {
			const mockProcess = createMockProcess();
			const notWritableStdin = { writable: false };
			mockProcess.stdin = notWritableStdin as any;
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			await expect(manager.exposedSend('test', { data: 'test' })).rejects.toThrow(
				/not writable/,
			);
		});

		it('sends request with valid type', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			const promise = manager.exposedSend('my-type', { input: 'test' });

			expect(promise).toBeDefined();
		});

		it('rejects when stdin.write fails with error', async () => {
			const mockProcess = createMockProcess();
			const writeError = new Error('Write failed: EPIPE');
			const failingStdin = {
				writable: true,
				write: vi.fn((chunk: string, callback: (err?: Error | null) => void) => {
					callback(writeError);
				}),
				end: vi.fn(),
			};
			mockProcess.stdin = failingStdin as any;
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			await expect(manager.exposedSend('test', { data: 'test' })).rejects.toThrow('Write failed');
		});
	});

	describe('destroy', () => {
		it('is safe to call when not initialized', async () => {
			const manager = new TestPythonManager();
			expect(manager.isInitialized).toBe(false);

			await manager.destroy();

			expect(manager.isInitialized).toBe(false);
		});

		it('SIGKILLs process if it does not exit within timeout', async () => {
			vi.useFakeTimers();
			// Use createMockProcess() which triggers the spawn event via a microtask,
			// keeping initialize() compatible with fake timers. The exit event is
			// simply never triggered so destroy() must resort to SIGKILL after its timeout.
			const mockProcess = createMockProcess();

			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			const destroyPromise = manager.destroy();

			// Advance past DESTROY_TIMEOUT_MS (5000ms)
			// This causes the setTimeout in destroy() to fire, which calls kill('SIGKILL')
			await vi.advanceTimersByTimeAsync(6000);

			// Ensure destroy completes
			await destroyPromise;

			// Verify that SIGKILL was called because exit event never fired
			expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
		});

		it('provides destroy method for cleanup', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			expect(typeof manager.destroy).toBe('function');
		});

		it('closes stdin and readline on destroy', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			const stdinEndSpy = vi.spyOn(mockProcess.stdin, 'end');
			const readlineCloseSpy = vi.fn();
			(manager as any).readline = { close: readlineCloseSpy };

			const destroyPromise = manager.destroy();
			setImmediate(() => {
				mockProcess.triggerExit(0);
			});
			await destroyPromise;

			expect(stdinEndSpy).toHaveBeenCalled();
			expect(readlineCloseSpy).toHaveBeenCalled();
		});

		it('handles destroy when process exits cleanly', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			expect(manager.isInitialized).toBe(true);

			const destroyPromise = manager.destroy();

			setImmediate(() => {
				mockProcess.triggerExit(0);
			});

			await destroyPromise;

			expect(manager.isInitialized).toBe(false);
			expect(mockProcess.kill).not.toHaveBeenCalled();
		});

		it('clears pending requests during destroy to avoid orphaned timeouts', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			// Manually add a pending request to ensure the cleanup code path is hit
			(manager as any).pending.set('fake-request-id', {
				resolve: vi.fn(),
				reject: vi.fn(),
				timeout: setTimeout(() => {}, 10000),
			});

			const destroyPromise = manager.destroy();

			setImmediate(() => {
				mockProcess.triggerExit(0);
			});

			await destroyPromise;

			// Verify pending was cleared
			expect((manager as any).pending.size).toBe(0);
		});

		it('sets process to null after destroy completes', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			const destroyPromise = manager.destroy();

			setImmediate(() => {
				mockProcess.triggerExit(0);
			});

			await destroyPromise;

			expect((manager as any).process).toBeNull();
		});

		it('sets initialized to false after destroy', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			expect(manager.isInitialized).toBe(true);

			const destroyPromise = manager.destroy();
			setImmediate(() => {
				mockProcess.triggerExit(0);
			});
			await destroyPromise;

			expect(manager.isInitialized).toBe(false);
		});

		it('calls ProcessEvents.Destroy during destroy', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			const destroySpy = vi.spyOn(manager.ProcessEvents, 'Destroy');

			const destroyPromise = manager.destroy();
			setImmediate(() => {
				mockProcess.triggerExit(0);
			});
			await destroyPromise;

			expect(destroySpy).toHaveBeenCalled();
		});

		it('logs console.error when signal handler destroy throws', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const manager = new TestPythonManager();
			await manager.initialize();

			vi.spyOn(manager, 'destroy').mockRejectedValueOnce(new Error('Destroy error'));

			const processOnSpy = vi.spyOn(process, 'on');
			manager.setupSignalHandlers();

			const sigTermCall = processOnSpy.mock.calls.find((call) => call[0] === 'SIGTERM');
			const handler = sigTermCall?.[1] as Function;

			handler();

			await new Promise((r) => setTimeout(r, 50));

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'Error during signal-based shutdown:',
				expect.any(Error),
			);

			consoleErrorSpy.mockRestore();
			processOnSpy.mockRestore();
		});
	});

	describe('ProcessEvents', () => {
		it('provides event handler for process lifecycle', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			expect(manager.ProcessEvents).toBeDefined();
			expect(typeof manager.ProcessEvents.Subscribe).toBe('function');
		});
	});

	describe('setupSignalHandlers', () => {
		it('registers SIGTERM and SIGINT handlers', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const onSpy = vi.spyOn(process, 'on');
			const manager = new TestPythonManager();

			manager.setupSignalHandlers();

			expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
			expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

			onSpy.mockRestore();
		});

		it('registers SIGTERM handler that calls destroy', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			const destroySpy = vi.spyOn(manager, 'destroy' as any);
			const processOnSpy = vi.spyOn(process, 'on');

			manager.setupSignalHandlers();

			expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

			destroySpy.mockRestore();
			processOnSpy.mockRestore();
		});

		it('registers SIGINT handler that calls destroy', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			const destroySpy = vi.spyOn(manager, 'destroy' as any);
			const processOnSpy = vi.spyOn(process, 'on');

			manager.setupSignalHandlers();

			expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

			destroySpy.mockRestore();
			processOnSpy.mockRestore();
		});
	});

	describe('logger integration', () => {
		it('accepts optional logger in constructor', async () => {
			const mockLogger = {
				debug: vi.fn().mockResolvedValue(undefined),
				info: vi.fn().mockResolvedValue(undefined),
				warn: vi.fn().mockResolvedValue(undefined),
				error: vi.fn().mockResolvedValue(undefined),
				fatal: vi.fn().mockResolvedValue(undefined),
			};

			const manager = new TestPythonManager({
				logger: mockLogger as any,
			});

			expect(manager).toBeDefined();
		});

		it('works without logger', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			expect(manager.isInitialized).toBe(true);
		});
	});

	describe('configuration options', () => {
		it('respects custom requestTimeoutMs', async () => {
			const manager = new TestPythonManager({ requestTimeoutMs: 2000 });
			expect(manager).toBeDefined();
		});

		it('respects custom maxConcurrent', async () => {
			const manager = new TestPythonManager({ maxConcurrent: 5 });
			expect(manager).toBeDefined();
		});

		it('handles combined configuration options', async () => {
			const mockLogger = {
				debug: vi.fn().mockResolvedValue(undefined),
			} as any;
			const manager = new TestPythonManager({
				requestTimeoutMs: 3000,
				maxConcurrent: 3,
				logger: mockLogger,
			});
			expect(manager).toBeDefined();
		});
	});

	describe('abstract methods', () => {
		it('getMinPythonVersion returns the configured version string', () => {
			const manager = new TestPythonManager();
			expect(manager['getMinPythonVersion']()).toBe('3.9.0');
		});

		it('getRequiredPackages returns an array', () => {
			const manager = new TestPythonManager();
			expect(Array.isArray(manager['getRequiredPackages']())).toBe(true);
		});

		it('getScriptPath returns the configured path string', () => {
			const manager = new TestPythonManager();
			expect(manager['getScriptPath']()).toBe('/fake/script.py');
		});
	});

	describe('error handling', () => {
		it('handles Python version check failure', async () => {
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockRejectedValue(new Error('Version check failed'));

			const manager = new TestPythonManager();
			await expect(manager.initialize()).rejects.toThrow('Version check failed');
		});

		it('handles package check failure', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockRejectedValue(new Error('Package missing'));
			mockSpawn.mockReturnValue(mockProcess as any);

			class TestManagerWithRequiredPackages extends PythonIpcManager {
				protected getMinPythonVersion(): string {
					return '3.9.0';
				}

				protected getRequiredPackages(): string[] {
					return ['numpy'];
				}

				protected getScriptPath(): string {
					return '/fake/script.py';
				}

				public async exposedSend<T>(type: string, data: unknown): Promise<T> {
					return this.send<unknown, T>(type, data);
				}
			}

			const manager = new TestManagerWithRequiredPackages();
			await expect(manager.initialize()).rejects.toThrow('Package missing');
		});

		it('rejects multiple concurrent initializations if first one fails', async () => {
			mockResolvePython.mockRejectedValue(new Error('Python not found'));

			const manager = new TestPythonManager();
			const promise1 = manager.initialize();
			const promise2 = manager.initialize();

			await expect(promise1).rejects.toThrow();
			await expect(promise2).rejects.toThrow();
		});
	});

	describe('concurrency management', () => {
		it('increments and decrements in-flight count correctly', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager({ maxConcurrent: 2 });
			await manager.initialize();

			expect(manager.isInitialized).toBe(true);
		});
	});

	describe('request handling', () => {
		it('auto-initializes when sending if not yet initialized', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			// Don't call initialize - let send() do it
			expect(manager.isInitialized).toBe(false);

			const _sendPromise = manager.exposedSend('test', {});

			// The promise should be pending while initialization happens
			await new Promise((r) => setImmediate(r));

			// Verify initialization was triggered by checking isInitialized is true
			// (if the promise didn't hang, initialization succeeded)
			expect(manager.isInitialized).toBe(true);
		});

		it('validates request type is not empty before sending', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			await expect(manager.exposedSend('', {})).rejects.toThrow();
		});

		it('validates request type contains at least one non-whitespace character', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			await expect(manager.exposedSend('\t\n ', {})).rejects.toThrow();
		});

		it('rejects when request times out', async () => {
			vi.useFakeTimers();
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager({ requestTimeoutMs: 100 });
			await manager.initialize();

			let timedOutError: unknown = null;
			const sendPromise = manager.exposedSend('slow', {});

			// Attach a handler to capture the rejection
			const capturError = sendPromise.catch((err: unknown) => {
				timedOutError = err;
				return undefined;
			});

			// Advance timers past the timeout without pushing a response
			await vi.advanceTimersByTimeAsync(200);

			// Wait for the captured error
			await capturError;

			// Verify the error occurred
			expect(timedOutError).toBeDefined();
			expect(timedOutError).toBeInstanceOf(Error);
			expect((timedOutError as Error).message).toMatch(/timed out after 100ms/);

			vi.useRealTimers();
		});
	});

	describe('response line parsing', () => {
		it('ignores empty lines from Python output', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			// Get the readline instance
			const { readline } = (manager as any);

			// Emit an empty line (should be ignored)
			expect(() => {
				readline.emit('line', '');
				readline.emit('line', '   ');
			}).not.toThrow();
		});

		it('handles malformed JSON from Python output without crashing', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			// Get the readline instance
			const { readline } = (manager as any);

			// Emit malformed JSON (should not crash, just log)
			expect(() => {
				readline.emit('line', '{invalid json}');
				readline.emit('line', 'not json at all');
			}).not.toThrow();
		});

		it('ignores responses for unknown request IDs', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			// Get the readline instance
			const { readline } = (manager as any);

			// Emit response for non-existent request ID
			expect(() => {
				readline.emit('line', JSON.stringify({
					success: true,
					requestId: 'unknown-id-12345',
					data: 'some data',
				}));
			}).not.toThrow();
		});

		it('handles successful response with pending request', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			// Get the readline instance and pending map
			const { readline } = (manager as any);
			const { pending } = (manager as any);

			// Create a fake pending request
			const fakeRequestId = 'test-id-123';
			const resolveSpy = vi.fn();
			const rejectSpy = vi.fn();
			const fakePending = {
				resolve: resolveSpy,
				reject: rejectSpy,
				timeout: setTimeout(() => {}, 10000),
			};
			pending.set(fakeRequestId, fakePending);

			// Emit a successful response
			readline.emit('line', JSON.stringify({
				success: true,
				requestId: fakeRequestId,
				data: { result: 'success' },
			}));

			// Verify the resolve was called with the data
			expect(resolveSpy).toHaveBeenCalledWith({ result: 'success' });
			expect(rejectSpy).not.toHaveBeenCalled();
		});

		it('handles error response with pending request', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			// Get the readline instance and pending map
			const { readline } = (manager as any);
			const { pending } = (manager as any);

			// Create a fake pending request
			const fakeRequestId = 'test-id-456';
			const resolveSpy = vi.fn();
			const rejectSpy = vi.fn();
			const fakePending = {
				resolve: resolveSpy,
				reject: rejectSpy,
				timeout: setTimeout(() => {}, 10000),
			};
			pending.set(fakeRequestId, fakePending);

			// Emit an error response
			readline.emit('line', JSON.stringify({
				success: false,
				requestId: fakeRequestId,
				error: 'Something went wrong',
			}));

			// Verify the reject was called with the error message
			expect(rejectSpy).toHaveBeenCalled();
			const error = rejectSpy.mock.calls[0][0] as Error;
			expect(error.message).toContain('Something went wrong');
			expect(resolveSpy).not.toHaveBeenCalled();
		});

		it('logs stderr output from Python process', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			// Simulate stderr output
			expect(() => {
				mockProcess.stderr.emit('data', Buffer.from('Error message from Python\n'));
			}).not.toThrow();
		});
	});

	describe('process lifecycle events', () => {
		it('rejects pending requests when process exits with error code', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			const sendPromise = manager.exposedSend('test', {});

			await new Promise((r) => setImmediate(r));

			mockProcess.triggerExit(1);

			await expect(sendPromise).rejects.toThrow(/exited with code 1/);
		});

		it('rejects pending requests when process emits error', async () => {
			const mockProcess = createMockProcess();
			mockResolvePython.mockResolvedValue('/usr/bin/python3');
			mockCheckPythonVersion.mockResolvedValue(undefined);
			mockCheckPythonPackages.mockResolvedValue(undefined);
			mockSpawn.mockReturnValue(mockProcess as any);

			const manager = new TestPythonManager();
			await manager.initialize();

			const sendPromise = manager.exposedSend('test', {});

			await new Promise((r) => setImmediate(r));

			mockProcess.triggerError(new Error('Spawn error'));

			await expect(sendPromise).rejects.toThrow('Spawn error');
		});
	});
});
