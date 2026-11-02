import fs from 'node:fs'
import path from 'node:path'

import {isApexType} from '../core/metadata-classifier.js'
import {componentKey} from '../core/models.js'
import type {AnalysisContext, Analyzer, DraftFinding} from './analyzer.js'

const ASSERTION = /\b(System\.assert\w*|Assert\.\w+)\s*\(/gi

/** Rule 3 — related Apex/Flow tests for changed code, and weakened or deleted tests. */
export class TestAnalyzer implements Analyzer {
  name = 'test'

  async analyze({changes, config, git, graph, mergeBase}: AnalysisContext): Promise<DraftFinding[]> {
    const weights = config.rules.test
    const findings: DraftFinding[] = []
    const changedKeys = new Set(changes.map((change) => componentKey(change)))

    for (const change of changes) {
      if (change.status === 'deleted' || change.isTest) continue

      if (isApexType(change.type)) {
        const tests = relatedTests(graph, change.name)
        if (tests.length === 0) {
          findings.push({
            category: 'test',
            severity: 'high',
            score: weights.noRelatedTest,
            title: 'No related Apex test found',
            description: `${change.type} ${change.name} changed, and no @IsTest class references it.`,
            component: change,
            evidence: [`Searched @IsTest classes referencing ${change.name} and ${change.name}Test / ${change.name}_Test`],
            recommendation: `Add or extend a test class covering ${change.name} before promotion.`,
          })
          continue
        }

        const updated = tests.filter((test) => changedKeys.has(componentKey({type: 'ApexClass', name: test})))
        findings.push({
          category: 'test',
          severity: updated.length > 0 ? 'info' : 'low',
          score: updated.length > 0 ? 0 : weights.testsNotUpdated,
          title: updated.length > 0 ? 'Related tests identified' : 'Related tests not updated',
          description:
            updated.length > 0
              ? `${change.name} changed and ${updated.join(', ')} was updated in the same change.`
              : `${change.name} changed but none of its ${tests.length} related test class(es) changed with it.`,
          component: change,
          evidence: tests.map((test) => `${test} references ${change.name}`),
          recommendation: `Run: sf apex run test --tests ${tests.join(' --tests ')} --result-format human`,
        })
      }

      if (change.type === 'Flow' && !graph.directReferrers(change).some((referrer) => referrer.ref.type === 'FlowTest')) {
        findings.push({
          category: 'test',
          severity: 'low',
          score: weights.flowWithoutTest,
          title: 'Flow changed without a Flow test',
          description: `Flow ${change.name} changed and no FlowTest in the repository references it.`,
          component: change,
          evidence: [`No flowtests/*.flowtest-meta.xml references ${change.name}`],
          recommendation: `Add a Flow test or a manual test step for ${change.name}.`,
        })
      }
    }

    for (const change of changes) {
      if (!change.isTest || change.type !== 'ApexClass') continue
      if (change.status === 'deleted') {
        findings.push({
          category: 'test',
          severity: 'high',
          score: weights.testDeleted,
          title: 'Test class deleted',
          description: `Test class ${change.name} is deleted, which can drop coverage below the deployment threshold.`,
          component: change,
          evidence: [`${change.path} deleted`],
          recommendation: `Confirm the coverage of ${change.name} is replaced elsewhere.`,
        })
        continue
      }

      if (change.status === 'added') continue
      const before = countAssertions(await git.show(mergeBase, change.path!))
      const after = countAssertions(readFile(git.cwd, change.path!))
      const weakened = after < before
      findings.push({
        category: 'test',
        severity: weakened ? 'medium' : 'low',
        score: weakened ? weights.assertionsRemoved : weights.testModified,
        title: weakened ? 'Test assertions removed' : 'Test class modified',
        description: weakened
          ? `${change.name} now has ${after} assertion(s), down from ${before}. The test may no longer catch regressions.`
          : `${change.name} was modified in this change.`,
        component: change,
        evidence: [`Assertions: ${before} → ${after}`],
        recommendation: weakened ? `Review why assertions were removed from ${change.name}.` : `Review the test changes in ${change.name}.`,
      })
    }

    return findings
  }
}

function relatedTests(graph: AnalysisContext['graph'], name: string): string[] {
  const tests = new Set<string>()
  for (const referrer of graph.directReferrers({type: 'ApexClass', name})) {
    if (referrer.isTest && referrer.ref.type === 'ApexClass') tests.add(referrer.ref.name)
  }

  for (const candidate of [`${name}Test`, `${name}_Test`, `${name}Tests`, `Test${name}`]) {
    for (const match of graph.findByName(candidate, ['ApexClass'])) if (!match.phantom) tests.add(match.ref.name)
  }

  return [...tests].sort()
}

export function countAssertions(source: string | undefined): number {
  return source?.match(ASSERTION)?.length ?? 0
}

function readFile(root: string, file: string): string | undefined {
  const full = path.join(root, file)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined
}
