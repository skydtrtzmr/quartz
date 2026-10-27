import test from "node:test"
import assert from "node:assert/strict"
import { sharedGraphOptions } from "./shared-graph"
import { resolveGraphViewConfig } from "../../../../plugins-local/graph-pro/src/options"

test("all graph views receive all settings from the global configuration", () => {
  const policy = {
    precomputeLocal: false,
    local: { depth: 2, linkDistance: 70, showTags: false, removeTags: ["hidden"] },
    defaults: { maxVisibleNodes: 60, expandBatchSize: 5, loadBatchSize: 10, coreMinLinks: 0 },
    folder: { maxVisibleNodes: 40 },
    global: { folders: ["project"], coreAggregationMaxLevels: 3, linkDistance: 150, filterNonCoreNodes: false },
  }
  const result = sharedGraphOptions(policy)
  for (const view of ["local", "folder", "dimension", "global"] as const) {
    assert.equal(resolveGraphViewConfig(result, view).maxVisibleNodes, view === "folder" ? 40 : 60)
    assert.equal(resolveGraphViewConfig(result, view).expandBatchSize, 5)
  }
  assert.equal(resolveGraphViewConfig(result, "local").linkDistance, 70)
  assert.equal(resolveGraphViewConfig(result, "global").linkDistance, 150)
  assert.deepEqual(resolveGraphViewConfig(result, "global").folders, ["project"])
  assert.deepEqual(result.graph, { precomputeLocal: false })
  assert.equal(resolveGraphViewConfig(result, "local").depth, 2)
  assert.equal(resolveGraphViewConfig(result, "local").showTags, false)
  assert.deepEqual(resolveGraphViewConfig(result, "local").removeTags, ["hidden"])
  assert.equal(resolveGraphViewConfig(result, "global").filterNonCoreNodes, false)
  assert.deepEqual(policy.local, { depth: 2, linkDistance: 70, showTags: false, removeTags: ["hidden"] })
})

test("no plugin-level graph configuration is accepted", () => {
  for (const section of ["graph", "graphDefaults", "localGraph", "folderGraph", "dimensionGraph", "globalGraph"]) {
    assert.throws(() => sharedGraphOptions(undefined, { [section]: { expandBatchSize: 5 } }), /Move graph-pro/)
  }
  assert.throws(() => sharedGraphOptions({}, { localGraph: { linkDistance: 70 } }), /Move graph-pro/)
})

test("rejects malformed sections without validating individual graph fields", () => {
  for (const graph of [null, [], { typo: {} }, { defaults: null }, { local: [] }]) {
    assert.throws(() => sharedGraphOptions(graph), /configuration.graph/)
  }
})
