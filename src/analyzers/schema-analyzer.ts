import fs from 'node:fs'
import path from 'node:path'

import type {ChangedComponent} from '../core/models.js'
import type {RepoComponent} from '../core/reference-graph.js'
import {asArray, isTrue, parseMetadata} from '../salesforce/xml.js'
import type {AnalysisContext, Analyzer, DraftFinding} from './analyzer.js'

type Xml = Record<string, unknown>

const APEX_DML = /\b(insert|update|upsert)\s+[A-Za-z_(]|Database\.(insert|update|upsert)\s*\(/i
const SIZE_ATTRIBUTES = ['length', 'precision', 'scale', 'visibleLines']

/**
 * Schema and automation rules: changes to fields, validation rules and record-triggered automation
 * that break existing code or data even when every changed file compiles.
 */
export class SchemaAnalyzer implements Analyzer {
  name = 'schema'

  async analyze(context: AnalysisContext): Promise<DraftFinding[]> {
    const findings: DraftFinding[] = []
    for (const change of context.changes) {
      if (change.status === 'deleted') continue
      const after = parseMetadata(readFile(context.git.cwd, change.path!))
      const before = change.status === 'added' ? {} : parseMetadata(await context.git.show(context.mergeBase, change.path!))

      if (change.type === 'CustomField') {
        findings.push(...fieldChanges(change, before, after, context))
      }

      if (isNewDataRule(change, before, after)) findings.push(...dataRuleOnAutomatedObject(change, after, context))
      if (change.type === 'Flow') findings.push(...automationOverlap(change, before, after, context))
    }

    return findings
  }
}

function fieldChanges(change: ChangedComponent, before: Xml, after: Xml, context: AnalysisContext): DraftFinding[] {
  if (Object.keys(before).length === 0) return []
  const weights = context.config.rules.dependency
  const findings: DraftFinding[] = []
  const referrers = activeReferrers(change, context)
  const usedBy = referrers.map((referrer) => `Used by ${referrer.ref.type} ${referrer.ref.name}`)

  const breaking: string[] = []
  if (before.type !== after.type) breaking.push(`Type ${before.type} → ${after.type}`)
  for (const attribute of SIZE_ATTRIBUTES) {
    const was = Number(before[attribute])
    const now = Number(after[attribute])
    if (was && now && now < was) breaking.push(`${attribute} ${was} → ${now} (existing values may be truncated)`)
  }

  if (breaking.length > 0) {
    findings.push({
      category: 'dependency',
      severity: 'high',
      score: weights.breakingFieldChange,
      title: 'Breaking field change',
      description: `${change.name} changes in a way that can fail deployment or lose data, and ${referrers.length} component(s) use it.`,
      component: change,
      evidence: [...breaking, ...usedBy],
      recommendation: `Check existing ${change.name} data and every component that reads or writes it before promotion.`,
    })
  }

  const removed = [...picklistValues(before)].filter((value) => !picklistValues(after).has(value))
  if (removed.length > 0) {
    const stillUsed = referrers.flatMap((referrer) => {
      const source = context.graph.source(referrer, context.git.cwd)
      return removed
        .filter((value) => usesLiteral(source, value))
        .map((value) => `'${value}' still used in ${referrer.ref.type} ${referrer.ref.name}`)
    })
    findings.push({
      category: 'dependency',
      severity: stillUsed.length > 0 ? 'high' : 'medium',
      score: stillUsed.length > 0 ? weights.breakingFieldChange : weights.picklistValueRemoved,
      title: 'Picklist value removed',
      description:
        stillUsed.length > 0
          ? `${change.name} no longer has ${removed.join(', ')}, but code and automation still compare against it. That logic will silently stop matching.`
          : `${change.name} no longer has ${removed.join(', ')}. Existing records may still hold the removed value.`,
      component: change,
      evidence: [...removed.map((value) => `Value '${value}' removed`), ...stillUsed],
      recommendation: `Update the components that use ${removed.join(', ')}, and plan a data migration for existing records.`,
    })
  }

  return findings
}

/** A validation rule that becomes active, or a field that becomes required. */
function isNewDataRule(change: ChangedComponent, before: Xml, after: Xml): boolean {
  if (change.type === 'ValidationRule') return isTrue(after.active) && !isTrue(before.active)
  if (change.type === 'CustomField') return isTrue(after.required) && !isTrue(before.required)
  return false
}

function dataRuleOnAutomatedObject(change: ChangedComponent, after: Xml, context: AnalysisContext): DraftFinding[] {
  const object = change.name.split('.')[0]
  const writers = [...context.graph.components.values()]
    .filter((component) => !component.phantom && writesObject(component, object, context))
    .sort((a, b) => Number(a.isTest) - Number(b.isTest) || a.ref.name.localeCompare(b.ref.name))
  if (writers.length === 0) return []

  const rule = change.type === 'ValidationRule' ? `validation rule ${change.name}` : `required field ${change.name}`
  return [
    {
      category: 'dependency',
      severity: 'medium',
      score: context.config.rules.dependency.dataRuleOnAutomatedObject,
      title: `New ${change.type === 'ValidationRule' ? 'validation rule' : 'required field'} on an automated object`,
      description: `The ${rule} applies to every save of ${object}, including the ${writers.length} automation(s) and test(s) that create or update ${object} records.`,
      component: change,
      evidence: [
        ...(typeof after.errorConditionFormula === 'string' ? [`Formula: ${after.errorConditionFormula.replaceAll(/\s+/g, ' ')}`] : []),
        ...writers.map((writer) => `${writer.ref.type} ${writer.ref.name}${writer.isTest ? ' (test)' : ''} may write ${object}`),
      ],
      recommendation: `Make sure the listed automation and test data satisfy the new rule, then run all local tests before promotion.`,
    },
  ]
}

function automationOverlap(change: ChangedComponent, before: Xml, after: Xml, context: AnalysisContext): DraftFinding[] {
  const trigger = recordTrigger(after)
  if (!trigger || recordTrigger(before)?.object === trigger.object) return []

  const others = [...context.graph.components.values()].filter((component) => {
    if (component.phantom || component.ref.name === change.name) return false
    const source = context.graph.source(component, context.git.cwd)
    if (component.ref.type === 'ApexTrigger') return triggerObject(source) === trigger.object.toLowerCase()
    if (component.ref.type === 'Flow') return recordTrigger(parseMetadata(source))?.object === trigger.object
    return false
  })
  if (others.length === 0) return []

  return [
    {
      category: 'dependency',
      severity: 'medium',
      score: context.config.rules.dependency.automationOverlap,
      title: `Multiple automations on ${trigger.object}`,
      description: `New ${trigger.type} flow ${change.name} runs on ${trigger.object}, which already has ${others.length} other automation(s). Their combined order of execution decides the final record values.`,
      component: change,
      evidence: [`Flow ${change.name}: ${trigger.type} on ${trigger.object}`, ...others.map((other) => `${other.ref.type} ${other.ref.name} also runs on ${trigger.object}`)],
      recommendation: `Review the order of execution on ${trigger.object}; set a Flow Trigger Order or consolidate the logic into the existing trigger handler.`,
    },
  ]
}

function writesObject(component: RepoComponent, object: string, context: AnalysisContext): boolean {
  const {type} = component.ref
  if (type !== 'ApexClass' && type !== 'ApexTrigger' && type !== 'Flow') return false
  const source = context.graph.source(component, context.git.cwd)
  if (type === 'Flow') {
    const flow = parseMetadata(source)
    const targets = [...asArray(flow.recordCreates as Xml[]), ...asArray(flow.recordUpdates as Xml[])].map((element) => element.object)
    return targets.includes(object) || (recordTrigger(flow)?.object === object && recordTrigger(flow)?.type === 'RecordBeforeSave')
  }

  return new RegExp(`\\b${object}\\b`, 'i').test(source) && APEX_DML.test(source)
}

function recordTrigger(flow: Xml): {object: string; type: string} | undefined {
  const start = flow.start as Xml | undefined
  const type = start?.triggerType
  if (typeof start?.object !== 'string' || typeof type !== 'string' || !type.startsWith('Record')) return undefined
  return {object: start.object, type}
}

function triggerObject(source: string): string | undefined {
  return /\btrigger\s+\w+\s+on\s+(\w+)/i.exec(source)?.[1].toLowerCase()
}

function picklistValues(field: Xml): Set<string> {
  const definition = (field.valueSet as Xml | undefined)?.valueSetDefinition as Xml | undefined
  return new Set(asArray(definition?.value as Xml[]).map((value) => String(value.fullName)))
}

function usesLiteral(source: string, value: string): boolean {
  const escaped = value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`'${escaped}'|"${escaped}"|>${escaped}<`).test(source)
}

function activeReferrers(change: ChangedComponent, context: AnalysisContext): RepoComponent[] {
  const ignored = context.config.blastRadius.ignoreReferrerTypes
  return context.graph.directReferrers(change).filter((referrer) => !referrer.phantom && !ignored.includes(referrer.ref.type))
}

function readFile(root: string, file: string): string | undefined {
  const full = path.join(root, file)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined
}
