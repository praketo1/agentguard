import fs from 'node:fs'
import path from 'node:path'

import type {GitReader} from '../git/git.js'
import {classify, isApexTestSource} from './metadata-classifier.js'
import {type ChangedComponent, componentKey} from './models.js'

export function readPackageDirs(repoRoot: string): string[] {
  try {
    const project = JSON.parse(fs.readFileSync(path.join(repoRoot, 'sfdx-project.json'), 'utf8'))
    const dirs = (project.packageDirectories ?? []).map((dir: {path: string}) => dir.path.replace(/\/$/, ''))
    if (dirs.length > 0) return dirs
  } catch {
    // No sfdx-project.json: fall back to the SFDX default.
  }

  return ['force-app']
}

/** Groups changed files into Salesforce components and works out each component's overall status. */
export async function detectChanges(git: GitReader, base: string, packageDirs: string[]): Promise<ChangedComponent[]> {
  const mergeBase = await git.mergeBase(base)
  const byKey = new Map<string, ChangedComponent & {statuses: Set<string>}>()

  for (const change of await git.changedFiles(base)) {
    const ref = classify(change.path, packageDirs)
    if (!ref) continue
    const key = componentKey(ref)
    let entry = byKey.get(key)
    if (!entry) {
      entry = {...ref, files: [], isTest: false, status: 'modified', statuses: new Set()}
      byKey.set(key, entry)
    }

    entry.files.push(change.path)
    entry.statuses.add(change.status)
  }

  const components: ChangedComponent[] = []
  for (const {statuses, ...component} of byKey.values()) {
    if (statuses.size === 1 && statuses.has('added')) component.status = 'added'
    else if (statuses.size === 1 && statuses.has('deleted')) component.status = 'deleted'
    else if (statuses.has('renamed')) component.status = 'renamed'

    const source = component.files.find((file) => /\.(cls|trigger)$/.test(file))
    if (source) {
      const content =
        component.status === 'deleted' ? await git.show(mergeBase, source) : readIfExists(path.join(git.cwd, source))
      component.isTest = isApexTestSource(content ?? '')
    }

    component.path = source ?? component.files[0]
    components.push(component)
  }

  return components.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
}

function readIfExists(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
}
