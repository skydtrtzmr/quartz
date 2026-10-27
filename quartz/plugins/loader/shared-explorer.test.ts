import test from "node:test"
import assert from "node:assert/strict"
import { sharedExplorerOptions } from "./shared-explorer"

test("injects global policy including false without dropping plugin or sort options", () => {
  const options = { folderDefaultState: "collapsed", excludePathPrefixes: ["assets"] }
  const explorer = { hideFiles: false, dimensionFolders: true, dimensionMaxLevels: 3, dimensionMaxValues: 20 }
  assert.deepEqual(sharedExplorerOptions(explorer, options), { ...options, ...explorer })
  assert.equal(Object.hasOwn(options, "hideFiles"), false)
  assert.equal(sharedExplorerOptions(undefined, options), options)
})

test("rejects misplaced explorer fields instead of supporting old configuration", () => {
  for (const key of ["hideFiles", "dimensionFolders", "dimensionMaxLevels", "dimensionMaxValues"]) {
    assert.throws(() => sharedExplorerOptions(undefined, { [key]: false }), /Move explorer-pro/)
  }
})

test("validates explorer policy types, bounds and unknown fields", () => {
  for (const value of [null, [], "wrong", { hideFiles: "false" }, { dimensionFolders: 0 },
    { dimensionMaxLevels: 0 }, { dimensionMaxValues: 1.5 }, { dimensionMaxValues: -1 }, { typo: true }]) {
    assert.throws(() => sharedExplorerOptions(value), /configuration.explorer/)
  }
})
