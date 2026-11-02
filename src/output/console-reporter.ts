import {CATEGORIES, type RiskLevel, type RiskReport, type Severity} from '../core/models.js'

const RULE = '─'.repeat(56)
const useColor = process.stdout.isTTY && !process.env.NO_COLOR

const CODES = {bold: 1, cyan: 36, dim: 2, green: 32, magenta: 35, red: 31, yellow: 33}
function paint(color: keyof typeof CODES, text: string): string {
  return useColor ? `\u001B[${CODES[color]}m${text}\u001B[0m` : text
}

const SEVERITY_COLORS: Record<Severity, keyof typeof CODES> = {
  critical: 'magenta',
  high: 'red',
  info: 'dim',
  low: 'cyan',
  medium: 'yellow',
}

const LEVEL_COLORS: Record<RiskLevel, keyof typeof CODES> = {CRITICAL: 'magenta', HIGH: 'red', LOW: 'green', MEDIUM: 'yellow'}

const CATEGORY_LABELS = {agentforce: 'Agentforce Risk', dependency: 'Dependency Risk', security: 'Security Risk', test: 'Test Risk'}

/** Renders the report as a terminal-friendly risk assessment. */
export function renderConsoleReport(report: RiskReport, {verbose = false} = {}): string {
  const lines: string[] = []
  const add = (...text: string[]) => lines.push(...text)
  const row = (label: string, value: string) => add(`${label.padEnd(36)}${value}`)

  add(paint('bold', 'AgentGuard Risk Assessment'), RULE, '')
  if (report.story.name) add(`Story       ${report.story.name}${report.story.title ? ` — ${report.story.title}` : ''}`)
  if (report.story.target) add(`Target      ${report.story.target}`)
  add(`Branch      ${report.branch}  (compared with ${report.base})`, `Changes     ${report.changes.total} component(s)`)
  for (const [type, count] of Object.entries(report.changes.byType).sort()) add(`              ${String(count).padStart(2)}  ${type}`)
  add('')

  const {risk} = report
  row(paint('bold', 'CHANGE RISK'), `${String(risk.score).padStart(3)} / 100   ${paint(LEVEL_COLORS[risk.level], paint('bold', risk.level))}`)
  add('')
  for (const category of CATEGORIES) {
    const {max, score} = risk.categories[category]
    row(CATEGORY_LABELS[category], `${String(score).padStart(3)} / ${max}   ${bar(score, max)}`)
  }

  const visible = report.findings.filter((finding) => verbose || finding.severity !== 'info')
  if (visible.length > 0) add('', paint('bold', 'FINDINGS'), RULE)
  for (const finding of visible) {
    add('')
    add(`${paint(SEVERITY_COLORS[finding.severity], finding.severity.toUpperCase().padEnd(9))}${paint('bold', finding.title)}  ${paint('dim', `[${finding.id} · ${finding.category} · +${finding.score}]`)}`)
    if (finding.component) add(`         ${finding.component.type} ${finding.component.name}`)
    add(`         ${finding.description}`)
    for (const evidence of finding.evidence.slice(0, verbose ? undefined : 6)) add(paint('dim', `           • ${evidence}`))
    if (!verbose && finding.evidence.length > 6) add(paint('dim', `           … ${finding.evidence.length - 6} more (use --verbose)`))
  }

  if (report.blastRadius.length > 0) {
    add('', paint('bold', 'BLAST RADIUS'), RULE)
    for (const {root, impacted} of report.blastRadius) {
      add('', `${paint('bold', root.name)} ${paint('dim', `(${root.type}) — ${impacted.length} impacted`)}`)
      add(...renderTree(impacted.map((item) => ({chain: item.chain, type: item.component.type}))))
    }
  }

  add('', paint('bold', 'VERDICT'), RULE, '')
  add(paint(risk.promotable ? (risk.level === 'LOW' ? 'green' : 'yellow') : 'red', `${risk.promotable ? '✔' : '⚠'} ${risk.verdict}`))
  if (risk.level !== 'LOW') {
    add('', 'Recommended actions:')
    const shown = verbose ? report.recommendations : [...report.recommendations.slice(0, 6), report.recommendations.at(-1)!]
    shown.forEach((recommendation, index) => add(`  ${index + 1}. ${recommendation}`))
    if (shown.length < report.recommendations.length) add(paint('dim', `  … ${report.recommendations.length - shown.length} more (use --verbose or --json)`))
  }

  if (report.explanation) add('', paint('bold', 'AI EXPLANATION (Copado AI)'), RULE, '', report.explanation)
  return lines.join('\n')
}

function bar(score: number, max: number): string {
  const width = 20
  const filled = max === 0 ? 0 : Math.round((score / max) * width)
  return paint('dim', '▕') + '█'.repeat(filled) + paint('dim', '░'.repeat(width - filled) + '▏')
}

interface TreeNode {
  name: string
  type?: string
  children: Map<string, TreeNode>
}

/** Turns shortest-path chains into an indented tree under the changed component. */
function renderTree(chains: Array<{chain: string[]; type: string}>): string[] {
  const root: TreeNode = {children: new Map(), name: ''}
  for (const {chain, type} of chains) {
    let node = root
    for (const name of chain.slice(1)) {
      if (!node.children.has(name)) node.children.set(name, {children: new Map(), name})
      node = node.children.get(name)!
    }

    node.type ??= type
  }

  const lines: string[] = []
  const visit = (node: TreeNode, prefix: string) => {
    const children = [...node.children.values()]
    children.forEach((child, index) => {
      const last = index === children.length - 1
      lines.push(`${prefix}${last ? '└── ' : '├── '}${child.name} ${paint('dim', `(${child.type ?? '?'})`)}`)
      visit(child, prefix + (last ? '    ' : '│   '))
    })
  }

  visit(root, '  ')
  return lines
}
