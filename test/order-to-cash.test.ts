import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

// @ts-expect-error plain JS demo scripts
import {write} from '../demo/create-demo-repo.mjs'
// @ts-expect-error plain JS demo scripts
import {createOrderToCashRepo, fixFiles} from '../demo/order-to-cash.mjs'
import {sharingMode} from '../src/analyzers/security-analyzer.js'
import {customSchemaTokens} from '../src/core/metadata-classifier.js'
import type {Finding, RiskReport} from '../src/core/models.js'
import {runAnalysis} from '../src/core/pipeline.js'

let root: string
let report: RiskReport

beforeAll(async () => {
  root = createOrderToCashRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-o2c-')))
  report = await runAnalysis({baseCandidates: ['main'], cwd: root})
})

afterAll(() => {
  fs.rmSync(root, {force: true, recursive: true})
})

const find = (title: string): Finding => {
  const finding = report.findings.find((candidate) => candidate.title === title)
  expect(finding, `finding "${title}"`).toBeDefined()
  return finding!
}

describe('order-to-cash story (no Agentforce)', () => {
  it('is CRITICAL and not promotable, with no Agentforce risk', () => {
    expect(report.risk).toMatchObject({level: 'CRITICAL', promotable: false})
    expect(report.risk.categories.agentforce.score).toBe(0)
    expect(report.changes.components.find((c) => c.name === 'Opportunity.Legacy_Region_Code__c')?.status).toBe('deleted')
  })

  it('flags the deleted field that Apex and a Flow still use', () => {
    expect(find('Deleted component is still referenced')).toMatchObject({
      evidence: expect.arrayContaining([
        'ApexClass RegionRoutingService → Opportunity.Legacy_Region_Code__c',
        'Flow Opportunity_Region_Assignment → Opportunity.Legacy_Region_Code__c',
      ]),
      severity: 'critical',
    })
  })

  it('flags the field the new code needs but the story does not contain', () => {
    expect(find('Missing dependency: Discount_Approved__c').evidence).toEqual([
      'ApexClass DiscountApprovalService → Discount_Approved__c: not found',
      'ValidationRule Opportunity.Discount_Requires_Approval → Discount_Approved__c: not found',
    ])
  })

  it('flags a removed picklist value that code and flows still compare against', () => {
    const finding = find('Picklist value removed')
    expect(finding.severity).toBe('high')
    expect(finding.evidence).toEqual(expect.arrayContaining(["Value 'LATAM' removed", "'LATAM' still used in Flow Opportunity_Region_Assignment"]))
  })

  it('flags sharing removed from a service and a new user-callable class without sharing', () => {
    expect(find('Sharing enforcement removed').evidence).toEqual(['InvoiceService: with sharing → without sharing'])
    expect(find('User-callable class runs without sharing').component?.name).toBe('DiscountApprovalService')
  })

  it('flags a validation rule on an object that automation and tests write to', () => {
    const finding = find('New validation rule on an automated object')
    expect(finding.evidence).toEqual(expect.arrayContaining(['ApexClass OpportunityServiceTest (test) may write Opportunity']))
  })

  it('flags a new record-triggered flow on an object that already has a trigger', () => {
    expect(find('Multiple automations on Opportunity').evidence).toContain('ApexTrigger OpportunityTrigger also runs on Opportunity')
  })

  it('flags SeeAllData and removed assertions in the modified test', () => {
    expect(find('Test uses SeeAllData=true').component?.name).toBe('InvoiceServiceTest')
    expect(find('Test assertions removed').evidence).toEqual(['Assertions: 3 → 2'])
  })

  it('traces the deleted field to its consumers in the blast radius', () => {
    const entry = report.blastRadius.find((candidate) => candidate.root.name === 'Opportunity.Legacy_Region_Code__c')!
    expect(entry.impacted.map((item) => item.component.name).sort()).toEqual(['Opportunity_Region_Assignment', 'RegionRoutingService'])
  })
})

describe('order-to-cash remediation', () => {
  it('drops to LOW once the fix is applied', async () => {
    write(root, fixFiles)
    const fixed = await runAnalysis({baseCandidates: ['main'], cwd: root})
    expect(fixed.risk).toMatchObject({level: 'LOW', promotable: true})
    expect(fixed.findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical')).toEqual([])
  })
})

describe('helpers', () => {
  it.each([
    ['public with sharing class A {}', 'with'],
    ['public without sharing class A {}', 'without'],
    ['global inherited sharing class A {}', 'inherited'],
    ['public class A { private without sharing class B {} }', 'none'],
    ['// public with sharing class Old\npublic class A {}', 'none'],
  ])('sharingMode(%s) = %s', (source, mode) => {
    expect(sharingMode(source)).toBe(mode)
  })

  it('extracts custom schema names but not managed-package names', () => {
    expect(customSchemaTokens('opp.Discount_Approved__c; Invoice__c inv; ns__Thing__c; Region__c; Region__c')).toEqual([
      'Discount_Approved__c', 'Invoice__c', 'Region__c',
    ])
  })
})
