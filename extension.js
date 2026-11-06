const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFile = promisify(cp.execFile);

const API = 'https://openrouter.ai/api/v1';
const KEY_NAME = 'openrouter.apiKey';

function workspaceRoot() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open a folder/workspace before using the agent.');
  return folder.uri.fsPath;
}

function insideWorkspace(root, requested) {
  const target = path.resolve(root, requested || '.');
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('That path is outside the workspace.');
  return target;
}

function safeRelative(root, absolute) { return path.relative(root, absolute).split(path.sep).join('/'); }

async function tree(root, dir = root, depth = 0, lines = []) {
  if (depth > 3 || lines.length >= 220) return lines;
  const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next']);
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return lines; }
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    lines.push(`${'  '.repeat(depth)}${entry.isDirectory() ? '📁' : '📄'} ${safeRelative(root, full)}`);
    if (entry.isDirectory()) await tree(root, full, depth + 1, lines);
    if (lines.length >= 220) break;
  }
  return lines;
}

const tools = [
  { type: 'function', function: { name: 'list_files', description: 'List the project tree, up to three levels deep.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_text', description: 'Search text in workspace files. Use this before editing when you need to find implementations or references.', parameters: { type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string', description: 'Optional ripgrep glob, e.g. *.js' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or replace a UTF-8 file in the workspace. Use only for intentional changes.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'replace_in_file', description: 'Safely replace one exact, unique text block in a UTF-8 workspace file. Prefer this for focused changes.', parameters: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'search', 'replace'] } } },
  { type: 'function', function: { name: 'get_diagnostics', description: 'Read current VS Code errors and warnings for workspace files.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'git_diff', description: 'Show uncommitted workspace changes so edits can be reviewed.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a non-interactive development/test/debug command at the workspace root. Never use destructive commands, delete broad paths, or expose secrets.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'number' } }, required: ['command'] } } }
];

function blockedCommand(command) {
  return /(^|[;&|]\s*)(rm\s+-rf|git\s+reset\s+--hard|git\s+clean|mkfs|dd\s|shutdown|reboot|sudo\b)/i.test(command);
}

