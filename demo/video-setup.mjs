#!/usr/bin/env node
/**
 * Prepares the two demo repositories used in the AgentGuard demo video.
 *
 *   <root>/sales-assistant  — Agentforce story on feature/US-0000025, with the AgentGuard quality gate
 *   <root>/order-to-cash    — non-Agentforce story on feature/US-0000026, plus ./apply-fix.sh and
 *                             ./validate-in-salesforce.sh (check-only deploy to the given org)
 *
 * Usage: node demo/video-setup.mjs [root] [org-alias]   (defaults: ~/agentguard-video, agnetgurarddev)
 */
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {createDemoRepo} from './create-demo-repo.mjs'
import {createOrderToCashRepo, fixFiles} from './order-to-cash.mjs'

const root = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'agentguard-video'))
const org = process.argv[3] ?? 'agnetgurarddev'
if (fs.existsSync(root)) fs.rmSync(root, {force: true, recursive: true})

const GATE = `#!/usr/bin/env bash
set -euo pipefail
# Agentia runs this during \`agentia cicd work test\` and \`agentia cicd work submit\`.
echo "## Running AgentGuard change risk analysis"
agentia guard analyze --fail-on "\${AGENTGUARD_FAIL_ON:-high}"
`

/** Adds helper files without making them part of the change AgentGuard analyses. */
function addHelpers(repo, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(repo, name)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, content)
    if (name.endsWith('.sh')) fs.chmodSync(file, 0o755)
  }

  fs.appendFileSync(path.join(repo, '.git/info/exclude'), `${Object.keys(files).map((name) => name.split('/')[0]).join('\n')}\n`)
}

const salesAssistant = createDemoRepo(path.join(root, 'sales-assistant'))
execFileSync('git', ['branch', '-m', 'feature/US-247', 'feature/US-0000025'], {cwd: salesAssistant})
addHelpers(salesAssistant, {'.agentia_quality_gates.sh': GATE})

const orderToCash = createOrderToCashRepo(path.join(root, 'order-to-cash'))
const fixHelpers = Object.fromEntries(Object.entries(fixFiles).map(([file, content]) => [`.fix/${file}`, content]))
addHelpers(orderToCash, {
  ...fixHelpers,
  '.agentia_quality_gates.sh': GATE,
  'apply-fix.sh': `#!/usr/bin/env bash
# Applies the remediation AgentGuard recommended, and commits it.
set -euo pipefail
cp -R .fix/force-app/. force-app/
git add -A force-app
git commit -qm "US-0000026: keep legacy field and LATAM, add Discount_Approved__c, restore sharing, add tests"
echo "Fix committed:"
git show --stat --format="  %s" HEAD | tail -n +2
`,
  'validate-in-salesforce.sh': `#!/usr/bin/env bash
# Check-only deploy of this branch to ${org}, with local tests. Nothing is saved in the org.
set -uo pipefail
D=force-app/main/default
sf project deploy start --dry-run -o ${org} -d $D/classes -d $D/triggers -d $D/flows -d $D/lwc -d $D/objects -d $D/permissionsets \\
  --test-level RunLocalTests --wait 20 --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result||{};const d=r.details||{};const t=d.runTestResult||{};
console.log("Salesforce check-only deploy: "+r.status+(t.numTestsRun?"  ("+t.numTestsRun+" tests, "+t.numFailures+" failures)":""));
for(const f of [].concat(d.componentFailures||[]))console.log("  ✗ "+f.componentType+" "+f.fullName+": "+f.problem)})'
`,
})

console.log(`Video repositories ready in ${root}:
  ${salesAssistant}  (branch feature/US-0000025)
  ${orderToCash}  (branch feature/US-0000026)`)
