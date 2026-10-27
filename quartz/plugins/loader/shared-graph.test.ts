import test from "node:test"
import assert from "node:assert/strict"
import { sharedGraphOptions } from "./shared-graph"
import { resolveGraphViewConfig } from "../../../../plugins-local/graph-pro/src/options"

test("all graph views use global business settings without losing view rendering options", () => {
  const options = { configVersion: 2 as const, localGraph: { linkDistance: 70 }, globalGraph: { linkDistance: 150 } }
  const policy = {
    defaults: { maxVisibleNodes: 60, expandBatchSize: 5, loadBatchSize: 10, coreMinLinks: 0 },
    folder: { maxVisibleNodes: 40 },
    global: { folders: ["project"], coreAggregationMaxLevels: 3 },
  }
  const result = sharedGraphOptions(policy, options)
  for (const view of ["local", "folder", "dimension", "global"] as const) {
    assert.equal(resolveGraphViewConfig(result, view).maxVisibleNodes, view === "folder" ? 40 : 60)
    assert.equal(resolveGraphViewConfig(result, view).expandBatchSize, 5)
  }
  assert.equal(resolveGraphViewConfig(result, "local").linkDistance, 70)
  assert.equal(resolveGraphViewConfig(result, "global").linkDistance, 150)
  assert.deepEqual(resolveGraphViewConfig(result, "global").folders, ["project"])
  assert.deepEqual(options.localGraph, { linkDistance: 70 })
})

test("no old plugin business keys are accepted", () => {
  for (const section of ["graph", "graphDefaults", "localGraph", "folderGraph", "dimensionGraph", "globalGraph"]) {
    assert.throws(() => sharedGraphOptions(undefined, { [section]: { expandBatchSize: 5 } }), /Move graph-pro/)
  }
  assert.throws(() => sharedGraphOptions({}, { globalGraph: { folders: [] } }), /Move graph-pro/)
})

test("validates bounds, paths, nulls and unknown graph fields", () => {
  for (const graph of [null, [], { typo: {} }, { defaults: { maxVisibleNodes: 0 } },
    { defaults: { coreMinLinks: -1 } }, { folder: { expandBatchSize: 1.5 } },
    { local: { folders: [] } }, { global: { folders: ["../outside"] } },
    { global: { coreAggregationMaxLevels: 0 } }]) {
    assert.throws(() => sharedGraphOptions(graph), /configuration.graph/)
  }
})
