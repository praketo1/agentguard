export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type RiskCategory = 'dependency' | 'security' | 'test' | 'agentforce'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface ComponentRef {
  type: string
  name: string
  path?: string
}

export interface ChangedComponent extends ComponentRef {
  status: ChangeStatus
  /** Every changed file that belongs to this component (e.g. .cls and .cls-meta.xml). */
  files: string[]
  isTest: boolean
}

export interface Finding {
  id: string
  category: RiskCategory
  severity: Severity
  title: string
  description: string
  component?: ComponentRef
  evidence: string[]
  recommendation?: string
  score: number
}

export interface ImpactedComponent {
  component: ComponentRef
  depth: number
  /** Shortest reference chain from the changed component to this one, by component name. */
  chain: string[]
}

export interface BlastRadiusEntry {
  root: ComponentRef
  impacted: ImpactedComponent[]
}

export interface StoryContext {
  id?: string
  name?: string
  title?: string
  status?: string
  target?: string
  source: 'agentia' | 'local'
}

export interface CategoryScore {
  score: number
  max: number
}

export interface RiskAssessment {
  score: number
  level: RiskLevel
  verdict: string
  promotable: boolean
  categories: Record<RiskCategory, CategoryScore>
}

export interface RiskReport {
  story: StoryContext
  branch: string
  base: string
  changes: {
    total: number
    byType: Record<string, number>
    components: ChangedComponent[]
  }
  risk: RiskAssessment
  findings: Finding[]
  blastRadius: BlastRadiusEntry[]
  recommendations: string[]
  explanation?: string
}

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info']

export const CATEGORIES: RiskCategory[] = ['dependency', 'security', 'test', 'agentforce']

export function componentKey(ref: ComponentRef): string {
  return `${ref.type}:${ref.name}`
}

export function bySeverity(a: Pick<Finding, 'score' | 'severity'>, b: Pick<Finding, 'score' | 'severity'>): number {
  return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.score - a.score
}
