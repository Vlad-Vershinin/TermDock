import { lazy, Suspense } from "react";
import type { EditorProps } from "./CodeEditor";

// CodeMirror is heavy; load it only when a file is opened for editing.
const CodeEditor = lazy(() => import("./CodeEditor"));

export function Editor(props: EditorProps) {
  return (
    <Suspense
      fallback={
        <div className="modal-backdrop">
          <div className="editor">
            <div className="editor-body">
              <div className="pane-loading" />
            </div>
          </div>
        </div>
      }
    >
      <CodeEditor {...props} />
    </Suspense>
  );
}
