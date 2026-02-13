/**
 * Context Resolvers — pluggable content resolution.
 * 
 * Provides abstraction layer for resolving context references from different
 * sources (filesystem, inline content, external pools, etc.).
 */

import { readFile } from "node:fs/promises";
import { join, normalize, isAbsolute } from "node:path";
import { loadSkillManifest } from "./skills.js";

/**
 * Context resolver interface.
 * 
 * Implementations can resolve content from different sources.
 */
export interface ContextResolver {
  /** Resolver type identifier (e.g., 'filesystem', 'inline', 'pool') */
  readonly type: string;

  /**
   * Check if this resolver can handle the given reference.
   * 
   * @param ref - Reference string to resolve
   * @returns True if this resolver can handle the reference
   */
  canResolve(ref: string): boolean;

  /**
   * Resolve the reference to content.
   * 
   * @param ref - Reference string to resolve
   * @returns Promise resolving to content string
   * @throws Error if reference cannot be resolved
   */
  resolve(ref: string): Promise<string>;
}

/**
 * Filesystem resolver — reads content from local filesystem.
 * 
 * Resolves references as file paths relative to a base directory.
 * Enforces security: cannot access files outside base directory.
 */
export class FilesystemResolver implements ContextResolver {
  readonly type = "filesystem";
  private readonly baseDir: string;

  /**
   * Create a filesystem resolver.
   * 
   * @param baseDir - Base directory for file resolution
   */
  constructor(baseDir: string) {
    this.baseDir = normalize(baseDir);
  }

  canResolve(ref: string): boolean {
    // Basic validation: non-empty, no absolute paths
    if (!ref || isAbsolute(ref)) {
      return false;
    }
    
    // Check for path traversal attempts
    const normalized = normalize(join(this.baseDir, ref));
    return normalized.startsWith(this.baseDir);
  }

  async resolve(ref: string): Promise<string> {
    if (!this.canResolve(ref)) {
      throw new Error(`Cannot resolve reference outside base directory: ${ref}`);
    }

    const fullPath = join(this.baseDir, ref);
    
    try {
      return await readFile(fullPath, "utf-8");
    } catch (err) {
      throw new Error(`Failed to read file: ${ref}`, { cause: err });
    }
  }
}

/**
 * Inline resolver — returns content from pre-loaded map.
 * 
 * Useful for manifest entries with inline content or pre-fetched data.
 */
export class InlineResolver implements ContextResolver {
  readonly type = "inline";
  private readonly contentMap: Record<string, string>;

  /**
   * Create an inline resolver.
   * 
   * @param contentMap - Map of reference -> content
   */
  constructor(contentMap: Record<string, string>) {
    this.contentMap = contentMap;
  }

  canResolve(ref: string): boolean {
    return ref in this.contentMap;
  }

  async resolve(ref: string): Promise<string> {
    if (!this.canResolve(ref)) {
      throw new Error(`Inline content not found: ${ref}`);
    }
    return this.contentMap[ref]!;
  }
}

/**
 * Resolver chain — tries multiple resolvers in order.
 * 
 * Delegates to the first resolver that can handle each reference.
 */
export class ResolverChain {
  private readonly resolvers: ContextResolver[];

  /**
   * Create a resolver chain.
   * 
   * @param resolvers - Array of resolvers to try (in order)
   */
  constructor(resolvers: ContextResolver[]) {
    this.resolvers = resolvers;
  }

  /**
   * Resolve a reference using the first matching resolver.
   * 
   * @param ref - Reference to resolve
   * @returns Promise resolving to content
   * @throws Error if no resolver can handle the reference
   */
  async resolve(ref: string): Promise<string> {
    for (const resolver of this.resolvers) {
      if (resolver.canResolve(ref)) {
        return await resolver.resolve(ref);
      }
    }
    
    throw new Error(`No resolver could handle reference: ${ref}`);
  }
}

/**
 * Skill resolver — resolves skill references from skills directory.
 * 
 * Resolves references with format "skill:name" by loading the skill's
 * manifest and reading the entrypoint file content.
 */
export class SkillResolver implements ContextResolver {
  readonly type = "skill";
  private readonly skillsDir: string;

  /**
   * Create a skill resolver.
   * 
   * @param skillsDir - Base directory containing skill subdirectories
   */
  constructor(skillsDir: string) {
    this.skillsDir = normalize(skillsDir);
  }

  canResolve(ref: string): boolean {
    return ref.startsWith("skill:");
  }

  async resolve(ref: string): Promise<string> {
    if (!this.canResolve(ref)) {
      throw new Error(`Not a skill reference: ${ref}`);
    }

    const skillName = ref.substring(6);
    if (!skillName) {
      throw new Error(`Invalid skill reference (empty name): ${ref}`);
    }

    const skillPath = join(this.skillsDir, skillName);
    
    // Load manifest to get entrypoint
    const manifest = await loadSkillManifest(skillPath);
    
    // Read entrypoint file
    const entrypointPath = join(skillPath, manifest.entrypoint);
    
    try {
      return await readFile(entrypointPath, "utf-8");
    } catch (err) {
      throw new Error(`Failed to read skill entrypoint: ${manifest.entrypoint}`, { cause: err });
    }
  }
}
