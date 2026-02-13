/**
 * Context Tools — tools for loading and managing context.
 * 
 * Provides agent-callable tools for lazy-loading skills and other context interfaces.
 */

import { wrapResponse, type ToolResponseEnvelope } from "./envelope.js";
import { SkillResolver } from "../context/resolvers.js";
import type { ContextInterfaceRegistry } from "../context/registry.js";

/**
 * Input for aofContextLoad tool.
 */
export interface AOFContextLoadInput {
  /** Name of skill to load */
  skillName: string;
  /** Context interface registry */
  registry: ContextInterfaceRegistry;
  /** Path to skills directory */
  skillsDir: string;
}

/**
 * Load a skill's context on demand.
 * 
 * Resolves the skill from the skills directory and returns its content
 * with metadata. Skills must be registered in the context interface registry.
 * 
 * @param input - Load parameters
 * @returns Tool response envelope with skill content
 * @throws Error if skill not found or not registered
 */
export async function aofContextLoad(
  input: AOFContextLoadInput,
): Promise<ToolResponseEnvelope> {
  const { skillName, registry, skillsDir } = input;

  // Verify skill is registered
  const registered = registry.get(skillName);
  if (!registered) {
    throw new Error(`Skill '${skillName}' not found in registry`);
  }

  // Load skill content via resolver
  const resolver = new SkillResolver(skillsDir);
  const skillRef = `skill:${skillName}`;

  let content: string;
  try {
    content = await resolver.resolve(skillRef);
  } catch (err) {
    throw new Error(`Failed to load skill '${skillName}'`, { cause: err });
  }

  // Build summary
  const summary = `Skill '${skillName}' loaded successfully`;

  // Build metadata
  const meta = {
    charCount: content.length,
  };

  return wrapResponse(summary, content, meta);
}
