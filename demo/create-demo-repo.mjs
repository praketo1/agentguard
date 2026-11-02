#!/usr/bin/env node
/**
 * Creates a sample Salesforce DX repository for demoing AgentGuard.
 *
 *   main            — a Sales Assistant Agentforce implementation
 *   feature/US-247  — a "small" change: OpportunityService logic, a new batch class without tests,
 *                     Modify All on Account, and a new agent action whose prompt template was forgotten
 *
 * Usage: node demo/create-demo-repo.mjs [target-dir]              (default: ./demo-repo)
 *        node demo/create-demo-repo.mjs --org <sfdx-project> [story]  (write into a real project)
 */
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const API = '62.0'
const XMLNS = 'http://soap.sforce.com/2006/04/metadata'

const classMeta = `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="${XMLNS}">
    <apiVersion>${API}</apiVersion>
    <status>Active</status>
</ApexClass>
`

const triggerMeta = `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="${XMLNS}">
    <apiVersion>${API}</apiVersion>
    <status>Active</status>
</ApexTrigger>
`

const base = 'force-app/main/default'

function apexClass(name, body) {
  return {[`${base}/classes/${name}.cls`]: body, [`${base}/classes/${name}.cls-meta.xml`]: classMeta}
}

function objectPermission(object, {create = false, read = true, edit = false, del = false, viewAll = false, modifyAll = false}) {
  return `    <objectPermissions>
        <allowCreate>${create}</allowCreate>
        <allowDelete>${del}</allowDelete>
        <allowEdit>${edit}</allowEdit>
        <allowRead>${read}</allowRead>
        <modifyAllRecords>${modifyAll}</modifyAllRecords>
        <object>${object}</object>
        <viewAllRecords>${viewAll}</viewAllRecords>
    </objectPermissions>`
}

function salesManager({modifyAllAccounts}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="${XMLNS}">
    <classAccesses>
        <apexClass>AccountIntelligenceController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <fieldPermissions>
        <editable>false</editable>
        <field>Account.AnnualRevenue</field>
        <readable>true</readable>
    </fieldPermissions>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Sales Manager</label>
${objectPermission('Account', {del: modifyAllAccounts, edit: true, modifyAll: modifyAllAccounts, viewAll: modifyAllAccounts})}
${objectPermission('Opportunity', {create: true, edit: true})}
</PermissionSet>
`
}

function genAiFunction({label, description, target, targetType}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<GenAiFunction xmlns="${XMLNS}">
    <description>${description}</description>
    <invocationTarget>${target}</invocationTarget>
    <invocationTargetType>${targetType}</invocationTargetType>
    <isConfirmationRequired>false</isConfirmationRequired>
    <masterLabel>${label}</masterLabel>
</GenAiFunction>
`
}

function topic(functions) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlugin xmlns="${XMLNS}">
    <canEscalate>false</canEscalate>
    <description>Answers questions about an account's health, pipeline and recent activity.</description>
${functions.map((name) => `    <genAiFunctions>\n        <functionName>${name}</functionName>\n    </genAiFunctions>`).join('\n')}
    <language>en_US</language>
    <masterLabel>Account Intelligence</masterLabel>
    <pluginType>Topic</pluginType>
    <scope>Help sales users understand an account before a meeting.</scope>
</GenAiPlugin>
`
}

function planner(label, topics) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlannerBundle xmlns="${XMLNS}">
    <description>${label} planner</description>
${topics.map((name) => `    <genAiPlugins>\n        <genAiPluginName>${name}</genAiPluginName>\n    </genAiPlugins>`).join('\n')}
    <masterLabel>${label}</masterLabel>
    <plannerType>AiCopilot__ReAct</plannerType>
</GenAiPlannerBundle>
`
}

