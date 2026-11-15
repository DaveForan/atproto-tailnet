interface CardProps {
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Card({ title, actions, children, className }: CardProps) {
  return (
    <div className={`card ${className ?? ""}`}>
      {title && (
        <div className="card-header">
          <h3>{title}</h3>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
