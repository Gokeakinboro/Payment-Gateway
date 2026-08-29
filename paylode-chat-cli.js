'use strict';
// Paylode · Harish · Engineering Assistant
// Uses the installed claude CLI (your Claude Code subscription — no extra credits needed).
// Run: node paylode-chat-cli.js

const readline  = require('readline');
const { execSync } = require('child_process');
const path = require('path');

// Load API key from .env at repo root
try { require(path.join(__dirname,'backend/node_modules/dotenv')).config({ path:path.join(__dirname,'.env') }); }
catch(_) { try { require('dotenv').config({ path:path.join(__dirname,'.env') }); } catch(_) {} }

let Anthropic;
try { Anthropic = require(path.join(__dirname,'backend/node_modules/@anthropic-ai/sdk')); }
catch(_) { Anthropic = require('@anthropic-ai/sdk'); }

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set in .env'); process.exit(1); }

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m',
  cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m',
  red:'\x1b[31m', gray:'\x1b[90m', white:'\x1b[97m',
};

const SYSTEM_CTX = `Your name is Harish. You are the Paylode engineering assistant.
Paylode is a CBN-licensed Nigerian payment gateway (PSSP).

Session: 2026-08-28 9am WAT — Parallex Bank meeting to restore NIP payouts.
Server 176.57.188.45. VPN: IPSec → Parallex FortiGate 102.220.220.19 (via DO 165.22.21.63).
Pilot endpoint: https://tptintegration.parallexbank.com/ThirdPartyTransferAPI (HTTPS 443, over VPN).
Credentials: USERNAME=Paylode, DEBIT_ACCOUNT=1000362849, SUBKEY=a600c3bcaa98463391a05ddc713f706e.
Status: Login OK · Balance OK (N7,711.27) · NameEnquiry OK (~5s) · InterbankTransfer TCP RST ~131s (Parallex APIM timeout bug).
VA and MPGS: working — do NOT change.
Smoke test: ssh root@176.57.188.45 then: cd /opt/paylode-api/backend && node test/parallex-tpt-smoke.js --pilot
Be concise and technical.`;

function now() {
  return new Date().toLocaleTimeString('en-NG',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}

function printHeader() {
  console.clear();
  console.log(C.cyan+C.bold+'╔════════════════════════════════════════════════════════════╗'+C.reset);
  console.log(C.cyan+C.bold+'║       PAYLODE  ·  Harish  ·  Engineering Assistant          ║'+C.reset);
  console.log(C.cyan+C.bold+'╚════════════════════════════════════════════════════════════╝'+C.reset);
  console.log(C.gray+'  Parallex TPT session · 2026-08-28 · 176.57.188.45'+C.reset);
  console.log(C.gray+'  /run <shell cmd>   /clear   /exit'+C.reset);
  console.log('');
}

function printUser(msg) {
  console.log(C.green+C.bold+'  You  '+C.reset+C.gray+now()+C.reset);
  console.log('  '+msg); console.log('');
}

function printAssistant(msg) {
  console.log(C.cyan+C.bold+'  Harish  '+C.reset+C.gray+now()+C.reset);
  for (const line of msg.split('\n')) {
    if (line.length <= 74) { console.log('  '+line); continue; }
    const words = line.split(' '); let cur = '';
    for (const w of words) {
      if ((cur+' '+w).trim().length > 74) { console.log('  '+cur.trim()); cur = w; }
      else cur = (cur+' '+w).trim();
    }
    if (cur) console.log('  '+cur);
  }
  console.log('');
}

function printSystem(msg) { console.log(C.yellow+'  » '+msg+C.reset+'\n'); }
function printError(msg)  { console.log(C.red   +'  ✗ '+msg+C.reset+'\n'); }

function runCmd(cmd) {
  printSystem('$ '+cmd);
  try {
    const out = execSync(cmd, { timeout:180000, encoding:'utf8' });
    if (out.trim()) console.log(C.white+out.trimEnd()+C.reset+'\n');
  } catch(e) { printError((e.stdout||'')+(e.stderr||'')||e.message); }
}

const history = [];

async function askHarish(userMsg) {
  history.push({ role:'user', content:userMsg });
  if (history.length > 40) history.splice(0, 2);

  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let fi = 0;
  const spin = setInterval(() => {
    process.stdout.write('\r'+C.gray+'  '+frames[fi++%frames.length]+' Harish is thinking...'+C.reset);
  }, 80);

  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_CTX,
      messages: history,
    });
    clearInterval(spin);
    process.stdout.write('\r\x1b[K');
    const reply = res.content[0]?.type === 'text' ? res.content[0].text : '(no response)';
    history.push({ role:'assistant', content:reply });
    printAssistant(reply);
  } catch(e) {
    clearInterval(spin);
    process.stdout.write('\r\x1b[K');
    printError('API error: '+e.message);
  }
}

// ── REPL ──────────────────────────────────────────────────────────────────────
printHeader();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: C.green+C.bold+'  > '+C.reset,
  historySize: 100,
});

rl.prompt();

rl.on('line', (line) => {
  const input = line.trim();
  if (!input) { rl.prompt(); return; }
  if (input === '/exit' || input === '/quit') {
    console.log(C.gray+'\n  Session ended.\n'+C.reset); process.exit(0);
  }
  if (input === '/clear') { printHeader(); rl.prompt(); return; }
  if (input.startsWith('/run ')) { runCmd(input.slice(5).trim()); rl.prompt(); return; }

  printUser(input);
  rl.pause();
  askHarish(input).then(() => { rl.resume(); rl.prompt(); });
});

let pending = false;
rl.on('close', () => {
  if (!pending) { console.log(C.gray+'\n  Session ended.\n'+C.reset); process.exit(0); }
});
