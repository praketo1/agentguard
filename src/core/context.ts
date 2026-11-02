import type {AgentiaPluginHost} from '@copado/agentia-plugin-sdk'

import type {StoryContext} from './models.js'

export interface HostContext {
  story: StoryContext
  baseBranch?: string
  warnings: string[]
}

/**
 * Reads the active Copado story, its base branch and promotion target from Agentia.
 * Every call is optional: without a Copado login the analysis still runs on plain git.
 */
export async function resolveHostContext(host: AgentiaPluginHost | undefined, storyId?: string): Promise<HostContext> {
  const story: StoryContext = {source: 'local'}
  const warnings: string[] = []
  if (!host) return {story, warnings}

  let baseBranch: string | undefined
  try {
    const workspace = await host.workspace.current()
    baseBranch = workspace.baseBranch
    Object.assign(story, {id: workspace.workItemId, name: workspace.workItemName, title: workspace.workItemTitle})
  } catch (error) {
    warnings.push(`Could not read the Agentia workspace: ${message(error)}`)
  }

  const id = storyId ?? story.id
  if (!id) return {baseBranch, story, warnings}

  try {
    const item = await host.work.getWorkItem(id)
    Object.assign(story, {id: item.id, name: item.name, source: 'agentia', status: item.status, title: item.title})
    baseBranch ??= item.baseBranch
    if (item.pipelineId) {
      const pipeline = await host.pipeline.get(item.pipelineId)
      const connection = pipeline.connections?.find((c) => c.sourceEnvironment?.name === item.sourceEnvironmentName)
      story.target = connection?.destinationEnvironment?.name
    }
  } catch (error) {
    warnings.push(`Could not read user story ${id}: ${message(error)}`)
  }

  return {baseBranch, story, warnings}
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
