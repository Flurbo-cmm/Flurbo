import { Link } from 'wouter';
import DocsShot from './DocsShot';
import researchShot from './docs-media/agent-research.png';
import runShot from './docs-media/agent-run.png';
import { SHOT_SIZE } from './docs-media/sizes';

// A step-by-step guide for someone who has never run a trading bot: what each step does, why it is
// needed, exactly what to type, and what they should see. Python is used because it needs the least setup.
const Code = ({ children }: { children: string }) => <pre className="docs-code"><code>{children}</code></pre>;
const Os = ({ windows, mac }: { windows: string; mac: string }) => <div className="docs-os">
  <div><span className="docs-os-label">Windows (PowerShell)</span><Code>{windows}</Code></div>
  <div><span className="docs-os-label">macOS or Linux (Terminal)</span><Code>{mac}</Code></div>
</div>;

const RESEARCH_BLOCK = `"research": {
  "provider": {
    "kind": "anthropic",
    "model": "PUT-THE-MODEL-NAME-HERE",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "retriever": { "kind": "http", "allowHosts": ["github.com"] },
  "evidenceRequirements": {
    "pilot": [
      { "event": 0, "freshness": "background" },
      { "event": 1, "freshness": "background" }
    ]
  },
  "perCycle": 2,
  "perHour": 20,
  "maxEvidenceAgeDays": 14
},`;

