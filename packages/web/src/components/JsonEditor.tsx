import CodeEditor from "./CodeEditor";

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  minHeight?: string;
  validate?: boolean;
}

/** JSON-flavoured CodeEditor, kept so existing callers do not change. */
export default function JsonEditor({ value, onChange, minHeight = "120px", validate }: JsonEditorProps) {
  return <CodeEditor language="json" value={value} onChange={onChange} minHeight={minHeight} validate={validate} />;
}
