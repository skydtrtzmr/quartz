import sourceMapSupport from "source-map-support"
sourceMapSupport.install(options)
import path from "path"
import { PerfTimer } from "./util/perf"
import { rm } from "fs/promises"
import { GlobbyFilterFunction, isGitIgnored } from "globby"
import { styleText } from "util"
import { parseMarkdown } from "./processors/parse"
import { filterContent } from "./processors/filter"
import { emitContent } from "./processors/emit"
import cfg from "../quartz.config"
import { FilePath, joinSegments, slugifyFilePath } from "./util/path"
// 把type拆开写!
import type { FullSlug, SimpleSlug } from "./util/path"
import chokidar from "chokidar"
import { ProcessedContent, QuartzPluginData } from "./plugins/vfile"
import { Argv, BuildCtx } from "./util/ctx"
import { glob, toPosixPath } from "./util/glob"
import { trace } from "./util/trace"
import { options } from "./util/sourcemap"
import { Mutex } from "async-mutex"
import { getStaticResourcesFromPlugins } from "./plugins"
import { randomIdNonSecure } from "./util/random"
import { ChangeEvent } from "./plugins/types"
import { minimatch } from "minimatch"
// 改动 1：在文件顶部新增导入
import { stat, mkdir, unlink } from "fs/promises"
import { existsSync, mkdirSync } from "fs"
import { defaultProcessedContent } from "./plugins/vfile"
import { GraphDatabase } from "./util/graphdb"

type ContentMap = Map<
  FilePath,
  | {
      type: "markdown"
      content: ProcessedContent
    }
  | {
      type: "other"
    }
>

type BuildData = {
  ctx: BuildCtx
  ignored: GlobbyFilterFunction
  mut: Mutex
  contentMap: ContentMap
  changesSinceLastBuild: Record<FilePath, ChangeEvent["type"]>
  lastBuildMs: number
}

// ==================== SQLite 图谱缓存架构 ====================
// 不再使用 JSON 存储 graph，直接使用 SQLite
// data/.quartz-cache.db 存储图结构（nodes + edges）
// WAL 模式会自动创建 data/.quartz-cache.db-wal 和 data/.quartz-cache.db-shm

// 初始化或加载图谱数据库
function getGraphDatabase(): GraphDatabase {
  // 确保 data 文件夹存在
  const dataDir = path.join(process.cwd(), "data")
  // 注意：这里使用同步方法，因为 DatabaseSync 构造函数需要同步路径
  // 如果文件夹不存在，DatabaseSync 会自动创建数据库文件，但不会创建父目录
  // 所以我们需要先确保目录存在
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  const dbPath = path.join(dataDir, ".quartz-cache.db")
  return new GraphDatabase(dbPath)
}

// 检测变化的文件（基于 SQLite 缓存）
async function detectChangedFiles(
  allFileNames: string[],
  graphDb: GraphDatabase,
  directory: string,
): Promise<{ changed: FilePath[]; deleted: FilePath[] }> {
  // 构建当前文件的 mtime Map（使用相对路径）
  const currentFiles = new Map<FilePath, number>()

  for (const fp of allFileNames) {
    if (!fp.endsWith(".md")) continue

    const fullPath = joinSegments(directory, fp) as FilePath
    try {
      const stats = await stat(fullPath)
      // 使用相对路径作为key，与数据库中的file_path保持一致
      currentFiles.set(fp as FilePath, stats.mtimeMs)
    } catch {
      // 文件不存在，忽略
    }
  }

  return graphDb.getChangedFiles(currentFiles)
}

