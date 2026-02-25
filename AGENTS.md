# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

`@pawells/nodejs-python-ipc` is a TypeScript library for managing long-lived Python child processes with JSON-based Inter-Process Communication (IPC). It provides automatic Python executable resolution and version validation, process lifecycle management, JSON request/response correlation with UUID tracking, concurrency limiting via semaphore pattern, timeout handling, and graceful shutdown with error propagation. The library has no runtime dependencies and uses only Node.js built-ins. It targets ES2022 and is distributed as ESM.

## Commands

```bash
yarn build            # Compile TypeScript → ./build/
yarn typecheck        # Type check without building
yarn lint             # ESLint src/
yarn lint:fix         # ESLint with auto-fix
yarn test             # Run Vitest tests
yarn test:ui          # Open interactive Vitest UI in a browser
yarn test:coverage    # Run tests with coverage (80% threshold)
```

To run a single test file: `yarn vitest run src/path/to/file.spec.ts`

## Source Files

All source lives under `src/` and is compiled to `./build/` by `tsc`.

**Entry point** (`src/index.ts`): The single public export surface. All types, utilities, and classes intended for consumers must be re-exported from this file.

### Core modules

| File | Key Exports | Description |
|------|-------------|-------------|
| `src/index.ts` | All public API | Main entry point. Re-exports from `errors.ts`, `python-resolver.ts`, and `python-ipc-manager.ts`. |
| `src/errors.ts` | `PythonNotFoundError`, `PythonVersionError`, `PythonDependencyError` | Three custom error classes thrown by Python resolver utilities and IPC manager initialization. |
| `src/python-resolver.ts` | `resolvePython`, `checkPythonVersion`, `checkPythonPackages`, `parsePythonVersion`, `assertVersionMeetsRequirement` | Utility functions for detecting and validating a Python installation. Handles PYTHON_PATH env var, searches PATH, parses version strings, and compares versions. |
| `src/python-ipc-manager.ts` | `PythonIpcManager` (abstract class), `PythonRequest`, `PythonResponse` | Main IPC implementation. Abstract base class with lifecycle methods (`initialize`, `destroy`, `send`), semaphore-based concurrency control, UUID-based request/response correlation, readline-based message parsing, and timeout handling. |

## Architecture Patterns

### 1. Abstract Base Class

`PythonIpcManager` is an abstract class. Applications extend it and implement three abstract methods:

```typescript
abstract getMinPythonVersion(): string;
abstract getRequiredPackages(): string[];
abstract getScriptPath(): string;
```

This allows each concrete manager to define its own Python version requirement, dependencies, and script location.

### 2. Semaphore-Based Concurrency Control

The manager uses a semaphore pattern to limit concurrent requests:

- `maxConcurrent` option (default: 2) controls the limit
- `inFlightCount` tracks active requests
- `waitQueue` is an array of pending requests waiting for a slot
- Each `send()` call acquires a slot before sending, releases after response

This prevents overwhelming the Python process with simultaneous requests.

### 3. UUID-Based Request/Response Correlation

Each request includes a unique `requestId` (UUID v4):

```typescript
interface PythonRequest {
  type: string;
  data: unknown;
  requestId: string;
}
```

The Python script echoes the `requestId` in its response, allowing the manager to correlate async responses to their requests:

```typescript
interface PythonResponse {
  success: boolean;
  requestId: string;
  data?: unknown;
  error?: string;
}
```

### 4. JSON Protocol over stdout/stdin

- **Request**: Single-line JSON sent to Python's stdin
- **Response**: Single-line JSON read from Python's stdout
- readline module parses newline-delimited messages

### 5. Graceful Shutdown

The `destroy()` method follows a three-step graceful shutdown:

1. Close stdin (signal to Python that no more input is coming)
2. Wait up to 5 seconds for the process to exit naturally
3. Send SIGKILL if the process hasn't exited by then

This ensures resources are cleaned up properly.

### 6. Error Propagation

Python errors are captured and propagated as Node.js errors:

- Python returns `{ success: false, error: "message", requestId: "..." }`
- Manager throws an error with the message
- Custom error types (`PythonNotFoundError`, `PythonVersionError`, `PythonDependencyError`) are used for initialization failures

## Internal State

