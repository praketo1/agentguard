import type {Finding, RiskReport} from '../core/models.js'

/**
 * Builds the prompt for Copado AI. The AI only receives the deterministic findings and score;
 * it explains and prioritises them but must not change them.
 */
export function buildExplainPrompt(report: RiskReport, findings: Finding[] = report.findings): string {
  const facts = {
    changedComponents: report.changes.components.map((change) => `${change.type} ${change.name} (${change.status})`),
    findings: findings
      .filter((finding) => finding.severity !== 'info')
      .map(({category, component, evidence, id, recommendation, severity, title}) => ({
        category,
        component: component && `${component.type} ${component.name}`,
        evidence: evidence.slice(0, 8),
        id,
        recommendation,
        severity,
        title,
      })),
    risk: {categories: report.risk.categories, level: report.risk.level, score: report.risk.score, verdict: report.risk.verdict},
    story: report.story.name,
    target: report.story.target,
  }

  return [
    'You are a Salesforce release reviewer. AgentGuard, a deterministic analyzer, produced the facts below for a change about to be promoted.',
    'Using ONLY these facts:',
    '1. Summarise in 2-3 sentences for a release manager what this change can break and why.',
    '2. For each high or critical finding, explain the business impact in one sentence, citing its id.',
    '3. Give a prioritised remediation plan (max 5 steps).',
    'Do not change the score or level, and do not invent components, permissions or dependencies that are not listed.',
    '',
    '```json',
    JSON.stringify(facts, null, 2),
    '```',
  ].join('\n')
}
