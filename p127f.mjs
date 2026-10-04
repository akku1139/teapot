// #127 with REAL logged history, so restoreFromLog() has something to load.
import { Agent } from "./src/agent/agent.ts";
import { mkdtempSync } from "node:fs"; import os from "node:os"; import path from "node:path";
const ws=mkdtempSync(path.join(os.tmpdir(),"w127f-")), sd=mkdtempSync(path.join(os.tmpdir(),"s127f-"));
let release=()=>{}; const gate=new Promise(r=>{release=r;});
let n=0;
const a=new Agent({id:"c",workspace:ws,sessionDir:sd,
  llm:{baseUrl:"http://x",apiKey:"k",model:"m"},
  chatFn: async()=>{ n++; await gate; return { message:{role:"assistant",content:"SUMMARY"} }; },
  autoContinue:false, contextTokenBudget: 400});
await a.init(); await a.setGoal("g");
// log real prompt/answer pairs through the normal path
for (let i=0;i<25;i++){
  a.enqueuePrompt("question ".repeat(300),"user");
  await a.runOnce?.().catch(()=>{});
}
process.exit(0);
