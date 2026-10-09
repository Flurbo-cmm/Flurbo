import {ArrowUpRight,FileText} from 'lucide-react';
import {useEffect,useRef,useState} from 'react';
import {Link} from 'wouter';
import {useAuth} from '../auth/context';
import './home.css';
import VisitorStatus from './VisitorStatus';
import {usePreviewAccess} from '../auth/preview-access';
import {LITEPAPER} from '../components/SiteFooter';
import {INK} from '../components/BrandLogo';
import {drawHalftone} from '../halftone';
import SegmentedControl from '../components/ui/SegmentedControl';
import JointGrid,{type JointKey,type JointMark} from '../components/market/JointGrid';
import ProofPanel from '../components/market/ProofPanel';
import LinkedMarketDemo from '../landing/LinkedMarketDemo';
import {EXAMPLE,jointCells} from '../landing/example-market';

// The hero ground: the logo's contour rings as a printed dot tone, drawn once per size.
function HeroGround(){
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    let frame=0;
    const draw=()=>{const node=canvas.current;if(!node)return;const small=window.innerWidth<1024;
      drawHalftone(node,small?{color:INK,opacity:0.2,markHeight:620,cx:0.62,cy:0.58,step:8,maxRadius:2.6,band:26,base:0.7}:{color:INK,opacity:0.2,markHeight:1100,cx:0.6,cy:0.52,step:10,maxRadius:3.6,band:44,base:1});};
    const onResize=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(draw);};
    draw();window.addEventListener('resize',onResize);
    return()=>{cancelAnimationFrame(frame);window.removeEventListener('resize',onResize);};
  },[]);
  return <canvas ref={canvas} className="home-ground" aria-hidden="true"/>;
}

const VIEWS={
  individual:{label:'Individual',text:'Choose Yes or No on one question. A winning share pays 1 test AUSD.',caption:'B yes pays in 2 of 4 outcomes, whatever happens to A.',
    cells:{yy:'Pays',yn:'0',ny:'Pays',nn:'0'},marks:{yy:'focus',yn:'in',ny:'focus',nn:'in'}},
  combined:{label:'Combined',text:'Join up to three supported questions from the same pool into one position, with one price and a payout rule you can inspect before buying.',caption:'A yes AND B yes pays only when both happen.',
    cells:{yy:'Pays',yn:'0',ny:'0',nn:'0'},marks:{yy:'focus',yn:'in',ny:'in',nn:'in'}},
  whatif:{label:'What-if',text:'Assume one answer and see the conditional chance of another. Read-only: it is not a position you can buy.',caption:'B if A looks only at outcomes where A is yes.',
    cells:{yy:'Counted',yn:'0',ny:'Set aside',nn:'Set aside'},marks:{yy:'focus',yn:'in',ny:'out',nn:'out'}},
} satisfies Record<string,{label:string;text:string;caption:string;cells:Record<JointKey,string>;marks:Record<JointKey,JointMark>}>;
type View=keyof typeof VIEWS;

