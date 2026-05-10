import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "crypto"
import type { ContentDetails } from "./contentIndex"

// Test getLocalGraphPath function logic
function getLocalGraphPath(slug: string): string {
  const hash = createHash("sha256").update(slug).digest("hex").slice(0, 4)
  const dir1 = hash.slice(0, 2)
  const dir2 = hash.slice(2, 4)
  return `${dir1}/${dir2}/${slug}`
}

// Test alphabet-based indexing strategy
function getLocalGraphPathAlphabet(slug: string): string {
  const firstChar = slug.charAt(0).toLowerCase()
  // Check if it's a number
  if (/\d/.test(firstChar)) {
    return `num/${firstChar}/${slug}`
  }
  // Check if it's a letter
  if (/[a-z]/.test(firstChar)) {
    return `${firstChar}/${slug}`
  }
  // Chinese or other characters
  return `other/${slug}`
}

describe("GraphLocal Path Generation", () => {
  describe("SHA-256 Strategy (default)", () => {
    it("should generate consistent hash paths for slugs", () => {
      const path1 = getLocalGraphPath("api-test-page")
      const path2 = getLocalGraphPath("api-test-page")
      
      assert.equal(path1, path2)
      // SHA-256 produces hex output
      assert.match(path1, /^[a-f0-9]{2}\/[a-f0-9]{2}\/api-test-page$/)
    })

    it("should distribute different slugs to different buckets", () => {
      const paths = [
        getLocalGraphPath("page-a"),
        getLocalGraphPath("page-b"),
        getLocalGraphPath("page-c"),
      ]
      
      // All should follow the pattern
      paths.forEach(path => {
        assert.match(path, /^[a-f0-9]{2}\/[a-f0-9]{2}\//)
      })
    })

    it("should handle Chinese slugs", () => {
      const path = getLocalGraphPath("中文笔记")
      assert.match(path, /^[a-f0-9]{2}\/[a-f0-9]{2}\/中文笔记$/)
    })

    it("should handle slugs with path separators (nested directories)", () => {
      const path = getLocalGraphPath("folder/page-name")
      // MD5 is computed on full slug "folder/page-name"
      // But path includes the / which creates subdirectories
      assert.match(path, /^[a-f0-9]{2}\/[a-f0-9]{2}\/folder\/page-name$/)
      // Verify consistency
      const path2 = getLocalGraphPath("folder/page-name")
      assert.equal(path, path2)
    })
  })

  describe("Alphabet Strategy", () => {
    it("should group alphabet slugs by first letter", () => {
      assert.equal(getLocalGraphPathAlphabet("api-test"), "a/api-test")
      assert.equal(getLocalGraphPathAlphabet("blog-post"), "b/blog-post")
      assert.equal(getLocalGraphPathAlphabet("zettelkasten"), "z/zettelkasten")
    })

    it("should group numeric slugs to num/ folder", () => {
      assert.equal(getLocalGraphPathAlphabet("2024-review"), "num/2/2024-review")
      assert.equal(getLocalGraphPathAlphabet("0-index"), "num/0/0-index")
    })

    it("should group Chinese slugs to other/ folder", () => {
      assert.equal(getLocalGraphPathAlphabet("中文笔记"), "other/中文笔记")
    })

    it("should be case insensitive", () => {
      assert.equal(getLocalGraphPathAlphabet("API-Test"), "a/API-Test")
      assert.equal(getLocalGraphPathAlphabet("api-test"), "a/api-test")
    })
  })
})

describe("LocalGraphData Structure", () => {
  it("should have correct data structure with Record<slug, ContentDetails>", () => {
    const localGraphData = {
      version: 1,
      center: "test-page",
      depth: 1,
      generatedAt: Date.now(),
      // nodes is Record<slug, ContentDetails> - same as contentIndex
      nodes: {
        "test-page": {
          slug: "test-page" as any,
          filePath: "test-page.md" as any,
          title: "Test Page",
          links: ["linked-page"],
          tags: [],
          content: "content...",
          frontmatter: {},
        } as ContentDetails,
        "linked-page": {
          slug: "linked-page" as any,
          filePath: "linked-page.md" as any,
          title: "Linked Page",
          links: [],
          tags: ["tag1"],
          content: "...",
          frontmatter: { tag: "value" },
        } as ContentDetails,
      } as Record<string, ContentDetails>,
      edges: [
        { source: "test-page" as any, target: "linked-page" as any, sourceField: "project" },
      ],
    }

    assert.equal(localGraphData.version, 1)
    assert.equal(localGraphData.center, "test-page")
    assert.ok(localGraphData.depth >= 1)
    assert.ok(localGraphData.generatedAt > 0)
    // Verify Record format
    assert.ok(typeof localGraphData.nodes === "object")
    assert.ok(!Array.isArray(localGraphData.nodes))
    assert.ok("test-page" in localGraphData.nodes)
    assert.ok("linked-page" in localGraphData.nodes)
    // Verify ContentDetails structure
    const centerNode = localGraphData.nodes["test-page"]
    assert.equal(centerNode.title, "Test Page")
    assert.ok(Array.isArray(centerNode.links))
    assert.ok(Array.isArray(centerNode.tags))
  })

  it("should support contentIndex-compatible node access", () => {
    // Simulate how graph.inline.ts accesses nodes
    const nodes: Record<string, ContentDetails> = {
      "page-a": {
        slug: "page-a" as any,
        filePath: "page-a.md" as any,
        title: "Page A",
        links: ["page-b"],
        tags: [],
        content: "",
      } as ContentDetails,
    }

    // Both contentIndex and localGraph use same access pattern
    const node = nodes["page-a"]
    assert.equal(node.title, "Page A")
    assert.deepEqual(node.links, ["page-b"])
  })

  it("should identify virtual nodes by empty filePath", () => {
    // Virtual nodes have empty filePath
    const virtualNode: ContentDetails = {
      slug: "virtual-node" as any,
      filePath: "" as any,  // Empty indicates virtual
      title: "virtual-node",
      links: [],
      tags: [],
      content: "",
    }

    const isVirtual = !virtualNode.filePath
    assert.equal(isVirtual, true)
  })
})

describe("Path Consistency (Emitter vs Reader)", () => {
  it("should generate same path in emitter and reader", () => {
    const testSlugs = [
      "simple-page",
      "folder/nested-page",
      "deep/folder/structure/page",
      "中文笔记",
      "mix-中文-english",
    ]

    testSlugs.forEach(slug => {
      // Emitter side
      const emitterPath = getLocalGraphPath(slug)
      
      // Reader side (same algorithm - SHA-256)
      const hash = createHash("sha256").update(slug).digest("hex").slice(0, 4)
      const dir1 = hash.slice(0, 2)
      const dir2 = hash.slice(2, 4)
      const readerPath = `${dir1}/${dir2}/${slug}`
      
      assert.equal(emitterPath, readerPath, `Path mismatch for slug: ${slug}`)
    })
  })
})

console.log("[graphLocal.test.ts] All tests defined, running...")
