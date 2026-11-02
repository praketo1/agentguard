import {AgentiaCommand} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'

import {resolveHostContext} from '../../core/context.js'
import {AI_HOST_METHODS, ANALYZE_HOST_METHODS, tryGetHost} from '../../core/host.js'
import type {RiskReport} from '../../core/models.js'
import {runAnalysis} from '../../core/pipeline.js'
import {renderConsoleReport} from '../../output/console-reporter.js'
import {buildExplainPrompt} from '../../output/explainer.js'

export const analysisFlags = {
  base: Flags.string({char: 'b', description: 'Base branch to compare against (defaults to the story base branch, then main/master)'}),
  depth: Flags.integer({char: 'd', description: 'Maximum blast-radius depth', min: 1, max: 10}),
  dir: Flags.directory({description: 'Path inside the Salesforce git repository', default: '.', exists: true}),
  story: Flags.string({char: 's', description: 'User story Id or name (defaults to the active story)'}),
  target: Flags.string({char: 't', description: 'Target environment name shown in the report'}),
}

export default class GuardAnalyze extends AgentiaCommand {
  static override description =
    'Assess the risk and blast radius of the current Salesforce change before promotion.\n' +
    'Compares the working tree with the base branch, traces downstream dependencies (Apex, Flows, Agentforce), ' +
    'checks permission elevation and related tests, and returns a deterministic risk score.'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --base main --target UAT',
    '<%= config.bin %> <%= command.id %> --explain',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --fail-on high',
  ]

  static override flags = {
    ...analysisFlags,
    explain: Flags.boolean({char: 'e', description: 'Ask Copado AI to explain the findings (uses AI quota)'}),
    'fail-on': Flags.string({description: 'Exit with code 1 when the risk level is at or above this level', options: ['low', 'medium', 'high', 'critical']}),
    verbose: Flags.boolean({char: 'v', description: 'Show informational findings and all evidence'}),
  }

  public async run(): Promise<RiskReport> {
    const {flags} = await this.parse(GuardAnalyze)
    const report = await this.withSpinner('Analysing change risk', () => analyze(flags, (message) => this.warn(message)))

    if (flags.explain) {
      const {error, host} = tryGetHost(AI_HOST_METHODS)
      if (!host?.auth.status().ai.ready) {
        this.warn(`Copado AI is not available${error ? ` (${error})` : ''}; skipping explanation. Configure AI credentials in Agentia to enable it.`)
      } else {
        const answer = await this.withSpinner('Asking Copado AI to explain the findings', () =>
          host.ai.ask({agent: 'release', prompt: buildExplainPrompt(report)}),
        )
        report.explanation = answer.content
      }
    }

    this.display(() => this.log(renderConsoleReport(report, {verbose: flags.verbose})))

    const levels = ['low', 'medium', 'high', 'critical']
    if (flags['fail-on'] && levels.indexOf(report.risk.level.toLowerCase()) >= levels.indexOf(flags['fail-on'])) {
      process.exitCode = 1
    }

    return report
  }
}

export async function analyze(
  flags: {base?: string; depth?: number; dir: string; story?: string; target?: string},
  warn: (message: string) => void,
): Promise<RiskReport> {
  const {host} = tryGetHost(ANALYZE_HOST_METHODS)
  const context = await resolveHostContext(host, flags.story)
  for (const warning of context.warnings) warn(warning)

  return runAnalysis({
    baseCandidates: [flags.base, context.baseBranch],
    cwd: flags.dir,
    maxDepth: flags.depth,
    story: context.story,
    target: flags.target,
  })
}
