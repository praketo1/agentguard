import {XMLParser} from 'fast-xml-parser'

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
})

/** Parses metadata XML and returns the root element's children, e.g. the `<PermissionSet>` body. */
export function parseMetadata(xml: string | undefined): Record<string, unknown> {
  if (!xml) return {}
  const doc = parser.parse(xml) as Record<string, unknown>
  const rootKey = Object.keys(doc).find((key) => key !== '?xml')
  const root = rootKey ? doc[rootKey] : undefined
  return typeof root === 'object' && root !== null ? (root as Record<string, unknown>) : {}
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

export function isTrue(value: unknown): boolean {
  return value === true || value === 'true'
}

/** Text content of every `<tag>` element in raw XML, in document order. */
export function tagValues(xml: string, tag: string): string[] {
  const values: string[] = []
  const pattern = new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, 'g')
  for (const match of xml.matchAll(pattern)) values.push(match[1])
  return values
}
