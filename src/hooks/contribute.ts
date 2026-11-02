import {defineContributions} from '@copado/agentia-plugin-sdk'

/** Offers the AgentGuard skill to `agentia setup skills`, so coding agents know when to run it. */
export default async function contribute() {
  return defineContributions({
    apiVersion: 1,
    skills: [{files: [{path: 'skills/agentia-guard/SKILL.md'}], id: 'guard'}],
  })
}
