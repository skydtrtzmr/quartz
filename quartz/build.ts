import sourceMapSupport from "source-map-support"
sourceMapSupport.install(options)
import path from "path"
import { PerfTimer } from "./util/perf"
import { mkdir, rm, stat, unlink } from "fs/promises"
import { existsSync, mkdirSync } from "fs"
import { GlobbyFilterFunction, isGitIgnored } from "globby"
import { styleText } from "util"
import { parseMarkdown } from "./processors/parse"
import { filterContent } from "./processors/filter"
import { emitContent } from "./processors/emit"
import cfg from "../quartz"
import { FilePath, FullSlug, SimpleSlug, joinSegments, slugifyFilePath } from "./util/path"
import { detectSlugCollisions, formatCollisionWarning } from "./util/slugCollisions"
import chokidar from "chokidar"
import { ProcessedContent, QuartzPluginData, defaultProcessedContent } from "./plugins/vfile"
import { Argv, BuildCtx } from "./util/ctx"
import { glob, toPosixPath } from "./util/glob"
import { trace } from "./util/trace"
import { options } from "./util/sourcemap"
import { Mutex } from "async-mutex"
import { getStaticResourcesFromPlugins } from "./plugins"
import { randomIdNonSecure } from "./util/random"
import { ChangeEvent } from "./plugins/types"
import { minimatch } from "minimatch"
import { GraphDatabase } from "./util/graphdb"

function reportSlugCollisions(content: ProcessedContent[]): void {
  const collisions = detectSlugCollisions(content)
  if (collisions.length === 0) return
  console.warn(styleText("yellow", formatCollisionWarning(collisions)))
}

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

function getGraphDatabase(cacheDir?: string): GraphDatabase {
  const dataDir = cacheDir ? path.resolve(cacheDir) : path.join(process.cwd(), "data")
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  return new GraphDatabase(path.join(dataDir, ".quartz-cache.db"))
}

async function detectChangedFiles(
  allFileNames: string[],
  graphDb: GraphDatabase,
  directory: string,
): Promise<{ changed: FilePath[]; deleted: FilePath[] }> {
  const currentFiles = new Map<FilePath, number>()
  for (const fp of allFileNames) {
    if (!fp.endsWith(".md")) continue

    const fullPath = joinSegments(directory, fp) as FilePath
    try {
      const stats = await stat(fullPath)
      currentFiles.set(fp as FilePath, stats.mtimeMs)
    } catch {
      // The file disappeared between glob and stat; the next build will detect it.
    }
  }

  return graphDb.getChangedFiles(currentFiles)
}

function updateGraphDatabase(
  graphDb: GraphDatabase,
  changedFiles: ProcessedContent[],
  deletedFiles: FilePath[],
): string[] {
  let prunedVirtualNodes: string[] = []
  graphDb.transaction(() => {
    for (const filePath of deletedFiles) {
      const node = graphDb.getNodeByFilePath(filePath)
      if (!node) continue

      const id = node.id
      if (graphDb.hasIncomingEdges(id)) {
        graphDb.deleteOutgoingEdges(id)
        graphDb.upsertNode({ id, type: "virtual" })
        console.log(`Entity -> Virtual: ${id}`)
      } else {
        graphDb.deleteNode(id)
        graphDb.deleteOutgoingEdges(id)
      }
    }

    for (const [, file] of changedFiles) {
      const id = file.data.relativePath!.replace(/\.md$/, "")
      const links = file.data.links ?? []
      const tags = Array.isArray(file.data.frontmatter?.tags) ? file.data.frontmatter.tags : []
      const dates = file.data.dates

      graphDb.upsertNode({
        id,
        type: "entity",
        mtime: 0,
        frontmatter: file.data.frontmatter ? JSON.stringify(file.data.frontmatter) : undefined,
        date_created: dates?.created?.toISOString(),
        date_modified: dates?.modified?.toISOString(),
        date_published: dates?.published?.toISOString(),
      })

      graphDb.deleteOutgoingEdges(id, "link")
      for (const target of links) {
        graphDb.addEdge({ source: id, target, type: "link" })
        if (!graphDb.getNode(target)) {
          graphDb.upsertNode({ id: target, type: "virtual" })
        }
      }

      graphDb.deleteOutgoingEdges(id, "tag")
      for (const tag of tags) {
        const tagId = `tags/${tag}`
        if (!graphDb.getNode(tagId)) {
          graphDb.upsertNode({ id: tagId, type: "tag" })
        }
        graphDb.addEdge({ source: id, target: tagId, type: "tag" })
      }
    }

    prunedVirtualNodes = graphDb.pruneUnreferencedVirtualNodes()
  })

  const stats = graphDb.getStats()
  console.log(
    `Graph updated: ${stats.nodeCount} nodes (${stats.entityCount} entity, ${stats.virtualCount} virtual, ${stats.tagCount} tag), ${stats.edgeCount} edges`,
  )
  return prunedVirtualNodes
}

