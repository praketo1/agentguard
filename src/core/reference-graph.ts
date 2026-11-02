import fs from 'node:fs'
import path from 'node:path'

import {asArray, parseMetadata, tagValues} from '../salesforce/xml.js'
import {REFERENCEABLE_TYPES, classify, isApexTestSource} from './metadata-classifier.js'
import {type ComponentRef, type ImpactedComponent, componentKey} from './models.js'

export interface RepoComponent {
  ref: ComponentRef
  files: string[]
  isTest: boolean
  /** True for components deleted by the change: they only exist so their referrers can be found. */
  phantom: boolean
}

export interface UnresolvedReference {
  from: ComponentRef
  name: string
  expectedType: string
  via: string
}

const MIN_NAME_LENGTH = 4
const SCANNED_EXTENSIONS = /\.(cls|trigger|xml|js|ts|html|page|component|cmp|json|genAiPlannerBundle|agent)$/
/** Metadata XML files, including planner bundles, which have no -meta.xml suffix. */
const METADATA_XML = /(-meta\.xml|\.genAiPlannerBundle)$/

/** GenAiFunction `invocationTargetType` → the metadata type the target must exist as. */
const INVOCATION_TARGET_TYPES: Record<string, string> = {
  apex: 'ApexClass',
  flow: 'Flow',
  generatePromptResponse: 'GenAiPromptTemplate',
}

/**
 * Reverse-reference graph over the repository: for every component, which other components mention it.
 * References are found by identifier matching, plus explicit Agentforce/Flow wiring that must resolve.
 */
export class ReferenceGraph {
  readonly components = new Map<string, RepoComponent>()
  readonly unresolved: UnresolvedReference[] = []
  private readonly referrers = new Map<string, Set<string>>()
  private readonly nameIndex = new Map<string, string[]>()

  static build(repoRoot: string, packageDirs: string[], deleted: ComponentRef[] = []): ReferenceGraph {
    const graph = new ReferenceGraph()
    for (const dir of packageDirs) {
      for (const file of walk(path.join(repoRoot, dir))) {
        const relative = path.relative(repoRoot, file).replaceAll('\\', '/')
        const ref = classify(relative, packageDirs)
        if (ref) graph.addFile(ref, relative)
      }
    }

    for (const ref of deleted) {
      const key = componentKey(ref)
      if (!graph.components.has(key)) graph.components.set(key, {ref, files: [], isTest: false, phantom: true})
    }

    graph.indexNames()
    graph.linkReferences(repoRoot)
    return graph
  }

  get(ref: ComponentRef): RepoComponent | undefined {
    return this.components.get(componentKey(ref))
  }

  /** Components whose name matches, case-insensitively, optionally restricted to some types. */
  findByName(name: string, types?: string[]): RepoComponent[] {
    return (this.nameIndex.get(name.toLowerCase()) ?? [])
      .map((key) => this.components.get(key)!)
      .filter((component) => !types || types.includes(component.ref.type))
  }

  directReferrers(ref: ComponentRef): RepoComponent[] {
    return [...(this.referrers.get(componentKey(ref)) ?? [])].map((key) => this.components.get(key)!)
  }

  /** Breadth-first walk up the referrer edges, keeping the shortest chain to each impacted component. */
  blastRadius(root: ComponentRef, maxDepth: number, ignoreTypes: string[] = []): ImpactedComponent[] {
    const rootKey = componentKey(root)
    const visited = new Set([rootKey])
    const impacted: ImpactedComponent[] = []
    let frontier = [{key: rootKey, chain: [root.name]}]

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: typeof frontier = []
      for (const {key, chain} of frontier) {
        for (const referrerKey of [...(this.referrers.get(key) ?? [])].sort()) {
          if (visited.has(referrerKey)) continue
          visited.add(referrerKey)
          const referrer = this.components.get(referrerKey)!
          if (referrer.isTest || ignoreTypes.includes(referrer.ref.type)) continue
          // A Bot and its planner bundle share a name; show it once in the chain.
          const referrerChain = chain.at(-1) === referrer.ref.name ? chain : [...chain, referrer.ref.name]
          impacted.push({component: referrer.ref, depth, chain: referrerChain})
          next.push({key: referrerKey, chain: referrerChain})
        }
      }

      frontier = next
    }

