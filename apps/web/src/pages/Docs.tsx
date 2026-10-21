import { Fragment, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowUpRight } from 'lucide-react';
import { useAuth } from '../auth/context';
import { SHORTCUT_HELP } from '../shortcuts';
import FirstBotGuide from './FirstBotGuide';
import DocsShot from './DocsShot';
import { SHOT_SIZE } from './docs-media/sizes';
import signupShot from './docs-media/signup.png';
import approvedShot from './docs-media/account-approved.png';
import fundsShot from './docs-media/test-funds.png';
import marketsShot from './docs-media/markets.png';
import marketPageShot from './docs-media/market-page.png';
import proofShot from './docs-media/proof.png';
import ticketShot from './docs-media/ticket-buy.png';
import approveShot from './docs-media/ticket-approve.png';
import noHashShot from './docs-media/ticket-no-hash.png';
import combinationShot from './docs-media/ticket-combination.png';
import whatIfShot from './docs-media/what-if.png';
import thesisShot from './docs-media/thesis.png';
import timelineShot from './docs-media/settlement-timeline.png';
import realityShot from './docs-media/settlement-reality.png';
import collectShot from './docs-media/collect.png';
import portfolioShot from './docs-media/portfolio.png';
import noticesShot from './docs-media/notices.png';
import registerShot from './docs-media/agents-register.png';
import walletShot from './docs-media/agent-wallet.png';
import liveShot from './docs-media/agent-live.png';
import activityShot from './docs-media/agent-activity.png';
import './docs.css';

const groups: [string, [string, string][]][] = [
  ['Get started', [['overview', 'Overview'], ['getting-started', 'Getting started'], ['accounts', 'Account and access'],
    ['metamask', 'MetaMask and wallets'], ['test-funds', 'Test funds']]],
  ['Trade', [['markets', 'Finding markets'], ['market-page', 'Reading a market'], ['trading', 'Buying and selling'],
    ['combinations', 'Combined predictions'], ['what-if', 'What if'], ['conditionals', 'Conditional predictions'],
    ['thesis', 'Build your thesis']]],
  ['Settlement', [['settlement', 'Settlement and payouts'], ['disputes', 'Challenges and Kleros'], ['portfolio', 'Portfolio'],
    ['notices', 'Email notices']]],
  ['For quants', [['pricing', 'How prices behave']]],
  ['Agents', [['agents', 'Agents and SDKs'], ['first-bot', 'Your first trading bot']]],
  ['Reference', [['limits', 'Limits and allowances'], ['application-data', 'Your data'], ['help', 'Common questions'],
    ['preview', 'Preview limitations']]],
];
const sections = groups.flatMap(([, items]) => items);

const Shot = ({ name, src, alt, caption }: { name: string; src: string; alt: string; caption: string }) =>
  <DocsShot src={src} {...SHOT_SIZE[name]} alt={alt} caption={caption}/>;

