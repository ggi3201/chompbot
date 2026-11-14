export default function PanelTitle({ title, meta }: { title: string; meta?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 mb-4">
      <h3 className="text-[15px] font-medium m-0">{title}</h3>
      {meta && <div className="ml-auto font-mono text-xs text-text-muted flex items-center gap-4">{meta}</div>}
    </div>
  );
}
