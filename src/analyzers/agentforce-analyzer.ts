import {agentforceRole, isAgentforceType} from '../core/metadata-classifier.js'
import {type ImpactedComponent, componentKey} from '../core/models.js'
import type {AnalysisContext, Analyzer, DraftFinding} from './analyzer.js'

const ROLE_LABELS = {action: 'Agent Action', agent: 'Agent', prompt: 'Prompt Template', topic: 'Topic'}

/** Rule 4 — Agentforce components (agents, topics, actions, prompts) reached by the change. */
export class AgentforceAnalyzer implements Analyzer {
  name = 'agentforce'

  async analyze({blastRadius, changes, config, graph}: AnalysisContext): Promise<DraftFinding[]> {
    const weights = config.rules.agentforce
    const findings: DraftFinding[] = []

    // A Bot and its planner bundle usually share a name: count agents by name, not by metadata component.
    const agentNames = new Set<string>()
    const reached = new Map<string, ImpactedComponent>()
    const chains: string[] = []
    for (const {impacted} of blastRadius) {
      for (const item of impacted) {
        if (!isAgentforceType(item.component.type)) continue
        if (agentforceRole(item.component.type) === 'agent') agentNames.add(item.component.name)
        chains.push(item.chain.join(' → '))
        const key = componentKey(item.component)
        if (!reached.has(key) || item.depth < reached.get(key)!.depth) reached.set(key, item)
      }
    }

    for (const change of changes) {
      if (change.status !== 'deleted' && agentforceRole(change.type) === 'agent') agentNames.add(change.name)
    }

    if (reached.size > 0 || agentNames.size > 0) {
      const agents = [...agentNames].sort()
      const multiple = agents.length > 1
      findings.push({
        category: 'agentforce',
        severity: agents.length > 0 ? 'high' : 'medium',
        score: multiple ? weights.multipleAgents : agents.length === 1 ? weights.agentAffected : weights.actionImplementationChanged,
        title: multiple ? `${agents.length} agents affected` : agents.length === 1 ? 'Agent affected' : 'Agentforce components affected',
        description: `This change reaches ${describeCounts([...reached.values()])}${agents.length > 0 ? ` (agents: ${agents.join(', ')})` : ''}. An apparently small change alters how AI agents behave.`,
        evidence: longestChains(chains),
        recommendation: `Re-test the affected agent conversations${agents.length > 0 ? ` (${agents.join(', ')})` : ''} in Agent Builder or with agent tests before promotion.`,
      })
    }

    for (const {root} of blastRadius) {
      const actions = graph.directReferrers(root).filter((referrer) => referrer.ref.type === 'GenAiFunction')
      if (actions.length === 0 || isAgentforceType(root.type)) continue
      findings.push({
        category: 'agentforce',
        severity: 'medium',
        score: weights.actionImplementationChanged,
        title: 'Agent Action implementation changed',
        description: `${root.name} directly implements ${actions.length} Agent Action(s). Inputs, outputs and error handling must stay compatible with the action definition.`,
        component: root,
        evidence: actions.map((action) => `GenAiFunction ${action.ref.name} → invocationTarget ${root.name}`),
        recommendation: `Check that ${root.name}'s @InvocableMethod signature still matches the action's input and output schema.`,
      })
    }

    for (const item of reached.values()) {
      if (agentforceRole(item.component.type) !== 'agent') continue
      const upstreamAgents = item.chain
        .slice(0, -1)
        .filter((name) => name !== item.component.name && graph.findByName(name).some((c) => agentforceRole(c.ref.type) === 'agent'))
      if (upstreamAgents.length === 0) continue
      findings.push({
        category: 'agentforce',
        severity: 'high',
        score: weights.agentToAgent,
        title: 'Agent-to-agent dependency',
        description: `Agent ${item.component.name} depends on agent ${upstreamAgents.join(', ')}, so the change cascades across agents.`,
        component: item.component,
        evidence: [item.chain.join(' → ')],
        recommendation: 'Test the downstream agent after validating the upstream one.',
      })
    }

    for (const change of changes) {
      if (change.status === 'deleted' || !isAgentforceType(change.type)) continue
      const prompt = change.type === 'GenAiPromptTemplate'
      findings.push({
        category: 'agentforce',
        severity: 'medium',
        score: prompt ? weights.promptTemplateChanged : weights.agentDefinitionChanged,
        title: prompt ? 'Prompt template changed' : `${ROLE_LABELS[agentforceRole(change.type)!]} definition ${change.status}`,
        description: prompt
          ? `Prompt template ${change.name} changed. Generated responses may differ for every agent and flow that uses it.`
          : `${change.type} ${change.name} is ${change.status}. Instructions, scope or routing of the agent may change.`,
        component: change,
        evidence: change.files.map((file) => `${file} ${change.status}`),
        recommendation: prompt
          ? `Compare responses from ${change.name} before and after the change on representative records.`
          : `Run the agent test conversations that exercise ${change.name}.`,
      })
    }

    for (const missing of graph.unresolved) {
      if (missing.expectedType !== 'GenAiPromptTemplate') continue
      findings.push({
        category: 'agentforce',
        severity: 'high',
        score: weights.promptDependencyMissing,
        title: `Prompt template dependency missing: ${missing.name}`,
        description: `${missing.from.type} ${missing.from.name} uses prompt template ${missing.name}, which is not in the repository or this change.`,
        component: missing.from,
        evidence: [`${missing.from.name} (${missing.via}) → ${missing.name}: not found`],
        recommendation: `Add GenAiPromptTemplate ${missing.name} to the user story, or confirm it exists in the target environment.`,
      })
    }

    return findings
  }
}

function describeCounts(items: ImpactedComponent[]): string {
  const names: Record<string, Set<string>> = {}
  for (const item of items) {
    const role = agentforceRole(item.component.type)!
    names[role] = (names[role] ?? new Set()).add(item.component.name)
  }

  const parts = (['action', 'topic', 'prompt', 'agent'] as const)
    .filter((role) => names[role])
    .map((role) => `${names[role].size} ${ROLE_LABELS[role]}${names[role].size > 1 ? 's' : ''}`)
  return parts.length > 0 ? parts.join(', ') : 'Agentforce metadata'
}

/** Unique chains that are not a prefix of a longer one, longest first. */
function longestChains(chains: string[]): string[] {
  const unique = [...new Set(chains)]
  return unique
    .filter((chain) => !unique.some((other) => other !== chain && other.startsWith(`${chain} → `)))
    .sort((a, b) => b.length - a.length)
}
