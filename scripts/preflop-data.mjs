import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CONTRACT="rangelab.preflop_strategy.v2";
export const LEGACY_CONTRACT="rangelab.preflop_strategy.v1";
export const POSITIONS=["UTG","UTG+1","MP","HJ","CO","BTN","SB","BB"];
export const STACKS=[20,40,60,100,150];
export const SCENARIOS=["unopened","single-open","open-with-callers","facing-3bet","facing-4bet"];
const ranks="AKQJT98765432";
export const ALL_HANDS=[...ranks].flatMap((high,row)=>[...ranks].map((low,column)=>row===column?`${high}${low}`:row<column?`${high}${low}s`:`${low}${high}o`));

export function convertDcfrCharts(charts,{stack=100}={}){
  if(!Array.isArray(charts)||!charts.length)throw new Error("DCFR chart input must be a non-empty array.");
  return charts.flatMap((spot,index)=>{
    const match=typeof spot?.spot_name==="string"?spot.spot_name.match(/^(UTG|HJ|CO|BTN|SB) RFI$/):null;
    if(!match||!Array.isArray(spot.hands))throw new Error(`DCFR spot ${index+1} is not a supported RFI chart.`);
    return spot.hands.map((entry,handIndex)=>{
      if(!entry||typeof entry.hand!=="string"||!Array.isArray(entry.actions))throw new Error(`${spot.spot_name} hand ${handIndex+1} is invalid.`);
      let fold=0,passive=0,aggressive=0;
      for(const item of entry.actions){if(!item||typeof item.action!=="string"||typeof item.prob!=="number"||!Number.isFinite(item.prob)||item.prob<0)throw new Error(`${spot.spot_name} ${entry.hand} contains an invalid action.`);const action=item.action.toLowerCase();if(action==="fold")fold+=item.prob;else if(action==="call"||action==="check")passive+=item.prob;else if(action.startsWith("raise")||action==="allin")aggressive+=item.prob;else throw new Error(`${spot.spot_name} ${entry.hand} contains unsupported action ${item.action}.`);}
      return {hand:entry.hand,position:match[1],stack,scenario:"unopened",fold,passive,aggressive};
    });
  });
}

export function normalizeHand(raw){
  const text=String(raw??"").toUpperCase().replace(/[^AKQJT2-9SO]/g,"");
  if(text.length<2||!ranks.includes(text[0])||!ranks.includes(text[1]))return null;
  if(text[0]===text[1])return `${text[0]}${text[1]}`;
  const [high,low]=ranks.indexOf(text[0])<ranks.indexOf(text[1])?[text[0],text[1]]:[text[1],text[0]];
  return `${high}${low}${text[2]==="O"?"o":"s"}`;
}

export function parseCsv(text){
  const records=[];let record=[],field="",quoted=false;
  for(let index=0;index<text.length;index++){
    const character=text[index];
    if(quoted){if(character==='"'&&text[index+1]==='"'){field+='"';index++;}else if(character==='"')quoted=false;else field+=character;}
    else if(character==='"')quoted=true;
    else if(character===","){record.push(field);field="";}
    else if(character==="\n"){record.push(field.replace(/\r$/,"") );if(record.some(value=>value.trim()))records.push(record);record=[];field="";}
    else field+=character;
  }
  if(quoted)throw new Error("CSV contains an unterminated quoted field.");
  record.push(field.replace(/\r$/,"") );if(record.some(value=>value.trim()))records.push(record);
  if(records.length<2)throw new Error("CSV requires a header and at least one data row.");
  const headers=records[0].map(value=>value.trim().toLowerCase());
  if(new Set(headers).size!==headers.length)throw new Error("CSV contains duplicate headers.");
  return records.slice(1).map((values,index)=>Object.fromEntries(headers.map((header,column)=>[header,values[column]?.trim()??""]).concat([["__line",String(index+2)]])));
}

