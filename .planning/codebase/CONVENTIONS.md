# Coding Conventions

**Analysis Date:** 2026-02-25

## Naming Patterns

**Files:**
- Kebab-case for module files: `redis.ts`, `skills-sh.ts`, `artifacts.ts`
- Test files co-located with implementation: `redis.ts` + `redis.test.ts`
- Integration tests in `__tests__` directory: `src/__tests__/integration.test.ts`
- Directory names lowercase with hyphens: `queue/`, `storage/`, `adapters/`

**Functions:**
- camelCase for all functions: `getRedisClient()`, `setArtifactMeta()`, `downloadFile()`
- Exported functions at module level, not in classes (functional style)
- Private functions prefixed implicitly through function scope or JSDoc comments
- Async functions explicitly marked with `async` keyword

**Variables:**
- camelCase for local variables and exports: `redisClient`, `testMeta`, `downloadUrl`
- UPPER_SNAKE_CASE for constants: `REDIS_AVAILABLE`, `DOWNLOAD_QUEUE_NAME`, `CATALOG_TTL_MS`
- Constructor parameters matching property names: `{ source, slug, version }`

**Types:**
- PascalCase for interfaces: `SkillSummary`, `SkillManifest`, `DownloadJob`, `ArtifactMeta`
- Type imports explicitly marked: `import type { DownloadJob }`
- Readonly properties in interfaces using `readonly`: `readonly name: string`
- Optional properties with `?` operator: `author?: string`, `downloads?: number`

## Code Style

**Formatting:**
- No explicit formatter configured (eslint/prettier not in config)
- Implicit style observed:
  - 2-space indentation
  - Single quotes for strings (JavaScript/TypeScript)
  - Trailing commas in multiline arrays/objects
  - Lines typically under 100 characters
  - Blank lines between logical sections within functions

**Linting:**
- No linter detected in package.json
- TypeScript strict mode enabled: `"strict": true` in `tsconfig.json`
- Enforced via TypeScript compiler at build time

**Example style from `src/config.ts`:**
```typescript
export const config = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  skillsDir: process.env.SKILLS_DIR || path.join(os.homedir(), '.openclaw', 'skills'),
  defaultTtlSeconds: parseInt(process.env.DEFAULT_TTL_SECONDS || '14400', 10),
} as const;
```

## Import Organization

**Order:**
1. Node.js built-in modules: `import * as os from 'node:os'`
2. Third-party dependencies: `import { Redis } from 'ioredis'`
3. Local modules: `import { config } from './config.js'`
4. Type imports: `import type { DownloadJob }`

**Path Aliases:**
- No path aliases configured in `tsconfig.json`
- Relative imports with explicit `.js` extensions for ES modules

**Example from `src/index.ts`:**
```typescript
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { getMetrics, getMetricsContentType } from './metrics.js';
import type { Worker } from 'bullmq';
import type { DownloadJob } from './adapters/types.js';
```

## Error Handling

**Patterns:**
- Try-catch blocks for all async operations
- Specific error messages with context: `throw new Error(`Download failed: ${response.status} ${response.statusText}`)`
- Error objects include identifiers in logs: `[download] Failed: ${jobId}`
- Catch-all in workers with metrics and re-throw: Errors tracked before re-throwing in `processDownloadJob()`
- Selective error suppression with comments: `catch { // Ignore cleanup errors }`

**Example from `src/storage/artifacts.ts` (line 109-111):**
```typescript
try {
  await fs.rm(finalDir, { recursive: true });
} catch (err: any) {
  if (err.code !== 'ENOENT') throw err;
}
```

**Example from `src/queue/workers/download.ts` (lines 40-125):**
```typescript
try {
  await ensureSkillsDir();
  // ... processing steps
  await job.updateProgress(100);
} catch (error) {
  const duration = (Date.now() - startTime) / 1000;
  downloadCounter.inc({ source, status: 'failure' });
  downloadDuration.observe({ source }, duration);
  console.error(`[download] Failed: ${jobId}`, error);
  throw error;
}
```

## Logging

**Framework:** `console` (no third-party logger)

