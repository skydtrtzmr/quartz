import assert from "node:assert/strict"
import { test } from "node:test"
import { createFolderPageSort, normalizeListingSort, resolveListingField } from "./listingSort"

test("folder sort inherits nearest ancestor and sorts its direct entries by frontmatter", () => {
  const config = normalizeListingSort({ default: "title", folders: { notes: "priority", "notes/archive": "rank" } })
  assert.equal(resolveListingField(config, "notes/child"), "priority")
  assert.equal(resolveListingField(config, "notes/archive"), "rank")
  assert.equal(resolveListingField(config, "other"), "title")

  const items = [
    { slug: "notes/b", frontmatter: { title: "B", priority: 10 } },
    { slug: "notes/a", frontmatter: { title: "A", priority: 2 } },
    { slug: "notes/c", frontmatter: { title: "C" } },
  ]
  items.sort(createFolderPageSort(config))
  assert.deepEqual(items.map((item) => item.slug), ["notes/a", "notes/b", "notes/c"])
})
