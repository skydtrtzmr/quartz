import test from "node:test"
import assert from "node:assert/strict"
import { ancestorFolderPages } from "./folderDependencies"

test("add, change, deletion and a move invalidate both directory chains", () => {
  assert.deepEqual([...ancestorFolderPages(["old/nested/file", "new/file", "root-file"])],
    ["old/nested/index", "old/index", "index", "new/index"])
})

test("an index edit invalidates its parent without touching unrelated folders", () => {
  assert.deepEqual([...ancestorFolderPages(["项目/子目录/index", "项目/a"])],
    ["项目/子目录/index", "项目/index", "index"])
  assert.deepEqual([...ancestorFolderPages([])], [])
})