// 更新图谱数据库（使用 SQLite 事务）
function updateGraphDatabase(
  graphDb: GraphDatabase,
  changedFiles: ProcessedContent[],
  deletedFiles: FilePath[],
) {
  graphDb.transaction(() => {
    // 处理删除的文件
    for (const filePath of deletedFiles) {
      const node = graphDb.getNodeByFilePath(filePath)

      if (!node) continue

      const id = node.id

      // 检查是否有入边（被其他节点链接），决定转为virtual还是完全删除
      if (graphDb.hasIncomingEdges(id)) {
        // 删除出边
        graphDb.deleteOutgoingEdges(id)

        // Entity → Virtual（virtual 节点没有 file_path，也不需要 title）
        graphDb.upsertNode({
          id,
          type: "virtual",
        })
        console.log(`Entity → Virtual: ${id}`)
      } else {
        // 完全删除节点及其所有边
        graphDb.deleteNode(id)
        graphDb.deleteOutgoingEdges(id)
      }
    }

    // 处理变化/新增的文件
    for (const [_tree, file] of changedFiles) {
      // 注意：数据库中存储的 id 就是简单的 relativePath 去掉 ".md" 后缀
      // 不是经过 slugifyFilePath 处理的结果
      const id = file.data.relativePath!.replace(/\.md$/, "")
      const links = file.data.links || []
      const tags = Array.isArray(file.data.tags) ? file.data.tags : []

      // 检查是否从virtual转为entity
      const existingNode = graphDb.getNode(id)
      if (existingNode && existingNode.type === "virtual") {
        console.log(`Virtual → Entity: ${id}`)
      }

      // 序列化 frontmatter 并存储
      const frontmatterJson = file.data.frontmatter
        ? JSON.stringify(file.data.frontmatter)
        : undefined

      // 从 file.data.dates 提取日期字段（CreatedModifiedDate 插件设置的）
      const dates = file.data.dates
      const date_created = dates?.created?.toISOString()
      const date_modified = dates?.modified?.toISOString()
      const date_published = dates?.published?.toISOString()

      // 更新/创建entity节点
      // frontmatter 以 JSON 序列化存储，日期字段使用 ISO 8601 字符串
      graphDb.upsertNode({
        id,
        type: "entity",
        mtime: 0, // 在保存时更新
        frontmatter: frontmatterJson,
        date_created,
        date_modified,
        date_published,
      })

      // 删除旧的link边
      graphDb.deleteOutgoingEdges(id, "link")

      // 添加新的link边
      for (const target of links) {
        graphDb.addEdge({ source: id, target: target as string, type: "link" })

        // 如果目标节点不存在，创建virtual节点
        if (!graphDb.getNode(target as string)) {
          graphDb.upsertNode({
            id: target as string,
            type: "virtual",
          })
        }
      }

      // 删除旧的tag边
      graphDb.deleteOutgoingEdges(id, "tag")

      // 添加新的tag边
      for (const tag of tags) {
        const tagId = `tags/${tag}`

        // 创建tag节点（如果不存在）
        if (!graphDb.getNode(tagId)) {
          graphDb.upsertNode({
            id: tagId,
            type: "tag",
          })
        }

        graphDb.addEdge({ source: id, target: tagId, type: "tag" })
      }
    }
  })

  const stats = graphDb.getStats()
  console.log(
    `Graph updated: ${stats.nodeCount} nodes (${stats.entityCount} entity, ${stats.virtualCount} virtual, ${stats.tagCount} tag), ${stats.edgeCount} edges`,
  )
}

