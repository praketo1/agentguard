import fs from 'node:fs'
import path from 'node:path'

import type {ChangedComponent, ComponentRef, Severity} from '../core/models.js'
import {asArray, isTrue, parseMetadata} from '../salesforce/xml.js'
import type {AnalysisContext, Analyzer, DraftFinding} from './analyzer.js'

type Entry = Record<string, string>

const OBJECT_FLAGS = ['allowCreate', 'allowRead', 'allowEdit', 'allowDelete', 'viewAllRecords', 'modifyAllRecords']

const FLAG_LABELS: Record<string, string> = {
  allowCreate: 'Create',
  allowDelete: 'Delete',
  allowEdit: 'Edit',
  allowRead: 'Read',
  modifyAllRecords: 'ModifyAllRecords',
  viewAllRecords: 'ViewAllRecords',
}

/** Rule 1 — compares Permission Sets and Profiles against the base branch and reports elevated access. */
export class SecurityAnalyzer implements Analyzer {
  name = 'security'

  async analyze(context: AnalysisContext): Promise<DraftFinding[]> {
    const findings: DraftFinding[] = []
    for (const change of context.changes) {
      if (change.type === 'ApexClass' && !change.isTest && change.status !== 'deleted') {
        const before = change.status === 'added' ? undefined : await context.git.show(context.mergeBase, change.path!)
        findings.push(...sharingChanges(change, before, readFile(context.git.cwd, change.path!) ?? '', context))
        continue
      }

      if (change.type !== 'PermissionSet' && change.type !== 'Profile') continue
      if (change.status === 'deleted') continue
      const before = parseMetadata(await context.git.show(context.mergeBase, change.path!))
      const after = parseMetadata(readFile(context.git.cwd, change.path!))
      findings.push(...diffPermissions(change, before, after, context))
    }

    return findings
  }
}

export function diffPermissions(
  change: ChangedComponent,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  {config}: Pick<AnalysisContext, 'config'>,
): DraftFinding[] {
  const weights = config.rules.security
  const component: ComponentRef = {type: change.type, name: change.name, path: change.path}
  const findings: DraftFinding[] = []
  const finding = (severity: Severity, score: number, title: string, description: string, evidence: string[], recommendation: string) =>
    findings.push({category: 'security', severity, score, title, description, component, evidence, recommendation})

  // System permissions
  const userBefore = enabledSet(before.userPermissions, 'name')
  const newUserPermissions = [...enabledSet(after.userPermissions, 'name')].filter((name) => !userBefore.has(name))
  for (const name of newUserPermissions) {
    if (name === 'ModifyAllData') {
      finding('critical', weights.modifyAllData, 'Modify All Data permission added',
        `${change.type} ${change.name} now grants Modify All Data, which bypasses sharing and CRUD on every object.`,
        ['ModifyAllData false → true'],
        'Remove Modify All Data unless an administrator-level grant is explicitly approved.')
    } else if (name === 'ViewAllData') {
      finding('high', weights.viewAllData, 'View All Data permission added',
        `${change.type} ${change.name} now grants read access to every record in the org.`,
        ['ViewAllData false → true'],
        'Confirm org-wide read access is required, or scope it with object-level View All instead.')
    } else if (weights.sensitiveUserPermissions.includes(name)) {
      finding('medium', weights.sensitiveUserPermission, `Sensitive system permission added: ${name}`,
        `${change.type} ${change.name} now grants the ${name} system permission.`,
        [`${name} false → true`],
        `Confirm ${name} is intentionally granted to everyone assigned ${change.name}.`)
    }
  }

  // Object permissions
  const objectsBefore = keyed(before.objectPermissions, 'object')
  const crudGrants: string[] = []
  for (const [object, entry] of keyed(after.objectPermissions, 'object')) {
    const previous = objectsBefore.get(object)
    const granted = OBJECT_FLAGS.filter((flag) => isTrue(entry[flag]) && !isTrue(previous?.[flag]))
    const describe = (flag: string) => `${object}.${FLAG_LABELS[flag]} ${previous ? 'false' : 'absent'} → true`
    // Salesforce requires View All and Delete alongside Modify All: one decision, scored once.
    const modifyAll = granted.includes('modifyAllRecords')
    for (const flag of granted) {
      const evidence = [describe(flag)]
      if (flag === 'modifyAllRecords') {
        finding('high', weights.modifyAllRecords, 'Modify All Records permission added',
          `Users with ${change.name} can view, edit and delete every ${object} record regardless of sharing.`,
          [...evidence, ...granted.filter((other) => other === 'viewAllRecords' || other === 'allowDelete').map(describe)],
          `Confirm Modify All on ${object} is intentionally required; prefer Read/Edit with sharing rules.`)
      } else if (modifyAll && (flag === 'viewAllRecords' || flag === 'allowDelete')) {
        continue
      } else if (flag === 'viewAllRecords') {
        finding('medium', weights.viewAllRecords, 'View All Records permission added',
          `Users with ${change.name} can read every ${object} record regardless of sharing.`,
          evidence,
          `Confirm View All on ${object} is required; sharing rules may be enough.`)
      } else if (flag === 'allowDelete') {
        finding('medium', weights.deletePermission, 'Delete permission added',
          `Users with ${change.name} can now delete ${object} records they have access to.`,
          evidence,
          `Confirm delete access on ${object} is part of the story's requirements.`)
      } else {
        crudGrants.push(evidence[0])
      }
    }
  }

  if (crudGrants.length > 0) {
    finding('low', Math.min(crudGrants.length * weights.newObjectCrud, 12), 'New object access granted',
      `${change.type} ${change.name} grants ${crudGrants.length} new object permission(s).`,
      crudGrants,
      'Review that each new object permission maps to a requirement in the story.')
  }

  // Apex class access
  const classesBefore = enabledSet(before.classAccesses, 'apexClass')
  const newClasses = [...enabledSet(after.classAccesses, 'apexClass')].filter((name) => !classesBefore.has(name))
  if (newClasses.length > 0) {
    finding('low', weights.apexClassAccess, 'Apex class access granted',
      `${change.type} ${change.name} grants access to ${newClasses.length} additional Apex class(es).`,
      newClasses.map((name) => `classAccess ${name} → enabled`),
      'Check that these classes enforce sharing and CRUD/FLS, since users can now invoke them.')
  }

  // Field-level security
  const fieldsBefore = keyed(before.fieldPermissions, 'field')
  const editableFields = [...keyed(after.fieldPermissions, 'field')]
    .filter(([field, entry]) => isTrue(entry.editable) && !isTrue(fieldsBefore.get(field)?.editable))
    .map(([field]) => field)
  if (editableFields.length > 0) {
    finding('low', Math.min(editableFields.length * weights.fieldEdit, 10), 'Field edit access granted',
      `${change.type} ${change.name} makes ${editableFields.length} field(s) editable.`,
      editableFields.map((field) => `${field}.editable → true`),
      'Confirm the new editable fields are expected for this persona.')
  }

  return findings
}

