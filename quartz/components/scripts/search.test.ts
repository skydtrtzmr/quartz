import test, { describe } from "node:test"
import assert from "node:assert"

// Inline the encoder function from search.inline.ts for testing
const encoder = (str: string): string[] => {
  const tokens: string[] = []
  let bufferStart = -1
  let bufferEnd = -1
  const lower = str.toLowerCase()

  let i = 0
  for (const char of lower) {
    const code = char.codePointAt(0)!

    const isCJK =
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x20000 && code <= 0x2a6df)

    const isWhitespace = code === 32 || code === 9 || code === 10 || code === 13

    if (isCJK) {
      if (bufferStart !== -1) {
        tokens.push(lower.slice(bufferStart, bufferEnd))
        bufferStart = -1
      }
      tokens.push(char)
    } else if (isWhitespace) {
      if (bufferStart !== -1) {
        tokens.push(lower.slice(bufferStart, bufferEnd))
        bufferStart = -1
      }
    } else {
      if (bufferStart === -1) bufferStart = i
      bufferEnd = i + char.length
    }

    i += char.length
  }

  if (bufferStart !== -1) {
    tokens.push(lower.slice(bufferStart))
  }

  return tokens
}

describe("search encoder", () => {
  describe("English text", () => {
    test("should tokenize simple English words", () => {
      const result = encoder("hello world")
      assert.deepStrictEqual(result, ["hello", "world"])
    })

    test("should handle multiple spaces", () => {
      const result = encoder("hello   world")
      assert.deepStrictEqual(result, ["hello", "world"])
    })

    test("should handle tabs and newlines", () => {
      const result = encoder("hello\tworld\ntest")
      assert.deepStrictEqual(result, ["hello", "world", "test"])
    })

    test("should lowercase all text", () => {
      const result = encoder("Hello WORLD Test")
      assert.deepStrictEqual(result, ["hello", "world", "test"])
    })
  })

  describe("CJK text", () => {
    test("should tokenize Japanese Hiragana character by character", () => {
      const result = encoder("こんにちは")
      assert.deepStrictEqual(result, ["こ", "ん", "に", "ち", "は"])
    })

    test("should tokenize Japanese Katakana character by character", () => {
      const result = encoder("コントロール")
      assert.deepStrictEqual(result, ["コ", "ン", "ト", "ロ", "ー", "ル"])
    })

    test("should tokenize Japanese Kanji character by character", () => {
      const result = encoder("日本語")
      assert.deepStrictEqual(result, ["日", "本", "語"])
    })

    test("should tokenize Korean Hangul character by character", () => {
      const result = encoder("안녕하세요")
      assert.deepStrictEqual(result, ["안", "녕", "하", "세", "요"])
    })

    test("should tokenize Chinese characters character by character", () => {
      const result = encoder("你好世界")
      assert.deepStrictEqual(result, ["你", "好", "世", "界"])
    })

    test("should handle mixed Hiragana/Katakana/Kanji", () => {
      const result = encoder("て以来")
      assert.deepStrictEqual(result, ["て", "以", "来"])
    })
  })

  describe("Mixed CJK and English", () => {
    test("should handle Japanese with English words", () => {
      const result = encoder("hello 世界")
      assert.deepStrictEqual(result, ["hello", "世", "界"])
    })

    test("should handle English with Japanese words", () => {
      const result = encoder("世界 hello world")
      assert.deepStrictEqual(result, ["世", "界", "hello", "world"])
    })

    test("should handle complex mixed content", () => {
      const result = encoder("これはtest文章です")
      assert.deepStrictEqual(result, ["こ", "れ", "は", "test", "文", "章", "で", "す"])
    })

    test("should handle mixed Korean and English", () => {
      const result = encoder("hello 안녕 world")
      assert.deepStrictEqual(result, ["hello", "안", "녕", "world"])
    })

    test("should handle mixed Chinese and English", () => {
      const result = encoder("你好 world")
      assert.deepStrictEqual(result, ["你", "好", "world"])
    })
  })

  describe("Edge cases", () => {
    test("should handle empty string", () => {
      const result = encoder("")
      assert.deepStrictEqual(result, [])
    })

    test("should handle only whitespace", () => {
      const result = encoder("   \t\n  ")
      assert.deepStrictEqual(result, [])
    })

    test("should handle single character", () => {
      const result = encoder("a")
      assert.deepStrictEqual(result, ["a"])
    })

    test("should handle single CJK character", () => {
      const result = encoder("あ")
      assert.deepStrictEqual(result, ["あ"])
    })

    test("should handle CJK with trailing whitespace", () => {
      const result = encoder("日本語  ")
      assert.deepStrictEqual(result, ["日", "本", "語"])
    })

    test("should handle English with trailing whitespace", () => {
      const result = encoder("hello  ")
      assert.deepStrictEqual(result, ["hello"])
    })
  })
})

