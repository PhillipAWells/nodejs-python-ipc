# @pawells/nodejs-python-ipc

[![npm](https://img.shields.io/npm/v/@pawells/nodejs-python-ipc)](https://www.npmjs.com/package/@pawells/nodejs-python-ipc)
[![GitHub Release](https://img.shields.io/github/v/release/PhillipAWells/nodejs-python-ipc)](https://github.com/PhillipAWells/nodejs-python-ipc/releases)
[![CI](https://github.com/PhillipAWells/nodejs-python-ipc/actions/workflows/ci.yml/badge.svg)](https://github.com/PhillipAWells/nodejs-python-ipc/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/PhillipAWells?style=social)](https://github.com/sponsors/PhillipAWells)

TypeScript library for managing long-lived Python child processes with JSON-based IPC (Inter-Process Communication). Provides process lifecycle management, automatic Python detection and version validation, JSON request/response correlation, concurrency limiting, and graceful shutdown handling.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
- [Environment Variables](#environment-variables)
- [Requirements](#requirements)
- [License](#license)

## Installation

```bash
yarn add @pawells/nodejs-python-ipc
```

## Quick Start

### 1. Extend `PythonIpcManager`

Create a concrete manager class that implements the three abstract methods:

```typescript
import { PythonIpcManager } from '@pawells/nodejs-python-ipc';
import path from 'node:path';

class MyPythonManager extends PythonIpcManager {
  getMinPythonVersion(): string {
    return '3.9.0';
  }

  getRequiredPackages(): string[] {
    return ['numpy', 'pandas'];
  }

  getScriptPath(): string {
    return path.join(import.meta.dirname, 'my_script.py');
  }
}
```

### 2. Initialize and use

```typescript
const manager = new MyPythonManager({
  requestTimeoutMs: 30000,
  maxConcurrent: 5,
});

// Initialize — validates Python, spawns process, sets up IPC
await manager.initialize();

// Send a request and await the response
interface ComputeRequest {
  values: number[];
}

interface ComputeResponse {
  result: number;
}

const response = await manager.send<ComputeRequest, ComputeResponse>(
  'compute',
  { values: [1, 2, 3, 4, 5] }
);

console.log('Result:', response.result);

// Graceful shutdown
await manager.destroy();
```

### 3. Python side

Your Python script receives JSON over stdin and writes JSON to stdout:

```python
import json
import sys

while True:
    try:
        line = input()
        request = json.loads(line)
        request_type = request.get('type')
        request_id = request.get('requestId')
        data = request.get('data', {})

        if request_type == 'compute':
            result = sum(data['values'])
            response = {
                'success': True,
                'requestId': request_id,
                'data': {'result': result}
            }
            print(json.dumps(response))
        else:
            response = {
                'success': False,
                'requestId': request_id,
                'error': f'Unknown request type: {request_type}'
            }
            print(json.dumps(response))
    except EOFError:
        break
    except Exception as e:
        print(json.dumps({
            'success': False,
            'requestId': request.get('requestId'),
            'error': str(e)
        }))
```

## Protocol Specification

This section documents the JSON IPC protocol used for communication between Node.js and the Python process.

### Request Format

Requests are sent from Node.js to Python as line-delimited JSON (one request per line, UTF-8 encoding):

```json
{
  "type": "compute",
  "data": { "values": [1, 2, 3, 4, 5] },
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Fields**:
- `type` (string, required) — Request type identifier. Used to route the request to the appropriate handler in Python.
- `data` (any, required) — Request payload. Can be any JSON-serializable value (object, array, string, number, boolean, null).
- `requestId` (string, required) — Unique request identifier (UUID v4). Used to correlate responses with requests.

### Response Format

Responses are sent from Python to Node.js as line-delimited JSON (one response per line, UTF-8 encoding):

```json
{
  "success": true,
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "data": { "result": 15 }
}
```

**Fields**:
- `success` (boolean, required) — Whether the request was processed successfully.
- `requestId` (string, required) — The request ID from the corresponding request.
- `data` (any, optional) — Response payload when `success` is true.
- `error` (string, optional) — Error message when `success` is false.

### Error Response

```json
{
  "success": false,
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "error": "Invalid input: values must be non-empty"
}
```

### Protocol Rules

- **Line-delimited**: Each request and response is exactly one line of JSON, terminated with a newline character (`\n`).
- **UTF-8 encoding**: All text is encoded as UTF-8.
- **One request per line**: Do not send multiple requests in a single write.
- **Response correlation**: Python must echo the `requestId` from the request in the response.
- **Request type required**: Node.js validates that `type` is non-empty before sending.

## API Reference

### `PythonIpcManager` (abstract class)

Base class for managing Python child processes. Extend this class and implement the three abstract methods.

#### Constructor

```typescript
constructor(options?: PythonIpcManagerOptions)
```

**Options**:
- `requestTimeoutMs?: number` — Timeout for individual requests (default: `60000` ms)
- `maxConcurrent?: number` — Maximum concurrent requests (default: `2`)

#### Public Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `initialize` | `(): Promise<void>` | Validates Python environment, spawns the process, and sets up IPC. Throws if Python is not found, too old, or missing required packages. Safe to call multiple times (concurrent calls are de-duplicated). |
| `destroy` | `(): Promise<void>` | Gracefully shuts down: closes stdin, waits up to 5 seconds for the process to exit, then sends SIGKILL if needed. Safe to call multiple times. |
| `send` | `<TData, TResult>(type: string, data: TData): Promise<TResult>` | Sends a request and waits for the correlated response. Respects the concurrency limit and request timeout. Automatically initializes the process if not already running. |
| `isInitialized` | `boolean` (getter) | Returns `true` if the process is currently running. |
| `setupSignalHandlers` | `(): void` | Registers SIGTERM and SIGINT signal handlers that gracefully destroy the Python process. Useful for CLI applications and servers. |
| `ProcessEvents` | `EventHandler<{ ProcessLifecycle: ProcessLifecycleEvent }>` (property) | Event handler for process lifecycle events (exit and error). Subscribe via `.Subscribe()` or async iteration. |

#### Abstract Methods

You **must** implement these three methods in your subclass:

```typescript
abstract getMinPythonVersion(): string;
abstract getRequiredPackages(): string[];
abstract getScriptPath(): string;
```

- **`getMinPythonVersion()`** — Return the minimum Python version (e.g., `"3.9.0"`)
- **`getRequiredPackages()`** — Return an array of required packages (e.g., `["numpy", "pandas"]`)
- **`getScriptPath()`** — Return the absolute path to your Python script

#### Protected Methods

```typescript
protected send<TData, TResult>(type: string, data: TData): Promise<TResult>
```

Sends a JSON request of the given type with the given data, waits for the response with a matching request ID, and returns the result. Throws `TimeoutError` if the request exceeds `requestTimeoutMs`.

### Interfaces

#### `PythonRequest`

```typescript
interface PythonRequest {
  type: string;
  data: unknown;
  requestId: string;
}
```

Sent from Node.js to Python over stdin as JSON.

#### `PythonResponse`

```typescript
interface PythonResponse {
  success: boolean;
  requestId: string;
  data?: unknown;
  error?: string;
}
```

Received from Python over stdout as JSON. The `requestId` is used to correlate requests to responses.

#### `PythonIpcManagerOptions`

```typescript
interface PythonIpcManagerOptions {
  requestTimeoutMs?: number;
  maxConcurrent?: number;
  logger?: Logger;
}
```

**Fields**:
- `requestTimeoutMs?: number` — Timeout for individual requests in milliseconds (default: 60000)
- `maxConcurrent?: number` — Maximum number of concurrent requests to allow (default: 2)
- `logger?: Logger` — Optional `@pawells/logger` Logger instance for structured debug logging. When not provided, falls back to `DEBUG=nodejs-python-ipc` environment variable.

#### `ProcessLifecycleEvent`

```typescript
type ProcessLifecycleEvent =
  | {
      type: 'exit';
      exitCode: number | null;
      stderr: string;
    }
  | {
      type: 'error';
      error: string;
      stderr: string;
    };
```

Events emitted by `PythonIpcManager.ProcessEvents`. Subscribe to receive notifications when the Python process exits or encounters an error.

### Process Lifecycle Events

Subscribe to `ProcessEvents` to receive notifications when the Python process exits or encounters an error.

#### Callback Style

```typescript
manager.ProcessEvents.Subscribe((event) => {
  const lifecycle = event.ProcessLifecycle;
  if (lifecycle.type === 'exit') {
    console.log(`Process exited with code: ${lifecycle.exitCode}`);
    if (lifecycle.stderr) {
      console.error('stderr:', lifecycle.stderr);
    }
  } else if (lifecycle.type === 'error') {
    console.error(`Process error: ${lifecycle.error}`);
  }
});
```

#### Async Iteration Style

```typescript
for await (const event of manager.ProcessEvents) {
  const lifecycle = event.ProcessLifecycle;
  if (lifecycle.type === 'exit') {
    console.log(`Process exited: ${lifecycle.exitCode}`);
  } else if (lifecycle.type === 'error') {
    console.error(`Process error: ${lifecycle.error}`);
  }
}
```

### Python Resolver Utilities

Utility functions for detecting and validating a Python installation.

#### `resolvePython(): Promise<string>`

Resolves the Python executable path:
1. Checks `PYTHON_PATH` environment variable
2. Tries `python3` in PATH
3. Tries `python` in PATH

**Throws** `PythonNotFoundError` if no Python interpreter is found.

```typescript
import { resolvePython } from '@pawells/nodejs-python-ipc';

const pythonPath = await resolvePython();
console.log('Using Python:', pythonPath);
```

#### `checkPythonVersion(pythonPath: string, minVersion: string): Promise<void>`

Validates that the Python at `pythonPath` meets the minimum version requirement.

**Throws** `PythonVersionError` if the version is too old.

```typescript
import { checkPythonVersion } from '@pawells/nodejs-python-ipc';

await checkPythonVersion('/usr/bin/python3', '3.9.0');
```

#### `checkPythonPackages(pythonPath: string, packages: string[]): Promise<void>`

Validates that all required packages are installed.

**Throws** `PythonDependencyError` on the first missing package.

```typescript
import { checkPythonPackages } from '@pawells/nodejs-python-ipc';

await checkPythonPackages('/usr/bin/python3', ['numpy', 'pandas']);
```

#### `parsePythonVersion(versionOutput: string): number[]`

Parses Python version output (e.g., `"Python 3.10.2"`) into an array of version parts `[3, 10, 2]`.

```typescript
import { parsePythonVersion } from '@pawells/nodejs-python-ipc';

const parts = parsePythonVersion('Python 3.10.2');
// parts = [3, 10, 2]
```

#### `assertVersionMeetsRequirement(found: number[], required: number[]): void`

Compares two version arrays and throws `PythonVersionError` if `found < required`.

### Error Classes

#### `PythonNotFoundError`

Thrown when Python cannot be found in the system PATH or `PYTHON_PATH` environment variable.

```typescript
import { PythonNotFoundError, resolvePython } from '@pawells/nodejs-python-ipc';

try {
  await resolvePython();
} catch (err) {
  if (err instanceof PythonNotFoundError) {
    console.error('Python not found:', err.message);
  }
}
```

#### `PythonVersionError`

Thrown when the installed Python version does not meet the minimum requirement.

```typescript
import { PythonVersionError, checkPythonVersion } from '@pawells/nodejs-python-ipc';

try {
  await checkPythonVersion('/usr/bin/python3', '3.11.0');
} catch (err) {
  if (err instanceof PythonVersionError) {
    console.error('Python version too old:', err.message);
  }
}
```

#### `PythonDependencyError`

Thrown when a required Python package is not installed.

```typescript
import { PythonDependencyError, checkPythonPackages } from '@pawells/nodejs-python-ipc';

try {
  await checkPythonPackages('/usr/bin/python3', ['numpy']);
} catch (err) {
  if (err instanceof PythonDependencyError) {
    console.error('Missing package:', err.message);
  }
}
```

## Error Handling

Handle different error types appropriately in your application:

```typescript
import {
  PythonNotFoundError,
  PythonVersionError,
  PythonDependencyError,
} from '@pawells/nodejs-python-ipc';

class MyWorker extends PythonIpcManager {
  getMinPythonVersion(): string { return '3.9.0'; }
  getRequiredPackages(): string[] { return ['numpy']; }
  getScriptPath(): string { return '/path/to/worker.py'; }
}

const manager = new MyWorker();

try {
  await manager.initialize();
  const result = await manager.send('compute', { values: [1, 2, 3] });
  console.log('Result:', result);
} catch (err) {
  if (err instanceof PythonNotFoundError) {
    console.error('Python is not installed or not in PATH');
  } else if (err instanceof PythonVersionError) {
    console.error(`Python ${err.foundVersion} is too old; need ${err.requiredVersion}`);
  } else if (err instanceof PythonDependencyError) {
    console.error(`Missing Python dependency: ${err.dependency}`);
    console.error(`Install with: pip install ${err.dependency}`);
  } else if (err instanceof Error && err.message.includes('timed out')) {
    console.error('Request timed out');
  } else {
    console.error('Unexpected error:', err);
  }
} finally {
  await manager.destroy();
}
```

## Environment Variables

- **`PYTHON_PATH`** — Explicit path to the Python executable. If set, `resolvePython()` will use this instead of searching PATH.

  ```bash
  export PYTHON_PATH=/opt/python3.11/bin/python3
  ```

- **`DEBUG`** — Enable debug logging via environment variable. Set to `nodejs-python-ipc` to see detailed logs from the library. Only used when no logger is provided via `PythonIpcManagerOptions.logger`.

  ```bash
  export DEBUG=nodejs-python-ipc
  ```

## Debug Logging

Configure debug logging via logger instance or environment variable.

### Using a Logger Instance (Recommended)

```typescript
import { PythonIpcManager } from '@pawells/nodejs-python-ipc';
import { Logger } from '@pawells/logger';

const logger = new Logger({ level: 'debug' });

class MyWorker extends PythonIpcManager {
  getMinPythonVersion(): string { return '3.9.0'; }
  getRequiredPackages(): string[] { return []; }
  getScriptPath(): string { return '/path/to/worker.py'; }
}

const manager = new MyWorker({
  logger, // Pass logger instance for structured logging
});

await manager.initialize();
// Debug logs will be written to the provided logger
```

### Using Environment Variable

```bash
export DEBUG=nodejs-python-ipc
node my-app.js
# Debug logs will be written to stderr
```

When a logger instance is provided, the `DEBUG` environment variable is ignored.

## Requirements

- **Node.js** >= 24.0.0 (uses native ESM, no CommonJS)
- **Python** >= 3.9 (or your project's minimum requirement)
- **Yarn** >= 4.12.0 (Berry, via corepack)

## Development

```bash
yarn build            # Compile TypeScript → ./build/
yarn typecheck        # Type check without building
yarn lint             # ESLint src/
yarn lint:fix         # ESLint with auto-fix
yarn test             # Run Vitest tests
yarn test:coverage    # Run tests with coverage
```

To run a single test file:

```bash
yarn vitest run src/path/to/file.spec.ts
```

## License

MIT — See [LICENSE](./LICENSE) for details.
