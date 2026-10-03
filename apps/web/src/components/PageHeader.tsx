import type { ReactNode } from 'react';

// One page anatomy everywhere: optional back link, title, one line, primary action.
export default function PageHeader({ back, title, lead, actions, meta, className = '' }: {
  back?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode; meta?: ReactNode; className?: string;
}) {
  return (
    <header className={`page-header ${className}`.trim()}>
      {back && <div className="page-header-top">{back}</div>}
      <div className="page-header-main">
        <div className="page-header-copy">
          <h1>{title}</h1>
          {lead && <p className="lead">{lead}</p>}
          {meta}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </header>
  );
}