async function buildQuartz(argv: Argv, mut: Mutex, clientRefresh: () => void) {
  const ctx: BuildCtx = {
    buildId: randomIdNonSecure(),
    argv,
    cfg,
    allSlugs: [],
    allFiles: [],
    incremental: false,
  }

  const perf = new PerfTimer()
  const output = argv.output

  const pluginCount = Object.values(cfg.plugins).flat().length
  const pluginNames = (key: "transformers" | "filters" | "emitters") =>
    cfg.plugins[key].map((plugin) => plugin.name)
  if (argv.verbose) {
    console.log(`Loaded ${pluginCount} plugins`)
    console.log(`  Transformers: ${pluginNames("transformers").join(", ")}`)
    console.log(`  Filters: ${pluginNames("filters").join(", ")}`)
    console.log(`  Emitters: ${pluginNames("emitters").join(", ")}`)
  }

  const release = await mut.acquire()
  perf.addEvent("clean")
  await rm(output, { recursive: true, force: true })
  console.log(`Cleaned output directory \`${output}\` in ${perf.timeSince("clean")}`)

  perf.addEvent("glob")
  const allFiles = await glob("**/*.*", argv.directory, cfg.configuration.ignorePatterns)
  const markdownPaths = allFiles.filter((fp) => fp.endsWith(".md")).sort()
  console.log(
    `Found ${markdownPaths.length} input files from \`${argv.directory}\` in ${perf.timeSince("glob")}`,
  )

  const filePaths = markdownPaths.map((fp) => joinSegments(argv.directory, fp) as FilePath)
  ctx.allFiles = allFiles
  ctx.allSlugs = allFiles.map((fp) => slugifyFilePath(fp as FilePath))

  const parsedFiles = await parseMarkdown(ctx, filePaths)
  const filteredContent = filterContent(ctx, parsedFiles)
  
  // TODO 从这一步（filterContent）开始，两个模式的数据就已经有偏差了。
  // console.log("parsedFiles:", JSON.stringify(parsedFiles, null, 2));
  // console.log("Filtered content:", JSON.stringify(filteredContent, null, 2));
  

  await emitContent(ctx, filteredContent)
  console.log(
    styleText("green", `Done processing ${markdownPaths.length} files in ${perf.timeSince()}`),
  )
  release()

  if (argv.watch) {
    ctx.incremental = true
    return startWatching(ctx, mut, parsedFiles, clientRefresh)
  }
}