// ============================================
// parseSearchQuery tests
// ============================================

// Inline the parseSearchQuery function from search2.inline.ts for testing
type YamlQuery = { type: 'key-value' | 'value-only' | 'key-only', key?: string, value?: string }

interface ParsedSearchQuery {
  yamlQueries: YamlQuery[]
  tags: string[]
  text: string
  excludeYamlQueries: YamlQuery[]
  excludeTags: string[]
  excludeTexts: string[]
}

function parseSearchQuery(searchTerm: string): ParsedSearchQuery {
  const yamlQueries: YamlQuery[] = []
  const tags: string[] = []
  const textParts: string[] = []
  const excludeYamlQueries: YamlQuery[] = []
  const excludeTags: string[] = []
  const excludeTexts: string[] = []

  const tokens = searchTerm.trim().split(/\s+/)

  for (const token of tokens) {
    const isExclude = token.startsWith('-') && token.length > 1
    const actualToken = isExclude ? token.substring(1) : token

    if (actualToken.startsWith('@')) {
      const yamlTerm = actualToken.substring(1)
      const colonIndex = yamlTerm.indexOf(':')
      const targetList = isExclude ? excludeYamlQueries : yamlQueries

      if (colonIndex === -1) {
        const key = yamlTerm.trim()
        if (key) targetList.push({ type: 'key-only', key })
      } else {
        const key = yamlTerm.substring(0, colonIndex).trim()
        const value = yamlTerm.substring(colonIndex + 1).trim()

        if (!key && value) {
          targetList.push({ type: 'value-only', value })
        } else if (key && !value) {
          targetList.push({ type: 'key-only', key })
        } else if (key && value) {
          targetList.push({ type: 'key-value', key, value })
        }
      }
    } else if (actualToken.startsWith('#')) {
      const tag = actualToken.substring(1).trim()
      if (tag) {
        if (isExclude) {
          excludeTags.push(tag)
        } else {
          tags.push(tag)
        }
      }
    } else {
      if (isExclude) {
        excludeTexts.push(actualToken)
      } else {
        textParts.push(token)
      }
    }
  }

  return {
    yamlQueries,
    tags,
    text: textParts.join(' '),
    excludeYamlQueries,
    excludeTags,
    excludeTexts,
  }
}