const ENTRY_POINT = /@AuraEnabled|@InvocableMethod|@RestResource|\bwebservice\s/i

/** Sharing keyword of the outer class: `with`, `without`, `inherited`, or `none` (runs in the caller's mode). */
export function sharingMode(source: string): string {
  const declaration = /\b(?:(with|without|inherited)\s+sharing\s+)?class\s+\w+/i.exec(source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))
  return declaration?.[1]?.toLowerCase() ?? 'none'
}

export function sharingChanges(
  change: ChangedComponent,
  before: string | undefined,
  after: string,
  {config}: Pick<AnalysisContext, 'config'>,
): DraftFinding[] {
  const weights = config.rules.security
  const component: ComponentRef = {type: change.type, name: change.name, path: change.path}
  const was = before === undefined ? undefined : sharingMode(before)
  const now = sharingMode(after)

  if (was === 'with' && now !== 'with') {
    return [{
      category: 'security',
      severity: 'high',
      score: weights.sharingRemoved,
      title: 'Sharing enforcement removed',
      description: `${change.name} no longer declares "with sharing", so its queries and DML can reach records the running user cannot see.`,
      component,
      evidence: [`${change.name}: with sharing → ${now === 'none' ? 'no sharing keyword' : `${now} sharing`}`],
      recommendation: `Keep "with sharing" on ${change.name}; if one operation must bypass sharing, isolate it in a small inner "without sharing" class.`,
    }]
  }

  if (now === 'without' && was !== 'without' && ENTRY_POINT.test(after)) {
    return [{
      category: 'security',
      severity: 'medium',
      score: weights.withoutSharingEntryPoint,
      title: 'User-callable class runs without sharing',
      description: `${change.name} is callable from LWC, Flow or the API and runs "without sharing", so any user who can call it bypasses record-level security.`,
      component,
      evidence: [`${change.name}: ${was ?? 'new class'} → without sharing`, ...(after.match(ENTRY_POINT) ?? []).map((match) => `Entry point: ${match.trim()}`)],
      recommendation: `Use "with sharing" (or "inherited sharing") on ${change.name} unless bypassing sharing is an explicit requirement.`,
    }]
  }

  return []
}

function keyed(value: unknown, keyField: string): Map<string, Entry> {
  return new Map(asArray(value as Entry | Entry[]).map((entry) => [entry[keyField], entry]))
}

function enabledSet(value: unknown, keyField: string): Set<string> {
  return new Set(asArray(value as Entry | Entry[]).filter((entry) => isTrue(entry.enabled)).map((entry) => entry[keyField]))
}

function readFile(root: string, file: string): string | undefined {
  const full = path.join(root, file)
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined
}