const ROUTE=[
  {step:'Source read',detail:'The source named in the rule is read at the deadline.'},
  {step:'Answer proposed',detail:'Someone posts the answer with a bond.'},
  {step:'Challenge window',detail:'Anyone can dispute it by posting a larger bond.'},
  {step:'Kleros review',detail:'Only if challenged: Kleros jurors rule on the answer.'},
  {step:'Final',detail:'The final answer is relayed to the pool on Monad testnet.'},
  {step:'Payout',detail:'Each winning share pays 1 test AUSD.'},
];
const FINALITY=[
  {step:'Rules published',detail:'Source, rule and deadlines are fixed before trading opens.'},
  {step:'Answer proposed',detail:'A mechanical source reader or a Reality.eth question on Sepolia proposes the answer, backed by a bond.'},
  {step:'Kleros, if challenged',detail:'Anyone can challenge within the window. A challenged answer goes to Kleros jurors.'},
  {step:'Relayed to Monad',detail:'The final answer is reported to the pool on Monad testnet.'},
  {step:'Paid',detail:'A shared pool pays once every question in it is final.'},
];
const SNIPPET=['# Node 24 or later, in your copy of the Flurbo SDK source','cd packages/sdk && npm ci','node bin/flurbo-agent.ts init --config flurbo-agent.json --markets <your markets>','# Keep "mode": "paper" until ready.','export FLURBO_AGENT_TOKEN=...','node bin/flurbo-agent.ts start --config flurbo-agent.json'].join('\n');
const FAQ=[
  ['How do I get access?','Create a Mera passkey account. When applications are open, use Request access on your account page. The native form captures your account automatically; enter and verify your email. Approval is manual; signing up does not automatically grant access.'],
  ['Which assets does this preview use?','Test AUSD and test MON on Monad testnet only. Questions can concern real events or clearly labelled scripted practice scenarios. Check the source and rules on each market.'],
  ['What does a winning share pay?','A winning share pays 1 test AUSD; a losing share pays 0. VOID outcomes follow the published fractional-payout rule, not a refund of your purchase. Payout is not profit: subtract your cost and network fees.'],
  ['Who decides the result?','Each market commits its source rules and deadlines before trading. Answers are proposed with a bond and can be challenged. Current testnet disputes use reviewer wallets controlled by the Flurbo operator. Finalization and delivery must complete before you can collect payouts.'],
  ['Is What-if a prediction I can buy?','What-if is read-only. It shows probabilities implied by the pricing model, including conditional probabilities. Buying a combined AND position is different from trading a conditional. A purchase quote also includes the impact of trade size.'],
  ['What can other people see?','Transactions and wallet positions are visible on-chain.'],
  ['Can I use more than one MetaMask wallet?','Yes. Link each trading wallet to your Mera account with a signature. Your portfolio shows their shares together. Funds and positions stay in the MetaMask wallet that owns them; use that wallet to sell or collect payouts.'],
];

