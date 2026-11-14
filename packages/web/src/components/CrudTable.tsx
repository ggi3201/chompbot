import { useState } from "react";
import { Button } from "./ui";

export interface Column<T> {
  key: keyof T & string;
  label: string;
  render?: (value: T[keyof T], item: T) => React.ReactNode;
}

interface CrudTableProps<T extends { id: string }> {
  items: T[];
  columns: Column<T>[];
  loading: boolean;
  error: string | null;
  onEdit: (item: T) => void;
  onDelete: (id: string) => void;
  onToggle?: (id: string, enabled: boolean) => void;
  enabledKey?: keyof T & string;
  renderActions?: (item: T) => React.ReactNode;
  /** Rows this page cannot change: the text says where they are managed, in place of the toggle, Edit and Delete. */
  readOnly?: (item: T) => string | undefined;
}

export default function CrudTable<T extends { id: string }>({
  items,
  columns,
  loading,
  error,
  onEdit,
  onDelete,
  onToggle,
  enabledKey,
  renderActions,
  readOnly,
}: CrudTableProps<T>) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (loading) {
    return <div className="p-8 text-text-muted">Loading</div>;
  }

  if (error) {
    return <div className="p-8 text-error">{error}</div>;
  }

  if (items.length === 0) {
    return <div className="p-8 text-text-muted">Nothing here yet</div>;
  }

  return (
    <div className="bg-glass rounded-lg border border-border overflow-hidden">
      <div className="overflow-x-auto">
      <table className="w-full border-collapse min-w-[480px]">
        <thead>
          <tr>
            {enabledKey && (
              <th className="text-left px-4 h-10 border-b border-border text-[13px] text-text-muted font-normal">
                On
              </th>
            )}
            {columns.map((col) => (
              <th
                key={col.key}
                className="text-left px-4 h-10 border-b border-border text-[13px] text-text-muted font-normal"
              >
                {col.label}
              </th>
            ))}
            <th className="text-left px-4 h-10 border-b border-border text-[13px] text-text-muted font-normal text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const managedElsewhere = readOnly?.(item);
            return (
            <tr key={item.id} className="border-b border-border last:border-b-0 hover:bg-white/2">
              {enabledKey && (
                <td className="px-4 py-2.5 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={!!item[enabledKey]}
                    disabled={!!managedElsewhere}
                    onChange={() => onToggle?.(item.id, !item[enabledKey])}
                  />
                </td>
              )}
              {columns.map((col) => (
                <td key={col.key} className="px-4 py-2.5 text-sm text-text-secondary">
                  {col.render ? col.render(item[col.key], item) : String(item[col.key] ?? "")}
                </td>
              ))}
              <td className="px-4 py-2.5 text-sm text-text-secondary">
                <div className="flex justify-end gap-1 whitespace-nowrap">
                {managedElsewhere ? (
                  <span className="self-center text-[13px] text-text-muted">{managedElsewhere}</span>
                ) : (
                <>
                <Button variant="ghost" size="sm" onClick={() => onEdit(item)}>
                  Edit
                </Button>
                {confirmDelete === item.id ? (
                  <>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => { onDelete(item.id); setConfirmDelete(null); }}
                    >
                      Confirm
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDelete(item.id)}
                  >
                    Delete
                  </Button>
                )}
                </>
                )}
                {renderActions?.(item)}
                </div>
              </td>
            </tr>
          );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
