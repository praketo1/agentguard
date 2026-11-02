import type {ComponentRef} from './models.js'

/** SFDX source-format folder → metadata type. `bundle` types are named by their sub-folder, not by file. */
const FOLDER_TYPES: Record<string, {type: string; bundle?: boolean}> = {
  aiAuthoringBundles: {type: 'AiAuthoringBundle', bundle: true},
  aura: {type: 'AuraDefinitionBundle', bundle: true},
  bots: {type: 'Bot', bundle: true},
  classes: {type: 'ApexClass'},
  customMetadata: {type: 'CustomMetadata'},
  customPermissions: {type: 'CustomPermission'},
  flows: {type: 'Flow'},
  flowtests: {type: 'FlowTest'},
  genAiFunctions: {type: 'GenAiFunction', bundle: true},
  genAiPlannerBundles: {type: 'GenAiPlannerBundle', bundle: true},
  genAiPlanners: {type: 'GenAiPlanner'},
  genAiPlugins: {type: 'GenAiPlugin'},
  genAiPromptTemplates: {type: 'GenAiPromptTemplate'},
  layouts: {type: 'Layout'},
  lwc: {type: 'LightningComponentBundle', bundle: true},
  objects: {type: 'CustomObject', bundle: true},
  pages: {type: 'ApexPage'},
  permissionsetgroups: {type: 'PermissionSetGroup'},
  permissionsets: {type: 'PermissionSet'},
  profiles: {type: 'Profile'},
  triggers: {type: 'ApexTrigger'},
}

const OBJECT_CHILD_TYPES: Record<string, string> = {
  fields: 'CustomField',
  listViews: 'ListView',
  recordTypes: 'RecordType',
  validationRules: 'ValidationRule',
}

export type AgentforceRole = 'agent' | 'topic' | 'action' | 'prompt'

const AGENTFORCE_ROLES: Record<string, AgentforceRole> = {
  AiAuthoringBundle: 'agent',
  Bot: 'agent',
  GenAiFunction: 'action',
  GenAiPlanner: 'agent',
  GenAiPlannerBundle: 'agent',
  GenAiPlugin: 'topic',
  GenAiPromptTemplate: 'prompt',
}

/** Types whose names are specific enough to find by token search across the repository. */
export const REFERENCEABLE_TYPES = new Set([
  'AiAuthoringBundle',
  'ApexClass',
  'ApexPage',
  'Bot',
  'CustomPermission',
  'Flow',
  'GenAiFunction',
  'GenAiPlanner',
  'GenAiPlannerBundle',
  'GenAiPlugin',
  'GenAiPromptTemplate',
  'LightningComponentBundle',
])

const CUSTOM_SUFFIX = /__(c|mdt|e|b|x)$/

/**
 * The identifier code uses to refer to a component, or undefined when it cannot be found by token search.
 * Fields are referenced by their API name (`Region__c`); standard objects (`Opportunity`) are too common to trace.
 */
export function referenceName(ref: ComponentRef): string | undefined {
  if (ref.type === 'CustomField') return ref.name.split('.')[1]
  if (ref.type === 'CustomObject') return CUSTOM_SUFFIX.test(ref.name) ? ref.name : undefined
  return REFERENCEABLE_TYPES.has(ref.type) ? ref.name : undefined
}

/** Custom schema identifiers (`Discount_Approved__c`, `Invoice__c`) used in source, excluding managed-package names. */
export function customSchemaTokens(source: string): string[] {
  const tokens = source.match(/\b[A-Za-z][A-Za-z0-9_]*__(c|mdt|e)\b/g) ?? []
  return [...new Set(tokens)].filter((token) => token.split('__').length === 2)
}

export function agentforceRole(type: string): AgentforceRole | undefined {
  return AGENTFORCE_ROLES[type]
}

export function isAgentforceType(type: string): boolean {
  return type in AGENTFORCE_ROLES
}

/**
 * Maps a repository path to its Salesforce component, or undefined when the file is not
 * source-format metadata inside one of the package directories.
 */
export function classify(filePath: string, packageDirs: string[]): ComponentRef | undefined {
  const normalized = filePath.replaceAll('\\', '/')
  if (!packageDirs.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))) return undefined

  const parts = normalized.split('/')
  const index = parts.findIndex((part) => part in FOLDER_TYPES)
  if (index === -1 || index === parts.length - 1) return undefined

  const folder = parts[index]
  const {type, bundle} = FOLDER_TYPES[folder]
  const rest = parts.slice(index + 1)

  if (folder === 'objects') {
    const objectName = rest[0]
    const childType = rest.length >= 3 ? OBJECT_CHILD_TYPES[rest[1]] : undefined
    if (childType) return {type: childType, name: `${objectName}.${baseName(rest.at(-1)!)}`, path: normalized}
    return {type, name: objectName, path: normalized}
  }

  if (bundle && rest.length > 1) return {type, name: rest[0], path: normalized}
  return {type, name: baseName(rest.at(-1)!), path: normalized}
}

/** `OpportunityService.cls-meta.xml` → `OpportunityService`; `Acc.Rec.md-meta.xml` → `Acc.Rec`. */
function baseName(fileName: string): string {
  const withoutMeta = fileName.replace(/-meta\.xml$/, '')
  const dot = withoutMeta.lastIndexOf('.')
  return dot > 0 ? withoutMeta.slice(0, dot) : withoutMeta
}

export function isApexType(type: string): boolean {
  return type === 'ApexClass' || type === 'ApexTrigger'
}

export function isApexTestSource(source: string): boolean {
  return /@isTest\b/i.test(source)
}
