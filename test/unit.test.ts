import {describe, expect, it} from 'vitest'

import {diffPermissions} from '../src/analyzers/security-analyzer.js'
import {DEFAULT_CONFIG} from '../src/core/config.js'
import {classify} from '../src/core/metadata-classifier.js'
import type {ChangedComponent, Finding} from '../src/core/models.js'
import {assessRisk, riskLevel} from '../src/core/risk-engine.js'
import {parseMetadata} from '../src/salesforce/xml.js'

const dirs = ['force-app']

describe('metadata classifier', () => {
  it.each([
    ['force-app/main/default/classes/OpportunityService.cls', 'ApexClass', 'OpportunityService'],
    ['force-app/main/default/classes/OpportunityService.cls-meta.xml', 'ApexClass', 'OpportunityService'],
    ['force-app/main/default/flows/Account_Update.flow-meta.xml', 'Flow', 'Account_Update'],
    ['force-app/main/default/permissionsets/Sales_Manager.permissionset-meta.xml', 'PermissionSet', 'Sales_Manager'],
    ['force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml', 'CustomField', 'Account.Rating__c'],
    ['force-app/main/default/objects/Account/Account.object-meta.xml', 'CustomObject', 'Account'],
    ['force-app/main/default/lwc/accountInsights/accountInsights.js', 'LightningComponentBundle', 'accountInsights'],
    ['force-app/main/default/genAiFunctions/GetSummary/GetSummary.genAiFunction-meta.xml', 'GenAiFunction', 'GetSummary'],
    ['force-app/main/default/genAiPlugins/Account_Intel.genAiPlugin-meta.xml', 'GenAiPlugin', 'Account_Intel'],
    ['force-app/main/default/bots/Sales_Assistant_Agent/v1.botVersion-meta.xml', 'Bot', 'Sales_Assistant_Agent'],
    ['force-app/main/default/genAiPlannerBundles/Sales_Assistant_Agent/Sales_Assistant_Agent.genAiPlannerBundle', 'GenAiPlannerBundle', 'Sales_Assistant_Agent'],
    ['force-app/main/default/customMetadata/Config.Default.md-meta.xml', 'CustomMetadata', 'Config.Default'],
  ])('%s → %s %s', (file, type, name) => {
    expect(classify(file, dirs)).toMatchObject({name, type})
  })

  it('ignores files outside package directories and non-metadata files', () => {
    expect(classify('scripts/apex/hello.apex', dirs)).toBeUndefined()
    expect(classify('force-app/main/default/README.md', dirs)).toBeUndefined()
  })
})

describe('risk engine', () => {
  const finding = (category: Finding['category'], score: number, severity: Finding['severity'] = 'medium'): Finding => ({
    category,
    description: '',
    evidence: [],
    id: 'X',
    score,
    severity,
    title: '',
  })

  it('maps scores to levels at the configured thresholds', () => {
    expect([0, 30, 31, 60, 61, 80, 81, 100].map((score) => riskLevel(score, DEFAULT_CONFIG))).toEqual([
      'LOW', 'LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'CRITICAL', 'CRITICAL',
    ])
  })

  it('caps each category at its weight', () => {
    const risk = assessRisk([finding('security', 25), finding('security', 15), finding('test', 5)], DEFAULT_CONFIG)
    expect(risk.categories.security).toEqual({max: 30, score: 30})
    expect(risk.score).toBe(35)
    expect(risk.level).toBe('MEDIUM')
    expect(risk.promotable).toBe(true)
  })

  it('escalates to CRITICAL and blocks promotion on any critical finding, whatever the score', () => {
    const risk = assessRisk([finding('dependency', 15, 'critical')], DEFAULT_CONFIG)
    expect(risk.score).toBe(15)
    expect(risk.level).toBe('CRITICAL')
    expect(risk.promotable).toBe(false)
  })

  it('is safe to promote with no findings', () => {
    expect(assessRisk([], DEFAULT_CONFIG)).toMatchObject({level: 'LOW', promotable: true, score: 0})
  })
})

describe('security rule: elevated permissions', () => {
  const change: ChangedComponent = {files: [], isTest: false, name: 'Sales_Manager', path: 'x', status: 'modified', type: 'PermissionSet'}
  const permset = (body: string) => parseMetadata(`<?xml version="1.0"?><PermissionSet xmlns="x">${body}</PermissionSet>`)
  const object = (flags: string) => `<objectPermissions><object>Account</object><allowRead>true</allowRead>${flags}</objectPermissions>`

  it('reports Modify All Records false → true as high', () => {
    const findings = diffPermissions(
      change,
      permset(object('<modifyAllRecords>false</modifyAllRecords>')),
      permset(object('<modifyAllRecords>true</modifyAllRecords>')),
      {config: DEFAULT_CONFIG},
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({evidence: ['Account.ModifyAllRecords false → true'], score: 15, severity: 'high'})
  })

  it('reports Modify All Data as critical', () => {
    const findings = diffPermissions(
      change,
      permset(''),
      permset('<userPermissions><enabled>true</enabled><name>ModifyAllData</name></userPermissions>'),
      {config: DEFAULT_CONFIG},
    )
    expect(findings[0]).toMatchObject({score: 25, severity: 'critical', title: 'Modify All Data permission added'})
  })

  it('reports nothing when access is unchanged or reduced', () => {
    const before = permset(object('<allowDelete>true</allowDelete><viewAllRecords>true</viewAllRecords>'))
    const after = permset(object('<allowDelete>false</allowDelete>'))
    expect(diffPermissions(change, before, after, {config: DEFAULT_CONFIG})).toEqual([])
  })

  it('groups new class access and editable fields into single findings', () => {
    const findings = diffPermissions(
      change,
      permset(''),
      permset(
        '<classAccesses><apexClass>A</apexClass><enabled>true</enabled></classAccesses>' +
          '<classAccesses><apexClass>B</apexClass><enabled>true</enabled></classAccesses>' +
          '<fieldPermissions><editable>true</editable><field>Account.Rating</field><readable>true</readable></fieldPermissions>',
      ),
      {config: DEFAULT_CONFIG},
    )
    expect(findings.map((finding) => finding.title)).toEqual(['Apex class access granted', 'Field edit access granted'])
    expect(findings[0].evidence).toHaveLength(2)
  })
})
