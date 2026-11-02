import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const exec = promisify(execFile)

export interface FileChange {
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  path: string
  oldPath?: string
}

export class GitReader {
  constructor(public readonly cwd: string) {}

  static async open(cwd: string): Promise<GitReader> {
    const probe = new GitReader(cwd)
    const root = await probe.run(['rev-parse', '--show-toplevel']).catch(() => {
      throw new Error(`Not a git repository: ${cwd}`)
    })
    return new GitReader(root.trim())
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  }

  async refExists(ref: string): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  /** Picks the first candidate that resolves locally, also trying `origin/<candidate>`. */
  async resolveBase(candidates: Array<string | undefined>): Promise<string | undefined> {
    for (const candidate of candidates) {
      if (!candidate) continue
      if (await this.refExists(candidate)) return candidate
      if (!candidate.startsWith('origin/') && (await this.refExists(`origin/${candidate}`))) return `origin/${candidate}`
    }

    return undefined
  }

  async mergeBase(base: string): Promise<string> {
    return (await this.run(['merge-base', base, 'HEAD'])).trim()
  }

  /** Changes between the merge base and the working tree, including uncommitted and untracked files. */
  async changedFiles(base: string): Promise<FileChange[]> {
    const mergeBase = await this.mergeBase(base)
    const diff = await this.run(['diff', '--name-status', '-M', mergeBase])
    const changes: FileChange[] = []
    for (const line of diff.split('\n')) {
      if (!line.trim()) continue
      const [code, first, second] = line.split('\t')
      if (code.startsWith('R')) changes.push({status: 'renamed', path: second, oldPath: first})
      else if (code === 'A') changes.push({status: 'added', path: first})
      else if (code === 'D') changes.push({status: 'deleted', path: first})
      else changes.push({status: 'modified', path: first})
    }

    const untracked = await this.run(['ls-files', '--others', '--exclude-standard'])
    for (const file of untracked.split('\n')) {
      if (file.trim()) changes.push({status: 'added', path: file.trim()})
    }

    return changes
  }

  /** File content at `ref`, or undefined when it did not exist there. */
  async show(ref: string, file: string): Promise<string | undefined> {
    try {
      return await this.run(['show', `${ref}:${file}`])
    } catch {
      return undefined
    }
  }

  private async run(args: string[]): Promise<string> {
    const {stdout} = await exec('git', args, {cwd: this.cwd, maxBuffer: 64 * 1024 * 1024})
    return stdout
  }
}
