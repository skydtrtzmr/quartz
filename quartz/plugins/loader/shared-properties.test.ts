import test from "node:test"
import assert from "node:assert/strict"
import { sharedPropertiesOptions } from "./shared-properties"

test("global rules are injected without dropping rendering options", () => {
  const properties = { branches: { default: [], folders: { tasks: ["status", "owner"] } } }
  const options = { excludedProperties: ["title"], includeAll: false }
  const result = sharedPropertiesOptions(properties, options)
  assert.equal(result.properties, properties)
  assert.deepEqual(result.excludedProperties, ["title"])
  assert.equal(result.includeAll, false)
  assert.equal(Object.hasOwn(options, "properties"), false)
})

test("absent or empty global rules never enable plugin-local chains", () => {
  const options = { includeAll: false }
  assert.equal(sharedPropertiesOptions(undefined, options), options)
  assert.deepEqual(sharedPropertiesOptions({}, options).properties, {})
  for (const value of [null, [], "invalid"]) {
    assert.throws(() => sharedPropertiesOptions(value, options), /configuration.properties/)
  }
  for (const properties of [undefined, {}, { branches: { default: ["status"] } }]) {
    assert.throws(
      () => sharedPropertiesOptions(properties, { properties: { branches: { default: ["old"] } } }),
      /Move.*configuration.properties/,
    )
  }
})
