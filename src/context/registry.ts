/**
 * Context Interface Registry — catalog of available context interfaces.
 * 
 * Provides central registry for tools, MCP servers, and skills
 * with search and filtering capabilities.
 */

/**
 * Kind of context interface.
 */
export type InterfaceKind = 'tool' | 'mcp' | 'skill';

/**
 * Context interface metadata.
 * 
 * Represents a tool, MCP server, or skill that can be loaded into context.
 */
export interface ContextInterface {
  /** Interface kind */
  kind: InterfaceKind;
  /** Unique identifier */
  name: string;
  /** Human-readable description */
  description: string;
  /** Estimated token cost to include this interface */
  estimatedTokens?: number;
  /** Resolver reference (e.g., "skill:name" or file path) */
  resolver?: string;
}

/**
 * Registry of available context interfaces.
 * 
 * Maintains catalog of tools, MCP servers, and skills.
 * Supports registration, lookup, filtering, and search.
 */
export class ContextInterfaceRegistry {
  private readonly interfaces = new Map<string, ContextInterface>();

  /**
   * Register a context interface.
   * 
   * If an interface with the same name exists, it will be overwritten.
   * 
   * @param iface - Context interface to register
   */
  register(iface: ContextInterface): void {
    this.interfaces.set(iface.name, iface);
  }

  /**
   * Unregister a context interface.
   * 
   * No-op if interface does not exist.
   * 
   * @param name - Name of interface to remove
   */
  unregister(name: string): void {
    this.interfaces.delete(name);
  }

  /**
   * Get a context interface by name.
   * 
   * @param name - Interface name
   * @returns Interface if found, undefined otherwise
   */
  get(name: string): ContextInterface | undefined {
    return this.interfaces.get(name);
  }

  /**
   * List all context interfaces, optionally filtered by kind.
   * 
   * @param kind - Optional kind filter
   * @returns Array of matching interfaces
   */
  list(kind?: InterfaceKind): ContextInterface[] {
    const all = Array.from(this.interfaces.values());
    
    if (kind === undefined) {
      return all;
    }
    
    return all.filter(iface => iface.kind === kind);
  }

  /**
   * Find interfaces by tag/keyword search.
   * 
   * Searches in interface name and description (case-insensitive).
   * 
   * @param tag - Search keyword
   * @returns Array of matching interfaces
   */
  findByTag(tag: string): ContextInterface[] {
    // Escape special regex characters for literal search
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escapedTag, 'i');
    
    return Array.from(this.interfaces.values()).filter(iface => {
      return pattern.test(iface.name) || pattern.test(iface.description);
    });
  }
}
