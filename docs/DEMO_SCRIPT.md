# AgentGuard demo video script (target 4:30, hard limit 5:00)

Read the **SAY** lines aloud. Type the **RUN** commands exactly. **SHOW** tells you where to point or scroll. Every command and number below was verified on this machine.

---

## Before you hit record (5 minutes)

```sh
cd ~/agentguard && npm run build
node demo/video-setup.mjs            # fresh demo repos in ~/agentguard-video (re-run this before every take)
```

- Terminal: dark theme, font size **18–20**, window about **120 columns wide**, so the report fits without wrapping.
- Close notifications (Focus mode). Hide the dock and desktop icons.
- Recorder: macOS **Cmd+Shift+5** → "Record Selected Portion" around the terminal (or QuickTime → New Screen Recording), with the microphone on.
- Open the deck at the title slide in a second window (optional for 0:00 and 4:15).
- Do one full rehearsal take. The first run of each command is slower while it warms up.

---

## 0:00 – 0:30 · The problem (title slide or terminal)

**SHOW:** the title slide (or an empty terminal).

**SAY:**
> "Salesforce releases rarely fail because of the component you changed. They fail because of what depends on it: a field someone deleted, a picklist value still used in code, a service that lost 'with sharing', or, with Agentforce, an Apex change that quietly alters how your AI agents behave.
> I built AgentGuard, an Agentia Headless plugin that answers one question before you promote: what can this change break, and is it safe to promote?"

---

## 0:30 – 0:50 · It is a native Agentia command

**RUN:**
```sh
clear && agentia guard --help
```

**SAY:**
> "AgentGuard is built on the Agentia plugin SDK, so it's just another Agentia command: analyze, explain with Copado AI, and rules. Everything runs locally against the Git repository and the active Copado user story."

---

## 0:50 – 2:00 · Demo 1: an Agentforce story

**RUN:**
```sh
cd ~/agentguard-video/sales-assistant && clear && git diff --stat main
```

**SAY:**
> "Here's user story US-0000025 from my Copado pipeline. Six files: a tweak to OpportunityService, a new batch class, a permission-set change, and a new agent action. It looks small."

**RUN:**
```sh
clear && agentia guard analyze --story US-0000025
```

**SHOW (scroll slowly from the top):**
1. Header: the story title and **Target INT-SFP** come live from Copado through the Agentia host API.
2. **70 / 100 HIGH** and the four category bars.
3. **SEC-001** Modify All Records on Account (with the View All and Delete it requires).
4. **TEST-001** No test for OpportunityScoringBatch.
5. **AF-001** 2 agents affected: point at the chain `OpportunityService → AccountIntelligenceController → GetAccountSummary → Account_Intelligence → Sales_Assistant_Agent`.
6. **AF-002** the prompt template the new action needs is missing.
7. The **BLAST RADIUS** tree, then the **VERDICT**.

**SAY (while scrolling):**
> "Seventy out of a hundred, HIGH. It found Modify All on Account and a batch class with no test. Most importantly, it traced OpportunityService through a controller, an agent action and a topic, all the way up to two Agentforce agents. A one-line Apex change affects two AI agents, and nothing in the diff shows it. It also caught a missing prompt template. The verdict is not recommended for promotion, with concrete next steps."

---

## 2:00 – 2:25 · The Agentia quality gate

**RUN:**
```sh
clear && cat .agentia_quality_gates.sh && agentia cicd work test
```

**SHOW:** the one AgentGuard line in the script, then the final error *"Local quality gates failed"*.

**SAY:**
> "To make it a real gate, I add one line to Agentia's local quality-gate script. Now 'agentia cicd work test', and 'work submit', fail this story before it can be published or promoted."

*(If a yellow "Failed to report local quality gates result" warning appears, ignore it. It only means the Local Quality Gate extension isn't configured in this Copado trial.)*

---

## 2:25 – 3:35 · Demo 2: a release with no Agentforce

**RUN:**
```sh
cd ~/agentguard-video/order-to-cash && clear && git diff --stat main
```

**SAY:**
> "AgentGuard isn't only for Agentforce. This is an Order-to-Cash story: discount approval and a region clean-up. A new approval service, a validation rule, a flow, a picklist tidy-up, and deleting a field nobody uses any more."

**RUN:**
```sh
clear && agentia guard analyze --target INT-SFP
```

**SHOW:** **CRITICAL**, then scroll through the findings, pausing on:
- **DEP-001** the deleted field is still used by an Apex class, its test and a Flow
- **DEP-002** Discount_Approved__c is used by the new class and the validation rule, but isn't in the story
- **SEC-001** InvoiceService: with sharing → without sharing
- **DEP-003** 'LATAM' removed but still used in code and the Flow
- **DEP-004 / DEP-005** a validation rule on Opportunity, which 7 automations write, and a second automation next to the trigger

**SAY:**
> "CRITICAL, with fourteen findings. The 'unused' field is still used by Apex and a Flow. The new code needs a field that nobody added to the story. InvoiceService lost 'with sharing'. LATAM was removed from the picklist but routing logic still checks for it. The new validation rule hits seven automations that save Opportunities."

**RUN:**
```sh
clear && ./validate-in-salesforce.sh
```

**SAY (during the ~10-second wait):**
> "Let's ask Salesforce. This is a check-only deploy to my Dev sandbox."

**SHOW:** the five ✗ lines.

**SAY:**
> "Salesforce fails with exactly the two problems AgentGuard ranked first, on the same five components, and AgentGuard found them before deploying. The rest, removed sharing, broken picklist logic, weakened tests, Salesforce would have deployed without a word."

---

## 3:35 – 4:15 · Fix it and re-check

**RUN:**
```sh
clear && ./apply-fix.sh && agentia guard analyze | head -18
```

**SAY:**
> "I apply AgentGuard's recommendations: keep the field, keep LATAM, add the missing field, restore sharing and add a test. Re-run: twenty out of a hundred, LOW."

**RUN:**
```sh
./validate-in-salesforce.sh
```

**SHOW:** `Succeeded (18 tests, 0 failures)`

**SAY:**
> "And Salesforce agrees: the deploy validates, with all eighteen tests passing."

---

## 4:15 – 4:45 · Built for headless, explainable AI

**RUN:**
```sh
clear && agentia guard analyze --json | jq '.result.risk'
```

**SAY:**
> "Everything is also available as JSON for CI pipelines and coding agents, and the plugin ships an Agentia skill, so Claude Code or Cursor checks risk before promoting. The score is always deterministic and evidence-based. Copado AI, through 'agentia guard explain', only explains the findings. It never invents or changes them."

---

## 4:45 – 5:00 · Close (title or last slide)

**SAY:**
> "AgentGuard moves Salesforce releases from 'deploy first and troubleshoot' to 'understand the blast radius, fix the risk, then deploy'. The code, demos and tests are on GitHub. Thank you."

**Stop recording.**

---

## After recording

- Trim dead air at the start and end (QuickTime → Edit → Trim). Keep it **under 5:00** and **under 300 MB**. A 1080p screen recording of this length is typically 50–150 MB. If it's larger, export at 1080p via QuickTime → File → Export As → 1080p.
- Before a second take, run `node ~/agentguard/demo/video-setup.mjs` again (it resets both repos, including the applied fix).
