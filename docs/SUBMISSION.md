# Hackathon submission: form answers

Paste each block into the matching field. Character counts are checked against the form limits.

## Submission title (max 200)

<!-- field:title -->
AgentGuard: a deterministic change-risk and blast-radius gate for Salesforce releases, built as an Agentia Headless plugin
<!-- /field -->

## Problem statement (max 2000)

<!-- field:problem -->
Salesforce releases rarely fail because of the component a developer changed. They fail because of what depends on it. Deleting an "unused" field breaks an Apex class and a Flow. Removing a picklist value silently breaks logic that still compares against it. A new Apex class references a field nobody added to the user story. A service quietly loses "with sharing". A new validation rule blocks the automation and tests that save the same object.

Agentforce makes this harder: an agent depends on topics, actions, Apex, Flows and prompt templates, so a one-line Apex change can alter how several AI agents behave, and nothing in the change itself shows it.

Today a developer or release manager has to stitch together dependency analysis, Git diffs, permission reviews, test knowledge and tribal knowledge to answer one question before promotion: "What can this change break, and is it safe to promote?" Most teams answer it by deploying and fixing what fails. Salesforce's own deploy only catches compile errors. It happily deploys removed sharing, broken picklist logic, weakened tests and new automation collisions.
<!-- /field -->

## Abstract / description of solution (max 4000)

<!-- field:abstract -->
AgentGuard is an Agentia Headless CLI plugin that adds a release-risk decision to the Copado workflow:

  agentia guard analyze

It reads the active Copado user story through the Agentia host API (story, base branch and the next pipeline environment), compares the story branch with its base branch, and builds a reverse-reference graph of the whole Salesforce repository. The graph covers Apex, triggers, Flows, LWC/Aura, custom fields and objects, validation rules, custom permissions, and Agentforce agents, topics, actions and prompt templates. From every changed component it walks the graph to find the blast radius, with the exact chain, for example: OpportunityService → AccountIntelligenceController → GetAccountSummary → Account_Intelligence → Sales_Assistant_Agent.

Five analyzers report facts with evidence:
- Security: Modify All / View All / Delete / system permissions, Apex class access, FLS, sharing removed from Apex, user-callable classes running without sharing.
- Dependency: deleted components still in use, missing dependencies (a field, class or prompt the change needs but the story does not contain), high blast radius, shared services.
- Schema and automation: breaking field changes, picklist values removed while code still uses them, new validation rules or required fields on objects that automation writes, new record-triggered flows on objects that already have a trigger.
- Test: changed Apex without related tests, deleted tests, removed assertions, SeeAllData=true, flows without Flow tests.
- Agentforce: agents, topics and actions reached by the change, agent-to-agent dependencies, missing prompt templates.

A deterministic risk engine scores the findings (dependency 30, security 30, test 20, Agentforce 20) into LOW, MEDIUM, HIGH or CRITICAL and a promotion verdict. Any critical finding blocks promotion. The LLM never sets the score: `agentia guard explain` sends only the structured findings to Copado AI (the release agent, through host.ai.ask) for a plain-language explanation and remediation plan.

Integration with Agentia:
1. Commands: guard analyze, guard explain, guard rules, with --json for CI and coding agents and --fail-on to gate.
2. Quality gate: one line in .agentia_quality_gates.sh makes `agentia cicd work test` and `work submit` fail a risky story before it is published or promoted.
3. Agent skill: the plugin contributes an agentia-guard skill (agentia setup skills), so Claude Code or Cursor runs AgentGuard before promoting and never re-estimates the score.
4. Configurable weights per organisation via agentguard.yml.

Validated on a real Copado pipeline (Dev1 → INT → UAT → Production) with check-only deploys to the Dev1 sandbox:
- Agentforce story: 70/100 HIGH. Modify All on Account, an untested batch class, two agents in the blast radius, a missing prompt template. Salesforce later rejected the batch class for 0% coverage, as AgentGuard predicted.
- Non-Agentforce Order-to-Cash story: CRITICAL with 14 findings. Salesforce's deploy failed with 5 errors, all covered by AgentGuard's top two findings with the same components named. The other risks (sharing removed, broken picklist logic, SeeAllData, a validation rule on automated saves) would have deployed silently. After the recommended fix: 20/100 LOW, and the Salesforce validation passes with 18/18 tests.
<!-- /field -->

## Problem solved / gap addressed (max 4000)

<!-- field:solved -->
AgentGuard adds the missing step between "my code compiles" and "deploy": an auditable answer to "what can this change break, and is it safe to promote?"

1. Hidden blast radius. Agentia and Salesforce answer "what depends on this?" only partially and in separate places. AgentGuard traces downstream impact across code, declarative automation, schema and Agentforce in one graph. It shows the exact chain from a changed Apex class or field to the flows, components and AI agents it affects.

2. Fragmented release validation. Permission review, dependency checks, test review and Agentforce impact are usually separate manual steps owned by different people. AgentGuard correlates them into one report, one score and one verdict, with evidence and a recommendation for every finding.

3. Reactive troubleshooting. Teams find these problems after a failed deployment or, worse, in production: a validation rule blocking an integration, a removed picklist value breaking routing, a service that lost sharing. AgentGuard moves the check to the developer's terminal and to Agentia's local quality gate, before publish and submit.

4. Risks Salesforce cannot see. A successful deployment is not a safe deployment. In our test, Salesforce deployed removed sharing, broken picklist logic, weakened tests and a second automation on Opportunity without complaint. AgentGuard flags all of them.

5. Trustworthy AI in the release process. Scores come from deterministic, configurable rules, so the same change always gets the same result and every point is traceable to evidence. AI (Copado AI through Agentia) only explains and prioritises facts it is given, which keeps AgentGuard repeatable, explainable and fit for governed enterprise release processes.

Who it helps: developers get immediate feedback with fix instructions; release managers get one promotion verdict per story; coding agents get structured JSON and a skill that tells them never to promote a blocked change.
<!-- /field -->

## Tools / technologies used (max 500)

<!-- field:tools -->
Agentia Headless CLI and Plugin SDK (@copado/agentia-plugin-sdk: AgentiaCommand, host API work/workspace/pipeline/ai/format, agentia:contribute skill hook), Agentia local quality gates, Copado AI (release agent), Copado DevOps pipeline, TypeScript, Node.js 22, oclif, fast-xml-parser, Git, Salesforce CLI (check-only deploys), Vitest (47 tests), Claude Code
<!-- /field -->

## GitHub repository

https://github.com/praketo1/agentguard (make it **public** before submitting)

## Any comments or considerations (optional, max 4000)

<!-- field:comments -->
To reproduce the demo in under two minutes: npm install && npm run build && agentia plugins link . && node demo/video-setup.mjs. This creates the two demo repositories used in the video (Agentforce story and Order-to-Cash story). Then run agentia guard analyze in each.

The Dev1 sandbox in my pipeline does not have Agentforce enabled, so Agentforce metadata in the demo is analysed from Git and excluded from deployment through .forceignore. AgentGuard is repository-based by design, because the plugin host gives plugins no direct Copado or org access. As a result, "missing dependency" means missing from the repository and the story, not from the target org.

Roadmap: reading committed metadata and test results from Copado when the host API exposes them, coverage-aware test risk, deployment-history signals, posting the report on the user story, and an automated remediation flow (fix, re-analyse, show the before/after score).
<!-- /field -->
