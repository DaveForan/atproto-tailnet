import { useState } from "react";
import { useTenantMutation } from "../../hooks/useMutation";
import { BoardText } from "../../components/BoardText";
import { lintBoardText, BOARD_TEXT_MAX_LENGTH } from "../../../shared/board-text";
import { boardsService } from "../../services/boards";

export function ControllerBoardEditor({ initial, address, onSaved }: { initial: string; address: string; onSaved: () => void }) {
  const { mutate, busy } = useTenantMutation({ onError: "Could not save the controller board" });
  const [text, setText] = useState(initial);
  const problems = lintBoardText(text);

  const save = async () => {
    if (problems.length > 0) return;
    await mutate((tid) => boardsService.setControllerBoard(tid, text), {
      successMsg: "Controller board saved",
      reload: async () => { onSaved(); },
    });
  };

  return (
    <div className="editor-split">
      <div className="form-stack">
        <label htmlFor="controller-text" className="text-sm">
          Text (headings with #, lists with -, **bold**, *italic*, [link](https://…))
        </label>
        <textarea
          id="controller-text"
          className="controller-input"
          value={text}
          maxLength={BOARD_TEXT_MAX_LENGTH}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="controller-help"
        />
        <p id="controller-help" className="help-text" role={problems.length ? "alert" : undefined}>
          {problems[0] ?? `${text.length} / ${BOARD_TEXT_MAX_LENGTH} characters. Text only: HTML is shown as written.`}
        </p>
        <div className="btn-group">
          <button type="button" disabled={busy || problems.length > 0 || text === initial} onClick={() => { void save(); }}>
            {busy ? "Saving..." : "Save"}
          </button>
          <a className="btn-sm btn-ghost" href={`/board/${address}`} target="_blank" rel="noopener noreferrer">
            Open public page
          </a>
        </div>
      </div>
      <div className="preview-pane" aria-label="Preview">
        <p className="text-dim text-xs">Preview — what anyone on the internet sees</p>
        {text.trim() ? <BoardText text={text} /> : <p className="text-dim">Nothing yet.</p>}
      </div>
    </div>
  );
}
