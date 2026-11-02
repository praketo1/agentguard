import {type AgentiaPluginHost, type HostMethodPath, getAgentiaHost} from '@copado/agentia-plugin-sdk'

/** Keep in sync with "agentia.requires" in package.json. */
export const ANALYZE_HOST_METHODS: HostMethodPath[] = ['workspace.current', 'work.getWorkItem', 'pipeline.get']
export const AI_HOST_METHODS: HostMethodPath[] = ['auth.status', 'ai.ask']

/** The Agentia host, or undefined when it is unavailable (for example an older CLI). */
export function tryGetHost(requires: HostMethodPath[]): {host?: AgentiaPluginHost; error?: string} {
  try {
    return {host: getAgentiaHost({requires})}
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)}
  }
}