// 增量构建函数
async function buildQuartzIncremental(argv: Argv, mut: Mutex, clientRefresh: () => void) {
  console.log("[DEBUG] buildQuartzIncremental started")
  const ctx: BuildCtx = {
    buildId: randomIdNonSecure(),
    argv,
    cfg,
    allSlugs: [],
    allFiles: [],
    incremental: true,
  }

  console.log("[DEBUG] ctx initialized")

  const perf = new PerfTimer()
  const output = argv.output
  console.log(`[DEBUG] output directory: ${output}`)

  if (argv.verbose) {
    const pluginCount = Object.values(cfg.plugins).flat().length
    console.log(`Loaded ${pluginCount} plugins`)
  }

  // 检测是否需要重置缓存和输出目录
  perf.addEvent("load-cache")
  const graphDb = getGraphDatabase()
  ctx.graphDb = graphDb

  const currentDirectory = argv.directory
  const storedDirectory = graphDb.getStoredDirectory()
  const directoryChanged = storedDirectory !== currentDirectory
  const shouldReset = argv.reset || directoryChanged

  if (shouldReset) {
    if (argv.reset) {
      console.log("Reset flag set, clearing cache and output directory")
    } else {
      console.log(
        `Directory changed from \`${storedDirectory}\` to \`${currentDirectory}\`, clearing cache`,
      )
    }
    // 先清空数据库
    graphDb.clearAll()
    // 再删除输出目录
    await rm(output, { recursive: true, force: true })
  }

  // 确保输出目录存在
  await mkdir(output, { recursive: true })

  // 存储当前目录
  graphDb.storeDirectory(currentDirectory)

  console.log(`Loaded graph database in ${perf.timeSince("load-cache")}`)

  // 获取所有文件
  perf.addEvent("glob")
  const allFiles = await glob("**/*.*", argv.directory, cfg.configuration.ignorePatterns)

  const markdownPaths = allFiles.filter((fp) => fp.endsWith(".md")).sort()
  console.log(`Found ${markdownPaths.length} input files in ${perf.timeSince("glob")}`)

  // 检测变化的文件
  perf.addEvent("detect-changes")
  const { changed: changedFilePaths, deleted: deletedFilePaths } = await detectChangedFiles(
    markdownPaths,
    graphDb,
    argv.directory,
  )
  console.log(`Detected ${changedFilePaths.length} changed, ${deletedFilePaths.length} deleted`)

  // 设置上下文
  ctx.allFiles = allFiles
  ctx.allSlugs = allFiles.map((fp) => slugifyFilePath(fp as FilePath))

  // 如果没有任何变化，跳过构建
  if (changedFilePaths.length === 0 && deletedFilePaths.length === 0) {
    console.log(styleText("green", "No changes detected, skipping build"))
    return
  }

  // buildQuartzIncremental 函数，不应该从SQLite恢复内容，而应该只解析变化的文件，然后使用SQLite来构建图谱关系。
  // 只解析变化的文件，目录和图谱将使用 SQLite 数据
  // 这样可以实现真正的增量构建性能提升
  perf.addEvent("parse")
  const changedFullPaths = changedFilePaths.map(
    (fp) => joinSegments(argv.directory, fp) as FilePath,
  )
  const parsedFiles = await parseMarkdown(ctx, changedFullPaths)
  // TODO 明天从这里开始查。allParsedFiles里全都没有frontmatter了。
  console.log(`Parsed ${parsedFiles.length} changed files in ${perf.timeSince("parse")}`)

  // 从 SQLite 导出完整的内容索引用于目录和图谱
  // 但 HTML 页面只构建变化的文件
  const allParsedFiles: ProcessedContent[] = []

  // TODO 现在只是将变化的文件添加到 allParsedFiles 中
  // 将变化的文件添加到 allParsedFiles
  allParsedFiles.push(...parsedFiles)

  // 为未变化的文件创建虚拟内容，仅用于目录和图谱（不包含HTML AST）
  // 但这些不会生成HTML页面，因为它们的HTML AST为空
  // 注意：数据库中的 slug 就是简单的 file_path 去掉 ".md" 后缀，不是 slugifyFilePath 的结果
  const changedSlugsSet = new Set(changedFilePaths.map((fp) => fp.replace(/\.md$/, "")))
  const deletedSlugsSet = new Set(deletedFilePaths.map((fp) => fp.replace(/\.md$/, "")))

  // 从数据库获取所有未变化的实体节点信息，用于目录和图谱
  // 只处理 entity 类型的节点（只有它们有 file_path）
  const allNodes = graphDb.getAllNodes()
  for (const node of allNodes) {
    if (node.type === "entity" && !changedSlugsSet.has(node.id) && !deletedSlugsSet.has(node.id)) {
      // 从 SQLite 恢复 frontmatter
      const frontmatter = graphDb.getNodeFrontmatter(node.id)

      // 从 SQLite 恢复日期信息
      const dates = graphDb.getNodeDates(node.id)

      // 创建一个包含元数据但没有HTML内容的虚拟文件
      // 这样目录和图谱可以访问完整数据，但不会生成HTML
      // 只有entity类型的节点才参与目录计算，需要relativePath
      const title = frontmatter?.title || node.id // 优先使用 frontmatter 中的 title
      // 从 id 计算 file_path：id + ".md"
      const filePath = (node.id + ".md") as FilePath

      const slug = slugifyFilePath(node.id as FilePath) as FullSlug

      // 确保 frontmatter 有 title 字段（类型要求）
      const frontmatterWithTitle = frontmatter
        ? { ...frontmatter, title: frontmatter.title || title }
        : { title: title }

      const virtualContent = defaultProcessedContent({
        slug: slug, // 使用 id 作为 slug（为了兼容性）
        title: title,
        relativePath: filePath,
        filePath: filePath, // 用于FileTrieNode
        frontmatter: frontmatterWithTitle as QuartzPluginData["frontmatter"], // 恢复 frontmatter
      })

      // 恢复日期信息（直接赋值以避免类型问题）
      if (dates) {
        virtualContent[1].data.dates = dates as { created: Date; modified: Date; published: Date }
      }

      // 恢复链接信息
      const outgoingLinks = graphDb.getOutgoingEdges(node.id, "link")
      virtualContent[1].data.links = outgoingLinks.map((l) => l.target as SimpleSlug)

      allParsedFiles.push(virtualContent)
    }
  }

  // 构造 changeEvents
  const changeEvents: ChangeEvent[] = [
    ...parsedFiles.map(
      ([_tree, file]): ChangeEvent => ({
        type: "change" as const,
        path: file.data.relativePath!,
        file: file,
      }),
    ),
    ...deletedFilePaths.map((fp): ChangeEvent => {
      const fullfilepath = path.join(argv.directory, fp) as FilePath

      // 注意：数据库中的 id 就是简单的 relativePath 去掉 ".md" 后缀
      // const id = relativePath.replace(/\.md$/, '')
      const id = fp.replace(/\.md$/, "")
      console.log(`id: ${id}`)

      const node = graphDb.getNode(id)

      // 注意，检索node的话要用 work/问答/MAPWD3.md这种形式
      if (node) {

        // 注意：description 和 frontmatter 不再存储在数据库中，使用默认值
        const title = node.id // 使用 id 作为 title

        // 使用 id 作为 slug（因为 contentIndex 使用 slug 作为 key）
        const slug = slugifyFilePath(id as FilePath) as FullSlug

        const virtualFile = defaultProcessedContent({
          slug: slug,
          relativePath: fp,
          filePath: fullfilepath,
          links: [],
          title: title,
        })
        // console.log("Deleted file:", JSON.stringify(virtualFile[1]));
        

        return {
          type: "delete" as const,
          path: fp,
          file: virtualFile[1],
        }
      } else {
        console.log(`Deleted no node ${fp}`)
      }

      return {
        type: "delete" as const,
        path: fp,
        file: undefined,
      }
    }),
  ]

  // 更新图谱数据库
  perf.addEvent("update-graph")
  updateGraphDatabase(graphDb, parsedFiles, deletedFilePaths)

  // 更新 mtime（只有 entity 类型的节点有 mtime）
  for (const [_tree, file] of parsedFiles) {
    const fullfilepath = path.join(argv.directory, file.data.relativePath!) as FilePath
    
    try {
      const stats = await stat(fullfilepath)
      // 注意：数据库中的 slug 就是简单的 relativePath 去掉 ".md" 后缀
      const slug = file.data.relativePath!.replace(/\.md$/, "")
      const node = graphDb.getNode(slug)
      if (node && node.type === "entity") {
        graphDb.upsertNode({
          ...node,
          mtime: stats.mtimeMs,
        })
      }
    } catch (err) {
      console.error(`Failed to update mtime for ${fullfilepath}:`, err)
    }
  }
  console.log(`Updated graph database in ${perf.timeSince("update-graph")}`)

  const filteredContent = filterContent(ctx, allParsedFiles)
  

  // 使用与 rebuild 函数相同的逻辑：对支持 partialEmit 的 emitter 使用 partialEmit，否则使用 emit
  // 但某些全局资源 emitter 需要使用 emit 方法以确保全局资源（如 index.css）被正确生成
  let emittedFiles = 0
  const staticResources = getStaticResourcesFromPlugins(ctx)
  // console.log(`cfg.plugins.emitters: ${JSON.stringify(cfg.plugins.emitters, null, 2)}`);

  for (const emitter of cfg.plugins.emitters) {
    console.log(`Running emitter: ${emitter.name}`)

    // 对于某些全局资源 emitter，始终使用 emit 方法以确保全局资源被生成
    // 对于内容相关的 emitter，可以使用 partialEmit 以提高性能
    let emitFn

    // 定制传递的内容,有的partialEmit需要全量数据,有的partialEmit需要部分数据。
    // TODO 但是我其实觉得这个逻辑有点乱，后期最好统一下。
    let contentToPass = filteredContent

    // 对特定的全局资源emitter（ComponentResources, Assets, Static, Favicon, CNAME）始终使用emit方法，确保它们的全局资源被正确生成
    if (["ComponentResources", "Assets", "Static", "Favicon", "CNAME"].includes(emitter.name)) {
      // 这些 emitter 生成全局资源，始终使用 emit 方法
      emitFn = emitter.emit
    } else {
      // 内容相关的 emitter 可以使用 partialEmit
      emitFn = emitter.partialEmit ?? emitter.emit

      // 对于 ContentIndex 的 partialEmit，只传递真正变化的文件
      if (emitter.name === "ContentIndex" && emitter.partialEmit) {
        contentToPass = filterContent(ctx, parsedFiles) // 只传递变化的文件
        // 把这里的打印到文本文件
        console.log(`emitter.name: ${emitter.name}`)
      }
    }

    const emitted = await emitFn(ctx, contentToPass, staticResources, changeEvents)
    if (emitted === null) {
      continue
    }

    if (Symbol.asyncIterator in emitted) {
      // Async generator case
      for await (const file of emitted) {
        emittedFiles++
        if (ctx.argv.verbose) {
          console.log(`[emit:${emitter.name}] ${file}`)
        }
      }
    } else {
      // Array case
      emittedFiles += emitted.length
      if (ctx.argv.verbose) {
        for (const file of emitted) {
          console.log(`[emit:${emitter.name}] ${file}`)
        }
      }
    }
  }

  console.log(`Emitted ${emittedFiles} files to \`${argv.output}\` in ${perf.timeSince()}`)

  // 删除对应的输出文件
  // 注意：只删除真正被删除的节点（无入边），不删除转为 virtual 的节点
  for (const deletedPath of deletedFilePaths) {
    try {
      // 检查该文件是否已转为 virtual 节点（如果有入边）
      // 数据库中的 id 就是简单的 file_path 去掉 ".md" 后缀
      const id = (deletedPath as string).replace(/\.md$/, "")
      const node = graphDb.getNode(id)

      if (node && node.type === "virtual") {
        // 该节点已转为 virtual，保留其输出文件（用于显示反向链接等）
        console.log(`Skipped deleting output for virtual node: ${id}`)
        continue
      }

      // 真正被删除的节点，删除其输出文件
      const slug = slugifyFilePath(deletedPath as FilePath)
      const outputPath = path.join(output, slug + ".html")
      await unlink(outputPath)
      console.log(`Deleted output: ${outputPath}`)
    } catch (err) {
      // 文件可能已经不存在，忽略错误
    }
  }

  console.log(styleText("green", `Done incremental build in ${perf.timeSince()}`))
}

