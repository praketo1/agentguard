import type {Analyzer, DraftFinding} from '../analyzers/analyzer.js'
import {AgentforceAnalyzer} from '../analyzers/agentforce-analyzer.js'
import {DependencyAnalyzer} from '../analyzers/dependency-analyzer.js'
import {SchemaAnalyzer} from '../analyzers/schema-analyzer.js'
import {SecurityAnalyzer} from '../analyzers/security-analyzer.js'
import {TestAnalyzer} from '../analyzers/test-analyzer.js'
import {GitReader} from '../git/git.js'
import {detectChanges, readPackageDirs} from './change-detector.js'
import {loadConfig} from './config.js'
import {type BlastRadiusEntry, type Finding, type RiskCategory, type RiskReport, type StoryContext, bySeverity} from './models.js'
import {ReferenceGraph} from './reference-graph.js'
import {assessRisk} from './risk-engine.js'

export interface AnalyzeOptions {
  cwd: string
  /** Base branch candidates in priority order; the first that exists is used. */
  baseCandidates: Array<string | undefined>
  story?: StoryContext
  target?: string
  maxDepth?: number
}

export const ANALYZERS: Analyzer[] = [
  new SecurityAnalyzer(),
  new DependencyAnalyzer(),
  new SchemaAnalyzer(),
  new TestAnalyzer(),
  new AgentforceAnalyzer(),
]

const ID_PREFIXES: Record<RiskCategory, string> = {agentforce: 'AF', dependency: 'DEP', security: 'SEC', test: 'TEST'}

/** Command → change detector → reference graph → analyzers → Finding[] → risk engine → report. */
export async function runAnalysis(options: AnalyzeOptions): Promise<RiskReport> {
  const git = await GitReader.open(options.cwd)
  const base = await git.resolveBase([...options.baseCandidates, 'main', 'master'])
  if (!base) throw new Error('Could not find a base branch to compare against. Pass one with --base.')

  const {config} = loadConfig(git.cwd)
  if (options.maxDepth) config.blastRadius.maxDepth = options.maxDepth
  const packageDirs = readPackageDirs(git.cwd)
  const mergeBase = await git.mergeBase(base)
  const changes = await detectChanges(git, base, packageDirs)

  const graph = ReferenceGraph.build(git.cwd, packageDirs, changes.filter((change) => change.status === 'deleted'))
  const blastRadius: BlastRadiusEntry[] = changes
    .filter((change) => !change.isTest)
    .map((change) => ({
      root: {type: change.type, name: change.name, path: change.path},
      impacted: graph.blastRadius(change, config.blastRadius.maxDepth, config.blastRadius.ignoreReferrerTypes),
    }))

  const context = {blastRadius, changes, config, git, graph, mergeBase}
  const drafts: DraftFinding[] = []
  for (const analyzer of ANALYZERS) drafts.push(...(await analyzer.analyze(context)))
  const findings = assignIds(drafts)
  const risk = assessRisk(findings, config)

  const byType: Record<string, number> = {}
  for (const change of changes) byType[change.type] = (byType[change.type] ?? 0) + 1

  return {
    base,
    blastRadius: blastRadius.filter((entry) => entry.impacted.length > 0),
    branch: await git.currentBranch(),
    changes: {byType, components: changes, total: changes.length},
    findings,
    recommendations: recommendations(findings),
    risk,
    story: {...(options.story ?? {source: 'local'}), target: options.target ?? options.story?.target},
  }
}

function assignIds(drafts: DraftFinding[]): Finding[] {
  const counters: Partial<Record<RiskCategory, number>> = {}
  return [...drafts].sort(bySeverity).map((draft) => {
    const next = (counters[draft.category] ?? 0) + 1
    counters[draft.category] = next
    return {id: `${ID_PREFIXES[draft.category]}-${String(next).padStart(3, '0')}`, ...draft}
  })
}

function recommendations(findings: Finding[]): string[] {
  const unique = new Set<string>()
  for (const finding of findings) {
    if (finding.recommendation && finding.score > 0) unique.add(finding.recommendation)
  }

  return [...unique, 'Re-run agentia guard analyze after remediation.']
}