function valueFrom(row,names){for(const name of names)if(row[name]!==undefined&&row[name]!=="")return row[name];return undefined;}
export function normalizeRows(inputRows){
  if(!Array.isArray(inputRows)||!inputRows.length)throw new Error("Input requires at least one strategy row.");
  return inputRows.map((source,index)=>{
    if(!source||typeof source!=="object"||Array.isArray(source))throw new Error(`Row ${index+1} must be an object.`);
    const row=Object.fromEntries(Object.entries(source).map(([key,value])=>[key.toLowerCase(),value]));
    const line=valueFrom(row,["__line"])??index+1;
    const hand=normalizeHand(valueFrom(row,["hand","combo","holding"]));
    const position=String(valueFrom(row,["position","pos"])??"").toUpperCase();
    const stack=Number(valueFrom(row,["stack","stackbb","stack_bb"]));
    const scenario=String(valueFrom(row,["scenario","spot"])??"").toLowerCase();
    const rawOpener=valueFrom(row,["openerposition","opener_position","opener"]);
    const openerPosition=rawOpener===undefined?undefined:String(rawOpener).toUpperCase();
    const rawCallers=valueFrom(row,["callerpositions","caller_positions","callers"]);
    const callerPositions=rawCallers===undefined?undefined:(Array.isArray(rawCallers)?rawCallers:String(rawCallers).split(/[+|;]/)).map(value=>String(value).trim().toUpperCase()).filter(Boolean);
    const rawActionSize=valueFrom(row,["actionsize","action_size","size","sizing"]);
    const actionSize=rawActionSize===undefined?undefined:Number(rawActionSize);
    let fold=Number(valueFrom(row,["fold","fold_frequency","fold_freq"]));
    let passive=Number(valueFrom(row,["passive","call","call_frequency","call_freq","limp"]));
    let aggressive=Number(valueFrom(row,["aggressive","raise","raise_frequency","raise_freq","open","bet"]));
    if(!hand)throw new Error(`Row ${line}: invalid hand.`);
    if(!POSITIONS.includes(position))throw new Error(`Row ${line}: invalid position ${position||"(empty)"}.`);
    if(!STACKS.includes(stack))throw new Error(`Row ${line}: invalid stack bucket ${String(stack)}.`);
    if(!SCENARIOS.includes(scenario))throw new Error(`Row ${line}: invalid scenario ${scenario||"(empty)"}.`);
    if(openerPosition!==undefined&&!POSITIONS.includes(openerPosition))throw new Error(`Row ${line}: invalid opener position ${openerPosition}.`);
    if(callerPositions!==undefined&&(callerPositions.some(position=>!POSITIONS.includes(position))||new Set(callerPositions).size!==callerPositions.length))throw new Error(`Row ${line}: caller positions must be valid and unique.`);
    if(actionSize!==undefined&&(!Number.isFinite(actionSize)||actionSize<=0))throw new Error(`Row ${line}: action size must be positive.`);
    if([fold,passive,aggressive].some(value=>!Number.isFinite(value)||value<0))throw new Error(`Row ${line}: frequencies must be non-negative numbers.`);
    const total=fold+passive+aggressive;
    if(total<=1.0001){fold*=100;passive*=100;aggressive*=100;}
    return {hand,position,stack,scenario,...(openerPosition===undefined?{}:{openerPosition}),...(callerPositions===undefined?{}:{callerPositions:callerPositions.sort((left,right)=>POSITIONS.indexOf(left)-POSITIONS.indexOf(right))}),...(actionSize===undefined?{}:{actionSize}),fold:round(fold),passive:round(passive),aggressive:round(aggressive)};
  });
}

