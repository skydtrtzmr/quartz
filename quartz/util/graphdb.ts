/**
 * GraphDatabase - SQLite graph cache manager.
 *
 * Ported from the v4 client implementation. It stores graph nodes and edges
 * used by the persistent incremental build path.
 */

import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync } from "fs"
import { dirname } from "path"
import type { FilePath } from "./path"

export type NodeType = "entity" | "virtual" | "tag"
export type EdgeType = "link" | "tag"

// Node ids are stored before slugify, matching the v4 implementation.
export interface GraphNode {
  id: string
  type: NodeType
  mtime?: number
  frontmatter?: string
  date_created?: string
  date_modified?: string
  date_published?: string
}

export interface GraphEdge {
  source: string
  target: string
  type: EdgeType
}

export interface ImpactAnalysis {
  affectedByLinks: Set<string>
  affectedByTags: Set<string>
  affectedByBacklinks: Set<string>
  allAffected: Set<string>
}

export class GraphDatabase {
  private db: DatabaseSync

  constructor(dbPath: string) {
    const parentDir = dirname(dbPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    this.db = new DatabaseSync(dbPath)
    this.initialize()
  }

  private initialize() {
    try {
      this.db.prepare("PRAGMA journal_mode=WAL").get()
    } catch (err) {
      console.warn("Failed to enable WAL mode:", err)
    }

    this.db.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('entity', 'virtual', 'tag')),
        mtime INTEGER,
        frontmatter TEXT,
        date_created TEXT,
        date_modified TEXT,
        date_published TEXT
      );

