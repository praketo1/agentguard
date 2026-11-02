import type {AgentGuardConfig} from '../core/config.js'
import type {BlastRadiusEntry, ChangedComponent, Finding} from '../core/models.js'
import type {ReferenceGraph} from '../core/reference-graph.js'
import type {GitReader} from '../git/git.js'

export interface AnalysisContext {
  git: GitReader
  /** Merge-base commit: the "before" side of every comparison. */
  mergeBase: string
  changes: ChangedComponent[]
  graph: ReferenceGraph
  blastRadius: BlastRadiusEntry[]
  config: AgentGuardConfig
}

/** A finding before the pipeline assigns its id. */
export type DraftFinding = Omit<Finding, 'id'>

/** Analyzers report facts with evidence. They never decide the overall release risk. */
export interface Analyzer {
  name: string
  analyze(context: AnalysisContext): Promise<DraftFinding[]>
}
