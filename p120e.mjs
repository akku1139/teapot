import { Agent } from "./src/agent/agent.ts";
import { readEvents } from "./src/log/events.ts";
import { mkdtempSync } from "node:fs"; import os from "node:os"; import path from "node:path";
const ws = mkdtempSync(path.join(os.tmpdir(),"w3-")), sd = mkdtempSync(path.join(os.tmpdir(),"s3-"));
let turn=0, parked=false, signal=null;
const KID = { id:"kid", status:"running" };
const a = new Agent({
  id:"p", workspace:ws, sessionDir:sd, llm:{baseUrl:"http://x",apiKey:"k",model:"m"},
  chatFn: async () => { turn++;
    if (turn===1) return { message:{role:"assistant",content:"",
      tool_calls:[{id:"w1",type:"function",function:{name:"wait_children",arguments:"{\"timeout_ms\":60000}"}}]}};
    return { message:{role:"assistant",content:"ok"} }; },
  autoContinue:false,
});
await a.init();
await a.setGoal("g");
// wire subAgents the way master.ts does: into the toolCtx, with the abort signal
const ctrl = new AbortController();
a.toolCtx.signal = ctrl.signal;
a.toolCtx.subAgents = {
  list: () => [KID],
  spawn: async () => ({ id: "x" }),
  message: async () => {},
  kill: async () => {},
  wait: (ids, ms) => {
    parked = true;
    return new Promise(res => { const t = setInterval(() => {}, 50);
      const done = (n) => { clearInterval(t); res({ note: n }); };
      ctrl.signal.addEventListener("abort", () => done("aborted while waiting"), { once: true });
    });
  },
};
a.enqueuePrompt("go","user"); a.start("t");
await new Promise(r => setTimeout(r,400));
console.log("parked:", parked, "| agent status:", a.snapshot().status, "| isLive:", a.isLive?.());
console.log("");
console.log("--- now send a prompt mid-park (the reported trigger) ---");
a.enqueuePrompt("are you there?", "user");
await new Promise(r => setTimeout(r,900));
const evs = await readEvents(`${sd}/chat.jsonl`);
const call = evs.find(e=>e.type==="tool_call"), res = evs.find(e=>e.type==="tool_result");
console.log("tool_call  :", !!call, call ? call.data.callId : "");
console.log("tool_result:", !!res,  res  ? String(res.data.result).slice(0,50) : "");
console.log("");
console.log(res ? "=> completes on the prompt path" : "=> NO tool_result: the row stays pending (#120)");
await a.dispose();
