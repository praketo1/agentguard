import {AgentiaCommand} from '@copado/agentia-plugin-sdk'
import {Args} from '@oclif/core'

import {AI_HOST_METHODS, tryGetHost} from '../../core/host.js'
import {buildExplainPrompt} from '../../output/explainer.js'
import {analysisFlags, analyze} from './analyze.js'

export default class GuardExplain extends AgentiaCommand {
  static override description =
    'Explain AgentGuard findings in plain language with Copado AI.\n' +
    'The AI receives only the deterministic findings; it cannot change the score.'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> SEC-001',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static override args = {
    finding: Args.string({description: 'Finding id to explain (for example SEC-001); omit to explain the whole assessment'}),
  }

  static override flags = analysisFlags

  public async run() {
    const {args, flags} = await this.parse(GuardExplain)
    const {error, host} = tryGetHost(AI_HOST_METHODS)
    if (!host) this.error(`The Agentia host is not available: ${error}`)
    if (!host.auth.status().ai.ready) this.error('Copado AI is not configured. Set up AI credentials in Agentia first.')

    const report = await this.withSpinner('Analysing change risk', () => analyze(flags, (message) => this.warn(message)))
    const findings = args.finding ? report.findings.filter((finding) => finding.id === args.finding) : report.findings
    if (args.finding && findings.length === 0) {
      this.error(`No finding ${args.finding}. Available: ${report.findings.map((finding) => finding.id).join(', ')}`)
    }

    const answer = await this.withSpinner('Asking Copado AI', () =>
      host.ai.ask({agent: 'release', prompt: buildExplainPrompt(report, findings)}),
    )

    this.display(() => {
      this.log(`Risk ${report.risk.score}/100 — ${report.risk.level}\n`)
      this.log(answer.content)
      for (const warning of answer.warnings) this.warn(warning)
    })

    return {explanation: answer.content, findings, risk: report.risk}
  }
}
