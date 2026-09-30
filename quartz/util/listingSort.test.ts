import assert from "node:assert/strict"
import { test } from "node:test"
import { createFolderPageSort, normalizeListingSort, resolveListingRule } from "./listingSort"

test("folder sort inherits nearest ancestor and sorts its direct entries by frontmatter", () => {
  const config = normalizeListingSort({
    default: "title",
    folders: { notes: "priority", "notes/archive": "rank" },
  })
  assert.deepEqual(resolveListingRule(config, "notes/child"), { field: "priority", order: "asc" })
  assert.deepEqual(resolveListingRule(config, "notes/archive"), { field: "rank", order: "asc" })
  assert.deepEqual(resolveListingRule(config, "other"), { field: "title", order: "asc" })

  const items = [
    { slug: "notes/b", frontmatter: { title: "B", priority: 10 } },
    { slug: "notes/a", frontmatter: { title: "A", priority: 2 } },
    { slug: "notes/c", frontmatter: { title: "C" } },
  ]
  items.sort(createFolderPageSort(config))
  assert.deepEqual(
    items.map((item) => item.slug),
    ["notes/a", "notes/b", "notes/c"],
  )
})

test("folder sort inherits descending direction and keeps missing values last", () => {
  const config = normalizeListingSort({
    default: "title",
    folders: { notes: { field: "priority", order: "desc" } },
  })
  assert.deepEqual(resolveListingRule(config, "notes/child"), { field: "priority", order: "desc" })
  const items = [
    { slug: "notes/a", frontmatter: { title: "A", priority: 2 } },
    { slug: "notes/b", frontmatter: { title: "B", priority: 10 } },
    { slug: "notes/c", frontmatter: { title: "C" } },
  ]
  items.sort(createFolderPageSort(config))
  assert.deepEqual(
    items.map((item) => item.slug),
    ["notes/b", "notes/a", "notes/c"],
  )
})

test("folder page sorts text fields descending", () => {
  const config = normalizeListingSort({ folders: { people: { field: "name", order: "desc" } } })
  const items = [
    { slug: "people/a", frontmatter: { title: "A", name: "Alice" } },
    { slug: "people/b", frontmatter: { title: "B", name: "Bob" } },
  ]
  items.sort(createFolderPageSort(config))
  assert.deepEqual(items.map((item) => item.slug), ["people/b", "people/a"])
})