export default function FirstBotGuide() {
  return <section id="first-bot" aria-labelledby="first-bot-title">
    <h2 id="first-bot-title">Your first trading bot, step by step</h2>
    <p>This guide takes you from nothing to a bot that makes practice decisions on a Flurbo market, then, only if you choose, real testnet trades. Every step says what to do, why it is needed and what you should see. Allow about 30 minutes. You will type a few commands; each one is explained, and you can copy them exactly.</p>
    <p>A bot here is a small program on your own computer. Every few minutes it reads a market, gathers public evidence (such as a project's release page), asks an AI model for a forecast, compares that forecast with the market price, and decides whether to buy. Flurbo does not run it for you; Flurbo only shows what it reports and the trades it makes.</p>

    <div className="docs-note"><strong>Four safety rules before you start</strong><ul>
      <li><strong>Use a separate wallet for the bot.</strong> Never give a bot the wallet you use yourself. If something goes wrong, only the bot's small balance is at risk.</li>
      <li><strong>Never share its private key or its Flurbo token.</strong> Not with Flurbo, not in a chat, not in a screenshot. Flurbo will never ask for them.</li>
      <li><strong>Start in practice mode (paper).</strong> Paper mode records what the bot would have done without spending anything. Only switch to live trades once its decisions look sensible to you.</li>
      <li><strong>Keep the amounts small.</strong> A live bot can only spend what is in its wallet, and Flurbo also limits it to 2 test AUSD per trade and 10 per day unless you change that.</li>
    </ul></div>

    <h3>What you need</h3>
    <ul>
      <li>A Flurbo account with testnet access, and MetaMask with a little test MON and test AUSD (see <a href="#getting-started">Getting started</a>).</li>
      <li>A computer where you can install software (Windows, macOS or Linux).</li>
      <li>The Flurbo agent kit for Python. The SDK is not public yet, so ask the Flurbo team for it through the channel where you received your invitation. You will get a folder named <code>sdk-python</code>.</li>
      <li>An API key from an AI provider (this guide uses Anthropic; any OpenAI-compatible provider also works). Each forecast is a paid request to that provider, so check its prices. The bot makes at most 2 requests per cycle and 20 per hour by default.</li>
    </ul>

    <ol className="docs-steps docs-guide">
      <li><strong>Install Python.</strong>
        <p><em>Why:</em> the bot is a Python program. It needs Python 3.11 or newer.</p>
        <p>Download it from python.org and install it. On Windows, tick <em>Add python.exe to PATH</em> in the installer. Then open a terminal (Windows: search for <em>PowerShell</em>; macOS: <em>Terminal</em>) and check the version:</p>
        <Os windows="py --version" mac="python3 --version"/>
        <p><em>You should see</em> <code>Python 3.11</code> or a higher number.</p>
      </li>

      <li><strong>Open the kit folder and set it up.</strong>
        <p><em>Why:</em> this creates a private space for the bot's software, so it does not interfere with anything else on your computer, and installs the bot into it.</p>
        <p>Put the <code>sdk-python</code> folder somewhere easy to find, such as your Documents folder. In the terminal, go into it and run these three lines one at a time:</p>
        <Os windows={'cd $HOME\\Documents\\sdk-python\npy -m venv .venv\n.venv\\Scripts\\Activate.ps1\npython -m pip install -e .'} mac={'cd ~/Documents/sdk-python\npython3 -m venv .venv\nsource .venv/bin/activate\npython -m pip install -e .'}/>
        <p><code>cd</code> moves into the folder. The <code>venv</code> line creates the private space, the next line switches it on (your prompt now starts with <code>(.venv)</code>), and <code>pip install</code> installs the bot. <em>You should see</em> <code>Successfully installed flurbo-sdk</code>.</p>
        <p>If Windows says running scripts is disabled, run <code>Set-ExecutionPolicy -Scope CurrentUser RemoteSigned</code> once, answer <code>Y</code>, and try again. Every time you open a new terminal later, run the <code>cd</code> line and the activate line again before using the bot.</p>
      </li>

      <li><strong>Create the bot's own wallet.</strong>
        <p><em>Why:</em> the bot signs its trades with this wallet, so its key must live on your computer, and it must not be your personal wallet.</p>
        <p>In MetaMask, open the account menu, choose <em>Add account</em> and name it <em>Flurbo bot</em>. Copy its address (starts with <code>0x</code>). Then open <em>Account details</em>, choose <em>Show private key</em> and copy the key. You will paste it into the terminal in the next step; do not save it in a document or send it anywhere.</p>
      </li>

      <li><strong>Tell the terminal the bot's secrets.</strong>
        <p><em>Why:</em> the bot reads its key from the terminal session instead of a file, so the key is never written into a file you might share.</p>
        <Os windows={'$env:FLURBO_AGENT_PRIVATE_KEY="0x...paste the bot wallet key..."'} mac={'export FLURBO_AGENT_PRIVATE_KEY="0x...paste the bot wallet key..."'}/>
        <p>This only lasts until you close the terminal. You will add two more secrets the same way in steps 6 and 7.</p>
      </li>

      <li><strong>Register the bot on Flurbo and prove the wallet is yours.</strong>
        <p><em>Why:</em> Flurbo only credits the bot with trades from a wallet it has proven it controls.</p>
        <ol>
          <li>Open <Link href="/agents">Agents</Link>, type a name, keep the market ticked and choose <em>Register agent</em>.</li>
          <li>On the agent's page, open <em>Setup</em>, paste the bot wallet address and choose <em>Get ownership message</em>. The message expires after 5 minutes, so do the next steps straight away.</li>
          <li>Copy the whole message, save it as a plain text file named <code>message.txt</code> inside the <code>sdk-python</code> folder, and first create the bot's settings file (the bot needs it for every command). The Setup page shows the <code>init</code> line with your agent's exact market names after <code>--markets</code>; copy that line rather than typing them:</li>
        </ol>
        <Code>{'python -m flurbo_sdk init --config flurbo-agent.json --markets <market names from the Setup page>\npython -m flurbo_sdk sign-message --config flurbo-agent.json --file message.txt'}</Code>
        <p><em>You should see</em> a long line starting with <code>0x</code>: that is the signature. It proves ownership and cannot move funds. Paste it into the <em>Signature</em> box on Flurbo and choose <em>Verify and associate</em>. The page then shows <em>Associated wallet</em>.</p>
      </li>

      <li><strong>Create the bot's Flurbo token.</strong>
        <p><em>Why:</em> the token lets the bot read markets and report what it does. It cannot move funds.</p>
        <p>Under <em>API credentials</em> on the Setup page, keep all four boxes ticked, give it a label and choose <em>Issue credential</em>. The token is shown only once. Copy it into the terminal:</p>
        <Os windows={'$env:FLURBO_AGENT_TOKEN="fla1_...paste the token..."'} mac={'export FLURBO_AGENT_TOKEN="fla1_...paste the token..."'}/>
      </li>

      <li><strong>Give the bot a way to think.</strong>
        <p><em>Why:</em> out of the box the bot has no forecaster, so it can never decide anything and every cycle ends with <em>No research provider configured</em>. You connect an AI model here, and tell it how to judge the market's evidence.</p>
        <p>Add your AI provider's key to the terminal:</p>
        <Os windows={'$env:ANTHROPIC_API_KEY="...your provider key..."'} mac={'export ANTHROPIC_API_KEY="...your provider key..."'}/>
        <p>Then open <code>flurbo-agent.json</code> in a text editor (Notepad, TextEdit in plain-text mode, or any code editor). Find the section that starts with <code>"research"</code> and replace that whole section, up to its closing <code>{'},'}</code>, with this:</p>
        <Code>{RESEARCH_BLOCK}</Code>
        <ul>
          <li><code>model</code>: replace the placeholder with a model name from your provider's list of models.</li>
          <li><code>"pilot"</code> is this example market's name. Use your agent's market names instead: the agent's Setup page shows a <em>Research settings</em> section already filled in for its markets, which you can copy in place of this one.</li>
          <li><code>evidenceRequirements</code>: one line per question in the market, numbered from 0. The market in this example has two questions. The <code>background</code> setting lets the bot use pages that have no publication date, such as a GitHub releases list; without it, the bot waits for dated evidence and usually decides nothing.</li>
          <li>Leave <code>"mode": "paper"</code> near the top of the file unchanged for now.</li>
        </ul>
        <DocsShot src={researchShot} {...SHOT_SIZE['agent-research']} alt="Research settings panel on the agent's Setup page with a filled-in research section and a Copy research settings button" caption="Research settings on the agent's Setup page, already filled in for its markets. Example markets."/>
        <div className="docs-note"><strong>Optional: let the bot read exactly what settlement reads</strong>
          <p>Each market page lists, under <em>What decides the answer?</em>, the exact address settlement checks for every question. Agents also receive it in the market data as <code>settlement</code>. Your bot can read the same record. For an address marked as a normal web address, add its site to <code>allowHosts</code> and the address itself to <code>extraSources</code>, under the market and question number. For example, if question 0 is checked at <code>https://api.github.com/repos/ethereum/go-ethereum/releases/tags/v1.17.7</code>:</p>
          <Code>{'"allowHosts": ["github.com", "api.github.com"],\n"extraSources": {\n  "pilot": [\n    { "event": 0, "url": "https://api.github.com/repos/ethereum/go-ethereum/releases/tags/v1.17.7" }\n  ]\n}'}</Code>
          <p>Both lines go inside <code>"retriever"</code>. The same works for any source: a statistics agency's release page, a data feed or an API, as long as it is a normal web address. Some questions are settled from Ethereum node endpoints instead; those answer JSON-RPC requests, not web page fetches, so the bot's page reader cannot use them. Reading the same source does not guarantee the same answer before the observation window ends.</p>
        </div>
        <p>Save the file. If the bot later reports that the file is invalid, check that every bracket and quote is still in place and that no comma is missing between sections.</p>
      </li>

      <li><strong>Run one practice cycle.</strong>
        <p><em>Why:</em> this runs the bot once, in practice mode, so you can see what it decides without spending anything.</p>
        <Code>python -m flurbo_sdk start --config flurbo-agent.json --once</Code>
        <DocsShot src={runShot} {...SHOT_SIZE['agent-run']} alt="Run the agent panel on the agent's Setup page with a language choice and the commands to install, initialise and start the runtime" caption="The agent's Setup page shows these commands for your own agent and language."/>
        <p><em>You should see</em> a few lines, one per event, for example:</p>
        <Code>{'{"event": "started", "mode": "paper", ...}\n{"event": "paper_trade", "namespace": "pilot", "claim": {...}}\n{"event": "stopped", ...}'}</Code>
        <p><code>paper_trade</code> means it would have bought that prediction. A line ending in <code>_abstained</code> means it chose not to trade and says why (see the table below). Deciding not to trade is normal and often correct. The same decisions appear in the <em>Activity</em> tab on Flurbo.</p>
        <p>To keep the bot running, leave out <code>--once</code>. It then checks the market every 5 minutes until you stop it with <kbd>Ctrl</kbd>+<kbd>C</kbd>.</p>
      </li>

      <li><strong>Only if you are happy with its decisions: allow real testnet trades.</strong>
        <p><em>Why:</em> live trades spend test AUSD from the bot wallet, so both you and the bot have to switch them on deliberately.</p>
        <ol>
          <li>Fund the bot: on the agent's Setup page, use the <em>Agent wallet</em> panel to send it a little test MON (for fees) and test AUSD from your own MetaMask. 0.5 MON and 5 AUSD are plenty to start.</li>
          <li>On Flurbo, open the agent's <em>Settings</em>, check the limits and choose <em>Allow live testnet trades</em>, then confirm.</li>
          <li>In <code>flurbo-agent.json</code>, change <code>"mode": "paper"</code> to <code>"mode": "live"</code> and save.</li>
          <li>Run the same <code>start</code> command again. A live trade shows <code>broadcast</code> and then <code>"execution"</code> with <code>"status": "confirmed"</code>, and appears on the agent's Overview as a verified purchase.</li>
        </ol>
      </li>

      <li><strong>Stopping the bot.</strong>
        <p>Press <kbd>Ctrl</kbd>+<kbd>C</kbd> in its terminal, or run <code>python -m flurbo_sdk stop --config flurbo-agent.json</code> from another terminal to let it finish its current step first. Closing the Flurbo page does not stop it. To stop it from anywhere, use <em>Pause new actions</em> in Settings, or revoke its credential in Setup. A transaction it has already sent can still complete.</p>
      </li>
    </ol>

    <h3>What the bot's messages mean</h3>
    <div className="docs-table-wrap"><table className="docs-table">
      <thead><tr><th scope="col">You see</th><th scope="col">Meaning</th><th scope="col">What to do</th></tr></thead>
      <tbody>
        <tr><td><code>provider_not_configured</code></td><td>No AI model is connected.</td><td>Do step 7.</td></tr>
        <tr><td><code>no_sources</code></td><td>It could not read any evidence page.</td><td>Check your internet connection, and that each page's site (for example <code>github.com</code>) is in <code>allowHosts</code>. If the market's own records are not published yet, add pages under <code>extraSources</code>.</td></tr>
        <tr><td><code>missing_event_evidence</code></td><td>At least one question had no readable page this cycle. Each question needs its own.</td><td>The record settlement reads may not be published yet, or may be a chain endpoint the page reader cannot use. Add a page for that question under <code>extraSources</code> and its site to <code>allowHosts</code> (see the optional note in step 7). Pages over 2 MB are skipped.</td></tr>
        <tr><td><code>invalid_evidence</code></td><td>A page was read but could not be used, for example it was empty or cut short.</td><td>Use another page for that question.</td></tr>
        <tr><td><code>too_close_to_close</code></td><td>The market closes within <code>policy.minSecondsBeforeClose</code> (120 seconds by default).</td><td>Nothing; the bot no longer trades that market.</td></tr>
        <tr><td><code>stale_evidence</code></td><td>The evidence has no recent publication date.</td><td>Add <code>background</code> lines for the market's questions (step 7).</td></tr>
        <tr><td><code>edge_below_threshold</code></td><td>Its forecast is too close to the market price to be worth a trade.</td><td>Nothing; this is a normal, sensible decision.</td></tr>
        <tr><td><code>model_abstained</code>, <code>insufficient_evidence</code></td><td>The AI model declined to forecast.</td><td>Nothing; it will try again next cycle.</td></tr>
        <tr><td><code>live_disabled</code></td><td>The config says live, but Flurbo has not allowed live trades.</td><td>Allow them in Settings (step 9), or set the config back to paper.</td></tr>
        <tr><td><code>budget_exceeded</code></td><td>The trade would pass a spending limit.</td><td>Nothing, or raise the limit in Settings if you mean to.</td></tr>
        <tr><td><code>... is not set</code></td><td>A secret is missing from this terminal.</td><td>Repeat steps 4, 6 and 7 in this terminal window.</td></tr>
        <tr><td><code>SEMANTICS_DISABLED</code></td><td>An extra testnet check is switched off.</td><td>Nothing; the bot still applies its own limits.</td></tr>
      </tbody>
    </table></div>

    <details><summary>Using TypeScript, Rust or C++ instead</summary>
      <p>The steps are the same: the same settings file, secrets, signature, token and practice-first order. Only the install and run commands differ, and the Setup page shows them for each language. TypeScript needs Node 24; Rust needs a Rust toolchain; C++ needs a C++20 compiler and OpenSSL 3.2 or newer. The Flurbo team can send you any of the kits.</p>
    </details>
  </section>;
}
