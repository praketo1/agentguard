import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

import type {RiskCategory} from './models.js'

export interface AgentGuardConfig {
  thresholds: {low: number; medium: number; high: number}
  weights: Record<RiskCategory, number>
  rules: {
    security: {
      modifyAllData: number
      viewAllData: number
      modifyAllRecords: number
      viewAllRecords: number
      deletePermission: number
      newObjectCrud: number
      apexClassAccess: number
      fieldEdit: number
      sensitiveUserPermission: number
      sensitiveUserPermissions: string[]
      sharingRemoved: number
      withoutSharingEntryPoint: number
    }
    dependency: {
      missingDependency: number
      deletedButReferenced: number
      breakingFieldChange: number
      picklistValueRemoved: number
      dataRuleOnAutomatedObject: number
      automationOverlap: number
      highBlastRadius: number
      blastRadius: number
      sharedService: number
      highBlastRadiusThreshold: number
      sharedServiceThreshold: number
    }
    test: {
      noRelatedTest: number
      testDeleted: number
      assertionsRemoved: number
      testModified: number
      testsNotUpdated: number
      flowWithoutTest: number
      seeAllData: number
    }
    agentforce: {
      agentAffected: number
      multipleAgents: number
      agentToAgent: number
      actionImplementationChanged: number
      promptDependencyMissing: number
      promptTemplateChanged: number
      agentDefinitionChanged: number
    }
  }
  blastRadius: {
    maxDepth: number
    /** Referrers of these types are not treated as impacted (they grant access, they don't call). */
    ignoreReferrerTypes: string[]
  }
}

export const DEFAULT_CONFIG: AgentGuardConfig = {
  thresholds: {low: 30, medium: 60, high: 80},
  weights: {dependency: 30, security: 30, test: 20, agentforce: 20},
  rules: {
    security: {
      modifyAllData: 25,
      viewAllData: 15,
      modifyAllRecords: 15,
      viewAllRecords: 10,
      deletePermission: 8,
      newObjectCrud: 4,
      apexClassAccess: 5,
      fieldEdit: 2,
      sensitiveUserPermission: 8,
      sensitiveUserPermissions: [
        'AuthorApex',
        'CustomizeApplication',
        'ManageInternalUsers',
        'ManageProfilesPermissionsets',
        'ManageUsers',
        'ResetPasswords',
        'ViewSetup',
      ],
      sharingRemoved: 12,
      withoutSharingEntryPoint: 8,
    },
    dependency: {
      missingDependency: 15,
      deletedButReferenced: 15,
      breakingFieldChange: 12,
      picklistValueRemoved: 6,
      dataRuleOnAutomatedObject: 8,
      automationOverlap: 6,
      highBlastRadius: 10,
      blastRadius: 3,
      sharedService: 7,
      highBlastRadiusThreshold: 5,
      sharedServiceThreshold: 3,
    },
    test: {
      noRelatedTest: 15,
      testDeleted: 10,
      assertionsRemoved: 6,
      testModified: 4,
      testsNotUpdated: 3,
      flowWithoutTest: 3,
      seeAllData: 5,
    },
    agentforce: {
      agentAffected: 10,
      multipleAgents: 15,
      agentToAgent: 10,
      actionImplementationChanged: 8,
      promptDependencyMissing: 10,
      promptTemplateChanged: 6,
      agentDefinitionChanged: 5,
    },
  },
  blastRadius: {
    maxDepth: 5,
    ignoreReferrerTypes: ['PermissionSet', 'Profile', 'PermissionSetGroup'],
  },
}

const CONFIG_FILES = ['agentguard.yml', 'agentguard.yaml', '.agentguard.yml', '.agentguard.yaml']

export function loadConfig(repoRoot: string): {config: AgentGuardConfig; file?: string} {
  for (const name of CONFIG_FILES) {
    const file = path.join(repoRoot, name)
    if (!fs.existsSync(file)) continue
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}
    const overrides = parsed.agentguard ?? parsed
    return {config: deepMerge(DEFAULT_CONFIG, overrides), file}
  }

  return {config: structuredClone(DEFAULT_CONFIG)}
}

function deepMerge<T>(base: T, overrides: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return (overrides === undefined ? base : overrides) as T
  }

  const result: Record<string, unknown> = {...base}
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = deepMerge((base as Record<string, unknown>)[key], value)
  }

  return result as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
