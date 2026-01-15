import { styleText } from "util"
import process from "process"
import { isMainThread } from "workerpool"

const rootFile = /.*at file:/

// 自定义错误类，用于在 API 模式下传递格式化的错误信息
export class QuartzError extends Error {
  constructor(
    message: string,
    public readonly originalError: Error,
    public readonly formattedMessage: string,
  ) {
    super(message)
    this.name = "QuartzError"
    // 保留原始堆栈
    this.stack = originalError.stack
  }
}

export function trace(msg: string, err: Error) {
    // 如果已经是 QuartzError，直接重新抛出，避免重复包装
  if (err instanceof QuartzError) {
    throw err
  }
  let stack = err.stack ?? ""

  const lines: string[] = []

  lines.push("")
  lines.push(
    "\n" +
      styleText(["bgRed", "black", "bold"], " ERROR ") +
      "\n\n" +
      styleText("red", ` ${msg}`) +
      (err.message.length > 0 ? `: ${err.message}` : ""),
  )

  let reachedEndOfLegibleTrace = false
  for (const line of stack.split("\n").slice(1)) {
    if (reachedEndOfLegibleTrace) {
      break
    }

    if (!line.includes("node_modules")) {
      lines.push(` ${line}`)
      if (rootFile.test(line)) {
        reachedEndOfLegibleTrace = true
      }
    }
  }

  const traceMsg = lines.join("\n")
  if (!isMainThread) {
    // gather lines and throw
    // worker 线程：抛出格式化的错误消息
    throw new Error(traceMsg)
  } else {
    // 主线程
    if (globalThis.__QUARTZ_API_MODE__) {
      // API 模式：抛出自定义错误对象，包含原始错误和格式化消息
      throw new QuartzError(err.message, err, traceMsg)
    } else {
      // 普通模式：打印并退出
      console.error(traceMsg)
      process.exit(1)
    }
  }
}