const round=value=>Math.round(value*10000)/10000;
export function validateDataset(dataset){
  if(!dataset||typeof dataset!=="object"||Array.isArray(dataset))throw new Error("Dataset must be a JSON object.");
  if(dataset.contract!==undefined&&dataset.contract!==CONTRACT&&dataset.contract!==LEGACY_CONTRACT)throw new Error(`Unsupported contract: ${String(dataset.contract)}.`);
  if(typeof dataset.id!=="string"||!/^[a-z0-9][a-z0-9._-]+$/i.test(dataset.id))throw new Error("Dataset id is invalid.");
  if(typeof dataset.license!=="string"||!dataset.license.trim())throw new Error("Dataset license is required.");
  if(typeof dataset.generatedAt!=="string"||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(dataset.generatedAt)||Number.isNaN(Date.parse(dataset.generatedAt)))throw new Error("Dataset generatedAt must be a valid ISO date.");
  if(dataset.provenance!==undefined&&(!dataset.provenance||typeof dataset.provenance!=="object"||typeof dataset.provenance.generator!=="string"||!dataset.provenance.generator.trim()||typeof dataset.provenance.revision!=="string"||!dataset.provenance.revision.trim()||!Number.isInteger(dataset.provenance.iterations)||dataset.provenance.iterations<1||!Number.isInteger(dataset.provenance.seed)||typeof dataset.provenance.model!=="string"||!dataset.provenance.model.trim()))throw new Error("Dataset provenance is invalid.");
  const rows=normalizeRows(dataset.rows);
  const groups=new Map();
  for(const row of rows){
    if(dataset.contract===LEGACY_CONTRACT&&(row.openerPosition!==undefined||row.callerPositions!==undefined||row.actionSize!==undefined))throw new Error("Strategy v2 spot fields require the v2 contract.");
    const total=row.fold+row.passive+row.aggressive;
    if(Math.abs(total-100)>0.01)throw new Error(`${row.position}|${row.stack}|${row.scenario}|${row.hand}: frequencies total ${round(total)}, expected 100.`);
    const callers=row.callerPositions===undefined?"*":row.callerPositions.join("+")||"none";
    const key=`${row.position}|${row.stack}|${row.scenario}|${row.openerPosition??"*"}|${callers}|${row.actionSize??"*"}`;const hands=groups.get(key)??new Set();
    if(hands.has(row.hand))throw new Error(`${key} contains duplicate hand ${row.hand}.`);hands.add(row.hand);groups.set(key,hands);
  }
  for(const [key,hands] of groups){const missing=ALL_HANDS.filter(hand=>!hands.has(hand));if(missing.length)throw new Error(`${key} has ${hands.size}/169 hands; missing ${missing.slice(0,12).join(",")}${missing.length>12?"…":""}.`);}
  return {dataset:{contract:dataset.contract??LEGACY_CONTRACT,id:dataset.id,license:dataset.license.trim(),generatedAt:dataset.generatedAt,...(dataset.provenance===undefined?{}:{provenance:dataset.provenance}),rows},spots:groups.size,rows:rows.length};
}

export function createTemplate({positions,stacks,scenarios,openerPosition,callerPositions=[],actionSizes=[]}){
  const invalidPosition=positions.find(value=>!POSITIONS.includes(value));if(invalidPosition)throw new Error(`Invalid template position: ${invalidPosition}.`);
  const invalidStack=stacks.find(value=>!STACKS.includes(value));if(invalidStack)throw new Error(`Invalid template stack: ${invalidStack}.`);
  const invalidScenario=scenarios.find(value=>!SCENARIOS.includes(value));if(invalidScenario)throw new Error(`Invalid template scenario: ${invalidScenario}.`);
  if(openerPosition!==undefined&&!POSITIONS.includes(openerPosition))throw new Error(`Invalid template opener: ${openerPosition}.`);
  if(callerPositions.some(value=>!POSITIONS.includes(value))||new Set(callerPositions).size!==callerPositions.length)throw new Error("Template callers must be valid and unique.");
  if(actionSizes.some(value=>!Number.isFinite(value)||value<=0))throw new Error("Template sizes must be positive numbers.");
  const lines=["hand,position,stack,scenario,openerPosition,callerPositions,actionSize,fold,passive,aggressive"];
  const sizes=actionSizes.length?actionSizes:[""];
  for(const position of positions)for(const stack of stacks)for(const scenario of scenarios)for(const actionSize of sizes)for(const hand of ALL_HANDS)lines.push(`${hand},${position},${stack},${scenario},${openerPosition??""},${callerPositions.join("+")},${actionSize},,,`);
  return `${lines.join("\n")}\n`;
}

