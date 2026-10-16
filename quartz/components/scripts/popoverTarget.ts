/** Query parameters select content; fragments only select scroll position. */
export function popoverTarget(href: string) {
  const url = new URL(href)
  const hash = decodeURIComponent(url.hash)
  url.hash = ""
  return { url, hash, id: `popover-${encodeURIComponent(url.href)}` }
}