async function startWatching(
  ctx: BuildCtx,
  mut: Mutex,
  initialContent: ProcessedContent[],
  clientRefresh: () => void,
) {
  const { argv, allFiles } = ctx

  const contentMap: ContentMap = new Map()
  for (const filePath of allFiles) {
    contentMap.set(filePath, {
      type: "other",
    })
  }

  for (const content of initialContent) {
    const [_tree, vfile] = content
    contentMap.set(vfile.data.relativePath!, {
      type: "markdown",
      content,
    })
  }

  const gitIgnoredMatcher = await isGitIgnored()
  const buildData: BuildData = {
    ctx,
    mut,
    contentMap,
    ignored: (fp) => {
      const pathStr = toPosixPath(fp.toString())
      if (pathStr.startsWith(".git/")) return true
      if (gitIgnoredMatcher(pathStr)) return true
      for (const pattern of cfg.configuration.ignorePatterns) {
        if (minimatch(pathStr, pattern)) {
          return true
        }
      }

      return false
    },

    changesSinceLastBuild: {},
    lastBuildMs: 0,
  }

  const watcher = chokidar.watch(".", {
    awaitWriteFinish: { stabilityThreshold: 250 },
    persistent: true,
    cwd: argv.directory,
    ignoreInitial: true,
  })

  const changes: ChangeEvent[] = []
  watcher
    .on("add", (fp) => {
      fp = toPosixPath(fp)
      if (buildData.ignored(fp)) return
      changes.push({ path: fp as FilePath, type: "add" })
      void rebuild(changes, clientRefresh, buildData)
    })
    .on("change", (fp) => {
      fp = toPosixPath(fp)
      if (buildData.ignored(fp)) return
      changes.push({ path: fp as FilePath, type: "change" })
      void rebuild(changes, clientRefresh, buildData)
    })
    .on("unlink", (fp) => {
      fp = toPosixPath(fp)
      if (buildData.ignored(fp)) return
      changes.push({ path: fp as FilePath, type: "delete" })
      void rebuild(changes, clientRefresh, buildData)
    })

  return async () => {
    await watcher.close()
  }
}