    return impacted
  }

  private addFile(ref: ComponentRef, file: string): void {
    const key = componentKey(ref)
    const existing = this.components.get(key)
    if (existing) existing.files.push(file)
    else this.components.set(key, {ref: {...ref, path: file}, files: [file], isTest: false, phantom: false})
  }

  private indexNames(): void {
    for (const [key, component] of this.components) {
      if (!REFERENCEABLE_TYPES.has(component.ref.type) || component.ref.name.length < MIN_NAME_LENGTH) continue
      const name = component.ref.name.toLowerCase()
      this.nameIndex.set(name, [...(this.nameIndex.get(name) ?? []), key])
    }
  }

  private linkReferences(repoRoot: string): void {
    for (const [key, component] of this.components) {
      if (component.phantom) continue
      const tokens = new Set<string>()
      for (const file of component.files) {
        if (!SCANNED_EXTENSIONS.test(file)) continue
        const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
        if (/\.(cls|trigger)$/.test(file) && isApexTestSource(source)) component.isTest = true
        for (const token of identifiers(stripComments(file, source))) tokens.add(token.toLowerCase())
        if (METADATA_XML.test(file)) this.collectExplicitReferences(component, source)
      }

      if (component.ref.type === 'FlowTest') component.isTest = true

      for (const token of tokens) {
        for (const targetKey of this.nameIndex.get(token) ?? []) {
          if (targetKey !== key) this.addEdge(targetKey, key)
        }
      }
    }
  }

  private collectExplicitReferences(component: RepoComponent, xml: string): void {
    const expect = (name: string | undefined, expectedType: string, via: string) => {
      // Namespaced names (`Ns__Action`) are standard or managed-package components outside the repo.
      if (!name || name.includes('__')) return
      if (this.findByName(name, [expectedType]).some((target) => !target.phantom)) return
      if (this.findByName(name).some((target) => target.phantom)) return // reported as deleted-but-referenced
      this.unresolved.push({from: component.ref, name, expectedType, via})
    }

    switch (component.ref.type) {
      case 'GenAiFunction': {
        const targetType = INVOCATION_TARGET_TYPES[tagValues(xml, 'invocationTargetType')[0] ?? '']
        if (targetType) expect(tagValues(xml, 'invocationTarget')[0], targetType, 'invocationTarget')
        break
      }

      case 'GenAiPlugin': {
        for (const name of tagValues(xml, 'functionName')) expect(name, 'GenAiFunction', 'functionName')
        break
      }

      case 'GenAiPlanner':
      case 'GenAiPlannerBundle': {
        for (const name of tagValues(xml, 'genAiPluginName')) expect(name, 'GenAiPlugin', 'genAiPluginName')
        break
      }

      case 'Flow': {
        for (const call of asArray(parseMetadata(xml).actionCalls as Record<string, string>[])) {
          if (call.actionType === 'apex') expect(call.actionName, 'ApexClass', 'actionCalls')
          if (call.actionType === 'generatePromptResponse') expect(call.actionName, 'GenAiPromptTemplate', 'actionCalls')
        }

        break
      }
    }
  }

  private addEdge(referenced: string, referrer: string): void {
    const set = this.referrers.get(referenced) ?? new Set()
    set.add(referrer)
    this.referrers.set(referenced, set)
  }
}

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

function stripComments(file: string, source: string): string {
  if (!/\.(cls|trigger|js|ts)$/.test(file)) return source
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/.*$/gm, ' ')
}

function identifiers(source: string): string[] {
  return source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
}