function options(args){const result={_:[]};for(let index=0;index<args.length;index++){const value=args[index];if(value.startsWith("--")){const key=value.slice(2);const next=args[index+1];if(!next||next.startsWith("--"))throw new Error(`Option --${key} requires a value.`);result[key]=next;index++;}else result._.push(value);}return result;}
const list=(value,fallback)=>value?value.split(",").map(item=>item.trim()).filter(Boolean):fallback;
const usage=`Usage:
  npm run strategy:data -- template <output.csv> [--positions BTN,SB,BB] [--stacks 100] [--scenarios single-open] [--opener CO] [--callers BTN] [--sizes 2.5,3]
  npm run strategy:data -- convert <input.csv|json> <output.json> --id <id> --license <license> [--generated-at YYYY-MM-DD]
  npm run strategy:data -- convert-dcfr <charts.json> <output.json> --id <id> --license <license> --revision <git-sha> --iterations <n> [--seed 42] [--stack 100]
  npm run strategy:data -- validate <dataset.json>`;

export async function main(argv=process.argv.slice(2)){
  const [command,...rest]=argv;const parsed=options(rest);
  if(command==="template"){
    const [output]=parsed._;if(!output)throw new Error(usage);
    const csv=createTemplate({positions:list(parsed.positions,["BTN","SB","BB"]),stacks:list(parsed.stacks,["100"]).map(Number),scenarios:list(parsed.scenarios,["unopened"]),openerPosition:parsed.opener?.toUpperCase(),callerPositions:list(parsed.callers,[]).flatMap(value=>value.split(/[+|;]/)).map(value=>value.toUpperCase()),actionSizes:list(parsed.sizes,[]).map(Number)});
    await writeFile(output,csv,"utf8");return `Created ${output} (${csv.trim().split("\n").length-1} rows).`;
  }
  if(command==="convert"){
    const [input,output]=parsed._;if(!input||!output||!parsed.id||!parsed.license)throw new Error(usage);
    const text=await readFile(input,"utf8");let sourceRows;
    if(input.toLowerCase().endsWith(".csv"))sourceRows=parseCsv(text);else{const value=JSON.parse(text);sourceRows=Array.isArray(value)?value:value.rows;}
    const report=validateDataset({contract:CONTRACT,id:parsed.id,license:parsed.license,generatedAt:parsed["generated-at"]??new Date().toISOString().slice(0,10),rows:sourceRows});
    await writeFile(output,`${JSON.stringify(report.dataset,null,2)}\n`,"utf8");return `Wrote ${output}: ${report.spots} spots, ${report.rows} rows.`;
  }
  if(command==="convert-dcfr"){
    const [input,output]=parsed._;const iterations=Number(parsed.iterations),seed=Number(parsed.seed??42),stack=Number(parsed.stack??100);
    if(!input||!output||!parsed.id||!parsed.license||!parsed.revision||!Number.isInteger(iterations)||iterations<1||!Number.isInteger(seed)||!STACKS.includes(stack))throw new Error(usage);
    const charts=JSON.parse(await readFile(input,"utf8"));
    const provenance={generator:"exinori/DCFR-SOLVER",revision:parsed.revision,iterations,seed,model:"6-max External Sampling MCCFR with sampled-board equity and OOP pot tax",config:{stack,openSizeBb:Number(parsed["open-size"]??2.5),sbOpenSizeBb:Number(parsed["sb-open-size"]??3.5),threeBetSizeBb:Number(parsed["3bet-size"]??9),fourBetSizeBb:Number(parsed["4bet-size"]??22),oopPotTax:Number(parsed["oop-pot-tax"]??0.2)}};
    const report=validateDataset({contract:CONTRACT,id:parsed.id,license:parsed.license,generatedAt:parsed["generated-at"]??new Date().toISOString().slice(0,10),provenance,rows:convertDcfrCharts(charts,{stack})});
    await writeFile(output,`${JSON.stringify(report.dataset,null,2)}\n`,"utf8");return `Wrote ${output}: ${report.spots} DCFR RFI spots, ${report.rows} rows.`;
  }
  if(command==="validate"){
    const [input]=parsed._;if(!input)throw new Error(usage);const report=validateDataset(JSON.parse(await readFile(input,"utf8")));
    return `Valid ${report.dataset.id}: ${report.spots} spots, ${report.rows} rows, license ${report.dataset.license}.`;
  }
  throw new Error(usage);
}

if(import.meta.url===pathToFileURL(process.argv[1]??"").href)main().then(message=>process.stdout.write(`${message}\n`)).catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
