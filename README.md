# AgentGuard

**Know what your Salesforce change can break before you deploy it.**

AgentGuard is an [Agentia Headless](https://developer.copado.com/docs) CLI plugin that answers one question before promotion:

> *"What can this Salesforce change break, and is it safe to promote?"*

```sh
agentia guard analyze
```

It reads the active Copado user story, compares your branch with its base branch, traces every downstream dependency (Apex → Flows → LWC → Agent Actions → Topics → Agents), checks permission elevation and related tests, and returns a **deterministic** risk score with evidence for every finding. Copado AI can then explain the findings, but it never decides the score.

Built for the Copado Agentia Headless Hackathon.

---

## Example

A developer on `feature/US-247` changes `OpportunityService`, adds a batch class, grants Modify All on Account and adds a new agent action. It looks like a small story:

```text
AgentGuard Risk Assessment
────────────────────────────────────────────────────────
Story       US-247
Target      UAT
Branch      feature/US-247  (compared with main)
Changes     5 component(s)

CHANGE RISK                          80 / 100   HIGH

Dependency Risk                      17 / 30   ▕███████████░░░░░░░░░▏
Security Risk                        25 / 30   ▕█████████████████░░░▏
Test Risk                            18 / 20   ▕██████████████████░░▏
Agentforce Risk                      20 / 20   ▕████████████████████▏

HIGH     Modify All Records permission added  [SEC-001 · security · +15]
         PermissionSet Sales_Manager
           • Account.ModifyAllRecords false → true

HIGH     No related Apex test found  [TEST-001 · test · +15]
         ApexClass OpportunityScoringBatch

HIGH     2 agents affected  [AF-001 · agentforce · +15]
           • OpportunityService → AccountIntelligenceController → GetAccountSummary
             → Account_Intelligence → Sales_Assistant_Agent

HIGH     Prompt template dependency missing: OpportunityInsightsPrompt  [AF-002]
           • GetOpportunityInsights (invocationTarget) → OpportunityInsightsPrompt: not found

BLAST RADIUS
OpportunityService (ApexClass) — 12 impacted
  ├── AccountIntelligenceController (ApexClass)
  │   ├── GetAccountSummary (GenAiFunction)
  │   │   └── Account_Intelligence (GenAiPlugin)
  │   │       ├── Sales_Assistant_Agent (GenAiPlannerBundle)
  │   │       └── Survey_Intelligence_Agent (GenAiPlannerBundle)
  │   └── accountInsights (LightningComponentBundle)
  ├── OpportunityRollupAction (ApexClass)
  │   └── Account_Pipeline_Update (Flow)
  └── OpportunityTriggerHandler (ApexClass)
      └── OpportunityTrigger (ApexTrigger)

VERDICT
⚠ NOT RECOMMENDED FOR PROMOTION — 5 high-risk finding(s) should be reviewed.
```

After the developer removes Modify All and adds a test class, a re-run reports **40 / 100 MEDIUM**.

---

## Commands

| Command | What it does |
| --- | --- |
| `agentia guard analyze` | Full risk assessment of the current change. |
| `agentia guard analyze --json` | The same result as structured JSON, for CI, Claude/Cursor or dashboards. |
| `agentia guard analyze --explain` | Adds a plain-language explanation from Copado AI (`release` agent). |
| `agentia guard analyze --fail-on high` | Exits with code 1 at or above a risk level, so it can gate a pipeline. |
| `agentia guard explain [FINDING_ID]` | Asks Copado AI to explain the whole assessment, or one finding such as `SEC-001`. |
| `agentia guard rules` | Lists every rule and the weights in effect. |

Common flags: `--base <branch>`, `--target <env>`, `--story <US-...>`, `--depth <n>`, `--dir <path>`, `--verbose`.

---

## How it works

```text
agentia guard analyze
        │
        ├─ Agentia host: workspace.current · work.getWorkItem · pipeline.get
        │    (story, base branch, target environment; optional, falls back to git)
        ▼
Change Detector ── git diff merge-base…working tree, grouped into Salesforce components
        ▼
Reference Graph ── scans the repository, builds a reverse-reference map,
        │          and resolves explicit Agentforce/Flow wiring
        ▼
Blast Radius ──── breadth-first walk up the referrers, shortest chain per component
        ▼
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Security    │  Dependency  │    Test      │  Agentforce  │   analyzers emit Finding[]
└──────────────┴──────────────┴──────────────┴──────────────┘   (facts + evidence only)
        ▼
Risk Engine ───── per-category sums, capped (30/30/20/20) → 0–100 → LOW/MEDIUM/HIGH/CRITICAL
        ▼
Console report · JSON · optional Copado AI explanation (host.ai.ask)
```

**Design principle:** the analyzers find facts, the risk engine scores them, and the AI only explains. The score is repeatable and auditable, and every finding carries its evidence.

### Rules

| Category (max) | Rule | Score |
| --- | --- | --- |
| **Security** (30) | Modify All Data granted | +25 (critical) |
| | View All Data granted | +15 |
| | Modify All Records on an object | +15 |
| | View All Records on an object | +10 |
| | Delete on an object | +8 |
| | Sensitive system permission (ManageUsers, AuthorApex, …) | +8 |
| | Apex class access granted | +5 |
| | New object CRUD / editable fields | +4 each / +2 each |
| **Dependency** (30) | Deleted component still referenced | +15 (critical) |
| | Missing dependency (referenced, not in repo or story) | +15 |
| | High blast radius (≥ 5 unchanged components impacted) | +10 |
| | Shared component changed (≥ 3 direct consumers) | +7 |
| **Test** (20) | Changed Apex with no related `@IsTest` class | +15 |
| | Test class deleted | +10 |
| | Test assertions removed | +6 |
| | Test class modified / related tests not updated / Flow without Flow test | +4 / +3 / +3 |
| **Agentforce** (20) | Multiple agents in the blast radius | +15 |
| | One agent in the blast radius | +10 |
| | Agent-to-agent dependency | +10 |
| | Prompt template dependency missing | +10 |
| | Agent Action implementation (invocation target) changed | +8 |
| | Prompt template changed / agent, topic or action definition changed | +6 / +5 |

Levels: **LOW** ≤ 30 < **MEDIUM** ≤ 60 < **HIGH** ≤ 80 < **CRITICAL**. Any critical finding blocks promotion whatever the total.

### Configuration

Drop an `agentguard.yml` in the repository root to tune weights, thresholds and depth for your organisation. See [agentguard.example.yml](agentguard.example.yml).

### Coding-agent skill

AgentGuard contributes an `agentia-guard` skill. It tells Claude Code, Cursor and similar agents to run `agentia guard analyze --json` before promoting, never to re-estimate the score, and to re-run after remediation:

```sh
agentia setup skills create --plugin agentguard
```

---

## Try it

Requirements: Node.js ≥ 22.12, Git, and the [Agentia CLI](https://developer.copado.com/docs#setup) (`npm install -g @copado/agentia-cli`).

```sh
npm install
npm run build
agentia plugins link .

# Create the sample Agentforce repository with a risky feature branch
npm run demo -- ../agentguard-demo
cd ../agentguard-demo
agentia guard analyze --base main --target UAT
```

Without an active Copado story, AgentGuard compares against `--base` (or `main`/`master`). With one selected in Agentia, it picks up the story number, base branch and target environment automatically.

## Development

```sh
npm run build   # compile TypeScript to dist/
npm test        # vitest: rule unit tests + end-to-end runs against the demo repository
```

```text
src/
  commands/guard/   analyze · explain · rules
  core/             models · pipeline · change-detector · metadata-classifier
                    reference-graph · risk-engine · config · context · host
  analyzers/        security · dependency · test · agentforce
  output/           console-reporter · explainer (Copado AI prompt)
  git/              git.ts
  salesforce/       xml.ts
  hooks/            contribute.ts (agent skill)
skills/agentia-guard/SKILL.md
demo/create-demo-repo.mjs
test/
```

## Limitations and roadmap

- References are found by identifier matching across the repository. This is fast and metadata-agnostic, but a name that only appears in a string or comment in XML can create an extra edge. Typed parsers for more metadata types will reduce this.
- Analysis is repository-based: plugins cannot call Copado endpoints directly, so "missing dependency" means missing from the repository and the change, not from the target org.
- Next: Flow complexity and Apex static-analysis rules, code coverage from Copado test results, deployment-history signals, PR and user-story comments, automated remediation, and an HTML/graph report.

## License

MIT