function agent(name, label, topics) {
  return {
    [`${base}/genAiPlannerBundles/${name}/${name}.genAiPlannerBundle`]: planner(label, topics),
    [`${base}/bots/${name}/${name}.bot-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<Bot xmlns="${XMLNS}">
    <agentType>EinsteinServiceAgent</agentType>
    <label>${label}</label>
</Bot>
`,
    [`${base}/bots/${name}/v1.botVersion-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<BotVersion xmlns="${XMLNS}">
    <conversationDefinitionPlanners>
        <genAiPlannerName>${name}</genAiPlannerName>
    </conversationDefinitionPlanners>
    <fullName>v1</fullName>
</BotVersion>
`,
  }
}

const opportunityServiceV1 = `public with sharing class OpportunityService {
    public static Decimal openPipeline(Id accountId) {
        AggregateResult result = [
            SELECT SUM(Amount) total FROM Opportunity
            WHERE AccountId = :accountId AND IsClosed = false
        ];
        return (Decimal) result.get('total');
    }

    public static void applyStageDefaults(List<Opportunity> opportunities) {
        for (Opportunity opp : opportunities) {
            if (opp.StageName == 'Closed Won') {
                opp.Probability = 100;
            }
        }
    }
}
`

const opportunityServiceV2 = `public with sharing class OpportunityService {
    public static Decimal openPipeline(Id accountId) {
        // US-247: weight pipeline by probability instead of raw amount
        Decimal weighted = 0;
        for (Opportunity opp : [
            SELECT Amount, Probability FROM Opportunity
            WHERE AccountId = :accountId AND IsClosed = false
        ]) {
            weighted += (opp.Amount == null ? 0 : opp.Amount) * (opp.Probability == null ? 0 : opp.Probability) / 100;
        }
        return weighted;
    }

    public static void applyStageDefaults(List<Opportunity> opportunities) {
        for (Opportunity opp : opportunities) {
            if (opp.StageName == 'Closed Won') {
                opp.Probability = 100;
            } else if (opp.StageName == 'Closed Lost') {
                opp.Probability = 0;
            }
        }
    }
}
`

const mainFiles = {
  'sfdx-project.json': JSON.stringify(
    {packageDirectories: [{default: true, path: 'force-app'}], sfdcLoginUrl: 'https://login.salesforce.com', sourceApiVersion: API},
    null,
    2,
  ),
  '.gitignore': '.sf/\n.sfdx/\nnode_modules/\n',
  'README.md': '# Sales Assistant\n\nSample Salesforce DX project used to demo AgentGuard.\n',

  ...apexClass('OpportunityService', opportunityServiceV1),
  ...apexClass(
    'OpportunityServiceTest',
    `@IsTest
private class OpportunityServiceTest {
    @IsTest
    static void closedWonSetsProbability() {
        Opportunity opp = new Opportunity(Name = 'Test', StageName = 'Closed Won', CloseDate = Date.today());
        OpportunityService.applyStageDefaults(new List<Opportunity>{ opp });
        System.assertEquals(100, opp.Probability);
    }

    @IsTest
    static void openPipelineIncludesOpenOpportunities() {
        Account acc = new Account(Name = 'Acme');
        insert acc;
        insert new Opportunity(Name = 'Open', AccountId = acc.Id, StageName = 'Prospecting', CloseDate = Date.today(), Amount = 1000);
        System.assertNotEquals(null, OpportunityService.openPipeline(acc.Id));
    }
}
`,
  ),
  ...apexClass(
    'OpportunityTriggerHandler',
    `public with sharing class OpportunityTriggerHandler {
    public void beforeUpsert(List<Opportunity> records) {
        OpportunityService.applyStageDefaults(records);
    }
}
`,
  ),
  [`${base}/triggers/OpportunityTrigger.trigger`]: `trigger OpportunityTrigger on Opportunity (before insert, before update) {
    new OpportunityTriggerHandler().beforeUpsert(Trigger.new);
}
`,
  [`${base}/triggers/OpportunityTrigger.trigger-meta.xml`]: triggerMeta,
  ...apexClass(
    'OpportunityRollupAction',
    `public with sharing class OpportunityRollupAction {
    public class Request {
        @InvocableVariable(required=true) public Id accountId;
    }

    @InvocableMethod(label='Roll up open pipeline')
    public static List<Decimal> rollup(List<Request> requests) {
        List<Decimal> totals = new List<Decimal>();
        for (Request request : requests) {
            totals.add(OpportunityService.openPipeline(request.accountId));
        }
        return totals;
    }
}
`,
  ),
  ...apexClass(
    'OpportunityRollupActionTest',
    `@IsTest
private class OpportunityRollupActionTest {
    @IsTest
    static void rollsUpPerAccount() {
        Account acc = new Account(Name = 'Acme');
        insert acc;
        OpportunityRollupAction.Request request = new OpportunityRollupAction.Request();
        request.accountId = acc.Id;
        System.assertEquals(1, OpportunityRollupAction.rollup(new List<OpportunityRollupAction.Request>{ request }).size());
    }
}
`,
  ),
  ...apexClass(
    'AccountIntelligenceController',
    `public with sharing class AccountIntelligenceController {
    public class Request {
        @InvocableVariable(required=true) public Id accountId;
    }

    @InvocableMethod(label='Get Account Summary' description='Summarise account health for the agent')
    public static List<String> getAccountSummary(List<Request> requests) {
        List<String> summaries = new List<String>();
        for (Request request : requests) {
            Decimal pipeline = OpportunityService.openPipeline(request.accountId);
            summaries.add('Open pipeline: ' + pipeline);
        }
        return summaries;
    }

    @AuraEnabled(cacheable=true)
    public static String getSummary(Id accountId) {
        return getAccountSummary(new List<Request>{ newRequest(accountId) })[0];
    }

    private static Request newRequest(Id accountId) {
        Request request = new Request();
        request.accountId = accountId;
        return request;
    }
}
`,
  ),
  ...apexClass(
    'AccountIntelligenceControllerTest',
    `@IsTest
private class AccountIntelligenceControllerTest {
    @IsTest
    static void returnsSummary() {
        Account acc = new Account(Name = 'Acme');
        insert acc;
        System.assert(AccountIntelligenceController.getSummary(acc.Id).startsWith('Open pipeline'));
    }
}
`,
  ),

  [`${base}/flows/Account_Pipeline_Update.flow-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="${XMLNS}">
    <actionCalls>
        <name>Roll_up_pipeline</name>
        <label>Roll up pipeline</label>
        <locationX>176</locationX>
        <locationY>134</locationY>
        <actionName>OpportunityRollupAction</actionName>
        <actionType>apex</actionType>
        <flowTransactionModel>CurrentTransaction</flowTransactionModel>
        <inputParameters>
            <name>accountId</name>
            <value>
                <elementReference>recordId</elementReference>
            </value>
        </inputParameters>
    </actionCalls>
    <apiVersion>${API}</apiVersion>
    <environments>Default</environments>
    <interviewLabel>Account Pipeline Update {!$Flow.CurrentDateTime}</interviewLabel>
    <label>Account Pipeline Update</label>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Roll_up_pipeline</targetReference>
        </connector>
    </start>
    <status>Active</status>
    <variables>
        <name>recordId</name>
        <dataType>String</dataType>
        <isCollection>false</isCollection>
        <isInput>true</isInput>
        <isOutput>false</isOutput>
    </variables>
</Flow>
`,

  [`${base}/lwc/accountInsights/accountInsights.js`]: `import {LightningElement, api, wire} from 'lwc'
import getSummary from '@salesforce/apex/AccountIntelligenceController.getSummary'

export default class AccountInsights extends LightningElement {
  @api recordId
  @wire(getSummary, {accountId: '$recordId'}) summary
}
`,
  [`${base}/lwc/accountInsights/accountInsights.html`]: '<template><p>{summary.data}</p></template>\n',
  [`${base}/lwc/accountInsights/accountInsights.js-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="${XMLNS}">
    <apiVersion>${API}</apiVersion>
    <isExposed>true</isExposed>
    <targets><target>lightning__RecordPage</target></targets>
</LightningComponentBundle>
`,

  [`${base}/genAiPromptTemplates/AccountSummaryPrompt.genAiPromptTemplate-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPromptTemplate xmlns="${XMLNS}">
    <developerName>AccountSummaryPrompt</developerName>
    <masterLabel>Account Summary Prompt</masterLabel>
    <templateVersions>
        <content>Summarise the health of {!$Input:Account.Name} for a sales manager.</content>
        <status>Published</status>
    </templateVersions>
    <type>einstein_gpt__flex</type>
</GenAiPromptTemplate>
`,
  [`${base}/genAiFunctions/GetAccountSummary/GetAccountSummary.genAiFunction-meta.xml`]: genAiFunction({
    description: 'Summarise an account using pipeline and activity data.',
    label: 'Get Account Summary',
    target: 'AccountIntelligenceController',
    targetType: 'apex',
  }),
  [`${base}/genAiPlugins/Account_Intelligence.genAiPlugin-meta.xml`]: topic(['GetAccountSummary']),
  ...agent('Sales_Assistant_Agent', 'Sales Assistant Agent', ['Account_Intelligence']),
  ...agent('Survey_Intelligence_Agent', 'Survey Intelligence Agent', ['Account_Intelligence']),

  [`${base}/permissionsets/Sales_Manager.permissionset-meta.xml`]: salesManager({modifyAllAccounts: false}),
}

/** Story changes that deploy to any Salesforce org. */
const storyFiles = {
  ...apexClass('OpportunityService', opportunityServiceV2),
  ...apexClass(
    'OpportunityScoringBatch',
    `public with sharing class OpportunityScoringBatch implements Database.Batchable<SObject> {
    public Database.QueryLocator start(Database.BatchableContext context) {
        return Database.getQueryLocator('SELECT Id, StageName, Probability FROM Opportunity WHERE IsClosed = false');
    }

    public void execute(Database.BatchableContext context, List<Opportunity> scope) {
        for (Opportunity opp : scope) {
            opp.Probability = opp.Probability == null ? 10 : opp.Probability;
        }
        update scope;
    }

    public void finish(Database.BatchableContext context) {}
}
`,
  ),
  [`${base}/permissionsets/Sales_Manager.permissionset-meta.xml`]: salesManager({modifyAllAccounts: true}),
}

/** What the developer commits after reading AgentGuard's findings: a test for the batch, and no Modify All. */
const fixFiles = {
  ...apexClass(
    'OpportunityScoringBatchTest',
    `@IsTest
private class OpportunityScoringBatchTest {
    @IsTest
    static void defaultsMissingProbability() {
        Account acc = new Account(Name = 'Acme');
        insert acc;
        insert new Opportunity(Name = 'Open', AccountId = acc.Id, StageName = 'Prospecting', CloseDate = Date.today());
        Test.startTest();
        Database.executeBatch(new OpportunityScoringBatch());
        Test.stopTest();
        System.assertEquals(1, [SELECT COUNT() FROM Opportunity WHERE Probability != null]);
    }
}
`,
  ),
  [`${base}/permissionsets/Sales_Manager.permissionset-meta.xml`]: salesManager({modifyAllAccounts: false}),
}

/** Story changes that need an Agentforce-enabled org. */
const agentforceStoryFiles = {
  [`${base}/genAiFunctions/GetOpportunityInsights/GetOpportunityInsights.genAiFunction-meta.xml`]: genAiFunction({
    description: 'Explain which open opportunities on the account are at risk.',
    label: 'Get Opportunity Insights',
    target: 'OpportunityInsightsPrompt',
    targetType: 'generatePromptResponse',
  }),
  [`${base}/genAiPlugins/Account_Intelligence.genAiPlugin-meta.xml`]: topic(['GetAccountSummary', 'GetOpportunityInsights']),
}

function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file)
    fs.mkdirSync(path.dirname(full), {recursive: true})
    fs.writeFileSync(full, content)
  }
}

function git(root, ...args) {
  execFileSync('git', args, {cwd: root, stdio: 'pipe'})
}

export function createDemoRepo(target) {
  const root = path.resolve(target)
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) throw new Error(`Target directory is not empty: ${root}`)
  fs.mkdirSync(root, {recursive: true})

  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'AgentGuard Demo')
  git(root, 'config', 'user.email', 'demo@agentguard.local')
  git(root, 'config', 'commit.gpgsign', 'false')
  write(root, mainFiles)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'Sales Assistant agent')

  git(root, 'checkout', '-q', '-b', 'feature/US-247')
  write(root, {...storyFiles, ...agentforceStoryFiles})
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'US-247: weighted pipeline, opportunity scoring and insights action')
  return root
}

