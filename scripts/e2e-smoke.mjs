import { chromium } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const baseURL=process.env.E2E_BASE_URL??"http://localhost:3002";
const cacheRoot=join(process.env.LOCALAPPDATA??"","ms-playwright");
const executablePath=existsSync(cacheRoot)?readdirSync(cacheRoot).filter(name=>name.startsWith("chromium_headless_shell-")).sort().reverse().map(name=>join(cacheRoot,name,"chrome-headless-shell-win64","chrome-headless-shell.exe")).find(existsSync):undefined;
const browser=await chromium.launch({headless:true,executablePath});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
try{
  await page.goto(baseURL,{waitUntil:"networkidle"});
  await page.getByRole("button",{name:/6-MAX/}).click();
  const ranks="AKQJT98765432";
  const hands=[...ranks].flatMap((high,row)=>[...ranks].map((low,column)=>row===column?`${high}${low}`:row<column?`${high}${low}s`:`${low}${high}o`));
  const dataset={id:"e2e-v1",license:"MIT",generatedAt:"2026-08-26",rows:hands.map(hand=>({hand,position:"BTN",stack:100,scenario:"unopened",fold:10,passive:20,aggressive:70}))};
  await page.locator('.strategy-import input[type="file"]').setInputFiles({name:"e2e-strategy.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(dataset))});
  await page.getByText(/e2e-v1 · 1 spots · MIT/).waitFor({state:"attached"});
  if(!(await page.locator(".strategy-import summary").innerText()).includes("e2e-v1"))throw new Error("Imported strategy dataset source was not displayed.");
  await page.locator(".strategy-import summary").click();
  await page.getByRole("button",{name:"BASELINE으로 복원"}).click();
  if(!(await page.locator(".strategy-import summary").innerText()).includes("baseline-v1"))throw new Error("Strategy dataset did not reset to baseline.");
  await page.getByRole("button",{name:"CO",exact:true}).last().click();
  await page.locator(".seat").filter({hasText:"CO"}).click();
  await page.getByRole("button",{name:"Open",exact:true}).click();
  await page.getByRole("button",{name:"Call",exact:true}).click();
  await page.locator(".seat").filter({hasText:"BB"}).click();
  await page.getByRole("button",{name:"Fold",exact:true}).click();
  await page.waitForTimeout(300);
  if(await page.locator(".postflop-builder").count()===0){
    const currentActor=await page.locator(".selected-player").innerText();
    const historyBeforeFlop=await page.locator(".history-strip").innerText();
    throw new Error(`Postflop did not open. Current=${currentActor}; History=${historyBeforeFlop}`);
  }
  if(await page.locator(".side-pot-list").count()!==0)throw new Error("A normal raised pot was incorrectly split into side pots.");
  await page.locator(".preflop-complete-card").waitFor();
  await page.locator(".board-entry input").nth(0).fill("2c");
  await page.locator(".board-entry input").nth(1).fill("7d");
  await page.locator(".board-entry input").nth(2).fill("Jh");
  const solverButton=page.getByRole("button",{name:"LOCAL TEXASSOLVER 실행"});
  if(!(await solverButton.isEnabled()))throw new Error("Local solver button did not activate for heads-up flop Hero OOP.");
  await solverButton.click();
  await Promise.race([
    page.getByText("SOLVER STRATEGY",{exact:true}).waitFor({timeout:120000}),
    page.locator(".validation-message").waitFor({state:"visible",timeout:120000}).then(async()=>{throw new Error(`Local solver failed: ${await page.locator(".validation-message").innerText()}`);}),
  ]);
  if(!(await page.locator(".equity-result").innerText()).includes("EQUITY"))throw new Error("Local solver did not calculate the range-weighted equity used for model EV.");
  await page.locator(".postflop-actions button").filter({hasText:"Check"}).click();
  await page.locator(".postflop-actions button").filter({hasText:"Check"}).click();
  await page.locator(".advance-street").click();
  await page.locator(".board-entry input").nth(3).fill("Kh");
  if(!(await page.locator(".local-solver-button").isEnabled()))throw new Error("Local solver button did not activate for a heads-up turn root.");
  const potText=await page.locator(".postflop-status").innerText();
  const history=await page.locator(".history-strip").innerText();
  await page.screenshot({path:"artifacts/e2e-smoke.png",fullPage:true});
  process.stdout.write(JSON.stringify({ok:true,potText,history,solverEnabled:true,turnSolverEnabled:true},null,2));
}catch(error){await page.screenshot({path:"artifacts/e2e-failure.png",fullPage:true});throw error;}finally{await browser.close();}