      CREATE TABLE IF NOT EXISTS edges (
        edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('link', 'tag')),
        UNIQUE(source, target, type)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_mtime ON nodes(mtime);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
    `)
  }

  upsertNode(node: GraphNode): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, type, mtime, frontmatter, date_created, date_modified, date_published)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        mtime = excluded.mtime,
        frontmatter = excluded.frontmatter,
        date_created = excluded.date_created,
        date_modified = excluded.date_modified,
        date_published = excluded.date_published
    `)

    stmt.run(
      node.id,
      node.type,
      node.mtime || null,
      node.frontmatter || null,
      node.date_created || null,
      node.date_modified || null,
      node.date_published || null,
    )
  }

  deleteNode(id: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id)
  }

  getNode(id: string): GraphNode | undefined {
    return this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as GraphNode | undefined
  }

  getNodeFrontmatter(id: string): Record<string, unknown> | undefined {
    const node = this.db.prepare("SELECT frontmatter FROM nodes WHERE id = ?").get(id) as
      { frontmatter: string | null } | undefined
    if (!node?.frontmatter) return undefined

    try {
      return JSON.parse(node.frontmatter)
    } catch {
      console.warn(`Failed to parse frontmatter for node: ${id}`)
      return undefined
    }
  }

  getNodeDates(id: string): { created?: Date; modified?: Date; published?: Date } {
    const node = this.db
      .prepare("SELECT date_created, date_modified, date_published FROM nodes WHERE id = ?")
      .get(id) as
      | {
          date_created: string | null
          date_modified: string | null
          date_published: string | null
        }
      | undefined

    if (!node) return {}

    const dates: { created?: Date; modified?: Date; published?: Date } = {}
    if (node.date_created) dates.created = new Date(node.date_created)
    if (node.date_modified) dates.modified = new Date(node.date_modified)
    if (node.date_published) dates.published = new Date(node.date_published)
    return dates
  }

  getAllNodes(): GraphNode[] {
    return this.db.prepare("SELECT * FROM nodes").all() as unknown as GraphNode[]
  }

  getChangedFiles(currentFiles: Map<FilePath, number>): {
    changed: FilePath[]
    deleted: FilePath[]
  } {
    const changed: FilePath[] = []
    const deleted: FilePath[] = []

    for (const [filePath, mtime] of currentFiles) {
      const id = filePath.replace(/\.md$/, "")
      const node = this.db
        .prepare("SELECT mtime FROM nodes WHERE id = ? AND type = 'entity'")
        .get(id) as { mtime: number } | undefined

      if (!node || node.mtime !== mtime) {
        changed.push(filePath)
      }
    }

    const dbIds = this.db.prepare("SELECT id FROM nodes WHERE type = 'entity'").all() as {
      id: string
    }[]
    for (const { id } of dbIds) {
      const filePath = (id + ".md") as FilePath
      if (!currentFiles.has(filePath)) {
        deleted.push(filePath)
      }
    }

    return { changed, deleted }
  }

  addEdge(edge: GraphEdge): void {
    this.db
      .prepare("INSERT OR IGNORE INTO edges (source, target, type) VALUES (?, ?, ?)")
      .run(edge.source, edge.target, edge.type)
  }

  deleteOutgoingEdges(id: string, edgeType?: EdgeType): void {
    if (edgeType) {
      this.db.prepare("DELETE FROM edges WHERE source = ? AND type = ?").run(id, edgeType)
    } else {
      this.db.prepare("DELETE FROM edges WHERE source = ?").run(id)
    }
  }

  getAllEdges(): GraphEdge[] {
    return this.db.prepare("SELECT source, target, type FROM edges").all() as unknown as GraphEdge[]
  }

  getOutgoingEdges(id: string, edgeType?: EdgeType): GraphEdge[] {
    if (edgeType) {
      return this.db
        .prepare("SELECT source, target, type FROM edges WHERE source = ? AND type = ?")
        .all(id, edgeType) as unknown as GraphEdge[]
    }

    return this.db
      .prepare("SELECT source, target, type FROM edges WHERE source = ?")
      .all(id) as unknown as GraphEdge[]
  }

  hasIncomingEdges(id: string): boolean {
    const result = this.db
      .prepare("SELECT COUNT(*) as count FROM edges WHERE target = ?")
      .get(id) as {
      count: number
    }
    return result.count > 0
  }

  /**
   * Remove placeholder nodes that are no longer referenced by any edge.
   * Call this after updating changed files' outgoing links.
   */
  pruneUnreferencedVirtualNodes(): string[] {
    const nodes = this.db
      .prepare(
        `
        SELECT n.id
        FROM nodes n
        WHERE n.type = 'virtual'
          AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target = n.id)
      `,
      )
      .all() as { id: string }[]

    for (const { id } of nodes) {
      this.deleteOutgoingEdges(id)
      this.deleteNode(id)
    }

    return nodes.map(({ id }) => id)
  }

  analyzeImpact(changedSlugs: string[]): ImpactAnalysis {
    if (changedSlugs.length === 0) {
      return {
        affectedByLinks: new Set(),
        affectedByTags: new Set(),
        affectedByBacklinks: new Set(),
        allAffected: new Set(),
      }
    }

    const affectedByLinks = new Set<string>()
    const affectedByTags = new Set<string>()
    const affectedByBacklinks = new Set<string>()
    const batchSize = 250

    for (let i = 0; i < changedSlugs.length; i += batchSize) {
      const batch = changedSlugs.slice(i, i + batchSize)
      const placeholders = batch.map(() => "?").join(",")
      const params = [...batch, ...batch, ...batch, ...batch]

      const linkAffected = this.db
        .prepare(
          `
          SELECT DISTINCT
            CASE
              WHEN source IN (${placeholders}) THEN target
              WHEN target IN (${placeholders}) THEN source
            END as affected
          FROM edges
          WHERE type = 'link' AND (source IN (${placeholders}) OR target IN (${placeholders}))
        `,
        )
        .all(...params) as { affected: string }[]
      linkAffected.forEach(({ affected }) => {
        if (affected) affectedByLinks.add(affected)
      })

      const tagAffected = this.db
        .prepare(
          `
          SELECT DISTINCT target as affected
          FROM edges
          WHERE type = 'tag' AND source IN (${placeholders})
        `,
        )
        .all(...batch) as { affected: string }[]
      tagAffected.forEach(({ affected }) => affectedByTags.add(affected))

      const backlinkAffected = this.db
        .prepare(
          `
          SELECT DISTINCT
            CASE
              WHEN source IN (${placeholders}) THEN target
              WHEN target IN (${placeholders}) THEN source
            END as affected
          FROM edges
          WHERE type = 'link' AND (source IN (${placeholders}) OR target IN (${placeholders}))
        `,
        )
        .all(...params) as { affected: string }[]
      backlinkAffected.forEach(({ affected }) => {
        if (affected) affectedByBacklinks.add(affected)
      })
    }

    return {
      affectedByLinks,
      affectedByTags,
      affectedByBacklinks,
      allAffected: new Set([...affectedByLinks, ...affectedByTags, ...affectedByBacklinks]),
    }
  }

  exportContentIndex(): Record<string, unknown> {
    const nodes = this.db
      .prepare("SELECT id FROM nodes WHERE type = 'entity'")
      .all() as unknown as GraphNode[]
    const index: Record<string, unknown> = {}

    for (const node of nodes) {
      const outgoingLinks = this.db
        .prepare("SELECT target FROM edges WHERE source = ? AND type = 'link'")
        .all(node.id) as { target: string }[]
      index[node.id] = {
        slug: node.id,
        title: node.id,
        links: outgoingLinks.map((link) => link.target),
        filePath: (node.id + ".md") as FilePath,
      }
    }

    return index
  }

  transaction(fn: () => void): void {
    this.db.exec("BEGIN TRANSACTION")
    try {
      fn()
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  close(): void {
    this.db.close()
  }

  getStats(): {
    nodeCount: number
    edgeCount: number
    entityCount: number
    virtualCount: number
    tagCount: number
  } {
    const count = (where = "") =>
      (
        this.db.prepare(`SELECT COUNT(*) as count FROM nodes ${where}`).get() as {
          count: number
        }
      ).count
    const edgeCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM edges").get() as { count: number }
    ).count

    return {
      nodeCount: count(),
      edgeCount,
      entityCount: count("WHERE type = 'entity'"),
      virtualCount: count("WHERE type = 'virtual'"),
      tagCount: count("WHERE type = 'tag'"),
    }
  }

  getNodeByFilePath(filePath: string): GraphNode | undefined {
    const id = filePath.replace(/\.md$/, "")
    return this.db.prepare("SELECT * FROM nodes WHERE id = ? AND type = 'entity'").get(id) as
      GraphNode | undefined
  }

  getStoredDirectory(): string | null {
    try {
      const result = this.db
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get("directory") as { value: string } | undefined
      return result?.value || null
    } catch {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `)
      return null
    }
  }

  storeDirectory(directory: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
      .run("directory", directory)
  }

  // 仅在所有 emitter 成功后保存完成记录；pending 让中断的构建下次自动重建。
  getBuildState(): string | undefined {
    return (
      this.db.prepare("SELECT value FROM metadata WHERE key = ?").get("buildState") as
        { value: string } | undefined
    )?.value
  }

  storeBuildState(value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
      .run("buildState", value)
  }

  clearAll(): void {
    this.db.exec("DELETE FROM nodes; DELETE FROM edges; DELETE FROM metadata;")
  }
}
