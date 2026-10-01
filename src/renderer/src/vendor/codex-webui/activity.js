/*
MIT License

Copyright (c) 2026 lezi-fun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/lezi-fun/codex-webui; public/codex-surfaces.js and public/app.js
Revision: f84909859d6f80e40aeaa984d329dd00dcc8e59d
*/

// Extraction only; group functions accept the host protocol adapter.
function shellWords(command = "") {
  return String(command).match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) || [];
}

function hasShellControl(command = "") {
  let quote = null;
  const value = String(command);
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\" && quote !== "'") { index++; continue; }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote == null) quote = char;
      continue;
    }
    if (quote !== "'" && (char === "`" || (char === "$" && value[index + 1] === "("))) return true;
    if (quote == null && (";&|<>\n\r".includes(char))) return true;
  }
  return false;
}

function explorationCommand(command = "") {
  if (hasShellControl(command)) return null;
  const words = shellWords(command);
  const name = words[0]?.split("/").at(-1);
  const hasOption = (options) => words.some((word) => options.some((option) => word === option || word.startsWith(`${option}=`)));
  if (name === "find" && hasOption(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"])) return null;
  if (name === "fd" && hasOption(["-x", "-X", "--exec", "--exec-batch"])) return null;
  if (["cat", "head", "tail", "bat", "less"].includes(name)) {
    const target = [...words.slice(1)].reverse().find((word) => !word.startsWith("-")) || "file";
    return { category: "read", detail: target, activeLabel: "Reading", completedLabel: "Read", animation: "local-context" };
  }
  if (["rg", "grep", "ag", "ack"].includes(name)) {
    const values = words.slice(1).filter((word) => !word.startsWith("-"));
    const query = values[0];
    return { category: "search", detail: query ? `for ${query}` : "files", activeLabel: "Searching", completedLabel: "Searched", animation: "searching" };
  }
  if (["ls", "find", "fd"].includes(name)) {
    const target = words.slice(1).find((word) => !word.startsWith("-")) || "files";
    return { category: "list", detail: target === "files" ? "files" : `files in ${target}`, activeLabel: "Listing", completedLabel: "Listed", animation: "local-context" };
  }
  return null;
}

export function summarizeActivity(item) {
  const status = item.status || "completed";
  const active = status === "inProgress" || status === "running" || status === "pendingInit";
  const failed = ["failed", "declined", "errored", "interrupted", "cancelled", "canceled"].includes(status);
  if (item.type === "imageView") {
    const paths = item.imagePaths || [];
    const count = paths.length;
    return {
      label: active ? "Viewing images" : failed ? "Image view failed" : count === 1 ? "Viewed image" : "Viewed images",
      detail: count === 1 ? paths[0] : count ? `${count} images` : "",
      category: "image",
      animation: "local-context",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "commandExecution") {
    const command = item.command || (item.commandActions || []).map((action) => action?.command).filter(Boolean).join("\n");
    const exploration = explorationCommand(command);
    if (exploration && !failed) return {
      label: active ? exploration.activeLabel : exploration.completedLabel,
      detail: exploration.detail,
      category: exploration.category,
      animation: exploration.animation,
      active,
      tone: active ? "active" : "success",
    };
    return {
      label: active ? "Running command" : failed ? "Command failed" : "Ran command",
      detail: command || "",
      category: "command",
      animation: "run-command",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "fileChange") {
    const count = item.changes?.length || 0;
    return {
      label: active ? "Editing files" : failed ? "File edit failed" : count === 1 ? "Edited a file" : "Edited files",
      detail: (item.changes || []).map((change) => change.path || change.filePath).filter(Boolean).join(", "),
      animation: "edit-files",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "collabAgentToolCall") {
    const receivers = item.receiverThreadIds || [];
    const count = receivers.length;
    const labels = {
      spawnAgent: ["Starting side task", "Started side task"],
      sendInput: ["Sending input to side task", "Sent input to side task"],
      resumeAgent: ["Resuming side task", "Resumed side task"],
      wait: ["Waiting for side tasks", "Waited for side tasks"],
      closeAgent: ["Closing side task", "Closed side task"],
    };
    const [activeLabel, completedLabel] = labels[item.tool] || ["Updating side task", "Updated side task"];
    return {
      label: active ? activeLabel : failed ? "Side task failed" : completedLabel,
      detail: item.prompt || (count ? `${count} side task${count === 1 ? "" : "s"}` : ""),
      category: "side-task",
      animation: "local-context",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "subAgentActivity") return {
    label: item.kind === "interrupted" ? "Side task interrupted" : item.kind === "interacted" ? "Side task active" : "Side task started",
    detail: item.agentPath || item.agentThreadId || "",
    category: "side-task",
    animation: "local-context",
    active: item.kind !== "interrupted" && active,
    tone: item.kind === "interrupted" ? "error" : active ? "active" : "success",
  };
  if (item.type === "webSearch") return {
    label: active ? "Searching the web" : failed ? "Search failed" : "Searched the web",
    detail: item.query || "",
    animation: "searching",
    active,
    tone: failed ? "error" : active ? "active" : "success",
  };
  if (item.type === "reasoning") return { label: active ? "Thinking" : "Thought", detail: "", animation: "local-context", active, tone: failed ? "error" : active ? "active" : "success" };
  return { label: active ? "Working" : failed ? "Tool failed" : "Completed", detail: item.tool || item.type || "", animation: "local-context", active, tone: failed ? "error" : active ? "active" : "success" };
}

export function joinActivityParts(parts){return parts.length<2?parts[0]||'Worked':`${parts.slice(0,-1).join(', ')} and ${parts.at(-1)}`}

export function completedActivitySummary(items, describe = summarizeActivity){const summaries=items.map(item=>({item,data:describe(item)})),commands=summaries.filter(({item,data})=>item.type==='commandExecution'&&data.category==='command').length,explored=summaries.some(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error'),edits=summaries.filter(({item,data})=>item.type==='fileChange'&&data.tone!=='error').reduce((count,{item})=>count+Math.max(1,item.changes?.length||0),0),web=summaries.some(({item,data})=>item.type==='webSearch'&&data.tone!=='error'),images=summaries.some(({data})=>data.category==='image'&&data.tone!=='error'),failed=summaries.some(({data})=>data.tone==='error'),parts=[],add=(leading,following)=>parts.push(parts.length?following:leading);if(edits)add(edits===1?'Edited a file':'Edited files',edits===1?'edited a file':'edited files');if(explored)add('Read files','read files');if(commands)add(commands===1?'Ran a command':'Ran commands',commands===1?'ran a command':'ran commands');if(web)add('Searched the web','searched the web');if(images)add('Viewed images','viewed images');if(!parts.length&&failed)return'Activity failed';return joinActivityParts(parts)}

export function completedActivityPrimaryItem(items, describe = summarizeActivity){const summaries=items.map(item=>({item,data:describe(item)})),find=predicate=>summaries.find(predicate)?.item;return find(({item,data})=>item.type==='fileChange'&&data.tone!=='error')||find(({data})=>['read','search','list'].includes(data.category)&&data.tone!=='error')||find(({data})=>data.category==='command'&&data.tone!=='error')||find(({item,data})=>item.type==='webSearch'&&data.tone!=='error')||find(({data})=>data.category==='image'&&data.tone!=='error')||items.find(item=>describe(item).tone==='error')||items[0]}

