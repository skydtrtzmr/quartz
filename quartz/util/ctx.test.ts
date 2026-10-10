import test from "node:test"
import assert from "node:assert/strict"
import { trieFromAllFiles } from "./ctx"
import type { QuartzPluginData } from "../plugins/vfile"

test("generated pages without physical files have breadcrumb ancestry", () => {
  const page = { slug: "_dimensions/status/ready", frontmatter: { title: "Ready", tags: [] } } as QuartzPluginData
  const trie = trieFromAllFiles([page])
  const chain = trie.ancestryChain(["_dimensions", "status", "ready"])
  assert.ok(chain)
  assert.equal(chain.at(-1)?.displayName, "Ready")
  assert.equal(page.filePath, undefined)
})
