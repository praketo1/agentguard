import {type ImpactedComponent, componentKey} from '../core/models.js'
import type {AnalysisContext, Analyzer, DraftFinding} from './analyzer.js'

/** Rule 2 — blast radius, shared services, and references that will not resolve after deployment. */
export class DependencyAnalyzer implements Analyzer {
  name = 'dependency'

  async analyze({blastRadius, changes, config, graph}: AnalysisContext): Promise<DraftFinding[]> {
    const weights = config.rules.dependency
    const findings: DraftFinding[] = []

    for (const change of changes) {
      if (change.status !== 'deleted') continue
      const referrers = graph.directReferrers(change).filter((referrer) => !referrer.phantom)
      if (referrers.length === 0) continue
      findings.push({
        category: 'dependency',
        severity: 'critical',
        score: weights.deletedButReferenced,
        title: 'Deleted component is still referenced',
        description: `${change.type} ${change.name} is deleted, but ${referrers.length} component(s) still reference it. Deployment will fail or break at runtime.`,
        component: change,
        evidence: referrers.map((referrer) => `${referrer.ref.type} ${referrer.ref.name} → ${change.name}`),
        recommendation: `Remove the references to ${change.name} or keep the component.`,
      })
    }

    // Prompt templates are reported by the Agentforce analyzer.
    const changedKeys = new Set(changes.map((change) => componentKey(change)))
    const impactedKeys = new Set(blastRadius.flatMap((entry) => entry.impacted.map((item) => componentKey(item.component))))
    for (const missing of graph.unresolved) {
      if (missing.expectedType === 'GenAiPromptTemplate') continue
      const key = componentKey(missing.from)
      if (!changedKeys.has(key) && !impactedKeys.has(key)) continue
      findings.push({
        category: 'dependency',
        severity: 'high',
        score: weights.missingDependency,
        title: `Missing dependency: ${missing.expectedType} ${missing.name}`,
        description: `${missing.from.type} ${missing.from.name} references ${missing.expectedType} ${missing.name}, which is neither in the repository nor in this change.`,
        component: missing.from,
        evidence: [`${missing.from.name} (${missing.via}) → ${missing.name}: not found`],
        recommendation: `Add ${missing.expectedType} ${missing.name} to the user story, or confirm it already exists in the target environment.`,
      })
    }

    for (const {root} of blastRadius) {
      const direct = graph.directReferrers(root).filter((referrer) => !referrer.isTest && !referrer.phantom)
      if (direct.length >= weights.sharedServiceThreshold) {
        findings.push({
          category: 'dependency',
          severity: 'medium',
          score: weights.sharedService,
          title: 'Shared component changed',
          description: `${root.type} ${root.name} is used directly by ${direct.length} components, so a behaviour change spreads widely.`,
          component: root,
          evidence: direct.map((referrer) => `${referrer.ref.type} ${referrer.ref.name} → ${root.name}`),
          recommendation: `Regression-test the direct consumers of ${root.name}.`,
        })
      }

    }

    // Scored once over the whole change, so overlapping chains from related components are not double counted.
    const unchangedImpacted = new Map<string, ImpactedComponent>()
    for (const {impacted} of blastRadius) {
      for (const item of impacted) {
        const key = componentKey(item.component)
        if (changedKeys.has(key)) continue
        const known = unchangedImpacted.get(key)
        if (!known || item.depth < known.depth) unchangedImpacted.set(key, item)
      }
    }

    if (unchangedImpacted.size > 0) {
      const impacted = [...unchangedImpacted.values()].sort((a, b) => a.depth - b.depth)
      const high = impacted.length >= weights.highBlastRadiusThreshold
      const roots = blastRadius.filter((entry) => entry.impacted.length > 0).map((entry) => entry.root.name)
      findings.push({
        category: 'dependency',
        severity: high ? 'high' : 'low',
        score: high ? weights.highBlastRadius : weights.blastRadius,
        title: high ? 'High blast radius' : 'Downstream components impacted',
        description: `This change can affect ${impacted.length} unchanged downstream component(s), up to ${impacted.at(-1)!.depth} level(s) away from ${roots.join(', ')}.`,
        evidence: impacted.map((item) => item.chain.join(' → ')),
        recommendation: 'Validate the impacted components in the blast radius before promotion.',
      })
    }

    return findings
  }
}
