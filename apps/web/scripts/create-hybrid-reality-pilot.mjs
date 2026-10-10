import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'viem';
import { evmBlockEvents } from './create-hybrid-evm-pilot.mjs';
import { realityQuestionText } from './prepare-hybrid-pilot.mjs';
import { assertSettlementRuleAuthoring, settlementRuleHash } from '../server/settlement-rules.mjs';
import { hybridArbitrator, SEPOLIA_KLEROS_SUBCOURT3, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';

// Custom rules replace the default chain-block questions. Each becomes one Reality question whose text links its rule.
function ruleEvents(rules, { closesAt, timeout }) {
  if (!Array.isArray(rules) || rules.length < 2 || rules.length > 32) throw Error('Provide 2 to 32 rules');
  if (new Set(rules.map(rule => rule?.eventId)).size !== rules.length) throw Error('Rule event IDs must be distinct');
  return rules.map(rule => {
    assertSettlementRuleAuthoring(rule);
    if (rule.timing.challengePeriod !== timeout) throw Error(`${rule.eventId}: the rule challenge period must equal the timeout`);
    if (rule.timing.assertionPeriod !== 3600 || rule.timing.observationEndsAt <= closesAt)
      throw Error(`${rule.eventId}: the rule needs a 3600 second assertion period and an end after the close time`);
    return { id: rule.eventId, question: rule.question, observationEndsAt: rule.timing.observationEndsAt, rule };
  });
}

export function createHybridRealityPilot({ creator, proposer, relay, closesAt, origin, timeout = 3600,
  minBondWei = '100000000000000', arbitrator = SEPOLIA_KLEROS_SUBCOURT3,
  title = 'Monad testnet Reality reader pool', rules = null }) {
  if (!hybridArbitrator(arbitrator)) throw Error('Choose a supported Kleros arbitrator proxy');
  if (typeof title !== 'string' || title.length < 8 || title.length > 120)
    throw Error('Choose a title of 8 to 120 characters');
  const addresses = [creator, proposer, relay].map(address => getAddress(address));
  if (new Set(addresses.map(address => address.toLowerCase())).size !== 3
    || !Number.isSafeInteger(closesAt)
    || closesAt < Math.floor(Date.now() / 1000) + 7200
    || closesAt > Math.floor(Date.now() / 1000) + 14 * 86400
    || !/^https:\/\/[a-z0-9.-]+$/.test(origin || '')
    || !Number.isSafeInteger(timeout) || timeout < 3600 || timeout > 30 * 86400
    || !/^[1-9]\d*$/.test(minBondWei))
    throw Error('Choose three distinct wallets, a close time 2 hours to 14 days away and an https origin');
  const [deployer, proposerWallet, relayWallet] = addresses;
  const items = (rules === null ? evmBlockEvents({ closesAt, challengePeriod: timeout }) : ruleEvents(rules, { closesAt, timeout })).map(item => {
    const ruleURI = `${origin}/api/hybrid/rules/0x${settlementRuleHash(item.rule)}`;
    return { ...item, ruleURI, questionText: realityQuestionText(item.question, ruleURI) };
  });
  const events = items.map(item => ({ id: item.id, question: item.question,
    observationEndsAt: item.observationEndsAt, route: 'reality', rule: item.rule,
    source: { kind: 'reality-sepolia', chainId: 11155111, reality: SEPOLIA_REALITY,
      arbitrator: getAddress(arbitrator), ruleURI: item.ruleURI, questionText: item.questionText,
      minTimeout: timeout, minBond: minBondWei, openingAt: item.observationEndsAt } }));
  const draft = { schema: 'flurbo.hybrid-publication.v4', chainId: 10143, rulesReviewed: true,
    creator: deployer, proposer: proposerWallet, relay: relayWallet,
    title, closesAt, assertionPeriod: 3600,
    challengePeriod: 3600, reportPeriod: 90 * 86400, arbitrationPeriod: 90 * 86400,
    bondAtoms: '1000000', liquidityAtoms: '10000000', events };
  return { schema: 'flurbo.hybrid-reality-template.v1', draft,
    questions: items.map((item, eventIndex) => ({ eventIndex, questionText: item.questionText,
      opening: item.observationEndsAt, timeout, minBondWei, nonce: 0 })) };
}

export function askCommand(template, index, templatePath) {
  const item = template.questions[index];
  const { arbitrator } = template.draft.events[index].source;
  const file = resolve(templatePath).replaceAll('\\', '/');
  return `cast send ${SEPOLIA_REALITY} 'askQuestionWithMinBond(uint256,string,address,uint32,uint32,uint256,uint256)' 0 "$(node -p "require('${file}').questions[${index}].questionText")" ${arbitrator} ${item.timeout} ${item.opening} ${item.nonce} ${item.minBondWei} --rpc-url "$FLURBO_SEPOLIA_RPC_URL" --account flurbo-testnet`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [creator, proposer, relay, close, origin, output, arbitrator, title, rulesFile] = process.argv.slice(2);
  if (!output || !/^[1-9]\d*$/.test(close || ''))
    throw Error('Usage: node create-hybrid-reality-pilot.mjs CREATOR PROPOSER RELAY CLOSE_UNIX ORIGIN OUTPUT_TEMPLATE.json [ARBITRATOR] [TITLE] [RULES.json]  (use "" to skip ARBITRATOR or TITLE)');
  const template = createHybridRealityPilot({ creator, proposer, relay, closesAt: Number(close), origin,
    ...(arbitrator ? { arbitrator } : {}), ...(title ? { title } : {}),
    ...(rulesFile ? { rules: JSON.parse(await readFile(rulesFile, 'utf8')) } : {}) });
  await writeFile(output, JSON.stringify(template, null, 2) + '\n', { flag: 'wx' });
  template.questions.forEach((_, index) => console.log(askCommand(template, index, output)));
  console.log(JSON.stringify({ status: 'template_created', questions: template.questions.length,
    closesAt: template.draft.closesAt, output }));
}
