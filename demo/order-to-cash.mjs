#!/usr/bin/env node
/**
 * A non-Agentforce release scenario: "Discount approval and region clean-up" on an Order-to-Cash app.
 *
 * The story looks routine (a new approval service, a validation rule, a flow, a picklist tidy-up, and
 * deleting an "unused" field), but it hides the failures Salesforce teams usually find after deployment:
 * a field still in use is deleted, a picklist value still in code is removed, the new field the code needs
 * is not in the story, sharing is removed from a service, a validation rule lands on an object that
 * automation writes to, a second automation is added to Opportunity, and a test switches to SeeAllData.
 *
 * Usage: node demo/order-to-cash.mjs [target-dir]                    (standalone git repository)
 *        node demo/order-to-cash.mjs --org <sfdx-project> [folder]   (write into a real project)
 */
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {API, XMLNS, apexClass, base, salesAssistantFiles, write} from './create-demo-repo.mjs'

const opportunityFields = `${base}/objects/Opportunity/fields`
const invoice = `${base}/objects/Invoice__c`
const LEGACY_REGION_FIELD = `${opportunityFields}/Legacy_Region_Code__c.field-meta.xml`

function field(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="${XMLNS}">
${body}
</CustomField>
`
}

function picklist(name, label, values) {
  return field(`    <fullName>${name}</fullName>
    <label>${label}</label>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
${values.map(([value, valueLabel]) => `            <value>
                <fullName>${value}</fullName>
                <default>false</default>
                <label>${valueLabel}</label>
            </value>`).join('\n')}
        </valueSetDefinition>
    </valueSet>`)
}

const REGIONS = [['NA', 'North America'], ['EMEA', 'EMEA'], ['APAC', 'APAC'], ['LATAM', 'Latin America']]

function financeUser({deleteInvoices = false, editDiscount = false} = {}) {
  const fieldPermission = (name, editable) => `    <fieldPermissions>
        <editable>${editable}</editable>
        <field>${name}</field>
        <readable>true</readable>
    </fieldPermissions>`
  const objectPermission = (object, {create = false, edit = false, del = false}) => `    <objectPermissions>
        <allowCreate>${create}</allowCreate>
        <allowDelete>${del}</allowDelete>
        <allowEdit>${edit}</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>${object}</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="${XMLNS}">
    <classAccesses>
        <apexClass>InvoiceController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
${fieldPermission('Invoice__c.Amount__c', true)}
${fieldPermission('Invoice__c.Opportunity__c', false)}
${fieldPermission('Invoice__c.Status__c', true)}
${fieldPermission('Opportunity.Discount_Percent__c', editDiscount)}
    <hasActivationRequired>false</hasActivationRequired>
    <label>Finance User</label>
${objectPermission('Account', {})}
${objectPermission('Invoice__c', {create: true, del: deleteInvoices, edit: true})}
${objectPermission('Opportunity', {})}
</PermissionSet>
`
}

function invoiceService(sharing) {
  return `public ${sharing} class InvoiceService {
    public static Decimal invoiceAmount(Opportunity opp) {
        Decimal amount = opp.Amount == null ? 0 : opp.Amount;
        Decimal discount = opp.Discount_Percent__c == null ? 0 : opp.Discount_Percent__c;
        return (amount * (100 - discount) / 100).setScale(2);
    }

    public static Invoice__c createInvoice(Id opportunityId) {
        Opportunity opp = [SELECT Id, Amount, Discount_Percent__c FROM Opportunity WHERE Id = :opportunityId];
        Invoice__c invoice = new Invoice__c(Opportunity__c = opp.Id, Amount__c = invoiceAmount(opp), Status__c = 'Draft');
        insert invoice;
        return invoice;
    }
}
`
}

function invoiceServiceTest({seeAllData}) {
  return `@IsTest${seeAllData ? '(SeeAllData=true)' : ''}
private class InvoiceServiceTest {
    @IsTest
    static void appliesDiscount() {
        Opportunity opp = new Opportunity(Name = 'Deal', StageName = 'Prospecting', CloseDate = Date.today(), Amount = 1000, Discount_Percent__c = 10);
        insert opp;
        Invoice__c invoice = InvoiceService.createInvoice(opp.Id);
        System.assertEquals(900, invoice.Amount__c);${seeAllData ? '' : "\n        System.assertEquals('Draft', invoice.Status__c);"}
    }

    @IsTest
    static void controllerCreatesInvoice() {
        Opportunity opp = new Opportunity(Name = 'Deal', StageName = 'Prospecting', CloseDate = Date.today(), Amount = 500);
        insert opp;
        System.assertNotEquals(null, InvoiceController.createInvoice(opp.Id));
    }
}
`
}

function discountApprovalService(sharing) {
  return `public ${sharing} class DiscountApprovalService {
    @AuraEnabled
    public static void approve(Id opportunityId) {
        Opportunity opp = [SELECT Id, Discount_Percent__c FROM Opportunity WHERE Id = :opportunityId];
        opp.Discount_Approved__c = true;
        update opp;
    }
}
`
}

/** The Order-to-Cash app as it exists before the story. */
const baselineFiles = {
  [`${opportunityFields}/Region__c.field-meta.xml`]: picklist('Region__c', 'Region', REGIONS),
  [LEGACY_REGION_FIELD]: field(`    <fullName>Legacy_Region_Code__c</fullName>
    <externalId>false</externalId>
    <label>Legacy Region Code</label>
    <length>10</length>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>Text</type>
    <unique>false</unique>`),
  [`${opportunityFields}/Discount_Percent__c.field-meta.xml`]: field(`    <fullName>Discount_Percent__c</fullName>
    <externalId>false</externalId>
    <label>Discount Percent</label>
    <precision>5</precision>
    <required>false</required>
    <scale>2</scale>
    <trackTrending>false</trackTrending>
    <type>Percent</type>`),

  [`${invoice}/Invoice__c.object-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="${XMLNS}">
    <deploymentStatus>Deployed</deploymentStatus>
    <enableActivities>false</enableActivities>
    <enableReports>true</enableReports>
    <label>Invoice</label>
    <nameField>
        <displayFormat>INV-{0000}</displayFormat>
        <label>Invoice Number</label>
        <type>AutoNumber</type>
    </nameField>
    <pluralLabel>Invoices</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
`,
  [`${invoice}/fields/Opportunity__c.field-meta.xml`]: field(`    <fullName>Opportunity__c</fullName>
    <deleteConstraint>SetNull</deleteConstraint>
    <label>Opportunity</label>
    <referenceTo>Opportunity</referenceTo>
    <relationshipLabel>Invoices</relationshipLabel>
    <relationshipName>Invoices</relationshipName>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>Lookup</type>`),
  [`${invoice}/fields/Amount__c.field-meta.xml`]: field(`    <fullName>Amount__c</fullName>
    <externalId>false</externalId>
    <label>Amount</label>
    <precision>16</precision>
    <required>false</required>
    <scale>2</scale>
    <trackTrending>false</trackTrending>
    <type>Currency</type>`),
  [`${invoice}/fields/Status__c.field-meta.xml`]: picklist('Status__c', 'Status', [['Draft', 'Draft'], ['Sent', 'Sent'], ['Paid', 'Paid']]),

  ...apexClass('InvoiceService', invoiceService('with sharing')),
  ...apexClass(
    'InvoiceController',
    `public with sharing class InvoiceController {
    @AuraEnabled
    public static Id createInvoice(Id opportunityId) {
        return InvoiceService.createInvoice(opportunityId).Id;
    }
}
`,
  ),
  ...apexClass('InvoiceServiceTest', invoiceServiceTest({seeAllData: false})),
  ...apexClass(
    'RegionRoutingService',
    `public with sharing class RegionRoutingService {
    public static String queueFor(Opportunity opp) {
        String region = opp.Region__c;
        if (region == null && opp.Legacy_Region_Code__c == 'LA') {
            region = 'LATAM';
        }
        switch on region {
            when 'NA' { return 'North_America_Sales'; }
            when 'EMEA' { return 'EMEA_Sales'; }
            when 'APAC' { return 'APAC_Sales'; }
            when 'LATAM' { return 'LATAM_Sales'; }
            when else { return 'Global_Sales'; }
        }
    }
}
`,
  ),
  ...apexClass(
    'RegionRoutingServiceTest',
    `@IsTest
private class RegionRoutingServiceTest {
    @IsTest
    static void routesByRegion() {
        System.assertEquals('LATAM_Sales', RegionRoutingService.queueFor(new Opportunity(Region__c = 'LATAM')));
        System.assertEquals('EMEA_Sales', RegionRoutingService.queueFor(new Opportunity(Region__c = 'EMEA')));
    }

    @IsTest
    static void fallsBackToLegacyCode() {
        System.assertEquals('LATAM_Sales', RegionRoutingService.queueFor(new Opportunity(Legacy_Region_Code__c = 'LA')));
    }
}
`,
  ),

  [`${base}/flows/Opportunity_Region_Assignment.flow-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="${XMLNS}">
    <apiVersion>${API}</apiVersion>
    <environments>Default</environments>
    <interviewLabel>Opportunity Region Assignment {!$Flow.CurrentDateTime}</interviewLabel>
    <label>Opportunity Region Assignment</label>
    <processType>AutoLaunchedFlow</processType>
    <recordUpdates>
        <name>Tag_LATAM_Opportunity</name>
        <label>Tag LATAM Opportunity</label>
        <locationX>176</locationX>
        <locationY>134</locationY>
        <filterLogic>and</filterLogic>
        <filters>
            <field>Id</field>
            <operator>EqualTo</operator>
            <value>
                <elementReference>recordId</elementReference>
            </value>
        </filters>
        <filters>
            <field>Region__c</field>
            <operator>EqualTo</operator>
            <value>
                <stringValue>LATAM</stringValue>
            </value>
        </filters>
        <inputAssignments>
            <field>Legacy_Region_Code__c</field>
            <value>
                <stringValue>LA</stringValue>
            </value>
        </inputAssignments>
        <object>Opportunity</object>
    </recordUpdates>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Tag_LATAM_Opportunity</targetReference>
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

  [`${base}/lwc/opportunityInvoice/opportunityInvoice.js`]: `import {LightningElement, api, wire} from 'lwc'
import {getFieldValue, getRecord} from 'lightning/uiRecordApi'
import DISCOUNT_FIELD from '@salesforce/schema/Opportunity.Discount_Percent__c'
import createInvoice from '@salesforce/apex/InvoiceController.createInvoice'

export default class OpportunityInvoice extends LightningElement {
  @api recordId
  @wire(getRecord, {recordId: '$recordId', fields: [DISCOUNT_FIELD]}) opportunity

  get discount() {
    return getFieldValue(this.opportunity.data, DISCOUNT_FIELD)
  }

  async handleCreate() {
    await createInvoice({opportunityId: this.recordId})
  }
}
`,
  [`${base}/lwc/opportunityInvoice/opportunityInvoice.html`]: `<template>
    <lightning-card title="Invoice">
        <p class="slds-p-horizontal_small">Discount: {discount}</p>
        <lightning-button label="Create invoice" onclick={handleCreate}></lightning-button>
    </lightning-card>
</template>
`,
  [`${base}/lwc/opportunityInvoice/opportunityInvoice.js-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="${XMLNS}">
    <apiVersion>${API}</apiVersion>
    <isExposed>true</isExposed>
    <targets>
        <target>lightning__RecordPage</target>
    </targets>
</LightningComponentBundle>
`,

  [`${base}/permissionsets/Finance_User.permissionset-meta.xml`]: financeUser(),
}

/** What the developer commits for the story. */
const storyFiles = {
  ...apexClass('DiscountApprovalService', discountApprovalService('without sharing')),
  ...apexClass('InvoiceService', invoiceService('without sharing')),
  ...apexClass('InvoiceServiceTest', invoiceServiceTest({seeAllData: true})),
  [`${opportunityFields}/Region__c.field-meta.xml`]: picklist('Region__c', 'Region', [...REGIONS.filter(([value]) => value !== 'LATAM'), ['AMER', 'Americas']]),
  [`${base}/objects/Opportunity/validationRules/Discount_Requires_Approval.validationRule-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="${XMLNS}">
    <fullName>Discount_Requires_Approval</fullName>
    <active>true</active>
    <errorConditionFormula>AND(Discount_Percent__c &gt; 0.2, NOT(Discount_Approved__c))</errorConditionFormula>
    <errorDisplayField>Discount_Percent__c</errorDisplayField>
    <errorMessage>Discounts above 20% need approval.</errorMessage>
</ValidationRule>
`,
  [`${base}/flows/Opportunity_High_Discount_Flag.flow-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="${XMLNS}">
    <apiVersion>${API}</apiVersion>
    <assignments>
        <name>Flag_High_Discount</name>
        <label>Flag High Discount</label>
        <locationX>176</locationX>
        <locationY>287</locationY>
        <assignmentItems>
            <assignToReference>$Record.NextStep</assignToReference>
            <operator>Assign</operator>
            <value>
                <stringValue>Discount approval required</stringValue>
            </value>
        </assignmentItems>
    </assignments>
    <environments>Default</environments>
    <interviewLabel>Opportunity High Discount Flag {!$Flow.CurrentDateTime}</interviewLabel>
    <label>Opportunity High Discount Flag</label>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Flag_High_Discount</targetReference>
        </connector>
        <filterLogic>and</filterLogic>
        <filters>
            <field>Discount_Percent__c</field>
            <operator>GreaterThan</operator>
            <value>
                <numberValue>20.0</numberValue>
            </value>
        </filters>
        <object>Opportunity</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <status>Active</status>
</Flow>
`,
  [`${base}/permissionsets/Finance_User.permissionset-meta.xml`]: financeUser({deleteInvoices: true, editDiscount: true}),
}

/** Files the story deletes ("the legacy field is not used any more"). */
const storyDeletions = [LEGACY_REGION_FIELD]

/** The remediation after reading AgentGuard's report. */
const fixFiles = {
  [LEGACY_REGION_FIELD]: baselineFiles[LEGACY_REGION_FIELD],
  [`${opportunityFields}/Region__c.field-meta.xml`]: picklist('Region__c', 'Region', [...REGIONS, ['AMER', 'Americas']]),
  [`${opportunityFields}/Discount_Approved__c.field-meta.xml`]: field(`    <fullName>Discount_Approved__c</fullName>
    <defaultValue>false</defaultValue>
    <label>Discount Approved</label>
    <trackTrending>false</trackTrending>
    <type>Checkbox</type>`),
  ...apexClass('DiscountApprovalService', discountApprovalService('with sharing')),
  ...apexClass(
    'DiscountApprovalServiceTest',
    `@IsTest
private class DiscountApprovalServiceTest {
    @IsTest
    static void approvesDiscount() {
        Opportunity opp = new Opportunity(Name = 'Deal', StageName = 'Prospecting', CloseDate = Date.today(), Discount_Percent__c = 30, Discount_Approved__c = true);
        insert opp;
        DiscountApprovalService.approve(opp.Id);
        System.assertEquals(true, [SELECT Discount_Approved__c FROM Opportunity WHERE Id = :opp.Id].Discount_Approved__c);
    }
}
`,
  ),
  ...apexClass('InvoiceService', invoiceService('with sharing')),
  ...apexClass('InvoiceServiceTest', invoiceServiceTest({seeAllData: false})),
  [`${base}/permissionsets/Finance_User.permissionset-meta.xml`]: financeUser(),
}

function git(root, ...args) {
  execFileSync('git', args, {cwd: root, stdio: 'pipe'})
}

/** A standalone repository: Sales Assistant + Order-to-Cash on main, the story on feature/US-0000026. */
export function createOrderToCashRepo(target, branch = 'feature/US-0000026') {
  const root = path.resolve(target)
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) throw new Error(`Target directory is not empty: ${root}`)
  fs.mkdirSync(root, {recursive: true})
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'AgentGuard Demo')
  git(root, 'config', 'user.email', 'demo@agentguard.local')
  git(root, 'config', 'commit.gpgsign', 'false')
  write(root, {...salesAssistantFiles, ...baselineFiles})
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'Baseline: Sales Assistant and Order-to-Cash')

  git(root, 'checkout', '-q', '-b', branch)
  write(root, storyFiles)
  for (const file of storyDeletions) fs.rmSync(path.join(root, file))
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'Discount approval and region clean-up')
  return root
}

