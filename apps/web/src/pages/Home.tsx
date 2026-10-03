import {ArrowUpRight,ArrowRight,FileText} from 'lucide-react';
import {useState} from 'react';
import {Link} from 'wouter';
import {useAuth} from '../auth/context';
import './home.css';
import VisitorStatus from './VisitorStatus';
import {usePreviewAccess} from '../auth/preview-access';
import {LITEPAPER} from '../components/SiteFooter';

function ConnectionExample(){
  const [answer,setAnswer]=useState<'all'|'yes'|'no'>('all');
  const chance=answer==='yes'?22/30*100:answer==='no'?18/70*100:40;
  return <section className="home-example" aria-label="Illustrative What-if example">
    <div className="home-example-top"><span className="home-example-kicker">What-if example</span><span className="home-pill">Illustrative</span></div>
    <h2>What if the upgrade <span className="serif-accent">goes live?</span></h2>
    <p className="home-example-lede">Explore how one answer changes the market’s view of another.</p>
    <div className="home-example-questions"><div><span>A / Exchange supports it</span><strong>40%</strong></div><div><span>B / Upgrade goes live</span><strong>30%</strong></div></div>
    <fieldset><legend>Assume the upgrade…</legend><div className="home-segments segmented segmented-block">{(['all','yes','no'] as const).map(a=><button type="button" key={a} aria-pressed={a===answer} onClick={()=>setAnswer(a)}>{a==='all'?'No assumption':a==='yes'?'Goes live':'Doesn’t go live'}</button>)}</div></fieldset>
    <div className="home-example-result" role="status" aria-live="polite"><span>Chance the exchange supports it</span><strong key={answer}>{chance.toFixed(answer==='all'?0:1)}<small>%</small></strong><div className="home-example-track" aria-hidden="true"><span style={{transform:`scaleX(${chance/100})`}}/></div><small>{answer==='yes'?'22 ÷ 30':answer==='no'?'(40 − 22) ÷ (100 − 30)':'Without assuming an answer to B'}</small></div>
    <div className="home-joint"><div><span>Both happen</span><strong>22%</strong></div><div><span>If independent</span><strong>12%</strong></div><span className="home-pill">+10 pp</span></div>
    <p className="home-example-note">Made-up probabilities, not live quotes. A conditional relationship does not establish cause and effect.</p>
  </section>;
}

// The 2 by 2 grid is the real outcome space for two yes-or-no questions.
function StateGrid({pays,scope}:{pays:[boolean,boolean,boolean,boolean];scope?:'a-yes'}){
  const cell=(i:number)=><span className={'state-cell'+(pays[i]?' pays':'')+(scope==='a-yes'&&i>1?' outside':'')}>{pays[i]?'Pays':scope==='a-yes'&&i>1?'Set aside':'0'}</span>;
  return <div className="state-grid" aria-hidden="true">
    <span/><span className="state-axis">B yes</span><span className="state-axis">B no</span>
    <span className="state-axis">A yes</span>{cell(0)}{cell(1)}
    <span className="state-axis">A no</span>{cell(2)}{cell(3)}
  </div>;
}