/** Metadata folders that only deploy to an Agentforce-enabled org. */
const AGENTFORCE_FOLDERS = ['bots', 'genAiFunctions', 'genAiPlannerBundles', 'genAiPlugins', 'genAiPromptTemplates']

/**
 * Writes the demo into an existing Salesforce DX project for a real Copado pipeline:
 * the baseline into force-app, and the story change into agentguard-demo/<story>/ to apply after `work set`.
 */
export function exportToProject(target, story = 'US-0000025') {
  const root = path.resolve(target)
  if (!fs.existsSync(path.join(root, 'sfdx-project.json'))) throw new Error(`Not a Salesforce DX project: ${root}`)
  const baseline = Object.fromEntries(Object.entries(mainFiles).filter(([file]) => file.startsWith('force-app/')))
  write(root, baseline)
  write(path.join(root, 'agentguard-demo', story), storyFiles)
  write(path.join(root, 'agentguard-demo', `${story}-fix`), fixFiles)
  write(path.join(root, 'agentguard-demo'), {
    'forceignore-agentforce.txt': [
      '',
      '# AgentGuard demo: Agentforce is not enabled in these sandboxes, so agent metadata stays in Git',
      '# (where AgentGuard analyses it) but is never deployed. Remove these lines in an Agentforce-enabled org.',
      ...AGENTFORCE_FOLDERS.map((folder) => `**/${folder}/**`),
      '',
    ].join('\n'),
  })
  return {baseline: Object.keys(baseline).length, root, story: Object.keys(storyFiles).length}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === '--org') {
    const {baseline, root, story} = exportToProject(process.argv[3] ?? '.', process.argv[4])
    console.log(`Wrote ${baseline} baseline files to ${root}/force-app and ${story} story files to ${root}/agentguard-demo/.`)
  } else {
    const root = createDemoRepo(process.argv[2] ?? 'demo-repo')
    console.log(`Demo repository created at ${root} on branch feature/US-247.\n\nTry:\n  cd ${root}\n  agentia guard analyze --base main --target UAT`)
  }
}

export {API, XMLNS, apexClass, base, mainFiles as salesAssistantFiles, write}
