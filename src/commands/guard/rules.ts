import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Flags} from '@oclif/core'

import {loadConfig} from '../../core/config.js'
import {GitReader} from '../../git/git.js'

export default class GuardRules extends AgentiaCommand {
  static override description = 'List the AgentGuard risk rules and the weights in effect (defaults plus agentguard.yml).'

  static override examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json']

  static override flags = {
    dir: Flags.directory({description: 'Path inside the Salesforce git repository', default: '.', exists: true}),
  }

  public async run() {
    const {flags} = await this.parse(GuardRules)
    const root = await GitReader.open(flags.dir).then((git) => git.cwd).catch(() => flags.dir)
    const {config, file} = loadConfig(root)

    const rows = Object.entries(config.rules).flatMap(([category, rules]) =>
      Object.entries(rules)
        .filter(([rule, value]) => typeof value === 'number' && !rule.endsWith('Threshold'))
        .map(([rule, score]) => ({category, max: config.weights[category as keyof typeof config.weights], rule, score: `+${score}`})),
    )

    this.display(() => {
      this.log(`Configuration: ${file ?? 'built-in defaults'}\n`)
      const host = getAgentiaHost({requires: ['format.table']})
      this.log(
        host.format.table(
          [
            {field: 'category', header: 'Category'},
            {field: 'rule', header: 'Rule'},
            {align: 'right', field: 'score', header: 'Score'},
            {align: 'right', field: 'max', header: 'Category max'},
          ],
          rows,
        ),
      )
      this.log(`\nLevels: LOW ≤ ${config.thresholds.low} < MEDIUM ≤ ${config.thresholds.medium} < HIGH ≤ ${config.thresholds.high} < CRITICAL`)
    })

    return {config, file}
  }
}