/** Writes the baseline into force-app and the story/fix kit into agentguard-demo/<folder>/. */
export function exportOrderToCash(target, folder = 'order-to-cash') {
  const root = path.resolve(target)
  if (!fs.existsSync(path.join(root, 'sfdx-project.json'))) throw new Error(`Not a Salesforce DX project: ${root}`)
  const kit = path.join(root, 'agentguard-demo', folder)
  write(root, baselineFiles)
  write(path.join(kit, 'story'), storyFiles)
  write(path.join(kit, 'fix'), fixFiles)
  write(kit, {
    'apply-story.sh': `#!/usr/bin/env bash
# Applies the "discount approval and region clean-up" story to force-app (run from the project root).
set -euo pipefail
cp -R agentguard-demo/${folder}/story/force-app/. force-app/
${storyDeletions.map((file) => `git rm -q --ignore-unmatch ${file} || rm -f ${file}`).join('\n')}
echo "Story applied. Commit it, then run: agentia guard analyze"
`,
    'apply-fix.sh': `#!/usr/bin/env bash
# Applies the remediation for the findings AgentGuard reported (run from the project root).
set -euo pipefail
cp -R agentguard-demo/${folder}/fix/force-app/. force-app/
echo "Fix applied. Commit it, then run: agentia guard analyze"
`,
  })
  fs.chmodSync(path.join(kit, 'apply-story.sh'), 0o755)
  fs.chmodSync(path.join(kit, 'apply-fix.sh'), 0o755)
  return {baseline: Object.keys(baselineFiles).length, fix: Object.keys(fixFiles).length, kit, story: Object.keys(storyFiles).length}
}

export {baselineFiles, fixFiles, storyDeletions, storyFiles}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === '--org') {
    const {baseline, fix, kit, story} = exportOrderToCash(process.argv[3] ?? '.', process.argv[4])
    console.log(`Wrote ${baseline} baseline files to force-app, and the story (${story} files + 1 deletion) and fix (${fix} files) to ${kit}.`)
  } else {
    const root = createOrderToCashRepo(process.argv[2] ?? 'order-to-cash-repo')
    console.log(`Order-to-Cash repository created at ${root} on branch feature/US-0000026.\n\nTry:\n  cd ${root}\n  agentia guard analyze --base main --target INT-SFP`)
  }
}
