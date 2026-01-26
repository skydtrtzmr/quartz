import { GlobalConfiguration } from "../cfg"
import { ValidLocale } from "../i18n"
import { QuartzPluginData } from "../plugins/vfile"

interface Props {
  date: Date
  locale?: ValidLocale
}

export type ValidDateType = keyof Required<QuartzPluginData>["dates"]

export function getDate(cfg: GlobalConfiguration, data: QuartzPluginData): Date | undefined {
  if (!cfg.defaultDateType) {
    throw new Error(
      `Field 'defaultDateType' was not set in the configuration object of quartz.config.ts. See https://quartz.jzhao.xyz/configuration#general-configuration for more details.`,
    )
  }
  return data.dates?.[cfg.defaultDateType]
}

export function formatDate(d: Date, locale: ValidLocale = "en-US"): string {
  // 检查是否为午夜0点（没有设置具体时间）
  const isDateOnly = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0

  if (isDateOnly) {
    // 只显示日期
    return d.toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    })
  } else {
    // 显示日期+时间
    return d.toLocaleString(locale, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false, // 使用24小时制
    })
  }
}

export function Date({ date, locale }: Props) {
  return <time datetime={date.toISOString()}>{formatDate(date, locale)}</time>
}
