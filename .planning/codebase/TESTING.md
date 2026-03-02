# Testing Patterns

**Analysis Date:** 2026-02-25

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in expect() API (compatible with Jest)

**Run Commands:**
```bash
npm test              # Run all tests once
npm run test:watch   # Watch mode with hot reload
npm test -- --coverage  # Run with coverage report (when configured)
```

## Test File Organization

**Location:**
- Co-located pattern: Tests sit adjacent to implementation
- `src/storage/redis.ts` paired with `src/storage/redis.test.ts`
- `src/storage/artifacts.ts` paired with `src/storage/artifacts.test.ts`
- `src/adapters/skills-sh.ts` paired with `src/adapters/skills-sh.test.ts`
- Integration tests in `src/__tests__/` directory for cross-module tests

**Naming:**
- `*.test.ts` extension for all test files
- Test discovery in `vitest.config.ts`: `include: ['src/**/*.test.ts']`

**Structure:**
```
src/
├── storage/
│   ├── redis.ts
│   ├── redis.test.ts
│   ├── artifacts.ts
│   └── artifacts.test.ts
├── adapters/
│   ├── skills-sh.ts
│   └── skills-sh.test.ts
├── queue/
│   ├── setup.ts
│   └── setup.test.ts
└── __tests__/
    ├── config.test.ts
    ├── download.test.ts
    ├── integration.test.ts
    └── skills-sh.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

describe('Redis Storage', () => {
  let testMeta: ArtifactMeta;

  beforeAll(() => {
    // One-time setup
    testMeta = { /* ... */ };
  });

  beforeEach(async () => {
    // Before each test
    try {
      await deleteArtifactMeta(testMeta.source, testMeta.slug);
    } catch {
      // Ignore if key doesn't exist
    }
  });

  afterAll(async () => {
    // One-time cleanup
    try {
      await deleteArtifactMeta(testMeta.source, testMeta.slug);
      await closeRedis();
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should set and get artifact metadata', async () => {
    await setArtifactMeta(testMeta);
    const retrieved = await getArtifactMeta(testMeta.source, testMeta.slug);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.source).toBe(testMeta.source);
  });
});
```

**Patterns:**
- Setup hook: `beforeAll()` for one-time initialization
- Cleanup hook: `afterAll()` for resource teardown
- Reset hook: `beforeEach()` to clean state between tests
- Error suppression: Try-catch blocks in cleanup with comments explaining intent
- Async handling: Tests marked as `async`, use `await` without explicit Promise wrapping

## Mocking

**Framework:** Vitest built-in `vi` object

**Patterns:**
- Minimal mocking; prefer real implementations where possible
- Mock used for skipping network tests: `it.skip('should fetch manifest from GitHub')`
- Environment variable mocking via direct assignment: `process.env.REDIS_HOST = 'redis.example.com'`
- Module reimport for config testing via dynamic imports with cache busting

**Example from `src/__tests__/config.test.ts` (environment mocking):**
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should use env vars when set', async () => {
    process.env.REDIS_HOST = 'redis.example.com';
    process.env.REDIS_PORT = '6380';

    // Cache busting for fresh config load
    delete require.cache[require.resolve('../config.js')];
    const { config } = await import('../config.js?t=' + Date.now());

    expect(config.redis.host).toBe('redis.example.com');
    expect(config.redis.port).toBe(6380);
  });
});
```

**What to Mock:**
- Environment variables for configuration testing
- Network requests for external API tests (e.g., `it.skip()` GitHub tests)

**What NOT to Mock:**
- Real implementations: Redis client, filesystem operations tested against real temp dirs
- Internal service calls: Use actual worker/queue implementations
- Type checking: All functions tested with real types

## Fixtures and Factories

**Test Data:**
Test metadata created inline in test suites:
```typescript
let testMeta: ArtifactMeta;