**Patterns:**
- Contextual prefix in brackets: `console.log('[download] Starting: ${jobId}')`
- Log levels via function choice: `console.log()` for info, `console.error()` for errors
- Always include job/operation ID for traceability
- Log at start, progress checkpoints, and completion/failure
- Progress tracking via job.updateProgress() in workers

**Example from `src/queue/workers/download.ts` (lines 38-116):**
```typescript
console.log(`[download] Starting: ${jobId}`);
console.log(`[download] Downloading: ${downloadUrl}`);
await job.updateProgress(10);
// ... steps ...
await job.updateProgress(100);
console.log(`[download] Complete: ${jobId} (${duration.toFixed(2)}s, ${finalSize} bytes)`);
// On error:
console.error(`[download] Failed: ${jobId}`, error);
```

## Comments

**When to Comment:**
- Multi-step processes: Each major step documented with comment block
- Non-obvious logic: Explain why, not what
- Regex patterns and special formats
- Configuration defaults and their rationale

**JSDoc/TSDoc:**
- Used for exported functions and types
- Standard JSDoc format with /** */ blocks
- Document parameters with @param, return with @returns
- Single-line description for simple functions

**Example from `src/storage/redis.ts`:**
```typescript
/**
 * Get or create Redis client singleton
 */
export function getRedisClient(): Redis {

/**
 * Store artifact metadata in Redis with TTL
 */
export async function setArtifactMeta(meta: ArtifactMeta): Promise<void> {

/**
 * Build Redis key for artifact metadata
 */
function artifactKey(source: string, slug: string): string {
```

## Function Design

**Size:**
- Functions typically 10-40 lines
- Longer operations broken into steps with progress updates
- `processDownloadJob()` is 127 lines (exceptional for complex workflow with 5 major steps)

**Parameters:**
- Destructured where appropriate: `{ source, slug, version, downloadUrl }`
- Type annotations required for all params: `slug: string, version?: string`
- Optional parameters use `?` operator with default handling

**Return Values:**
- Explicit return type annotations: `Promise<void>`, `Promise<string>`, `Promise<boolean>`
- Union types for multiple success states: `Promise<{ checksum: string; sizeBytes: number }>`
- Null for "not found" rather than exceptions: `ArtifactMeta | null`
- Boolean for success/failure of idempotent operations: `removeSkill()` returns `boolean`

**Example from `src/storage/artifacts.ts`:**
```typescript
export async function downloadFile(
  url: string,
  destPath: string
): Promise<{ checksum: string; sizeBytes: number }> {
  // ...
  return {
    checksum: hash.digest('hex'),
    sizeBytes,
  };
}

export async function validateSkillDir(skillDir: string): Promise<boolean> {
  try {
    // validation logic
    return true;
  } catch {
    return false;
  }
}

export async function getArtifactMeta(
  source: string,
  slug: string
): Promise<ArtifactMeta | null> {
  // ...
  if (!data || Object.keys(data).length === 0) {
    return null;
  }
  // ...
}
```

## Module Design

**Exports:**
- Named exports for functions: `export function getRedisClient()`
- Named exports for types: `export interface SkillManifest`
- Single default export for singletons where appropriate: `export const skillsShAdapter = new SkillsShAdapter()`
- Barrel files not used; direct imports preferred

**Module Organization:**
- One concern per module: `redis.ts` = Redis operations only
- Type definitions in separate `types.ts` for adapter interfaces
- Singletons (config, redis client) instantiated once per module
- Workers and processors as separate modules from setup

**Example from `src/adapters/skills-sh.ts`:**
```typescript
export class SkillsShAdapter implements SourceAdapter {
  readonly name = 'skills-sh';

  async search(query: string): Promise<SkillSummary[]> { ... }
  async getManifest(slug: string): Promise<SkillManifest> { ... }
  async getDownloadUrl(slug: string, version?: string): Promise<string> { ... }
  async listAll(): Promise<SkillSummary[]> { ... }

  private async fetchCatalog(): Promise<SkillSummary[]> { ... }
  private packageJsonToManifest(slug: string, pkg: ManifestJson): SkillManifest { ... }
}

export const skillsShAdapter = new SkillsShAdapter();
```

---

*Convention analysis: 2026-02-25*
