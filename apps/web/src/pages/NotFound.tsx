import { ArrowUpRight } from "lucide-react";
import { Link } from "wouter";
import { ContourMark } from "../components/BrandLogo";

export default function NotFound() {
  return <main id="main" tabIndex={-1} className="page page-task not-found">
    <svg className="not-found-mark" viewBox="4 3 54 54" aria-hidden="true" focusable="false"><ContourMark /></svg>
    <h1>Nothing here.</h1>
    <p className="lead">This address does not match a Flurbo page. It may have moved, or the link may be incomplete.</p>
    <div className="cluster">
      <Link href="/markets" className="btn btn-primary">Go to markets <ArrowUpRight size={16} strokeWidth={1.75} /></Link>
      <Link href="/" className="text-link">Back to flurbo</Link>
    </div>
  </main>;
}
