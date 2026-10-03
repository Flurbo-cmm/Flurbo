import { ArrowUpRight } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "../auth/context";

export default function NotFound() {
  const { state } = useAuth();
  return <main id="main" tabIndex={-1} className="page page-task not-found">
    <p className="overline">Page not found</p>
    <h1>Nothing here <span className="serif-accent">yet.</span></h1>
    <p className="lead">This address does not match a Flurbo page. It may have moved, or the link may be incomplete.</p>
    <div className="cluster">
      {state.address ? <Link href="/markets" className="btn btn-primary">Go to markets <ArrowUpRight size={16} strokeWidth={1.75} /></Link>
        : <Link href="/" className="btn btn-primary">Back to flurbo <ArrowUpRight size={16} strokeWidth={1.75} /></Link>}
      <Link href="/docs" className="text-link">Read the guide</Link>
    </div>
  </main>;
}
