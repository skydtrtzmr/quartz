/**
 * GraphDatabase - SQLite 图谱缓存管理
 * 
 * 使用 Node.js 22 原生 node:sqlite 模块
 * 存储图谱结构（nodes + edges）用于增量构建的影响分析
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { FilePath } from './path'

export type NodeType = 'entity' | 'virtual' | 'tag'
export type EdgeType = 'link' | 'tag'

// 注意数据库里存的id,是未经过slugify的.
export interface GraphNode {
  id: string  // 唯一标识符（对于 entity 类型，就是 file_path 去掉 ".md" 后缀）
  type: NodeType
  mtime?: number
  frontmatter?: string  // JSON序列化的frontmatter
  date_created?: string    // ISO 8601 格式的创建时间
  date_modified?: string   // ISO 8601 格式的修改时间
  date_published?: string  // ISO 8601 格式的发布时间
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
    // 确保数据库文件的父目录存在
    // DatabaseSync 会自动创建数据库文件，但不会创建父目录
    const parentDir = dirname(dbPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }
    
    this.db = new DatabaseSync(dbPath)
    this.initialize()
  }

  private initialize() {
    // 开启 WAL 模式（Write-Ahead Logging）
    // WAL 模式的优势：
    // 1. 读操作不会被写操作阻塞
    // 2. 写操作不会被读操作阻塞（在大多数情况下）
    // 3. 性能更好，特别是对于大量小事务
    // 4. 支持并发读取
    try {
      const result = this.db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string } | undefined
      if (result && result.journal_mode === 'wal') {
        // WAL 模式已成功开启
      }
    } catch (err) {
      // 如果开启 WAL 失败（例如数据库文件是只读的），继续使用默认模式
      console.warn('Failed to enable WAL mode:', err)
    }

    // 设置其他性能优化选项
    // synchronous=NORMAL：在 WAL 模式下，NORMAL 是安全的，性能更好
    // busy_timeout：设置忙等待超时，避免数据库锁定错误
    this.db.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `)

    // 创建表结构
    // frontmatter 以 JSON 序列化存储，日期字段使用 ISO 8601 字符串格式
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

      -- 性能优化索引
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_mtime ON nodes(mtime);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
      
    `)
  }

  /**
   * 插入或更新节点
   */
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

  /**
   * 删除节点
   */
  deleteNode(id: string): void {
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id)
  }

  /**
   * 获取单个节点
   */
  getNode(id: string): GraphNode | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as GraphNode | undefined
  }

  /**
   * 获取节点的 frontmatter（JSON 解析后的对象）
   * 如果 frontmatter 不存在或解析失败，返回 undefined
   */
  getNodeFrontmatter(id: string): Record<string, any> | undefined {
    const node = this.db.prepare('SELECT frontmatter FROM nodes WHERE id = ?').get(id) as { frontmatter: string | null } | undefined
    if (!node || !node.frontmatter) {
      return undefined
    }
    try {
      return JSON.parse(node.frontmatter)
    } catch {
      console.warn(`Failed to parse frontmatter for node: ${id}`)
      return undefined
    }
  }

  /**
   * 获取节点的日期信息
   * 返回 { created, modified, published } 格式
   * 注意：如果某个日期不存在，则不设置该字段
   */
  getNodeDates(id: string): { created?: Date; modified?: Date; published?: Date } {
    const node = this.db.prepare(
      'SELECT date_created, date_modified, date_published FROM nodes WHERE id = ?'
    ).get(id) as { date_created: string | null; date_modified: string | null; date_published: string | null } | undefined

    if (!node) {
      return {}
    }

    const dates: { created?: Date; modified?: Date; published?: Date } = {}

    if (node.date_created) {
      dates.created = new Date(node.date_created)
    }
    if (node.date_modified) {
      dates.modified = new Date(node.date_modified)
    }
    if (node.date_published) {
      dates.published = new Date(node.date_published)
    }

    // 如果没有任何日期，返回空对象
    if (Object.keys(dates).length === 0) {
      return {}
    }

    return dates
  }

  /**
   * 获取所有节点
   */
  getAllNodes(): GraphNode[] {
    return this.db.prepare('SELECT * FROM nodes').all() as unknown as GraphNode[]
  }

  /**
   * 检测变化的文件（基于 mtime）
   * 注意：数据库中存储的 id 就是简单的 file_path 去掉 ".md" 后缀
   * 只有 entity 类型的节点有 file_path（可通过 id + ".md" 计算）
   */
  getChangedFiles(currentFiles: Map<FilePath, number>): {
    changed: FilePath[]
    deleted: FilePath[]
  } {
    const changed: FilePath[] = []
    const deleted: FilePath[] = []

    // 辅助函数：从 file_path 转换为 id（简单去掉 .md 后缀）
    const filePathToId = (fp: string): string => {
      return fp.replace(/\.md$/, '')
    }

    // 检查当前文件是否变化（只查询 entity 类型的节点）
    for (const [filePath, mtime] of currentFiles) {
      // 从 file_path 转换为 id：简单去掉 .md 后缀
      const id = filePathToId(filePath)
      const node = this.db.prepare(
        'SELECT mtime FROM nodes WHERE id = ? AND type = \'entity\''
      ).get(id) as { mtime: number } | undefined

      if (!node || node.mtime !== mtime) {
        changed.push(filePath)
      }
    }

    // 检查删除的文件（只查询 entity 类型的节点）
    // 从数据库获取所有 entity 节点的 id，然后转换为 file_path
    const dbIds = this.db.prepare(
      'SELECT id FROM nodes WHERE type = \'entity\''
    ).all() as { id: string }[]

    for (const { id } of dbIds) {
      // 从 id 计算 file_path：id + ".md"（只适用于 entity 类型节点）
      const filePath = (id + '.md') as FilePath
      if (!currentFiles.has(filePath)) {
        deleted.push(filePath)
      }
    }

    return { changed, deleted }
  }

  /**
   * 添加边（如果已存在则忽略）
   */
  addEdge(edge: GraphEdge): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO edges (source, target, type)
      VALUES (?, ?, ?)
    `).run(edge.source, edge.target, edge.type)
  }

  /**
   * 删除节点的所有出边
   */
  deleteOutgoingEdges(id: string, edgeType?: EdgeType): void {
    if (edgeType) {
      this.db.prepare('DELETE FROM edges WHERE source = ? AND type = ?').run(id, edgeType)
    } else {
      this.db.prepare('DELETE FROM edges WHERE source = ?').run(id)
    }
  }

  /**
   * 获取所有边
   */
  getAllEdges(): GraphEdge[] {
    return this.db.prepare('SELECT source, target, type FROM edges').all() as unknown as GraphEdge[]
  }

  /**
   * 获取节点的出边
   */
  getOutgoingEdges(id: string, edgeType?: EdgeType): GraphEdge[] {
    if (edgeType) {
      return this.db.prepare(
        'SELECT source, target, type FROM edges WHERE source = ? AND type = ?'
      ).all(id, edgeType) as unknown as GraphEdge[]
    } else {
      return this.db.prepare(
        'SELECT source, target, type FROM edges WHERE source = ?'
      ).all(id) as unknown as GraphEdge[]
    }
  }

  /**
   * 检查节点是否有入边
   */
  hasIncomingEdges(id: string): boolean {
    const result = this.db.prepare(
      'SELECT COUNT(*) as count FROM edges WHERE target = ?'
    ).get(id) as { count: number }
    return result.count > 0
  }

  /**
   * 影响分析：查找受变化影响的节点
   */
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

    const placeholders = changedSlugs.map(() => '?').join(',')

    // 1. 链接影响（双向）
    const linkAffected = this.db.prepare(`
      SELECT DISTINCT 
        CASE 
          WHEN source IN (${placeholders}) THEN target
          WHEN target IN (${placeholders}) THEN source
        END as affected
      FROM edges
      WHERE type = 'link' AND (source IN (${placeholders}) OR target IN (${placeholders}))
    `).all(...changedSlugs, ...changedSlugs) as { affected: string }[]

    linkAffected.forEach(({ affected }) => {
      if (affected) affectedByLinks.add(affected)
    })

    // 2. 标签影响
    const tagAffected = this.db.prepare(`
      SELECT DISTINCT target as affected
      FROM edges
      WHERE type = 'tag' AND source IN (${placeholders})
    `).all(...changedSlugs) as { affected: string }[]

    tagAffected.forEach(({ affected }) => affectedByTags.add(affected))

    // 3. 反向链接影响
    const backlinkAffected = this.db.prepare(`
      SELECT DISTINCT 
        CASE 
          WHEN source IN (${placeholders}) THEN target
          WHEN target IN (${placeholders}) THEN source
        END as affected
      FROM edges
      WHERE type = 'link' AND (source IN (${placeholders}) OR target IN (${placeholders}))
    `).all(...changedSlugs, ...changedSlugs) as { affected: string }[]

    backlinkAffected.forEach(({ affected }) => {
      if (affected) affectedByBacklinks.add(affected)
    })

    // 汇总所有受影响的节点
    const allAffected = new Set([
      ...affectedByLinks,
      ...affectedByTags,
      ...affectedByBacklinks,
    ])

    return {
      affectedByLinks,
      affectedByTags,
      affectedByBacklinks,
      allAffected,
    }
  }



  /**
   * 导出为 contentIndex 格式（完整数据）
   * 注意：只处理 entity 类型的节点，因为只有它们有 file_path
   * 注意：此方法已不再使用，因为 description 和 frontmatter 不再存储在数据库中
   */
  exportContentIndex(): Record<string, any> {
    // 只查询 entity 类型的节点（只有它们有 file_path）
    const nodes = this.db.prepare(`
      SELECT id, tags
      FROM nodes
      WHERE type = 'entity'
    `).all() as unknown as GraphNode[]

    const index: Record<string, any> = {}

    for (const node of nodes) {
      const outgoingLinks = this.db.prepare(`
        SELECT target FROM edges WHERE source = ? AND type = 'link'
      `).all(node.id) as { target: string }[]

      // 使用 id 作为 title（因为 description 和 frontmatter 不再存储在数据库中）
      const title = node.id

      // 使用 id 作为 key（因为 contentIndex 使用 slug 作为 key，而 id 就是原来的 slug）
      index[node.id] = {
        slug: node.id,  // 为了兼容性，保留 slug 字段
        title: title,
        links: outgoingLinks.map(l => l.target),
        filePath: (node.id + '.md') as FilePath, // 从 id 计算 file_path（只适用于 entity 节点）
      }
    }

    return index
  }

  /**
   * 开启事务
   */
  transaction(fn: () => void): void {
    this.db.exec('BEGIN TRANSACTION')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * 关闭数据库
   */
  close(): void {
    this.db.close()
  }

  /**
   * 获取统计信息
   */
  getStats(): { nodeCount: number; edgeCount: number; entityCount: number; virtualCount: number; tagCount: number } {
    const nodeCount = (this.db.prepare('SELECT COUNT(*) as count FROM nodes').get() as { count: number }).count
    const edgeCount = (this.db.prepare('SELECT COUNT(*) as count FROM edges').get() as { count: number }).count
    const entityCount = (this.db.prepare('SELECT COUNT(*) as count FROM nodes WHERE type = \'entity\'').get() as { count: number }).count
    const virtualCount = (this.db.prepare('SELECT COUNT(*) as count FROM nodes WHERE type = \'virtual\'').get() as { count: number }).count
    const tagCount = (this.db.prepare('SELECT COUNT(*) as count FROM nodes WHERE type = \'tag\'').get() as { count: number }).count

    return { nodeCount, edgeCount, entityCount, virtualCount, tagCount }
  }

  /**
   * 根据文件路径获取节点
   * 注意：数据库中存储的 id 就是简单的 file_path 去掉 ".md" 后缀
   * 只有 entity 类型的节点有 file_path，所以只查询 entity 类型
   */
  getNodeByFilePath(filePath: string): GraphNode | undefined {
    // 从 file_path 转换为 id：简单去掉 .md 后缀（数据库中就是这样存储的）
    const id = filePath.replace(/\.md$/, '')
    // 只查询 entity 类型的节点（因为只有 entity 类型节点有 file_path）
    return this.db.prepare("SELECT * FROM nodes WHERE id = ? AND type = 'entity'").get(id) as GraphNode | undefined
  }

  /**
   * 获取存储的目录路径
   */
  getStoredDirectory(): string | null {
    try {
      const result = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('directory') as { value: string } | undefined
      return result?.value || null
    } catch {
      // 如果metadata表不存在，创建它
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `)
      return null
    }
  }

  /**
   * 存储目录路径
   */
  storeDirectory(directory: string): void {
    this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('directory', directory)
  }

  /**
   * 清空所有数据
   */
  clearAll(): void {
    this.db.exec('DELETE FROM nodes; DELETE FROM edges; DELETE FROM metadata;')
  }
}