The `PythonIpcManager` maintains:

- `_process: ChildProcess | null` — The spawned Python process
- `_readline: Interface | null` — readline interface for parsing stdout
- `_pending: Map<string, { resolve, reject }>` — Pending request callbacks keyed by requestId
- `_inFlightCount: number` — Number of active concurrent requests
- `_waitQueue: Array<{ resolve, reject }>` — Requests waiting for a concurrency slot

## TypeScript Configuration

Project uses a 4-config split:

- **`tsconfig.json`** — Base/development configuration. Includes all source files.
- **`tsconfig.build.json`** — Production build configuration that excludes test files and is used by the build script.
- **`tsconfig.test.json`** — Vitest test configuration.
- **`tsconfig.eslint.json`** — ESLint type-aware linting configuration.

General settings: Requires Node.js >= 24.0.0. Outputs to `./build/`, targets ES2022, module resolution `bundler`. Declaration files (`.d.ts`) and source maps are emitted. Strict mode is fully enabled.

## Testing

Uses Vitest with globals and node environment. Coverage threshold: 80%.

- Unit tests for each module (errors, resolvers, IPC manager)
- Integration tests for end-to-end scenarios
- Mock Python process for testing IPC without a real Python install

Test files: `src/**/*.spec.ts`

## Common Patterns for Extending PythonIpcManager

### Pattern 1: Simple RPC-style manager

```typescript
class DataProcessor extends PythonIpcManager {
  getMinPythonVersion(): string {
    return '3.9.0';
  }

  getRequiredPackages(): string[] {
    return ['numpy', 'pandas'];
  }

  getScriptPath(): string {
    return path.join(import.meta.dirname, 'processor.py');
  }

  async processData(values: number[]): Promise<number> {
    const response = await this.send<{ values: number[] }, { result: number }>(
      'process',
      { values }
    );
    return response.result;
  }
}
```

### Pattern 2: Stateful manager with session tracking

```typescript
class SessionManager extends PythonIpcManager {
  private sessions = new Map<string, unknown>();

  async createSession(config: unknown): Promise<string> {
    const response = await this.send<unknown, { sessionId: string }>(
      'createSession',
      config
    );
    this.sessions.set(response.sessionId, config);
    return response.sessionId;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.send<{ sessionId: string }, void>('closeSession', { sessionId });
    this.sessions.delete(sessionId);
  }
}
```

## Error Types and When They're Thrown

### `PythonNotFoundError`

Thrown by `resolvePython()` when:
- `PYTHON_PATH` env var is not set
- `python3` not found in PATH
- `python` not found in PATH

Typically happens during `manager.initialize()` when resolving the Python executable.

### `PythonVersionError`

Thrown by `checkPythonVersion()` when:
- The detected Python version is less than the required minimum

Typically happens during `manager.initialize()` after successful Python resolution.

### `PythonDependencyError`

Thrown by `checkPythonPackages()` when:
- Any required package is not installed

Typically happens during `manager.initialize()` after version validation.

### `TimeoutError` (Node.js built-in)

Thrown by `send()` when:
- A request doesn't receive a response within `requestTimeoutMs`

### `Error` (generic)

Thrown by `send()` when:
- Python returns `{ success: false, error: "..." }`

## Key Implementation Notes

- **No runtime dependencies**: Only uses Node.js built-ins (`child_process`, `readline`, `crypto`, `util`)
- **ESM only**: `"type": "module"` in package.json. Use `.js` extensions in internal imports.
- **Process spawning**: Uses `child_process.spawn()` with `stdio: ['pipe', 'pipe', 'inherit']` to capture stdout, inherit stderr for visibility
- **UUID generation**: Uses `crypto.randomUUID()` for request IDs
- **Event loop integration**: All I/O is async via Promises; no blocking calls

## CI/CD

Single workflow (`.github/workflows/ci.yml`) triggered on push to `main`, PRs to `main`, and `v*` tags. Jobs run on Node 24 (`ubuntu-latest`):

- **`validate`** (typecheck + lint) and **`test`** run in parallel on every push/PR.
- **`build`** runs after both pass, only on non-tag pushes.
- **`publish`** runs after both pass on `v*` tags: builds, publishes to npm with provenance, and creates a GitHub Release.