async function buildQuartz(argv: Argv, mut: Mutex, clientRefresh: () => void) {
  const ctx: BuildCtx = {
    buildId: randomIdNonSecure(),
    argv,
    cfg,
    allSlugs: [],
    allFiles: [],
    incremental: false,
    virtualPages: [],
  }

  const perf = new PerfTimer()
  const output = argv.output

  const pluginCount = Object.values(cfg.plugins).flat().length
  const pluginNames = (key: "transformers" | "filters" | "emitters" | "pageTypes") =>
    (cfg.plugins[key] ?? []).map((plugin) => plugin.name)
  if (argv.verbose) {
    console.log(`Loaded ${pluginCount} plugins`)
    console.log(`  Transformers: ${pluginNames("transformers").join(", ")}`)
    console.log(`  Filters: ${pluginNames("filters").join(", ")}`)
    console.log(`  Emitters: ${pluginNames("emitters").join(", ")}`)
    console.log(`  PageTypes: ${pluginNames("pageTypes").join(", ")}`)
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
  reportSlugCollisions(parsedFiles)
  const filteredContent = filterContent(ctx, parsedFiles)

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

async function buildQuartzIncremental(argv: Argv, mut: Mutex, clientRefresh: () => void) {
  const ctx: BuildCtx = {
    buildId: randomIdNonSecure(),
    argv,
    cfg,
    allSlugs: [],
    allFiles: [],
    incremental: true,
    virtualPages: [],
  }

  const release = await mut.acquire()
  let openedGraphDb: GraphDatabase | undefined
  try {
    const perf = new PerfTimer()
    const output = argv.output

    perf.addEvent("load-cache")
    const graphDb = getGraphDatabase(argv.cacheDir)
    openedGraphDb = graphDb
    ctx.graphDb = graphDb

    const currentDirectory = argv.directory
    const storedDirectory = graphDb.getStoredDirectory()
    const directoryChanged = storedDirectory !== currentDirectory
    // SQLite 与输出目录是一组状态。旧缓存、失败构建或缺失产物不能作为增量基线。
    let previousBuild: { output: string; files: string[] } | undefined
    try {
      previousBuild = JSON.parse(graphDb.getBuildState() ?? "null") ?? undefined
    } catch {
      // 包括上次在 emitter 写出期间中断留下的 pending 标记。
    }
    const completeOutput =
      previousBuild?.output === path.resolve(output) &&
      Array.isArray(previousBuild.files) &&
      previousBuild.files.length > 0 &&
      previousBuild.files.every((fp) => existsSync(fp))
    const shouldReset = argv.reset || directoryChanged || !completeOutput

    if (shouldReset) {
      if (argv.reset) {
        console.log("Reset flag set, clearing cache and output directory")
      } else if (directoryChanged) {
        console.log(
          `Directory changed from \`${storedDirectory}\` to \`${currentDirectory}\`, clearing cache`,
        )
      } else {
        console.log("Incremental baseline incomplete or output changed; rebuilding all files")
      }
      graphDb.clearAll()
      await rm(output, { recursive: true, force: true })
    }

    await mkdir(output, { recursive: true })
    graphDb.storeDirectory(currentDirectory)
    const coldBuild = graphDb.getStats().entityCount === 0
    console.log(`Loaded graph database in ${perf.timeSince("load-cache")}`)

    perf.addEvent("glob")
    const allFiles = await glob("**/*.*", argv.directory, cfg.configuration.ignorePatterns)
    const markdownPaths = allFiles.filter((fp) => fp.endsWith(".md")).sort()
    console.log(`Found ${markdownPaths.length} input files in ${perf.timeSince("glob")}`)

    perf.addEvent("detect-changes")
    const { changed: changedFilePaths, deleted: deletedFilePaths } = await detectChangedFiles(
      markdownPaths,
      graphDb,
      argv.directory,
    )
    console.log(`Detected ${changedFilePaths.length} changed, ${deletedFilePaths.length} deleted`)

    ctx.allFiles = allFiles
    ctx.allSlugs = allFiles.map((fp) => slugifyFilePath(fp as FilePath))

    if (changedFilePaths.length === 0 && deletedFilePaths.length === 0) {
      console.log(styleText("green", "No changes detected, skipping build"))
      return
    }

    // 先标记未完成；解析或写出失败时，下一次不会被提前保存的 mtime 误导。
    graphDb.storeBuildState("pending")

    perf.addEvent("parse")
    const changedFullPaths = changedFilePaths.map(
      (fp) => joinSegments(argv.directory, fp) as FilePath,
    )
    const parsedFiles = await parseMarkdown(ctx, changedFullPaths)
    if (parsedFiles.length !== changedFullPaths.length) {
      throw new Error("Some Markdown files failed to parse; incremental build was not completed")
    }
    reportSlugCollisions(parsedFiles)
    console.log(`Parsed ${parsedFiles.length} changed files in ${perf.timeSince("parse")}`)

    const allParsedFiles: ProcessedContent[] = [...parsedFiles]
    const changedSlugsSet = new Set(changedFilePaths.map((fp) => fp.replace(/\.md$/, "")))
    const deletedSlugsSet = new Set(deletedFilePaths.map((fp) => fp.replace(/\.md$/, "")))

    for (const node of graphDb.getAllNodes()) {
      if (node.type !== "entity" || changedSlugsSet.has(node.id) || deletedSlugsSet.has(node.id)) {
        continue
      }

      const frontmatter = graphDb.getNodeFrontmatter(node.id)
      const dates = graphDb.getNodeDates(node.id)
      const title =
        typeof frontmatter?.title === "string" && frontmatter.title.length > 0
          ? frontmatter.title
          : node.id
      const filePath = (node.id + ".md") as FilePath
      const slug = slugifyFilePath(filePath)
      const frontmatterWithTitle = frontmatter ? { ...frontmatter, title } : { title }
      const virtualContent = defaultProcessedContent({
        slug,
        title,
        relativePath: filePath,
        filePath,
        frontmatter: frontmatterWithTitle as QuartzPluginData["frontmatter"],
      })

      if (Object.keys(dates).length > 0) {
        virtualContent[1].data.dates = dates as QuartzPluginData["dates"]
      }
      virtualContent[1].data.links = graphDb
        .getOutgoingEdges(node.id, "link")
        .map((edge) => edge.target as SimpleSlug)
      allParsedFiles.push(virtualContent)
    }

    const changeEvents: ChangeEvent[] = [
      ...parsedFiles.map(([, file]): ChangeEvent => ({
        type: "change",
        path: file.data.relativePath!,
        file,
      })),
      ...deletedFilePaths.map((fp): ChangeEvent => {
        const id = fp.replace(/\.md$/, "")
        const node = graphDb.getNode(id)
        const file = node
          ? defaultProcessedContent({
              slug: slugifyFilePath(fp),
              relativePath: fp,
              filePath: path.join(argv.directory, fp) as FilePath,
              links: [],
              title: node.id,
            })[1]
          : undefined
        return { type: "delete", path: fp, file }
      }),
    ]

    const rawIds = [...changedFilePaths, ...deletedFilePaths].map((fp) => fp.replace(/\.md$/, ""))
    const beforeAffected = graphDb.analyzeImpact(rawIds).allAffected

    perf.addEvent("update-graph")
    const prunedVirtualNodes = updateGraphDatabase(graphDb, parsedFiles, deletedFilePaths)
    const afterAffected = graphDb.analyzeImpact(rawIds).allAffected
    const affectedIds = [...new Set([...beforeAffected, ...afterAffected])].filter(
      (id) => !rawIds.includes(id),
    )
    ctx.affectedSlugs = new Set(affectedIds.map((id) => slugifyFilePath((id + ".md") as FilePath)))
    console.log(`Affected slugs: ${ctx.affectedSlugs.size}`)

    // v5 renders pages through PageTypeDispatcher. Reparse affected source pages so
    // their existing body is not replaced by the metadata-only cached content.
    const markdownPathSet = new Set(markdownPaths)
    const markdownPathBySlug = new Map(
      markdownPaths.map((fp) => [slugifyFilePath(fp as FilePath), fp as FilePath]),
    )
    const affectedFilePaths = [
      ...new Set(
        affectedIds.flatMap((id) => {
          const rawPath = (id + ".md") as FilePath
          const filePath = markdownPathSet.has(rawPath)
            ? rawPath
            : markdownPathBySlug.get(id as FullSlug)
          return filePath === undefined ? [] : [filePath]
        }),
      ),
    ].filter((fp) => !changedSlugsSet.has(fp.replace(/\.md$/, "")))
    if (affectedFilePaths.length > 0) {
      const affectedFullPaths = affectedFilePaths.map(
        (fp) => joinSegments(argv.directory, fp) as FilePath,
      )
      const affectedContent = await parseMarkdown(ctx, affectedFullPaths)
      if (affectedContent.length !== affectedFullPaths.length) {
        throw new Error("Some affected Markdown files failed to parse; build was not completed")
      }
      for (const content of affectedContent) {
        const relativePath = content[1].data.relativePath
        const cachedIndex = allParsedFiles.findIndex(
          ([, file]) => file.data.relativePath === relativePath,
        )
        if (cachedIndex >= 0) {
          allParsedFiles[cachedIndex] = content
        } else {
          allParsedFiles.push(content)
        }
      }
      console.log(`Parsed ${affectedContent.length} affected files for page rendering`)
    }

    for (const [, file] of parsedFiles) {
      const relativePath = file.data.relativePath!
      const fullPath = path.join(argv.directory, relativePath) as FilePath
      try {
        const stats = await stat(fullPath)
        const id = relativePath.replace(/\.md$/, "")
        const node = graphDb.getNode(id)
        if (node?.type === "entity") {
          graphDb.upsertNode({ ...node, mtime: stats.mtimeMs })
        }
      } catch (err) {
        console.error(`Failed to update mtime for ${fullPath}:`, err)
      }
    }
    console.log(`Updated graph database in ${perf.timeSince("update-graph")}`)

    const filteredContent = filterContent(ctx, allParsedFiles)
    const staticResources = getStaticResourcesFromPlugins(ctx)
    let emittedFiles = 0
    const outputFiles = new Set<string>(coldBuild ? [] : previousBuild?.files)

    const runEmitter = async (
      emitter: (typeof cfg.plugins.emitters)[number],
      content: ProcessedContent[],
      forceFull = false,
    ) => {
      const emitFn = forceFull || coldBuild ? emitter.emit : (emitter.partialEmit ?? emitter.emit)
      const emitted = await emitFn(ctx, content, staticResources, changeEvents)
      if (emitted === null) return

      if (Symbol.asyncIterator in emitted) {
        for await (const file of emitted) {
          outputFiles.add(path.resolve(file))
          emittedFiles++
          if (ctx.argv.verbose) console.log(`[emit:${emitter.name}] ${file}`)
        }
      } else {
        for (const file of emitted) outputFiles.add(path.resolve(file))
        emittedFiles += emitted.length
        if (ctx.argv.verbose) {
          for (const file of emitted) console.log(`[emit:${emitter.name}] ${file}`)
        }
      }
    }

    const componentResources = cfg.plugins.emitters.find((e) => e.name === "ComponentResources")
    if (componentResources) {
      await runEmitter(componentResources, filteredContent, true)
    }

    const dispatcher = cfg.plugins.emitters.find((e) => e.name === "PageTypeDispatcher")
    if (dispatcher) {
      ctx.virtualPages = []
      await runEmitter(dispatcher, filteredContent)
    }

    const currentVirtualSlugs = new Set(ctx.virtualPages.map(([, file]) => file.data.slug))
    const realSlugs = new Set(filteredContent.map(([, file]) => file.data.slug))
    for (const id of prunedVirtualNodes) {
      if (currentVirtualSlugs.has(id as FullSlug) || realSlugs.has(id as FullSlug)) continue
      try {
        await unlink(joinSegments(output, `${id}.html`) as FilePath)
        console.log(`Deleted obsolete virtual page: ${id}`)
      } catch {
        // The stale output may already be absent.
      }
    }

    const contentWithVirtual =
      ctx.virtualPages.length > 0 ? [...filteredContent, ...ctx.virtualPages] : filteredContent
    for (const emitter of cfg.plugins.emitters) {
      if (emitter.name === "ComponentResources" || emitter.name === "PageTypeDispatcher") continue
      await runEmitter(emitter, contentWithVirtual)
    }

    for (const deletedPath of deletedFilePaths) {
      try {
        const id = deletedPath.replace(/\.md$/, "")
        const node = graphDb.getNode(id)
        if (node?.type === "virtual") continue

        const slug = slugifyFilePath(deletedPath)
        await unlink(path.join(output, slug + ".html"))
      } catch {
        // The output may already be absent.
      }
    }

    console.log(`Emitted ${emittedFiles} files to \`${argv.output}\` in ${perf.timeSince()}`)
    graphDb.storeBuildState(
      JSON.stringify({
        output: path.resolve(output),
        files: [...outputFiles].filter((fp) => existsSync(fp)),
      }),
    )
    console.log(styleText("green", `Done incremental build in ${perf.timeSince()}`))
    clientRefresh()
  } finally {
    openedGraphDb?.close()
    release()
  }
}

// setup watcher for rebuilds
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
    const relPath = vfile.data.relativePath
    if (!relPath) {
      console.warn(`Skipping file with no relativePath: ${vfile.path}`)
      continue
    }
    contentMap.set(relPath, {
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
  let rebuildTimeout: ReturnType<typeof setTimeout> | null = null
  const scheduleRebuild = () => {
    if (rebuildTimeout) clearTimeout(rebuildTimeout)
    rebuildTimeout = setTimeout(() => {
      rebuildTimeout = null
      rebuild(changes, clientRefresh, buildData).catch((err) => {
        console.error(styleText("red", "Rebuild failed:"), err.message ?? err)
      })
    }, 100)
  }
  watcher
    .on("add", (fp) => {
      fp = toPosixPath(fp)
      if (buildData.ignored(fp)) return
      changes.push({ path: fp as FilePath, type: "add" })
      scheduleRebuild()
    })
    .on("change", (fp) => {
      fp = toPosixPath(fp)
      if (buildData.ignored(fp)) return
      changes.push({ path: fp as FilePath, type: "change" })
      scheduleRebuild()
    })
    .on("unlink", (fp) => {
      fp = toPosixPath(fp)
      if (buildData.ignored(fp)) return
      changes.push({ path: fp as FilePath, type: "delete" })
      scheduleRebuild()
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
  try {
    // if there's another build after us, release and let them do it
    if (ctx.buildId !== buildId) {
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
      const relPath = content[1].data.relativePath
      if (!relPath) {
        console.warn(`Skipping file with no relativePath: ${content[1].path}`)
        continue
      }
      contentMap.set(relPath, {
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

    const markdownContent = Array.from(contentMap.values())
      .filter((file) => file.type === "markdown")
      .map((file) => file.content)
    reportSlugCollisions(markdownContent)
    let processedFiles = filterContent(ctx, markdownContent)

    let emittedFiles = 0

    // Phase 1: Run PageTypeDispatcher first so it populates ctx.virtualPages
    const dispatcher = cfg.plugins.emitters.find((e) => e.name === "PageTypeDispatcher")
    if (dispatcher) {
      ctx.virtualPages = []
      const emitFn = dispatcher.partialEmit ?? dispatcher.emit
      const emitted = await emitFn(ctx, processedFiles, staticResources, changeEvents)
      if (emitted !== null) {
        if (Symbol.asyncIterator in emitted) {
          for await (const file of emitted) {
            emittedFiles++
            if (ctx.argv.verbose) {
              console.log(`[emit:${dispatcher.name}] ${file}`)
            }
          }
        } else {
          emittedFiles += emitted.length
          if (ctx.argv.verbose) {
            for (const file of emitted) {
              console.log(`[emit:${dispatcher.name}] ${file}`)
            }
          }
        }
      }
    }

    // Phase 2: Run all other emitters with content extended by virtual pages
    const contentWithVirtual =
      ctx.virtualPages.length > 0 ? [...processedFiles, ...ctx.virtualPages] : processedFiles
    for (const emitter of cfg.plugins.emitters) {
      if (emitter.name === "PageTypeDispatcher") continue
      // Try to use partialEmit if available, otherwise assume the output is static
      const emitFn = emitter.partialEmit ?? emitter.emit
      const emitted = await emitFn(ctx, contentWithVirtual, staticResources, changeEvents)
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

    console.log(
      `Emitted ${emittedFiles} files to \`${argv.output}\` in ${perf.timeSince("rebuild")}`,
    )
    console.log(styleText("green", `Done rebuilding in ${perf.timeSince()}`))
    changes.splice(0, numChangesInBuild)
    clientRefresh()
  } finally {
    release()
  }
}

export default async (argv: Argv, mut: Mutex, clientRefresh: () => void) => {
  try {
    if (argv.sqlite) {
      return await buildQuartzIncremental(argv, mut, clientRefresh)
    }
    return await buildQuartz(argv, mut, clientRefresh)
  } catch (err) {
    trace("\nExiting Quartz due to a fatal error", err as Error)
  }
}