export default function Home(){
  const {state}=useAuth();
  const {access,checking}=usePreviewAccess();
  const destination=access?.approved?'/markets':state.address?'/access':'/signup';
  const action=access?.approved?'Explore markets':state.address?'Your access':'Get early access';
  // Signed-in visitors wait for the access check, so the main action never changes label after it appears.
  const resolving=!!state.address&&checking&&!access;
  const primary=(className='')=>resolving?<span className={`btn btn-primary btn-lg home-action-placeholder ${className}`} aria-hidden="true">Explore markets</span>:<Link href={destination} className={`btn btn-primary btn-lg ${className}`}>{action}<ArrowUpRight size={18} strokeWidth={1.75}/></Link>;
  const [proof,setProof]=useState(false),[view,setView]=useState<View>('individual');
  const cells=jointCells(),shown=VIEWS[view];
  return <main id="main" tabIndex={-1} className="home-current">
    <section className="home-hero">
      <HeroGround/>
      <div className="home-hero-inner">
        <div className="home-hero-copy">
          <h1>Price how events connect.</h1>
          <p className="home-lede">Trade single questions or linked outcomes from one shared pool. Every price, rule and result is public.</p>
          <div className="home-actions">{primary()}<a className="text-link" href="#the-idea">See the example</a></div>
        </div>
        <div className="home-demo"><LinkedMarketDemo proofHref="#the-proof" onProof={()=>setProof(true)}/></div>
      </div>
    </section>

    <section className="home-idea home-band" id="the-idea" aria-labelledby="idea-title">
      <div className="home-idea-copy">
        <h2 id="idea-title">One pool. Four outcomes.</h2>
        <p>The example's two questions share one pool. It prices each answer and every way the two can land together, so the four outcomes always add up to 1 test AUSD.</p>
        <dl className="leaders home-outcomes">
          <div><dt>A yes, B yes</dt><dd>{cells.yy.toFixed(2)}</dd></div>
          <div><dt>A yes, B no</dt><dd>{cells.yn.toFixed(2)}</dd></div>
          <div><dt>A no, B yes</dt><dd>{cells.ny.toFixed(2)}</dd></div>
          <div><dt>A no, B no</dt><dd>{cells.nn.toFixed(2)}</dd></div>
          <div className="home-outcomes-total"><dt>All four</dt><dd>1.00</dd></div>
        </dl>
        <p className="home-muted">Together, A and B cost {EXAMPLE.pAB.toFixed(2)}. If the two were unrelated they would cost {(EXAMPLE.pA*EXAMPLE.pB).toFixed(2)}, so the pool expects them to move together. Connected pricing adds context. It does not guarantee accuracy.</p>
      </div>
      <div className="home-proof">
        <h3>How the example would settle</h3>
        <p className="home-muted">The rule, the source and the route to a final answer are fixed before anyone trades.</p>
        <button type="button" className="btn btn-secondary" aria-expanded={proof} aria-controls="the-proof" onClick={()=>setProof(open=>!open)}>{proof?'Hide the proof':'Show the proof'}</button>
        <div id="the-proof" className="home-proof-slot">{proof&&<ProofPanel label="Proof for the example market" rule="Yes if the upgrade activates on mainnet before the deadline in the published rules." source="The client team's release announcement, read at the deadline." route={ROUTE}
          links={[{label:'The live pool on Monadscan',href:`https://testnet.monadscan.com/address/${EXAMPLE.proofPool}`},{label:'Its Reality.eth question on Sepolia',href:`https://sepolia.etherscan.io/tx/${EXAMPLE.proofQuestionTx}`}]}/>}</div>
      </div>
    </section>

    <section className="home-views home-band" aria-labelledby="views-title">
      <div className="home-views-copy">
        <h2 id="views-title">Three ways to hold a view.</h2>
        <SegmentedControl label="Way to hold a view" hideLabel value={view} options={(Object.keys(VIEWS) as View[]).map(value=>({value,label:VIEWS[value].label}))} onChange={value=>setView(value as View)}/>
        <p>{shown.text}</p>
        <Link href="/docs#combinations" className="text-link">Read the guide <ArrowUpRight size={16} strokeWidth={1.75}/></Link>
      </div>
      <figure className="home-views-grid">
        <JointGrid caption={`${shown.label}: which outcomes pay`} cells={shown.cells} marks={shown.marks}/>
        <figcaption>{shown.caption}</figcaption>
      </figure>
    </section>

    <section className="home-final-route home-band" aria-labelledby="route-title">
      <h2 id="route-title">How a result becomes final.</h2>
      <ol className="home-route">{FINALITY.map(item=><li key={item.step}><strong>{item.step}</strong><span>{item.detail}</span></li>)}</ol>
    </section>

    <section className="home-builders home-band" aria-labelledby="builders-title">
      <div>
        <h2 id="builders-title">For builders and quants.</h2>
        <p>Write an agent with the Flurbo SDK in TypeScript, Python, Rust or C++. It researches, forecasts and trades from its own wallet within limits you set, and it starts in paper mode.</p>
        <Link href="/docs#agents" className="text-link">Read the agent guide <ArrowUpRight size={16} strokeWidth={1.75}/></Link>
      </div>
      <pre className="home-code" aria-label="Start an agent in paper mode with the TypeScript SDK"><code>{SNIPPET}</code></pre>
    </section>

    <section className="home-start home-band" id="how-it-works" aria-labelledby="start-title">
      <h2 id="start-title">From invitation to prediction.</h2>
      <ol className="home-steps">
        <li><span className="home-step-index">1</span><div><h3>Create your account</h3><p>Create a Mera passkey account and request access when applications open. Approval belongs to your account.</p></div></li>
        <li><span className="home-step-index">2</span><div><h3>Connect and fund MetaMask</h3><p>Once approved, connect MetaMask and get test AUSD and test MON. Your trading wallet signs every transaction.</p></div></li>
        <li><span className="home-step-index">3</span><div><h3>Pick your prediction</h3><p>Choose an answer, review the cost and confirm in MetaMask. Follow your shares in Portfolio.</p></div></li>
      </ol>
      <div className="home-start-foot"><VisitorStatus access={access}/>
        <a className="home-litepaper" href={LITEPAPER.href} type="application/pdf"><FileText size={20} strokeWidth={1.75}/><span><strong>{LITEPAPER.label}</strong><small>How pricing, combinations and settlement work. {LITEPAPER.detail}.</small></span><ArrowUpRight size={16} strokeWidth={1.75}/></a>
      </div>
    </section>

    <section className="home-faq home-band" id="faq" aria-labelledby="faq-title"><h2 id="faq-title">A few things, made clear.</h2><div className="home-faq-list">{FAQ.map(([q,a])=><details key={q} className="disclosure"><summary>{q}</summary><p>{a}</p></details>)}</div></section>

    <section className="home-final home-band"><h2>Put your view to the test.</h2>{primary()}</section>
  </main>;
}
