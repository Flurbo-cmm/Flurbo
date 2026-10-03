import {Link} from 'wouter';
import {ArrowLeft} from 'lucide-react';
import Funding from './Funding';
import PageHeader from '../components/PageHeader';
import './funding.css';

export default function FundingPage() {
  return <main id="main" className="page page-task funding-page" tabIndex={-1}>
    <PageHeader back={<Link href="/markets" className="link-back"><ArrowLeft size={16} strokeWidth={1.75} /> Back to markets</Link>}
      title="Get test funds" lead="A little fuel for your predictions. Free test tokens in MetaMask. No real money needed." />
    <Funding expanded/>
  </main>;
}