beforeAll(() => {
  testMeta = {
    source: 'test-source',
    slug: 'test-skill',
    version: '1.0.0',
    path: '/tmp/test-skill',
    sizeBytes: 1024,
    downloadedAt: new Date().toISOString(),
    ttlSeconds: 3600,
    checksum: 'abc123',
  };
});
```

**Location:**
- Inline creation within test files
- No centralized fixture directory
- Temp directories used for filesystem tests: `path.join(os.tmpdir(), `skillhub-test-${Date.now()}`)`

**Example from `src/storage/artifacts.test.ts` (filesystem fixture):**
```typescript
describe('Artifact Storage', () => {
  const testDir = path.join(os.tmpdir(), 'skillhub-test-artifacts');
  const originalSkillsDir = config.skillsDir;

  beforeAll(async () => {
    (config as any).skillsDir = testDir;
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    (config as any).skillsDir = originalSkillsDir;
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });
});
```

## Coverage

**Requirements:** No coverage threshold enforced

**View Coverage:**
```bash
npm test -- --coverage  # If v8 provider configured
```

**Configuration in `vitest.config.ts`:**
```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json', 'html'],
},
```

## Test Types

**Unit Tests:**
- Scope: Individual functions and modules
- Approach: Real implementations with external resources isolated (temp dirs, Redis)
- Location: Co-located with source (e.g., `redis.test.ts`)
- Timeout: 30 seconds default (configurable per test)

**Example from `src/storage/redis.test.ts`:**
```typescript
it('should set and get artifact metadata', async () => {
  await setArtifactMeta(testMeta);

  const retrieved = await getArtifactMeta(testMeta.source, testMeta.slug);

  expect(retrieved).not.toBeNull();
  expect(retrieved?.source).toBe(testMeta.source);
  expect(retrieved?.slug).toBe(testMeta.slug);
  expect(retrieved?.version).toBe(testMeta.version);
});
```

**Integration Tests:**
- Scope: Multi-module workflows (queue + storage + adapters)
- Approach: Real worker startup, job processing, metadata storage
- Location: `src/__tests__/integration.test.ts`
- Timeout: 10 seconds (longer than unit tests)

**Example from `src/__tests__/integration.test.ts`:**
```typescript
describe('Integration Tests', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `skillhub-integration-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    process.env.SKILLS_DIR = tempDir;

    await startWorker();
  });

  afterAll(async () => {
    await stopWorker();

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  it('should process a download job end-to-end', async () => {
    const job: DownloadJob = {
      source: 'test',
      slug: 'test/skill',
      version: '1.0.0',
      downloadUrl: 'https://example.com/test.tar.gz',
    };

    const jobId = await enqueueDownload(job);
    expect(jobId).toBeDefined();
  }, 10000);
});
```

**E2E Tests:**
- Framework: Not currently used
- Would require external service deployment (Redis, file storage)
- Manual testing or containerized integration recommended

## Common Patterns

**Async Testing:**
```typescript
it('should return artifact metadata', async () => {
  // Vitest globals enabled: no need to wrap in explicit Promise
  await setArtifactMeta(testMeta);

  const retrieved = await getArtifactMeta(testMeta.source, testMeta.slug);

  expect(retrieved).not.toBeNull();
});

// With timeout override
it('should complete within timeout', async () => {
  // test code
}, 10000);  // 10 second timeout
```

**Error Testing:**
```typescript
it('should return false for invalid manifest', async () => {
  const skillDir = path.join(testDir, 'invalid-manifest');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'manifest.json'),
    JSON.stringify({ foo: 'bar' })  // Missing required fields
  );

  const isValid = await validateSkillDir(skillDir);
  expect(isValid).toBe(false);

  await fs.rm(skillDir, { recursive: true });
});

// Expecting thrown errors
it('should throw on network failure', async () => {
  const badUrl = 'https://invalid-url-that-404s';

  // No explicit try-catch needed; expect() handles promise rejection
  await expect(fetch(badUrl)).rejects.toThrow();
});
```

**Null/Empty Returns:**
```typescript
it('should return null for non-existent artifact', async () => {
  const retrieved = await getArtifactMeta('nonexistent', 'skill');
  expect(retrieved).toBeNull();
});

it('should return empty array for no matches', async () => {
  const results = await skillsShAdapter.search('xyznonexistent123');
  expect(results).toBeInstanceOf(Array);
  expect(results.length).toBe(0);
});
```

**Config Management in Tests:**
Type casting to allow mutation during tests:
```typescript
beforeAll(async () => {
  const originalSkillsDir = config.skillsDir;
  (config as any).skillsDir = testDir;  // Bypass readonly via type cast
});

afterAll(() => {
  (config as any).skillsDir = originalSkillsDir;
});
```

---

*Testing analysis: 2026-02-25*
