interface PageHeaderProps {
  title: string;
  action?: React.ReactNode;
}

export default function PageHeader({ title, action }: PageHeaderProps) {
  return (
    <div className="flex justify-between items-center gap-4 mb-6">
      <h2 className="text-text-primary font-medium text-2xl leading-tight">{title}</h2>
      {action}
    </div>
  );
}