describe("parseSearchQuery", () => {
  describe("basic text search", () => {
    test("should parse plain text", () => {
      const result = parseSearchQuery("机器学习")
      assert.deepStrictEqual(result.text, "机器学习")
      assert.deepStrictEqual(result.tags, [])
      assert.deepStrictEqual(result.yamlQueries, [])
      assert.deepStrictEqual(result.excludeTags, [])
      assert.deepStrictEqual(result.excludeTexts, [])
      assert.deepStrictEqual(result.excludeYamlQueries, [])
    })

    test("should parse multi-word text", () => {
      const result = parseSearchQuery("hello world")
      assert.deepStrictEqual(result.text, "hello world")
    })

    test("should handle empty input", () => {
      const result = parseSearchQuery("")
      assert.deepStrictEqual(result.text, "")
      assert.deepStrictEqual(result.tags, [])
    })
  })

  describe("tag search", () => {
    test("should parse single tag", () => {
      const result = parseSearchQuery("#AI")
      assert.deepStrictEqual(result.tags, ["AI"])
      assert.deepStrictEqual(result.text, "")
    })

    test("should parse multiple tags", () => {
      const result = parseSearchQuery("#AI #机器学习")
      assert.deepStrictEqual(result.tags, ["AI", "机器学习"])
      assert.deepStrictEqual(result.text, "")
    })
  })

  describe("YAML search", () => {
    test("should parse key-value YAML query", () => {
      const result = parseSearchQuery("@author:张三")
      assert.deepStrictEqual(result.yamlQueries, [{ type: 'key-value', key: 'author', value: '张三' }])
    })

    test("should parse key-only YAML query", () => {
      const result = parseSearchQuery("@status")
      assert.deepStrictEqual(result.yamlQueries, [{ type: 'key-only', key: 'status' }])
    })

    test("should parse value-only YAML query", () => {
      const result = parseSearchQuery("@:完成")
      assert.deepStrictEqual(result.yamlQueries, [{ type: 'value-only', value: '完成' }])
    })

    test("should parse multiple YAML queries", () => {
      const result = parseSearchQuery("@author:张三 @status:完成")
      assert.strictEqual(result.yamlQueries.length, 2)
      assert.deepStrictEqual(result.yamlQueries[0], { type: 'key-value', key: 'author', value: '张三' })
      assert.deepStrictEqual(result.yamlQueries[1], { type: 'key-value', key: 'status', value: '完成' })
    })
  })

  describe("compound search (mixed)", () => {
    test("should parse tags + text", () => {
      const result = parseSearchQuery("#AI 深度学习")
      assert.deepStrictEqual(result.tags, ["AI"])
      assert.deepStrictEqual(result.text, "深度学习")
    })

    test("should parse tags + YAML + text", () => {
      const result = parseSearchQuery("#AI @author:张三 深度学习")
      assert.deepStrictEqual(result.tags, ["AI"])
      assert.deepStrictEqual(result.yamlQueries, [{ type: 'key-value', key: 'author', value: '张三' }])
      assert.deepStrictEqual(result.text, "深度学习")
    })

    test("should parse multiple tags + YAML", () => {
      const result = parseSearchQuery("#AI #ML @status:完成")
      assert.deepStrictEqual(result.tags, ["AI", "ML"])
      assert.deepStrictEqual(result.yamlQueries, [{ type: 'key-value', key: 'status', value: '完成' }])
    })
  })

  describe("exclusion with -", () => {
    test("should parse exclude tag", () => {
      const result = parseSearchQuery("-#draft")
      assert.deepStrictEqual(result.excludeTags, ["draft"])
      assert.deepStrictEqual(result.tags, [])
    })

    test("should parse exclude text", () => {
      const result = parseSearchQuery("-废弃")
      assert.deepStrictEqual(result.excludeTexts, ["废弃"])
      assert.deepStrictEqual(result.text, "")
    })

    test("should parse exclude YAML key-value", () => {
      const result = parseSearchQuery("-@author:张三")
      assert.deepStrictEqual(result.excludeYamlQueries, [{ type: 'key-value', key: 'author', value: '张三' }])
      assert.deepStrictEqual(result.yamlQueries, [])
    })

    test("should parse exclude YAML key-only", () => {
      const result = parseSearchQuery("-@status")
      assert.deepStrictEqual(result.excludeYamlQueries, [{ type: 'key-only', key: 'status' }])
    })

    test("should parse mixed include and exclude tags", () => {
      const result = parseSearchQuery("#AI -#draft")
      assert.deepStrictEqual(result.tags, ["AI"])
      assert.deepStrictEqual(result.excludeTags, ["draft"])
    })

    test("should parse mixed include text and exclude text", () => {
      const result = parseSearchQuery("机器学习 -废弃")
      assert.deepStrictEqual(result.text, "机器学习")
      assert.deepStrictEqual(result.excludeTexts, ["废弃"])
    })

    test("should parse complex mixed include/exclude", () => {
      const result = parseSearchQuery("#AI @author:张三 深度学习 -#draft -废弃 -@status:archived")
      assert.deepStrictEqual(result.tags, ["AI"])
      assert.deepStrictEqual(result.yamlQueries, [{ type: 'key-value', key: 'author', value: '张三' }])
      assert.deepStrictEqual(result.text, "深度学习")
      assert.deepStrictEqual(result.excludeTags, ["draft"])
      assert.deepStrictEqual(result.excludeTexts, ["废弃"])
      assert.deepStrictEqual(result.excludeYamlQueries, [{ type: 'key-value', key: 'status', value: 'archived' }])
    })

    test("should parse multiple exclude tags", () => {
      const result = parseSearchQuery("-#draft -#archived -#private")
      assert.deepStrictEqual(result.excludeTags, ["draft", "archived", "private"])
      assert.deepStrictEqual(result.tags, [])
    })

    test("should parse multiple exclude texts", () => {
      const result = parseSearchQuery("-废弃 -过时 -删除")
      assert.deepStrictEqual(result.excludeTexts, ["废弃", "过时", "删除"])
      assert.deepStrictEqual(result.text, "")
    })

    test("should not treat lone - as exclude", () => {
      const result = parseSearchQuery("-")
      // A lone "-" has length 1, so isExclude = false, it becomes plain text
      assert.deepStrictEqual(result.text, "-")
      assert.deepStrictEqual(result.excludeTexts, [])
    })

    test("should handle pure exclusion (no include conditions)", () => {
      const result = parseSearchQuery("-#draft -@status:archived")
      assert.deepStrictEqual(result.tags, [])
      assert.deepStrictEqual(result.yamlQueries, [])
      assert.deepStrictEqual(result.text, "")
      assert.deepStrictEqual(result.excludeTags, ["draft"])
      assert.deepStrictEqual(result.excludeYamlQueries, [{ type: 'key-value', key: 'status', value: 'archived' }])
    })
  })
})