async function rebuild(changes: ChangeEvent[], clientRefresh: () => void, buildData: BuildData) {
  const { ctx, contentMap, mut, changesSinceLastBuild } = buildData
  const { argv, cfg } = ctx

  const buildId = randomIdNonSecure()
  ctx.buildId = buildId
  buildData.lastBuildMs = new Date().getTime()
  const numChangesInBuild = changes.length
  const release = await mut.acquire()

  // if there's another build after us, release and let them do it
  if (ctx.buildId !== buildId) {
    release()
    return
  }

  const perf = new PerfTimer()
  perf.addEvent("rebuild")
  console.log(styleText("yellow", "Detected change, rebuilding..."))

  // update changesSinceLastBuild
  for (const change of changes) {
    changesSinceLastBuild[change.path] = change.type
  }

  const staticResources = getStaticResourcesFromPlugins(ctx)
  const pathsToParse: FilePath[] = []
  for (const [fp, type] of Object.entries(changesSinceLastBuild)) {
    if (type === "delete" || path.extname(fp) !== ".md") continue
    const fullPath = joinSegments(argv.directory, toPosixPath(fp)) as FilePath
    pathsToParse.push(fullPath)
  }

  const parsed = await parseMarkdown(ctx, pathsToParse)
  for (const content of parsed) {
    contentMap.set(content[1].data.relativePath!, {
      type: "markdown",
      content,
    })
  }

  // update state using changesSinceLastBuild
  // we do this weird play of add => compute change events => remove
  // so that partialEmitters can do appropriate cleanup based on the content of deleted files
  for (const [file, change] of Object.entries(changesSinceLastBuild)) {
    if (change === "delete") {
      // universal delete case
      contentMap.delete(file as FilePath)
    }

    // manually track non-markdown files as processed files only
    // contains markdown files
    if (change === "add" && path.extname(file) !== ".md") {
      contentMap.set(file as FilePath, {
        type: "other",
      })
    }
  }

  const changeEvents: ChangeEvent[] = Object.entries(changesSinceLastBuild).map(([fp, type]) => {
    const path = fp as FilePath
    const processedContent = contentMap.get(path)
    if (processedContent?.type === "markdown") {
      const [_tree, file] = processedContent.content
      return {
        type,
        path,
        file,
      }
    }

    return {
      type,
      path,
    }
  })

  // update allFiles and then allSlugs with the consistent view of content map
  ctx.allFiles = Array.from(contentMap.keys())
  ctx.allSlugs = ctx.allFiles.map((fp) => slugifyFilePath(fp as FilePath))
  let processedFiles = filterContent(
    ctx,
    Array.from(contentMap.values())
      .filter((file) => file.type === "markdown")
      .map((file) => file.content),
  )
  // 调试语句
  // console.log("processedFiles:", JSON.stringify(processedFiles, null, 2));
  
  let emittedFiles = 0
  for (const emitter of cfg.plugins.emitters) {
    // Try to use partialEmit if available, otherwise assume the output is static
    const emitFn = emitter.partialEmit ?? emitter.emit
    const emitted = await emitFn(ctx, processedFiles, staticResources, changeEvents)
    if (emitted === null) {
      continue
    }

    if (Symbol.asyncIterator in emitted) {
      // Async generator case
      for await (const file of emitted) {
        emittedFiles++
        if (ctx.argv.verbose) {
          console.log(`[emit:${emitter.name}] ${file}`)
        }
      }
    } else {
      // Array case
      emittedFiles += emitted.length
      if (ctx.argv.verbose) {
        for (const file of emitted) {
          console.log(`[emit:${emitter.name}] ${file}`)
        }
      }
    }
  }

  console.log(`Emitted ${emittedFiles} files to \`${argv.output}\` in ${perf.timeSince("rebuild")}`)
  console.log(styleText("green", `Done rebuilding in ${perf.timeSince()}`))
  changes.splice(0, numChangesInBuild)
  clientRefresh()
  release()
}

export default async (argv: Argv, mut: Mutex, clientRefresh: () => void) => {
  try {
    // 改动 4：修改 export default
    // 如果启用基于 SQLite 的持久化增量构建
    if (argv.sqlite) {
      return await buildQuartzIncremental(argv, mut, clientRefresh)
    }
    // 改动4结束
    return await buildQuartz(argv, mut, clientRefresh)
  } catch (err) {
    trace("\nExiting Quartz due to a fatal error", err as Error)
  }
}