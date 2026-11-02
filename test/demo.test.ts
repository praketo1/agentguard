import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

// @ts-expect-error plain JS demo script
import {createDemoRepo} from '../demo/create-demo-repo.mjs'
import type {RiskReport} from '../src/core/models.js'
import {runAnalysis} from '../src/core/pipeline.js'

const CLASSES = 'force-app/main/default/classes'

let root: string

beforeEach(() => {
  root = createDemoRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-')))
})

afterEach(() => {
  fs.rmSync(root, {force: true, recursive: true})
})

const analyze = () => runAnalysis({baseCandidates: ['main'], cwd: root})
const titles = (report: RiskReport) => report.findings.map((finding) => finding.title)
const write = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content)
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('demo scenario: feature/US-247', () => {
  it('detects the changed components', async () => {
    const report = await analyze()
    expect(report.branch).toBe('feature/US-247')
    expect(report.changes.components.map((c) => `${c.type}:${c.name}:${c.status}`)).toEqual([
      'ApexClass:OpportunityScoringBatch:added',
      'ApexClass:OpportunityService:modified',
      'GenAiFunction:GetOpportunityInsights:added',
      'GenAiPlugin:Account_Intelligence:modified',
      'PermissionSet:Sales_Manager:modified',
    ])
  })

  it('scores the change HIGH and blocks promotion', async () => {
    const report = await analyze()
    expect(report.risk).toMatchObject({level: 'HIGH', promotable: false, score: 70})
    expect(report.risk.categories).toEqual({
      agentforce: {max: 20, score: 20},
      dependency: {max: 30, score: 17},
      security: {max: 30, score: 15},
      test: {max: 20, score: 18},
    })
  })

  it('reports one finding per rule with evidence', async () => {
    const report = await analyze()
    expect(titles(report)).toEqual(
      expect.arrayContaining([
        'Modify All Records permission added',
        'High blast radius',
        'No related Apex test found',
        '2 agents affected',
        'Prompt template dependency missing: OpportunityInsightsPrompt',
      ]),
    )
    for (const finding of report.findings) expect(finding.evidence.length).toBeGreaterThan(0)
    expect(new Set(report.findings.map((finding) => finding.id)).size).toBe(report.findings.length)
  })

  it('traces OpportunityService up to both agents', async () => {
    const report = await analyze()
    const agents = report.findings.find((finding) => finding.category === 'agentforce' && finding.title.includes('agents affected'))!
    expect(agents.evidence).toContain(
      'OpportunityService → AccountIntelligenceController → GetAccountSummary → Account_Intelligence → Sales_Assistant_Agent',
    )
    const radius = report.blastRadius.find((entry) => entry.root.name === 'OpportunityService')!
    expect(radius.impacted.map((item) => item.component.name)).toEqual(
      expect.arrayContaining(['OpportunityTriggerHandler', 'OpportunityTrigger', 'Account_Pipeline_Update', 'accountInsights']),
    )
    // Tests and permission sets are not part of the blast radius.
    expect(radius.impacted.map((item) => item.component.type)).not.toContain('PermissionSet')
    expect(radius.impacted.map((item) => item.component.name)).not.toContain('OpportunityServiceTest')
  })

  it('identifies the related test for OpportunityService', async () => {
    const report = await analyze()
    const related = report.findings.find((f) => f.component?.name === 'OpportunityService' && f.category === 'test')!
    expect(related.recommendation).toContain('--tests OpportunityServiceTest')
  })
})

describe('remediation', () => {
  it('lowers the score after fixing the findings', async () => {
    const before = await analyze()
    const permset = 'force-app/main/default/permissionsets/Sales_Manager.permissionset-meta.xml'
    write(permset, read(permset).replaceAll('<modifyAllRecords>true', '<modifyAllRecords>false').replaceAll('<viewAllRecords>true', '<viewAllRecords>false').replaceAll('<allowDelete>true', '<allowDelete>false'))
    write(`${CLASSES}/OpportunityScoringBatchTest.cls`, '@IsTest\nprivate class OpportunityScoringBatchTest {\n    @IsTest static void runs() { Database.executeBatch(new OpportunityScoringBatch()); System.assert(true); }\n}\n')
    write(
      'force-app/main/default/genAiPromptTemplates/OpportunityInsightsPrompt.genAiPromptTemplate-meta.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<GenAiPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata">\n    <developerName>OpportunityInsightsPrompt</developerName>\n</GenAiPromptTemplate>\n',
    )

    const after = await analyze()
    expect(after.risk.score).toBeLessThan(before.risk.score)
    expect(after.risk.categories.security.score).toBe(0)
    expect(titles(after)).not.toContain('No related Apex test found')
    expect(titles(after)).not.toContain('Prompt template dependency missing: OpportunityInsightsPrompt')
  })
})

describe('other rules', () => {
  it('flags a deleted class that a flow still calls as critical', async () => {
    fs.rmSync(path.join(root, CLASSES, 'OpportunityRollupAction.cls'))
    fs.rmSync(path.join(root, CLASSES, 'OpportunityRollupAction.cls-meta.xml'))
    const report = await analyze()
    const deleted = report.findings.find((finding) => finding.title === 'Deleted component is still referenced')!
    expect(deleted).toMatchObject({severity: 'critical'})
    expect(deleted.evidence).toContain('Flow Account_Pipeline_Update → OpportunityRollupAction')
    expect(report.risk.promotable).toBe(false)
  })

  it('flags removed test assertions', async () => {
    const test = `${CLASSES}/OpportunityServiceTest.cls`
    write(test, read(test).replace(/\s*System\.assertEquals\(100, opp\.Probability\);/, ''))
    const report = await analyze()
    expect(report.findings.find((finding) => finding.title === 'Test assertions removed')?.evidence).toEqual(['Assertions: 2 → 1'])
  })

  it('reports LOW with no findings when nothing changed', async () => {
    execFileSync('git', ['checkout', '-q', 'main'], {cwd: root})
    const report = await analyze()
    expect(report.changes.total).toBe(0)
    expect(report.risk).toMatchObject({level: 'LOW', promotable: true, score: 0})
  })
})

describe('modify all', () => {
  it('folds the required View All and Delete grants into one finding', async () => {
    const report = await analyze()
    const security = report.findings.filter((finding) => finding.category === 'security')
    expect(security.map((finding) => finding.title)).toEqual(['Modify All Records permission added'])
    expect(security[0].evidence).toEqual([
      'Account.ModifyAllRecords false → true',
      'Account.Delete false → true',
      'Account.ViewAllRecords false → true',
    ])
  })
})
