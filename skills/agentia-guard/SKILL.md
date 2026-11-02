---
name: agentia-guard
description: Assess the risk and blast radius of a Salesforce change before promoting or deploying it. Use when the user asks whether a user story, branch or change is safe to promote, what a change can break, which agents/flows/classes depend on a changed component, or before running a Copado promotion or deployment.
---

# AgentGuard — Salesforce change risk

AgentGuard compares the current branch (including uncommitted files) with its base branch and reports a deterministic risk score (0–100, LOW/MEDIUM/HIGH/CRITICAL) across four categories: dependency, security, test and Agentforce.

## When to run it

- Before `agentia` promotion or deployment commands for a user story.
- When the user asks "is this safe to promote/deploy?", "what can this break?", or "what uses this class/flow/action?".
- After making remediation changes, to confirm the score went down.

## How to run it

Always use JSON so you can reason over the result:

```sh
agentia guard analyze --json
```

Useful flags: `--base <branch>` (when there is no active story), `--target <env>`, `--depth <n>`, `--story <US-...>`, `--fail-on high`.

## Reading the result

The JSON `result` contains:

- `risk.score`, `risk.level`, `risk.verdict`, `risk.promotable`, and `risk.categories.<category>.{score,max}`.
- `findings[]`: `id`, `category`, `severity`, `title`, `description`, `component`, `evidence[]`, `recommendation`, `score`.
- `blastRadius[]`: for each changed component, the `impacted` components with their `chain` (shortest reference path).
- `recommendations[]`: de-duplicated remediation steps, most severe first.

## Rules for the agent

1. Never change or re-estimate the score; report it exactly as AgentGuard returned it.
2. Quote finding ids and evidence when explaining risk to the user.
3. If `risk.promotable` is false, do not start a promotion or deployment without the user explicitly accepting the risk.
4. Offer to fix what can be fixed in the repository (add missing tests, remove an unintended permission, add a missing dependency), then re-run the analysis and show the before/after score.
5. For a plain-language summary from Copado AI, run `agentia guard explain` or `agentia guard explain <FINDING_ID>`.
