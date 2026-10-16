import test from "node:test"
import assert from "node:assert/strict"
import { popoverTarget } from "./popoverTarget"

test("previews retain scope, context and filters, with separate caches for each query", () => {
  const a = popoverTarget("https://example.com/site/value?scope=a&context=x&filter=type:A#heading")
  const b = popoverTarget("https://example.com/site/value?scope=b")
  assert.equal(a.url.search, "?scope=a&context=x&filter=type:A")
  assert.notEqual(a.id, b.id)
  assert.equal(a.hash, "#heading")
  assert.equal(a.url.hash, "")
  assert.equal(a.id, popoverTarget(a.url.href + "#another").id)
})