export default function Docs() {
  const { state } = useAuth();
  const [active, setActive] = useState<string>(sections[0][0]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id);
    }, { rootMargin: '-110px 0px -60% 0px' });
    sections.forEach(([id]) => { const node = document.getElementById(id); if (node) observer.observe(node); });
    return () => observer.disconnect();
  }, []);
  // The guide loads after the address, so a section link lands once its content exists.
  useEffect(() => { const id = decodeURIComponent(window.location.hash.slice(1)); if (id) document.getElementById(id)?.scrollIntoView(); }, []);
  const explore = state.address
    ? <Link href="/markets" className="btn btn-primary docs-explore">Explore markets <ArrowUpRight size={16} strokeWidth={1.75} /></Link>
    : <Link href="/signup" className="btn btn-primary docs-explore">Get early access <ArrowUpRight size={16} strokeWidth={1.75} /></Link>;
  return <main id="main" tabIndex={-1} className="docs-page page">
    <header className="docs-hero">
      <h1>Understand the market.</h1>
      <p className="lead">How to trade, combine and settle predictions on Flurbo, and how its prices behave.</p>
    </header>
    <nav className="docs-quickstart" aria-label="Choose a guide">
      <a href="#getting-started"><strong>Make your first prediction</strong><small>Account, access, test funds and MetaMask.</small></a>
      <a href="#combinations"><strong>Combine your ideas</strong><small>When AND, OR and Exactly one pay.</small></a>
      <a href="#pricing"><strong>Understand the prices</strong><small>The properties every quote in a pool shares.</small></a>
      <a href="#agents"><strong>Build an agent</strong><small>TypeScript, Python, Rust or C++.</small></a>
    </nav>
    <div className="docs-layout">
      <aside className="docs-sidebar">
        <details className="docs-contents" open><summary>Contents</summary>
        <nav aria-label="Documentation contents">
          <p className="docs-contents-title">On this page</p>
          {groups.map(([group, items]) => <Fragment key={group}>
            <h3 className="docs-contents-group">{group}</h3>
            {items.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={active === id ? 'location' : undefined}>{label}</a>)}
          </Fragment>)}
        </nav>
        </details>
        {explore}
      </aside>
      <article className="docs-article">
        <section id="overview" aria-labelledby="overview-title">
          <h2 id="overview-title">One pool. Related questions.</h2>
          <p>Flurbo is a prediction market where related questions share one pool. You can take a position on a single answer, or join answers from the same pool into one combined prediction, such as “the Federal Reserve cuts rates AND inflation comes in at or below 2.8%”.</p>
          <p>One pool prices every question and every combination together. Its prices therefore show more than the chance of each event on its own: they also show how the market expects the events to move together.</p>
          <dl className="docs-definitions">
            <div><dt>Question</dt><dd>A Yes or No question with a published source, a rule that decides it and a time when trading closes.</dd></div>
            <div><dt>Pool</dt><dd>A group of related questions with one trading close and one reserve that pays every winning share in the pool.</dd></div>
            <div><dt>Share</dt><dd>Pays 1 test AUSD if its answer is correct and 0 if it is wrong. An unresolved (VOID) question pays a fraction, explained under <a href="#void">VOID</a>.</dd></div>
            <div><dt>Combined prediction</dt><dd>One position over two or three answers from the same pool, with a rule that says when it pays.</dd></div>
            <div><dt>Settlement route</dt><dd>How a question's answer becomes final: read from a published source, or answered on Reality.eth. Any challenge goes to the Kleros court.</dd></div>
          </dl>
          <div className="docs-note"><strong>This is a testnet preview.</strong><p>Trading uses test AUSD on Monad testnet, which has no monetary value, and test MON pays network fees. Taking part in Reality.eth settlement uses Sepolia test ETH. Read each market's rules before trading.</p></div>
        </section>

        <section id="getting-started" aria-labelledby="getting-started-title">
          <h2 id="getting-started-title">Getting started</h2>
          <ol className="docs-steps">
            <li><strong>Create your account.</strong> Sign up with a Mera passkey. It is your Flurbo login, so keep it safe.<Shot name="signup" src={signupShot} alt="The Create your Flurbo account page with a passkey name field and a Create a passkey button" caption="Sign-up: name the passkey, then create it with your device or password manager."/></li>
            <li><strong>Request access.</strong> On Your account, enter your email and verify the six-digit code. The team reviews each request and emails you when you are approved. See <a href="#accounts">Account and access</a>.</li>
            <li><strong>Link MetaMask.</strong> MetaMask holds your test funds and confirms your trades. See <a href="#metamask">MetaMask and wallets</a>.</li>
            <li><strong>Get test funds.</strong> Test MON for network fees and up to 50 test AUSD a day for trading. See <a href="#test-funds">Test funds</a>.</li>
            <li><strong>Choose a market and review the quote.</strong> Pick an answer and a number of shares, check the cost and confirm in MetaMask. A purchase usually asks twice: once to allow the payment, once to buy. See <a href="#trading">Buying and selling</a>.</li>
            <li><strong>Follow settlement and collect.</strong> The market page shows each step until the answer is final. When every question in the pool is final, collect your payout on the market page. See <a href="#settlement">Settlement and payouts</a>.</li>
          </ol>
          <p>The home page and this guide are public. Markets, funding, portfolio and agents need a signed-in, approved account.</p>
        </section>

        <section id="accounts" aria-labelledby="accounts-title">
          <h2 id="accounts-title">Account and access</h2>
          <p>Your Mera passkey signs you in, and your Mera account address identifies your Flurbo account. A sign-in lasts seven days. Mera does not place trades: your linked MetaMask wallets hold your funds and confirm each transaction.</p>
          <ol className="docs-steps">
            <li><strong>Create a passkey.</strong> Give it a name you will recognise in your password manager. Creating an account does not apply for access.</li>
            <li><strong>Request access.</strong> Open Your account, enter your email and verify the six-digit code sent to it. Verifying your email is not approval.</li>
            <li><strong>Wait for approval.</strong> The team reviews requests by hand and emails you when your account is approved. Your account page always shows the current status.<Shot name="account-approved" src={approvedShot} alt="Your account page showing Access approved" caption="Your account once access is approved."/></li>
          </ol>
          <p>To use Flurbo on another device, that device needs the same passkey from your credential provider. A fingerprint or face scan only unlocks the passkey on your device. Creating a different passkey creates a different Flurbo account.</p>
          <div className="docs-note"><strong>Losing your passkey means losing your Flurbo account.</strong><p>There is no password reset, and your email cannot restore access. Keep the passkey in a password manager that syncs across your devices. Funds in your MetaMask wallets stay yours; contact the Flurbo team to link those wallets to a new account.</p></div>
          <p>Never share a wallet recovery phrase, private key or passkey recovery details with anyone, including Flurbo.</p>
        </section>

        <section id="metamask" aria-labelledby="metamask-title">
          <h2 id="metamask-title">MetaMask and wallets</h2>
          <p>MetaMask holds your test funds and confirms your trades. If you already use it, skip to step 3.</p>
          <ol className="docs-steps">
            <li><strong>Install it from the official site.</strong> Go to <a href="https://metamask.io" target="_blank" rel="noreferrer">metamask.io</a> and install the browser extension or the mobile app. Copies of it in other places can steal funds.</li>
            <li><strong>Create a wallet and save the recovery phrase offline.</strong> MetaMask shows 12 words once. Write them down and keep them safe. Anyone with these words controls the wallet, and nobody can recover them for you.</li>
            <li><strong>Connect and link.</strong> Signed in and approved, open <Link href="/fund">Get test funds</Link> or any market and choose Connect MetaMask. Approve adding and switching to Monad testnet if MetaMask asks, then sign the account-linking message. Signing proves you own the wallet. It does not move funds or give anyone permission to spend them.</li>
          </ol>
          <h3>More than one wallet</h3>
          <p>You can link up to 20 wallets to one account. Each new wallet signs its own linking message. Portfolio combines their shares, trades and collected payouts, even when MetaMask is disconnected. Use Switch wallet on a market or the Trading wallets panel on Your account to change the active wallet. To sell shares or collect a payout, use the wallet that holds them.</p>
          <h3>Networks</h3>
          <p>Trading happens on Monad testnet. Reality.eth answers and Kleros cases happen on Sepolia, so MetaMask switches to Sepolia only when you take part in that settlement. Flurbo asks MetaMask to switch for you and shows the network on every confirmation.</p>
          <p>If MetaMask does not offer to add Monad testnet, choose Add network, then Add a network manually, and enter:</p>
          <div className="docs-table-wrap"><table className="docs-table">
            <tbody>
              <tr><th scope="row">Network name</th><td>Monad Testnet</td></tr>
              <tr><th scope="row">RPC URL</th><td><code>https://testnet-rpc.monad.xyz</code></td></tr>
              <tr><th scope="row">Chain ID</th><td>10143</td></tr>
              <tr><th scope="row">Currency symbol</th><td>MON</td></tr>
              <tr><th scope="row">Block explorer</th><td><code>https://testnet.monadscan.com</code></td></tr>
            </tbody>
          </table></div>
          <p>Test MON, test AUSD and Sepolia ETH have no monetary value. Never send real funds to a testnet address.</p>
        </section>

        <section id="test-funds" aria-labelledby="test-funds-title">
          <h2 id="test-funds-title">Test funds</h2>
          <p>Open <Link href="/fund">Get test funds</Link> to see your trading wallet's balances and the ways to fund it.</p>
          <Shot name="test-funds" src={fundsShot} alt="Get test funds page with the trading wallet balances, a Get test MON step and a Get test AUSD step" caption="Get test funds: balances first, then test MON for fees and test AUSD for trading."/>
          <ul>
            <li><strong>Test MON</strong> pays network fees. Flurbo may send a starter amount automatically when an approved account links its first wallet. Otherwise use the Monad faucet linked on the page.</li>
            <li><strong>Test AUSD</strong> is what you trade with. Choose Request test AUSD and confirm in MetaMask: 50 test AUSD, once every 24 hours per wallet, while the dispenser has funds. The only cost is a small test MON fee.</li>
            <li><strong>Sepolia ETH</strong> is needed only to post a Reality.eth answer, request Kleros arbitration or fund an appeal. Flurbo does not hand it out; use a public Sepolia faucet.</li>
          </ul>
        </section>

        <section id="markets" aria-labelledby="markets-title">
          <h2 id="markets-title">Finding markets</h2>
          <p>Markets lists every question from every pool in one place. You do not need to choose a pool first.</p>
          <Shot name="markets" src={marketsShot} alt="Markets board with example questions from four pools, showing status, time to close, linked count and Yes and No prices" caption="The market board with every status shown. Example questions."/>
          <ul>
            <li><strong>Each tile</strong> shows its pool, the question, its status (Open, Closes soon, Closed or Settled), the time to close, how many questions share its pool, and the cost of one Yes or No share.</li>
            <li><strong>Prices</strong> are the cost of one share in test AUSD, including the pool's commission and the small price impact of buying it. That is why Yes and No add up to more than 1. A price older than a minute is dimmed until the next refresh.</li>
            <li><strong>Filters</strong>: categories across the top, search, status (Open, Closed, Settled, All) and sort (Closing soon, A to Z). Refresh prices reads every pool again.</li>
            <li><strong>Watchlist</strong>: the star keeps a market in your Watchlist category in this browser.</li>
            <li><strong>Linked questions</strong>: pointing at a tile draws a bracket over the other questions in the same pool.</li>
          </ul>
          <h3>Keyboard shortcuts</h3>
          <p>Press <kbd>?</kbd> on the board or a market to see these. Shortcuts move focus and choose options; none of them reviews, approves or sends anything.</p>
          <div className="docs-table-wrap"><table className="docs-table">
            <thead><tr><th scope="col">Where</th><th scope="col">Keys</th><th scope="col">Action</th></tr></thead>
            <tbody>{SHORTCUT_HELP.map((item) => <tr key={item.scope + item.label}><td>{item.scope === 'board' ? 'Markets' : 'A market'}</td><td>{item.keys.map((key, i) => <Fragment key={key}>{i > 0 && ' '}<kbd>{key}</kbd></Fragment>)}</td><td>{item.label}</td></tr>)}</tbody>
          </table></div>
        </section>

        <section id="market-page" aria-labelledby="market-page-title">
          <h2 id="market-page-title">Reading a market</h2>
          <Shot name="market-page" src={marketPageShot} alt="A market page with the question, status, trading close, Yes and No prices, the price history chart, the Linked, Timeline and Proof tabs and the trade ticket" caption="A market page: question and prices at the top, the chart and tabs on the left, the ticket on the right."/>
          <ul>
            <li><strong>The head</strong> shows the question, its status, when trading closes and when results are expected, with the current cost of one Yes and one No share.</li>
            <li><strong>Price history</strong> charts the one-share cost over the last 24 hours or all recorded samples. Shaded, dotted spans have no samples, so movement inside them is unknown. View exact observations lists every sample.</li>
            <li><strong>Linked</strong> shows which questions the pool prices together, with a link to the connections map (<a href="#what-if">What if</a>) and <a href="#thesis">Build your thesis</a>.</li>
            <li><strong>Timeline</strong> follows the question from trading to payout and holds any settlement action you can take. See <a href="#settlement">Settlement and payouts</a>.</li>
            <li><strong>Proof</strong> shows what decides the answer: the source, the reader that checks it, the publisher, the evidence once it exists, and the public addresses of the pool and its rules.</li>
            <li><strong>The ticket</strong> on the right is where you buy, sell and collect. Your position in this question is shown under it.</li>
          </ul>
          <Shot name="proof" src={proofShot} alt="Proof tab listing the source link, reader, publisher, evidence status and the pool, resolver and rules hash" caption="Proof: the published source and rule that decide the answer, and the records to check them against."/>
        </section>

        <section id="trading" aria-labelledby="trading-title">
          <h2 id="trading-title">Buying and selling</h2>
          <p>A winning share pays 1 test AUSD at settlement and a losing share pays 0. What you pay for a share is separate from what it pays.</p>
          <div className="docs-example"><span className="docs-example-label">Illustrative example</span><p>If 5 Yes shares cost 3.12 test AUSD and Yes is correct, they pay 5 test AUSD: 1.88 more than you paid, before network fees. If No is correct, they pay 0.</p></div>
          <ol className="docs-steps">
            <li><strong>Choose.</strong> In the ticket, pick Buy or Sell, your answer and up to 20 shares. Add up to two linked questions under Add a linked question if you want a <a href="#combinations">combined prediction</a>.</li>
            <li><strong>Read the quote.</strong> The ticket shows the quoted cost, the average per share, the payout if you are right, the maximum you can spend and what you can lose.<Shot name="ticket-buy" src={ticketShot} alt="Trade ticket buying 5 Yes shares with the quoted cost, average per share, gross payout, maximum spend and possible loss" caption="The ticket with a live quote for 5 Yes shares. Example values."/></li>
            <li><strong>Allow the payment.</strong> Unless an earlier allowance still covers it, a purchase starts with Step 1 of 2: allowing the pool to spend exactly this purchase's maximum. This is not a purchase. When it confirms, the purchase review opens on its own.<Shot name="ticket-approve" src={approveShot} alt="Review sheet titled Step 1 of 2: allow this payment, with the amount to allow and an Allow payment button" caption="Step 1 of 2: allowing the exact maximum this purchase can spend."/></li>
            <li><strong>Review and confirm.</strong> The review reads a fresh quote and stays valid for about two minutes. Confirm in MetaMask. If the review expires, cancel it and review again.</li>
            <li><strong>Wait for confirmation.</strong> The sheet checks the transaction automatically, even after a reload. You can hide it and keep browsing: a bar at the bottom of every page shows a transaction still pending.</li>
          </ol>
          <h3>Price tolerance</h3>
          <p>Every trade allows 0.5% of price movement. A purchase never spends more than its maximum spend, and a sale never receives less than its minimum proceeds. If the price moves further before your transaction confirms, it fails instead of filling at a worse price, and you only pay the network fee.</p>
          <p>A larger trade averages a higher price per share than a smaller one, because each share bought moves the price for the next. The ticket's average per share shows this before you review.</p>
          <h3>If you cancel in MetaMask</h3>
          <p>Rejecting the request in MetaMask sends nothing. The ticket shows Transaction cancelled in MetaMask and keeps your review open.</p>
          <p>If MetaMask closes without returning a transaction hash, Flurbo cannot tell whether anything was sent, so it waits rather than guess. If you cancelled, choose <strong>Nothing was sent</strong> to clear it. Otherwise copy the hash from MetaMask's activity, paste it and choose Track transaction. Do not send the trade again until this is resolved.</p>
          <Shot name="ticket-no-hash" src={noHashShot} alt="Waiting for confirmation sheet saying MetaMask did not return a transaction hash, with a transaction hash field and Nothing was sent and Track transaction buttons" caption="When MetaMask returns no hash: clear it if you cancelled, or attach the hash from MetaMask activity."/>
          <h3>Selling</h3>
          <p>While trading is open, you can sell shares back to the pool from the wallet that holds them, at a fresh quote. The sale price can differ from what you paid. After trading closes, positions wait for settlement.</p>
        </section>

        <section id="combinations" aria-labelledby="combinations-title">
          <h2 id="combinations-title">Combined predictions</h2>
          <p>A combined prediction is one position over two or three answers from the same pool, with a rule that says when it pays. It is not the same as buying each answer separately: it pays 1 test AUSD per share once, when its rule is met. Combinations cannot span different pools.</p>
          <div className="docs-comparison">
            <div><h3>Both (AND)</h3><p>Pays only when every selected answer is correct. “A Yes AND B Yes” needs both A and B to resolve Yes.</p></div>
            <div><h3>At least one (OR)</h3><p>Pays when one or more selected answers are correct, including when all are. It still pays once per share.</p></div>
            <div><h3>Exactly one</h3><p>Pays when exactly one selected answer is correct. With three answers, all three being correct is a loss.</p></div>
          </div>
          <Shot name="ticket-combination" src={combinationShot} alt="Trade ticket combining two questions with Yes on each and Both (AND) chosen, with the quote for 4 combined shares" caption="A combined prediction: two answers joined with Both (AND). Example values."/>
          <p>A combination is quoted from the same pool as the single questions. An AND usually costs less than either answer alone because more has to go right, which does not make it better value. <a href="#pricing">How prices behave</a> shows how the two are related.</p>
          <h3>When a combination has no quote</h3>
          <p>The combinations already bought in a pool decide which new ones it can price. If a new combination would tie its questions together more closely than the pool supports, the ticket shows that a current quote is unavailable. Every single question and every combination already bought stays tradable. In a pool of two questions, every combination is always available.</p>
          <h3>Sharing a combination</h3>
          <p>A combined ticket can be shared as a link. The page address carries this question's answer (<code>answer</code>), the second question (<code>other</code>, <code>otherAnswer</code>), an optional third (<code>third</code>, <code>thirdAnswer</code>), the rule (<code>rule=AND</code>, <code>OR</code> or <code>EXACTLY_ONE</code>), the number of shares (<code>shares</code>) and <code>trade=sell</code> for a sale, for example <code>?other=6&amp;otherAnswer=no&amp;rule=OR</code>. Questions are numbered from 0 in pool order. Opening the link fills the ticket; nothing is traded until you review and confirm in your wallet.</p>
          <h3>Collecting a combined prediction</h3>
          <p>After settlement, open Collect a combined prediction on the market page and select the same answers and rule you bought. The Collect on market page link in <a href="#portfolio">Portfolio</a> fills these in for you.</p>
        </section>

        <section id="what-if" aria-labelledby="what-if-title">
          <h2 id="what-if-title">What if</h2>
          <p>On the Linked tab, What if starts from this question: choose up to three answers to assume and the pool shows how its chance for every other question moves, largest shift first. Each row is one tap from becoming a combined prediction in the ticket. Open connections shows the same view for any question on the map, and selecting a line there compares one pair of questions. It is read-only: nothing is traded or saved.</p>
          <Shot name="what-if" src={whatIfShot} alt="What if on the Linked tab with this question assumed Yes, and the other questions listed by how far the pool's chance moves, each with its chance now, a small dumbbell, its chance if assumed and a Combine button" caption="What if, for three linked example questions. Example values."/>
          <dl className="docs-definitions">
            <div><dt>Assumptions</dt><dd>Up to three answers you suppose are true. The pool recomputes every other chance as if they held.</dd></div>
            <div><dt>Chance now</dt><dd>The pool's chance of each other question's Yes, with no assumption.</dd></div>
            <div><dt>If assumed</dt><dd>The pool's chance of Yes given the assumptions. For example, P(A given B) = P(A and B) / P(B).</dd></div>
            <div><dt>The shift</dt><dd>The difference in percentage points. A hollow square marks the chance now and a lime square the chance if assumed, joined by a line. Rows are ordered by the largest shift.</dd></div>
            <div><dt>Combine</dt><dd>Adds the assumptions and that question to the ticket as a combined prediction, up to three answers, ready for a fresh quote.</dd></div>
            <div><dt>Very unlikely assumptions</dt><dd>When the assumptions together have less than a one in a billion chance, the pool shows no conditional chances.</dd></div>
          </dl>
          <p>These are the pool's estimates at the block shown, not independent evidence. A relationship between two questions does not mean that one causes the other.</p>
        </section>

        <section id="conditionals" aria-labelledby="conditionals-title">
          <h2 id="conditionals-title">Conditional predictions</h2>
          <p>A conditional prediction counts only if something else happens first. "If the first question is Yes, then the second is Yes" pays 1 test AUSD per share when both happen, pays nothing when the first happens and the second does not, and is refunded in full when the first does not happen.</p>
          <p>Open Conditionals, choose the If answer and the Then answer, and the page shows the pool's chance of the Then answer in both cases, If Yes and If No, next to the chance of the If answer itself. The price per share sits a little above the chance; on an unlikely If answer it sits further above, because you only pay for the case that counts.</p>
          <p>If a question is Void, the payout averages its two answers, as for every Flurbo prediction. Conditional pools settle exactly like other pools, through Reality.eth with Kleros for disputes.</p>
        </section>

        <section id="thesis" aria-labelledby="thesis-title">
          <h2 id="thesis-title">Build your thesis</h2>
          <p>Build your thesis, under the Linked tab, puts your own view into numbers and compares it with the pool. Enter the chance A is Yes, the chance B is Yes if A is Yes, and the chance B is Yes if A is No. Those three numbers decide your chance for all four outcomes.</p>
          <Shot name="thesis" src={thesisShot} alt="Build your thesis page with three estimates entered, the four outcomes with the pool's chance and yours, the quote and the expected net at that quote" caption="Comparing your estimates with the pool for one AND prediction. Example values."/>
          <p>Choose the answers, the payout rule and the number of shares to compare. For each outcome you see the pool's chance, yours, and whether your prediction pays. Your expected net is your chance of being paid times the payout, minus the current quote. It excludes gas and VOID, and it is an estimate built on your inputs, not a promise.</p>
          <p>Review this prediction takes the selection back to the ticket, where a fresh quote and your MetaMask confirmation are still needed. Nothing you enter is saved when you leave the page.</p>
        </section>

        <section id="settlement" aria-labelledby="settlement-title">
          <h2 id="settlement-title">Settlement and payouts</h2>
          <p>When trading closes, each question waits for the end of its source window (Results expected on the market page) and then follows its settlement route. The route is fixed before trading opens and shown on the market's Timeline tab. No AI model decides an outcome: every answer comes with public evidence, and every answer can be challenged.</p>
          <h3>Source-verified questions</h3>
          <p>These questions have an official, machine-readable source. On the market board, pointing at the pool name shows Source verified, Kleros challenge.</p>
          <ol className="docs-steps">
            <li><strong>Source observed.</strong> Flurbo's reader checks the source named in the rule inside the window. Missing or malformed data is never read as No; the rule's VOID policy applies instead.</li>
            <li><strong>Answer proposed.</strong> The result is posted with a test AUSD bond and a link to its public evidence.</li>
            <li><strong>Challenge window.</strong> Anyone can challenge with a different answer and the same bond before the deadline shown. A challenged answer goes to the Kleros court.</li>
            <li><strong>Final answer.</strong> An unchallenged answer is final when the window ends. A challenged one is decided by the Kleros ruling.</li>
          </ol>
          <Shot name="settlement-timeline" src={timelineShot} alt="Settlement timeline with trading, source observed and answer proposed done, the challenge window current, and the form to challenge the answer" caption="A proposed answer in its challenge window, with the form to challenge it."/>
          <h3>Reality.eth questions</h3>
          <p>Other questions are asked on Reality.eth, on Sepolia, with Kleros as the arbitrator. Their pool name on the board shows Reality.eth + Kleros.</p>
          <ol className="docs-steps">
            <li><strong>First answer.</strong> After the source window, Flurbo's reader posts a bonded answer with its evidence. The timeline shows it as Flurbo reader answered.</li>
            <li><strong>Answer window.</strong> Anyone can post a different answer by at least doubling the bond, or request Kleros arbitration, until the window closes.</li>
            <li><strong>Kleros review, if requested.</strong> Jurors review the evidence and rule. Rulings can be appealed while an appeal is open.</li>
            <li><strong>Final on Reality.eth, then reported to Monad.</strong> A relay delivers the final answer to the pool on Monad.</li>
          </ol>
          <Shot name="settlement-reality" src={realityShot} alt="Settlement timeline for a Reality.eth question under Kleros review, with links to the question and court contract and a form to submit evidence" caption="A Reality.eth answer under Kleros review. Evidence can be submitted from the timeline."/>
          <h3>When payouts open</h3>
          <p>A pool pays only when every question in it is final, so one slow question delays payouts for the whole pool. Payouts are not sent automatically: open the market page with the wallet that holds the shares and choose Collect. Collecting is a transaction and needs a little test MON. Combined predictions are collected under Collect a combined prediction.</p>
          <Shot name="collect" src={collectShot} alt="Ticket on a settled market showing the shares held and a Collect yes payout button" caption="A settled market: collect from the wallet that holds the shares."/>
          <h3 id="void">What happens with VOID?</h3>
          <p>VOID means a question could not be resolved. It is not No, and it is not a refund. A VOID question counts as half Yes and half No, so a share pays its average over the two answers. A single VOID share pays 0.5 test AUSD. An AND prediction with one confirmed Yes and one VOID pays 0.5; with two VOID questions it pays 0.25; with a confirmed losing answer it pays 0.</p>
          <div className="docs-note"><strong>Settlement has trust and timing limits.</strong><p>A wrong answer that nobody challenges can become final. Disputes, source outages and network delays can hold up settlement. Treat Results expected as an estimate, and use the market's current status and rules.</p></div>
        </section>

        <section id="disputes" aria-labelledby="disputes-title">
          <h2 id="disputes-title">Challenges and Kleros</h2>
          <p>Any member can take part in settlement from a market's Timeline tab. Each control appears only when it applies. Evidence you save is public and can be read by anyone, including jurors, so include public information only.</p>
          <h3>Challenge a source-verified answer</h3>
          <ol className="docs-steps">
            <li><strong>Choose the answer you believe is right.</strong> The other answer, or Void.</li>
            <li><strong>Write and save your evidence.</strong> A title, what is wrong with the proposed answer and a public source link. Saving publishes it; it does not challenge yet.</li>
            <li><strong>Review the challenge.</strong> Allow the bond in test AUSD, then confirm the challenge. The question goes to the Kleros court, and its ruling decides the answer. If a case cannot be opened before the published deadline, the question becomes VOID.</li>
          </ol>
          <h3>Take part in a Reality.eth question</h3>
          <ul>
            <li><strong>Post an answer.</strong> Choose Yes, No or Void and a bond in Sepolia ETH of at least the minimum shown. A different answer must at least double the current bond. If another answer arrives first, your transaction can fail.</li>
            <li><strong>Request Kleros arbitration.</strong> Pay the fee shown while the answer window is open. If a posted answer contradicts Flurbo's published source reading, Flurbo requests arbitration itself.</li>
            <li><strong>During a case.</strong> Submit evidence, and fund an appeal for the ruling you support while an appeal is open.</li>
            <li><strong>After a ruling.</strong> Complete the Kleros ruling reports it to Reality.eth from your wallet so the answer can finalize.</li>
          </ul>
          <h3>Bonds and rewards</h3>
          <p>A bond backs an answer. If your answer is upheld, your bond comes back with the winnings; if not, you lose it. Bond credit and Reality.eth bond winnings are withdrawn from the market page. If you funded an appeal, Appeal rewards shows what you can claim once the court allows it.</p>
        </section>

        <section id="portfolio" aria-labelledby="portfolio-title">
          <h2 id="portfolio-title">Portfolio</h2>
          <p><Link href="/portfolio">Portfolio</Link> brings together the shares of every wallet linked to your account, individual and combined, with what is ready to collect and what you have already collected.</p>
          <Shot name="portfolio" src={portfolioShot} alt="Portfolio holdings with an individual and a combined position open for trading and a settled position ready to collect" caption="Holdings: open positions and a settled one ready to collect. Example values."/>
          <ul>
            <li><strong>Holdings</strong> shows each position's shares and status: Open for trading, Awaiting settlement, Ready to collect or No payout. Collect on market page opens the market with the position selected and names the wallet to use in MetaMask.</li>
            <li><strong>Activity</strong> lists confirmed purchases, sales and collections. <strong>Collected</strong> lists collected payouts, which are money received, not profit.</li>
            <li><strong>Performance</strong> charts realized profit and loss: sale proceeds and collected payouts minus the average cost of those shares, per wallet and position. It excludes open positions, uncollected payouts and gas, and appears only once history is complete.</li>
          </ul>
          <p>Trades by your agents appear beside your own, labelled with the agent's name. If shares are missing, check that the wallet holding them is linked, then refresh. History is checked in the background, so older activity can take a moment to appear.</p>
        </section>

        <section id="notices" aria-labelledby="notices-title">
          <h2 id="notices-title">Email notices</h2>
          <p>On Your account, choose which emails Flurbo sends about your own positions. They go only to the email you verified, never to anyone else, and each one has a link to stop them.</p>
          <Shot name="notices" src={noticesShot} alt="Email notices panel with options for payouts, proposed answers, Reality.eth source windows and trading closing soon" caption="Email notices: choose what Flurbo tells you about questions you hold."/>
        </section>

        <section id="pricing" aria-labelledby="pricing-title">
          <h2 id="pricing-title">How prices behave</h2>
          <p>Each pool is one automated market maker holding one probability for every combination of answers in the pool. Every claim, single or combined, is priced from those same probabilities: its price is the pool's chance of the outcomes in which it pays, plus the impact of its size. The properties below follow from that, and each can be checked against live quotes.</p>
          <h3>One table prices everything</h3>
          <p>For two questions, A (the Federal Reserve cuts) and B (inflation at or below 2.8%), the pool holds four chances that add up to 100%. These are the example values in the screenshots above.</p>
          <div className="docs-table-wrap"><table className="docs-table docs-joint">
            <thead><tr><td /><th scope="col">B Yes</th><th scope="col">B No</th><th scope="col">Total</th></tr></thead>
            <tbody>
              <tr><th scope="row">A Yes</th><td>38.4%</td><td>23.4%</td><td>61.8%</td></tr>
              <tr><th scope="row">A No</th><td>9.6%</td><td>28.6%</td><td>38.2%</td></tr>
              <tr><th scope="row">Total</th><td>48.0%</td><td>52.0%</td><td>100%</td></tr>
            </tbody>
          </table></div>
          <p>Every claim the pool quotes is a sum of cells from this one table:</p>
          <ul className="docs-formulas">
            <li>A Yes: <code>38.4 + 23.4 = 61.8%</code></li>
            <li>A Yes AND B Yes: <code>38.4%</code></li>
            <li>A Yes OR B Yes: <code>100 − 28.6 = 71.4%</code></li>
            <li>Exactly one: <code>23.4 + 9.6 = 33.0%</code></li>
            <li>A Yes given B Yes: <code>38.4 / 48.0 = 80.0%</code>; given B No: <code>23.4 / 52.0 = 45.0%</code></li>
          </ul>
          <p>Because there is only one table, the identities between claims hold exactly at every moment: <code>P(A) = P(A and B) + P(A and not B)</code>, <code>P(A or B) = P(A) + P(B) − P(A and B)</code>, and the chances of Yes and No add up to 1. A set of claims that pays exactly 1 test AUSD in every outcome always costs more than 1 test AUSD, because every price includes the pool's commission, so quotes cannot be combined into a riskless profit against the pool.</p>
          <h3>Relationships have a price</h3>
          <p>Two separate markets for A and B fix P(A) and P(B), but not P(A and B). All they imply is <code>max(0, P(A) + P(B) − 1) ≤ P(A and B) ≤ min(P(A), P(B))</code>, here anywhere from 9.8% to 48.0%. Pricing a combination by multiplying its single prices assumes independence: <code>61.8% × 48.0% = 29.7%</code>. This pool says 38.4%, so it expects the two to happen together more often than independent events would. A trader who disagrees can trade that relationship directly, rather than holding two separate positions that do not express it.</p>
          <div className="docs-example"><span className="docs-example-label">Same view, two ways to hold it</span><p>One Yes share of A and one of B cost about 0.621 + 0.482 = 1.103 test AUSD and pay 2 if both happen, 1 if only one does. That position pays for how many happen, not for both happening. One combined A AND B share costs about 0.386 and pays 1 exactly when both happen.</p></div>
          <h3>Trades move related prices</h3>
          <p>Buying A AND B raises the both-Yes cell and lowers the other three. So P(A), P(B) and P(A given B) all move, although the trader never bought A or B alone. In the What if example, one combined share moves the chance of A from 61.8% to 63.0% and the chance of A given B from 80.0% to 80.5%. Information about how questions relate reaches the single-question prices, and the reverse.</p>
          <h3>Always a counterparty</h3>
          <p>The pool quotes every supported claim at any time until trading closes. A three-question combination does not need a matching trader or its own order book: its depth is the depth of the whole pool.</p>
          <h3>Order size and splitting</h3>
          <p>The total cost of moving the pool from one state to another depends only on where it starts and ends, not on how the order is split. Buying 10 shares at once or in ten trades of one costs the same in total, apart from rounding that always favours the pool and any trades by others in between. Splitting an order does not lower its total cost.</p>
          <h3>Prices reach your belief</h3>
          <p>If you think a claim pays with probability q and its price p is lower, each further share has expected value <code>q − p</code> above its cost. Your expected profit is largest when you buy until the price reaches q, and stop there. Stopping short leaves expected profit unclaimed, and pushing past it gives profit back, so a price at rest reflects the last trader's belief.</p>
          <h3>Funded before trading</h3>
          <p>Each pool is funded before trading opens with enough to pay every possible outcome, and every trade checks that the reserve still covers the largest possible payout. The pool's worst-case loss is fixed when it is funded and does not grow with trading volume. Payouts never depend on another trader arriving or on a top-up.</p>
          <h3>Commission and depth</h3>
          <p>Each pool keeps a commission, fixed when the pool is created: 5% for the pools Flurbo creates now. Before price impact, Yes and No together cost at most 1 plus the commission. The commission is largest while the pool's chances are most uncertain and shrinks as they become more certain.</p>
          <p>A pool also gets deeper as it is used. The more shares are outstanding, the more it costs to move a price by the same amount, so early trades move prices more than later trades of the same size. Selling shares makes the pool shallower again. Neither the commission nor the depth changes the worst-case loss fixed when the pool was funded.</p>
          <h3>One outcome settles every claim</h3>
          <p>When the pool settles, one set of final answers decides every claim in it, single or combined, so no two claims can settle inconsistently. A VOID question counts as an even split of Yes and No for every claim that includes it.</p>
          <h3>Reading the numbers</h3>
          <ul>
            <li><strong>Board and ticket prices</strong> are the cost of one share including the pool's commission and its own impact, so they sit above the pool's chance, and Yes plus No above 1.</li>
            <li><strong>What if and Build your thesis</strong> show the pool's chances without impact, read at the block shown.</li>
            <li><strong>Average per share</strong> in the ticket shows the impact at your size. The difference between the 1-share price and your average is what moving the pool costs you.</li>
          </ul>
          <p>Prices are the pool's estimates. Being internally consistent does not make them accurate, and none of the properties above promises a profit.</p>
        </section>

        <section id="agents" aria-labelledby="agents-title">
          <h2 id="agents-title">Agents and SDKs</h2>
          <p>Agents are for members comfortable running software on their own computer or server. Flurbo provides SDKs in TypeScript, Python, Rust and C++. Registering an agent does not start or host it. Agents can trade every pool. Pools of more than four questions need SDK 0.3.0 or later, and the pool comparison analytics cover every pool.</p>
          <p className="docs-note"><strong>New to running software?</strong> Follow <a href="#first-bot">Your first trading bot, step by step</a>. It explains every command and why it is needed.</p>
          <ol className="docs-steps">
            <li><strong>Register.</strong> Open <Link href="/agents">Agents</Link>, name your agent and choose the markets it may trade. Permission covers the market's whole pool; your strategy chooses the questions and combinations.<Shot name="agents-register" src={registerShot} alt="Register an agent form with a name field and market checkboxes" caption="Registering an agent: a name and the markets it may trade."/></li>
            <li><strong>Associate a dedicated wallet.</strong> In Setup, enter its public address and sign the ownership message where the agent runs. Keep its private key on that machine. Never use your personal or manual-trading wallet.</li>
            <li><strong>Create an API credential.</strong> Copy the token when it is shown and store it in the runtime's environment. It allows API access, not wallet signing. Never put the token or the private key in a shared script or a model prompt.</li>
            <li><strong>Run in paper mode.</strong> Choose your language in Setup, install its dependencies and create the configuration with the <code>init</code> line shown there: it already carries your agent's markets after <code>--markets</code>. Then set your model provider, strategy and limits. Paper decisions simulate trades without moving funds. On Windows the C++ runtime needs <code>C:/msys64/ucrt64/bin</code> on PATH; without it, it exits at once with code 127 and no message.</li>
            <li><strong>Fund the agent wallet.</strong> On Setup, under Agent wallet, send test MON and test AUSD from your own MetaMask. The test AUSD dispenser only pays the wallet that asks, so it cannot fund an agent wallet directly.<Shot name="agent-wallet" src={walletShot} alt="Agent wallet panel showing the agent's balances and buttons to send test MON and test AUSD from MetaMask" caption="Agent wallet on Setup: send test MON and test AUSD from your own MetaMask."/></li>
            <li><strong>Turn on live testnet trading deliberately.</strong> Live mode must be on in both the runtime configuration and Flurbo Settings. New agents start with Flurbo limits of 2 test AUSD per trade and 10 test AUSD per 24 hours, which you can change. Every trade must also pass the runtime's own limits and a fresh quote.<Shot name="agent-live" src={liveShot} alt="Agent Settings with the per-trade and daily limits and the confirmation to allow live testnet trades" caption="Allowing live testnet trades asks you to confirm the agent's limits first."/></li>
          </ol>
          <p>Overview shows the runtime's status and verified trades. Running means a heartbeat arrived in the last 90 seconds. Stopped means the runtime reported that its run ended: after a stop request, Ctrl+C in TypeScript and Python, or a single <code>--once</code> pass. Rust and C++ end at once on Ctrl+C without reporting, so they show as possibly offline after 90 seconds, and as not running after 10 minutes. Activity shows reported decisions, Setup holds the wallet, funding, credentials and language instructions, and Settings holds limits, pause and archive.</p>
          <Shot name="agent-activity" src={activityShot} alt="Agent Activity tab listing decisions, one opened to show its forecast and evidence" caption="Activity: every decision the runtime reports, with the evidence behind its forecast."/>
          <div className="docs-note"><strong>Identical agents compete with each other.</strong><p>Each purchase moves the price for the next one. Agents running the same strategy on the same market bid against each other, pay more for the same shares and shrink each other's edge. Vary forecasts, markets or limits.</p></div>
          <details><summary>SDK reference and custom strategies</summary><p>Each SDK's README covers configuration, execution, recovery and custom strategies; custom software must keep those checks. The SDK source is not public yet. Ask the Flurbo team for a copy through the channel where you received your invitation.</p></details>
          <details><summary>Stopping an agent and recovering a transaction</summary><p>Closing the browser does not stop the runtime; stop it where it runs. A pause on Flurbo is a software instruction, and a transaction already sent can still confirm. Keep the runtime's state directory and restart with the same configuration to recover pending transactions without sending them twice.</p><p>A revoked credential stops a compliant runtime from starting new work. It does not revoke the wallet's on-chain permissions or its private key. A stale heartbeat is a last report, not proof that the runtime has stopped.</p></details>
          <p>The assisted agent is different: you enter forecasts yourself and either record paper decisions or confirm proposed trades in MetaMask. It never trades on its own.</p>
        </section>
        <FirstBotGuide/>

        <section id="limits" aria-labelledby="limits-title">
          <h2 id="limits-title">Limits and allowances</h2>
          <p>These are the defaults on this testnet. Where a market or your agent settings show a different value, that value applies.</p>
          <h3>Test funds</h3>
          <ul>
            <li><strong>Starter test MON:</strong> sent once, automatically, when an approved account links its first wallet. Once per account and per wallet, only while the wallet holds less than 0.1 test MON, and within a daily total across all members. The amount is shown on Get test funds.</li>
            <li><strong>Test AUSD:</strong> 50 per request, once every 24 hours per wallet, while the dispenser has funds.</li>
          </ul>
          <h3>Trading on the site</h3>
          <ul>
            <li>Up to 20 shares per trade.</li>
            <li>0.5% price tolerance on every purchase and sale.</li>
            <li>A transaction review stays valid for about two minutes.</li>
            <li>Combined predictions cover up to three questions from one pool, within the combinations that pool can quote.</li>
            <li>Up to 20 linked wallets per account. Buying and selling on the site use linked wallets; collecting a payout works from any wallet that holds the shares.</li>
          </ul>
          <h3>Settlement</h3>
          <ul>
            <li>Challenging a source-verified answer needs the test AUSD bond shown on the market, the same as the proposal's bond.</li>
            <li>Reality.eth answers need at least the minimum Sepolia ETH bond shown, and a different answer at least doubles the current bond. Kleros arbitration costs the fee shown.</li>
          </ul>
          <h3>Agents</h3>
          <ul>
            <li><strong>Flurbo limits, set per agent in Settings:</strong> 2 test AUSD per trade and 10 test AUSD per 24 hours by default. Live trading also needs <code>"mode": "live"</code> in the runtime.</li>
            <li><strong>Runtime limits, in its configuration file:</strong> 2 test AUSD per trade, 10 test AUSD per 24 hours, 20 test AUSD in total, at most 5 shares of any one prediction, 0.5% price tolerance, no trading in the last 120 seconds before a market closes (<code>policy.minSecondsBeforeClose</code>), at most 2 unconfirmed transactions, and 0.2 test MON always kept for fees.</li>
            <li>A trade must pass both sets of limits. At most 100 shares or 100 test AUSD per trade, and 120 API requests per minute per credential.</li>
          </ul>
          <p>Limits are software checks by Flurbo and the runtime. The balance in a wallet is the hard limit on what it can spend.</p>
        </section>

        <section id="application-data" aria-labelledby="application-data-title">
          <h2 id="application-data-title">Your data</h2>
          <p>When you request access, Flurbo stores your contact email, Mera account address, verification state and application decision. Your email is used for verification, access updates and, once you are approved, the <a href="#notices">notices</a> you choose about your own positions. It is never used for marketing or shared, and each email goes to you alone. Supabase stores applications and Resend delivers the emails.</p>
          <p>You can withdraw an unapproved application from Your account to remove its contact email. Approval records and account identifiers are kept to enforce access decisions. Withdrawing does not erase blockchain activity or change your passkey. For other deletion requests, contact the Flurbo team through the channel where you received your invitation.</p>
          <p>Wallet transactions and positions are public on chain, and evidence you save for settlement is public. Organising wallets under one account does not hide their activity.</p>
        </section>

        <section id="help" aria-labelledby="help-title">
          <h2 id="help-title">Common questions</h2>
          <details><summary>I created an account. Why can't I open the markets?</summary><p>Creating an account and being approved are separate steps. Request access from Your account and verify your email. The team reviews requests and emails you when you are approved, and Your account always shows the current status.</p></details>
          <details><summary>Why did MetaMask ask me twice for one purchase?</summary><p>The first confirmation allows the pool to spend exactly the purchase's maximum in test AUSD. The second is the purchase. Only the second buys shares.</p></details>
          <details><summary>I allowed the payment. Where are my shares?</summary><p>Allowing a payment does not buy anything. When it confirms, the purchase review opens in the ticket: confirm that too. If a transaction is pending, wait for it instead of sending another.</p></details>
          <details><summary>I cancelled in MetaMask, but the page still says waiting.</summary><p>MetaMask closed without telling Flurbo what happened. If you cancelled, choose Nothing was sent in the sheet. If you are not sure, check MetaMask's activity: attach the hash if a transaction is there. See <a href="#trading">If you cancel in MetaMask</a>.</p></details>
          <details><summary>What is the bar at the bottom of the page?</summary><p>It shows a transaction Flurbo is still tracking, on every page. View opens the market it belongs to.</p></details>
          <details><summary>Why is there no quote for my combination?</summary><p>Trading may have closed, the pool may not be able to price that combination yet, or the quote could not be read. Try Refresh price. See <a href="#combinations">When a combination has no quote</a>.</p></details>
          <details><summary>Why do Yes and No add up to more than 1?</summary><p>Each price is the cost of buying one share, including the pool's commission and that share's own price impact. Before impact, Yes and No together cost at most 1 plus the commission. The pool's chances add up to exactly 100%; What if shows them.</p></details>
          <details><summary>Trading closed. When can I collect?</summary><p>When every question in the pool is final. The Timeline tab shows where each question is. Then collect on the market page with the wallet that holds the shares; Portfolio links you there.</p></details>
          <details><summary>Why did MetaMask switch to Sepolia?</summary><p>Reality.eth answers and Kleros cases run on Sepolia, so posting an answer, requesting arbitration, submitting evidence or funding an appeal happens there. Trading and collecting stay on Monad testnet.</p></details>
          <details><summary>Why is profit and loss still loading?</summary><p>Holdings and collected payouts can appear before the full purchase history. The Performance chart waits until the cost of every sold or collected share is known. Retry activity continues the check if needed. A payout total is not a profit total.</p></details>
        </section>

        <section id="preview" aria-labelledby="preview-title">
          <h2 id="preview-title">Preview limitations</h2>
          <p>Flurbo is in a supervised testnet preview. Every asset is a test asset, and features and availability differ by market. The published rules and the live on-chain state govern each market.</p>
          <ul>
            <li>The relay that reports Reality.eth answers to Monad is run by Flurbo and is trusted on this testnet.</li>
            <li>Kleros cases run on Sepolia, where Flurbo team members can be among the jurors, so a ruling is not an independent review.</li>
            <li>Flurbo runs the reader that proposes or posts first answers. Every answer can be challenged, and a wrong answer nobody challenges can still become final.</li>
            <li>The contracts have not been audited.</li>
          </ul>
          <p>Invitations control access to this site. They do not make the contracts permissioned or hide trades, and removing site access does not change on-chain balances or rights.</p>
          <p>This guide describes the product. For the exact question, source, deadlines and payout conditions of a market, read the rules linked from that market.</p>
          {explore}
        </section>
      </article>
    </div>
  </main>;
}
