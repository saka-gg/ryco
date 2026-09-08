import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import { useMemo } from "react";

const createEditor: EditorFactory<undefined, undefined> = (type, options, editStateKey) =>
  new Editor(type, options, editStateKey);

interface PreviewFileEditorProps {
  readonly cacheKey: string;
  readonly className: string;
  readonly contents: string;
  readonly filePath: string;
  readonly language: string;
  readonly onChange: (contents: string) => void;
  readonly options: FileOptions<undefined, undefined>;
}

export function PreviewFileEditor(props: PreviewFileEditorProps) {
  const { cacheKey, className, contents, filePath, language, onChange, options } = props;
  const file = useMemo(
    () => ({
      name: filePath,
      contents,
      lang: language,
      cacheKey,
    }),
    [cacheKey, contents, filePath, language],
  );

  return (
    <EditProvider createEditor={createEditor}>
      <Virtualizer
        className="min-h-0 flex-1 overflow-auto"
        contentClassName="min-h-full"
        config={{ overscrollSize: 400, intersectionObserverMargin: 800 }}
      >
        <File<undefined>
          edit
          file={file}
          className={className}
          onEditChange={({ file }) => onChange(file.contents)}
          options={options}
        />
      </Virtualizer>
    </EditProvider>
  );
}
