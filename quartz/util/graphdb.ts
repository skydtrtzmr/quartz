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
  // entity 节点的内容哈希（变更检测第二级判据），见 getChangedFiles
  content_hash?: string
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
        content_hash TEXT,
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

    // 旧库迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，这里幂等补齐 content_hash。
    // 正常使用方式是删除 cache 目录重建基线，这段只是兜底，避免旧库直接报 SQL 错误。
    const columns = this.db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[]
    if (!columns.some((c) => c.name === "content_hash")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN content_hash TEXT")
    }
  }

  upsertNode(node: GraphNode): void {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, type, mtime, content_hash, frontmatter, date_created, date_modified, date_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        mtime = excluded.mtime,
        content_hash = excluded.content_hash,
        frontmatter = excluded.frontmatter,
        date_created = excluded.date_created,
        date_modified = excluded.date_modified,
        date_published = excluded.date_published
    `)

    stmt.run(
      node.id,
      node.type,
      node.mtime || null,
      node.content_hash || null,
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

  /**
   * 两级变更判定：
   * 1. mtime 相同 → 未变更（不读文件，零开销）；
   * 2. mtime 不同 → 由调用方经 computeHash 计算内容哈希复核：
   *    - 哈希与库中一致 → 内容未变（mtime 被外部触碰），静默回写新 mtime、不计入 changed，
   *      避免下轮对同一批文件重复计算哈希；
   *    - 哈希不一致 / 库中无哈希 / computeHash 返回 undefined（读取失败）→ 保守判为 changed。
   * mtime 应传入取整后的整数毫秒（Math.round），与回写侧保持同一精度。
   */
  getChangedFiles(
    currentFiles: Map<FilePath, number>,
    computeHash?: (fp: FilePath) => string | undefined,
  ): {
    changed: FilePath[]
    deleted: FilePath[]
  } {
    const changed: FilePath[] = []
    const deleted: FilePath[] = []
    const touchedUnchanged: { id: string; mtime: number }[] = []

    const stmt = this.db.prepare(
      "SELECT mtime, content_hash FROM nodes WHERE id = ? AND type = 'entity'",
    )
    for (const [filePath, mtime] of currentFiles) {
      const id = filePath.replace(/\.md$/, "")
      const node = stmt.get(id) as
        | { mtime: number | null; content_hash: string | null }
        | undefined

      if (node && node.mtime === mtime) {
        // 快路径：mtime 一致，零开销
        continue
      }

      if (!node) {
        // 新文件：必然 changed；仍调用一次 computeHash 预热哈希缓存，
        // 否则冷构建的回写拿不到哈希，content_hash 落 null，
        // 下一轮 mtime 一被触碰就会全量误报（null != md5）。
        if (computeHash) computeHash(filePath)
        changed.push(filePath)
        continue
      }

      if (computeHash) {
        const currentHash = computeHash(filePath)
        if (currentHash !== undefined && node.content_hash === currentHash) {
          // mtime 被外部触碰但内容未变：静默回写新 mtime（保留原哈希），不标记 changed
          touchedUnchanged.push({ id, mtime })
          continue
        }
      }

      changed.push(filePath)
    }

    if (touchedUnchanged.length > 0) {
      this.transaction(() => {
        const update = this.db.prepare(
          "UPDATE nodes SET mtime = ? WHERE id = ? AND type = 'entity'",
        )
        for (const { id, mtime } of touchedUnchanged) {
          update.run(mtime, id)
        }
      })
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