async function callTool(name, raw, root) {
  let args;
  try { args = JSON.parse(raw || '{}'); } catch { throw new Error('Model supplied invalid tool JSON.'); }
  if (name === 'list_files') return (await tree(root)).join('\n') || '(workspace is empty)';
  if (name === 'read_file') {
    const file = insideWorkspace(root, args.path);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('Not a file: ' + args.path);
    const content = await fs.readFile(file, 'utf8');
    return content.length > 60000 ? content.slice(0, 60000) + '\n[truncated]' : content;
  }
  if (name === 'search_text') {
    const rgArgs = ['-n', '--hidden', '--glob', '!.git', '--glob', '!node_modules', '--glob', '!.venv'];
    if (args.glob) rgArgs.push('--glob', args.glob);
    rgArgs.push(args.query, root);
    try {
      const result = await execFile('rg', rgArgs, { cwd: root, timeout: 15000, maxBuffer: 1024 * 1024 });
      return (result.stdout || '').slice(0, 60000) || '(no matches)';
    } catch (error) {
      if (error.code === 1) return '(no matches)';
      return `Search failed: ${error.message}`;
    }
  }
  if (name === 'write_file') {
    const file = insideWorkspace(root, args.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, args.content, 'utf8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
    return `Wrote ${args.path} (${args.content.length} characters).`;
  }
  if (name === 'replace_in_file') {
    const file = insideWorkspace(root, args.path);
    const before = await fs.readFile(file, 'utf8');
    const matches = before.split(args.search).length - 1;
    if (matches !== 1) throw new Error(`Expected one exact match in ${args.path}, found ${matches}. Read the file and retry with a unique block.`);
    await fs.writeFile(file, before.replace(args.search, args.replace), 'utf8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
    return `Updated one exact block in ${args.path}.`;
  }
  if (name === 'get_diagnostics') {
    const items = vscode.languages.getDiagnostics().filter(([uri]) => {
      if (uri.scheme !== 'file') return false;
      try { insideWorkspace(root, uri.fsPath); return true; } catch { return false; }
    });
    const result = items.flatMap(([uri, diagnostics]) => diagnostics.map(d => `${safeRelative(root, uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1} [${['Error', 'Warning', 'Information', 'Hint'][d.severity] || 'Unknown'}] ${d.message}`));
    return result.slice(0, 250).join('\n') || '(no VS Code diagnostics)';
  }
  if (name === 'git_diff') {
    try { const result = await execFile('git', ['diff', '--', '.'], { cwd: root, timeout: 15000, maxBuffer: 1024 * 1024 }); return result.stdout.slice(0, 60000) || '(no uncommitted diff)'; }
    catch (error) { return `Git diff unavailable: ${error.stderr || error.message}`; }
  }
  if (name === 'run_command') {
    if (blockedCommand(args.command)) throw new Error('Blocked potentially destructive command.');
    const timeout = Math.min(Math.max(Number(args.timeout_seconds || 45), 5), 120) * 1000;
    try {
      const result = await execFile('/bin/bash', ['-lc', args.command], { cwd: root, timeout, maxBuffer: 1024 * 1024 });
      return `Exit code: 0\n${[result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 60000) || '(command completed with no output)'}`;
    } catch (error) {
      return `Exit code: ${error.code ?? 'unknown'}\n${[error.stdout, error.stderr, error.message].filter(Boolean).join('\n').slice(0, 60000)}`;
    }
  }
  throw new Error('Unknown tool: ' + name);
}

async function openRouter(key, body) {
  const response = await fetch(`${API}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://code.visualstudio.com', 'X-Title': 'OpenRouter Code Agent' }, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

async function importFilesIntoWorkspace(root) {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true, canSelectFolders: false, canSelectMany: true,
    title: 'Choose files to copy into this workspace for the coding agent'
  });
  if (!selected?.length) return [];
  const uploadDir = insideWorkspace(root, 'uploads');
  await fs.mkdir(uploadDir, { recursive: true });
  const imported = [];
  for (const uri of selected) {
    const source = uri.fsPath;
    const info = await fs.stat(source);
    if (!info.isFile()) continue;
    if (info.size > 25 * 1024 * 1024) throw new Error(`${path.basename(source)} is larger than the 25 MB upload limit.`);
    const parsed = path.parse(path.basename(source));
    let target = path.join(uploadDir, parsed.base), index = 2;
    while (true) { try { await fs.access(target); target = path.join(uploadDir, `${parsed.name}-${index++}${parsed.ext}`); } catch { break; } }
    await fs.copyFile(source, target);
    imported.push(safeRelative(root, target));
  }
  return imported;
}

function panelHtml(webview) {
  const nonce = String(Date.now());
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
  body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)} input,select,textarea,button{box-sizing:border-box;width:100%;margin:5px 0;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);font:inherit}textarea{height:130px;resize:vertical}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}.row{display:flex;gap:8px}.row>*{flex:1}#log{white-space:pre-wrap;line-height:1.45;border-top:1px solid var(--vscode-panel-border);padding-top:10px;min-height:190px}.muted{opacity:.7;font-size:.9em} .status{font-size:.9em;color:var(--vscode-descriptionForeground)}</style></head><body>
  <h2>OpenRouter Code Agent</h2><div class="muted">The agent works only inside the opened workspace. Keys are stored in VS Code Secret Storage.</div>
  <label>OpenRouter API key</label><div class="row"><input id="key" type="password" placeholder="sk-or-v1-…"><button id="save" style="max-width:105px">Save key</button></div>
  <label>Free model</label><div class="row"><select id="model"><option>Save a key, then load models</option></select><button id="models" style="max-width:130px">Load free models</button></div>
  <div class="status" id="status">Ready.</div><label>Task</label><textarea id="task" placeholder="Example: Analyze this codebase, find why the tests fail, fix the smallest issue, and run the relevant test."></textarea>
  <div class="row"><button id="analyze">Analyze codebase</button><button id="upload">Upload files</button><button id="send">Run agent</button></div><h3>Agent activity</h3><div id="log">Waiting for a task.</div>
  <script nonce="${nonce}">const vscode=acquireVsCodeApi(), $=id=>document.getElementById(id);let running=false;
  function log(x){$('log').textContent+='\\n\\n'+x;$('log').scrollTop=$('log').scrollHeight} function status(x){$('status').textContent=x}
  $('save').onclick=()=>vscode.postMessage({type:'saveKey',key:$('key').value}); $('models').onclick=()=>vscode.postMessage({type:'models'});
  $('upload').onclick=()=>vscode.postMessage({type:'upload'});
  $('analyze').onclick=()=>{$('task').value='Analyze this codebase. Explain its architecture, identify likely issues, and suggest the smallest high-value next change. Do not modify files unless I explicitly ask.';$('send').click()};
  $('send').onclick=()=>{if(running)return;const task=$('task').value.trim();if(!task)return;running=true;$('log').textContent='';status('Agent is working…');vscode.postMessage({type:'run',task,model:$('model').value})};
  window.addEventListener('message',e=>{const m=e.data;if(m.type==='status')status(m.text);if(m.type==='log')log(m.text);if(m.type==='models'){$('model').innerHTML=m.models.map(x=>'<option value="'+x.id+'">'+x.name+'</option>').join('');status(m.models.length+' tool-capable free models loaded.')}if(m.type==='uploaded'){log('Uploaded: '+m.files.join(', '));status('Files are ready in uploads/. Ask the agent to inspect them.')}if(m.type==='done'){running=false;status('Ready.')}});
  </script></body></html>`;
}

function attachAgentWebview(webview, context) {
    webview.options = { enableScripts: true };
    webview.html = panelHtml(webview);
    webview.onDidReceiveMessage(async m => {
      try {
        if (m.type === 'saveKey') { if (!m.key?.trim()) throw new Error('Paste an API key first.'); await context.secrets.store(KEY_NAME, m.key.trim()); webview.postMessage({type:'status',text:'API key saved securely.'}); return; }
        if (m.type === 'upload') {
          const files = await importFilesIntoWorkspace(workspaceRoot());
          if (files.length) webview.postMessage({type:'uploaded',files});
          else webview.postMessage({type:'status',text:'No file was uploaded.'});
          return;
        }
        const key = await context.secrets.get(KEY_NAME); if (!key) throw new Error('Save your OpenRouter API key first.');
        if (m.type === 'models') {
          const r = await fetch(`${API}/models`, {headers:{Authorization:`Bearer ${key}`}}); if (!r.ok) throw new Error('Could not load models: '+r.status);
          const data = await r.json(); const models = data.data.filter(x => (x.id.endsWith(':free') || (Number(x.pricing?.prompt) === 0 && Number(x.pricing?.completion) === 0)) && x.supported_parameters?.includes('tools')).map(x=>({id:x.id,name:x.name || x.id})).sort((a,b)=>a.name.localeCompare(b.name));
          if (!models.length) throw new Error('No free models with tool support are available right now. Reload models later; code agents need tool support to read and edit files.');
          webview.postMessage({type:'models',models}); return;
        }
        if (m.type === 'run') {
          const root = workspaceRoot(); const model = m.model; if (!model || model.startsWith('Save a key')) throw new Error('Load and choose a free model first.');
          const system = `You are a careful senior software engineer operating inside a VS Code workspace. You have tools to inspect, search, edit, review diagnostics/diff, and run tests. Work only on the requested task. First inspect enough code to understand it. Make minimal, correct changes. After an edit, run the relevant test or diagnostic whenever feasible. Read tool output carefully, especially a nonzero command exit code, and fix the actual cause. Finish with a concise summary of changes and verification. Never access outside the workspace, reveal secrets, use destructive commands, or claim verification you did not perform.`;
          const messages = [{role:'system',content:system},{role:'user',content:`Workspace root: ${root}\n\nTask: ${m.task}`}];
          const max = vscode.workspace.getConfiguration('openrouterCodeAgent').get('maxToolRounds', 12);
          for (let round=0; round<max; round++) {
            webview.postMessage({type:'status',text:`Agent reasoning (${round+1}/${max})…`});
            const data = await openRouter(key, {model,messages,tools,tool_choice:'auto',temperature:0.2}); const msg=data.choices?.[0]?.message; if (!msg) throw new Error('Model returned no message.');
            messages.push(msg); if (msg.content) webview.postMessage({type:'log',text:msg.content});
            if (!msg.tool_calls?.length) break;
            for (const tool of msg.tool_calls) { webview.postMessage({type:'log',text:`→ ${tool.function.name}(${tool.function.arguments})`}); let output; try { output=await callTool(tool.function.name,tool.function.arguments,root); } catch(e) { output='Tool error: '+e.message; } messages.push({role:'tool',tool_call_id:tool.id,content:output}); webview.postMessage({type:'log',text:output.slice(0,2000)}); }
          }
          webview.postMessage({type:'done'});
        }
      } catch (e) { webview.postMessage({type:'log',text:'Error: '+e.message}); webview.postMessage({type:'done'}); }
    }, null, context.subscriptions);
}

function activate(context) {
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('openrouterCodeAgent.sidebar', {
    resolveWebviewView(view) { attachAgentWebview(view.webview, context); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('openrouterCodeAgent.open', () => {
    const panel = vscode.window.createWebviewPanel('openrouterCodeAgent', 'OpenRouter Code Agent', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    attachAgentWebview(panel.webview, context);
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