export default function Home(){
  const {state}=useAuth();
  const {access,checking}=usePreviewAccess();
  const destination=access?.approved?'/markets':state.address?'/access':'/signup';
  const action=access?.approved?'Explore markets':state.address?'Your access':'Get early access';
  // Signed-in visitors wait for the access check, so the main action never changes label after it appears.
  const resolving=!!state.address&&checking&&!access;
  const primary=(className='')=>resolving?<span className={`btn btn-primary btn-lg home-action-placeholder ${className}`} aria-hidden="true">Explore markets</span>:<Link href={destination} className={`btn btn-primary btn-lg ${className}`}>{action}<ArrowUpRight size={18} strokeWidth={1.75}/></Link>;
  return <main id="main" tabIndex={-1} className="home-current">
    <section className="home-hero container">
      <div className="home-hero-copy">
        <h1>A view worth <span className="serif-accent">combining.</span></h1>
        <p className="home-lede">Make predictions on individual events or how they happen together. Explore connected ideas, with one price for your combination.</p>
        <div className="home-actions">{primary()}<a className="text-link" href="#the-idea">See the connection <ArrowRight size={16} strokeWidth={1.75}/></a></div>
        <p className="home-hero-note">Monad testnet preview. Test assets only.</p>
      </div>
      <ConnectionExample/>
    </section>

    <section className="home-idea container" id="the-idea">
      <div className="home-idea-copy">
        <h2>Look beyond one question.</h2>
        <p>Flurbo brings individual and combined predictions into one shared market, letting you see how the market prices relationships between events.</p>
        <p className="home-muted">Buy a single answer, combine outcomes with “all” or “any,” or explore a What-if without placing a trade. Connected pricing adds context. It does not guarantee accuracy.</p>
      </div>
      <div className="home-compare" role="list" aria-label="Three ways to hold a view">
        <article role="listitem"><h3>Individual</h3><p>Choose Yes or No on one question. A winning share pays 1 test AUSD.</p><StateGrid pays={[true,false,true,false]}/><p className="state-caption">B yes pays in 2 of 4 outcomes, whatever happens to A.</p></article>
        <article role="listitem"><h3>Combined</h3><p>Join up to three supported questions from the same pool into one position, with one price and a payout rule you can inspect before buying.</p><StateGrid pays={[true,false,false,false]}/><p className="state-caption">A yes AND B yes pays only when both happen.</p></article>
        <article role="listitem"><h3>What-if</h3><p>Assume one answer and see the conditional chance of another. Read-only: it is not a position you can buy.</p><StateGrid pays={[true,false,false,false]} scope="a-yes"/><p className="state-caption">B if A looks only at outcomes where A is yes.</p></article>
      </div>
      <Link href="/docs#combinations" className="text-link">Read the guide <ArrowUpRight size={16} strokeWidth={1.75}/></Link>
    </section>

    <section className="home-start container" id="how-it-works">
      <div className="home-section-heading"><h2>From invitation to prediction.</h2><p>Each market has its own page, price observations, source rules and settlement timeline. Your portfolio brings shares from your linked trading wallets together.</p></div>
      <ol className="home-steps">
        <li><span className="home-step-index" aria-hidden="true">1</span><h3>Create your account</h3><p>Create a Mera passkey account and request access when applications open. Approval belongs to your account.</p></li>
        <li><span className="home-step-index" aria-hidden="true">2</span><h3>Connect & fund MetaMask</h3><p>Once approved, connect MetaMask and get test AUSD and test MON. Your trading wallet signs every transaction.</p></li>
        <li><span className="home-step-index" aria-hidden="true">3</span><h3>Pick your prediction</h3><p>Choose an answer, review the cost and confirm in MetaMask. Follow your shares in Portfolio.</p></li>
      </ol>
      <div className="home-start-foot"><VisitorStatus access={access}/>
        <a className="home-litepaper" href={LITEPAPER.href} type="application/pdf"><FileText size={20} strokeWidth={1.75}/><span><strong>{LITEPAPER.label}</strong><small>How pricing, combinations and settlement work. {LITEPAPER.detail}.</small></span><ArrowUpRight size={16} strokeWidth={1.75}/></a>
      </div>
    </section>

    <section className="home-faq container" id="faq"><h2>A few things, made clear.</h2><div className="home-faq-list">{[
      ['How do I get access?','Create a Mera passkey account. When applications are open, use Request access on your account page. The native form captures your account automatically; enter and verify your email. Approval is manual; signing up does not automatically grant access.'],
      ['Which assets does this preview use?','Test AUSD and test MON on Monad testnet only. Questions can concern real events or clearly labelled scripted practice scenarios. Check the source and rules on each market.'],
      ['What does a winning share pay?','A winning share pays 1 test AUSD; a losing share pays 0. VOID outcomes follow the published fractional-payout rule, not a refund of your purchase. Payout is not profit: subtract your cost and network fees.'],
      ['Who decides the result?','Each market commits its source rules and deadlines before trading. Answers are proposed with a bond and can be challenged. Current testnet disputes use reviewer wallets controlled by the Flurbo operator. Finalization and delivery must complete before you can collect payouts.'],
      ['Is What-if a prediction I can buy?','What-if is read-only. It shows probabilities implied by the pricing model, including conditional probabilities. Buying a combined AND position is different from trading a conditional. A purchase quote also includes the impact of trade size.'],
      ['What can other people see?','Transactions and wallet positions are visible on-chain.'],
      ['Can I use more than one MetaMask wallet?','Yes. Link each trading wallet to your Mera account with a signature. Your portfolio shows their shares together. Funds and positions stay in the MetaMask wallet that owns them; use that wallet to sell or collect payouts.']
    ].map(([q,a])=><details key={q} className="disclosure"><summary>{q}</summary><p>{a}</p></details>)}</div></section>

    <section className="home-final container"><h2>Put your view to the test.</h2>{primary()}</section>
  </main>;
}
