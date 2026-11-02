import type {AgentGuardConfig} from './config.js'
import {CATEGORIES, type CategoryScore, type Finding, type RiskAssessment, type RiskCategory, type RiskLevel} from './models.js'

/** Deterministic scoring: per-category sums capped at the category weight, then mapped to a level. */
export function assessRisk(findings: Finding[], config: AgentGuardConfig): RiskAssessment {
  const categories = {} as Record<RiskCategory, CategoryScore>
  for (const category of CATEGORIES) {
    const raw = findings.filter((finding) => finding.category === category).reduce((sum, finding) => sum + finding.score, 0)
    categories[category] = {score: Math.min(raw, config.weights[category]), max: config.weights[category]}
  }

  const score = Math.min(100, Object.values(categories).reduce((sum, category) => sum + category.score, 0))
  const hasCritical = findings.some((finding) => finding.severity === 'critical')
  // A critical finding (e.g. a deleted component still in use) breaks the release whatever the total.
  const level = hasCritical ? 'CRITICAL' : riskLevel(score, config)
  const highCount = findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical').length

  let verdict: string
  let promotable: boolean
  if (level === 'CRITICAL' || level === 'HIGH' || hasCritical) {
    promotable = false
    verdict = `NOT RECOMMENDED FOR PROMOTION — ${highCount} high-risk finding(s) should be reviewed.`
  } else if (level === 'MEDIUM') {
    promotable = true
    verdict = 'REVIEW BEFORE PROMOTION — address the findings below or accept the risk explicitly.'
  } else {
    promotable = true
    verdict = 'SAFE TO PROMOTE — no significant risk detected.'
  }

  return {categories, level, promotable, score, verdict}
}

export function riskLevel(score: number, {thresholds}: AgentGuardConfig): RiskLevel {
  if (score <= thresholds.low) return 'LOW'
  if (score <= thresholds.medium) return 'MEDIUM'
  if (score <= thresholds.high) return 'HIGH'
  return 'CRITICAL'
}
