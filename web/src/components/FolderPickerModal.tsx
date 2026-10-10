import { useDialogFocus } from "../use-dialog-focus";
import { useEffect, useState } from "react";
import {
	FiCheck,
	FiChevronRight,
	FiCornerLeftUp,
	FiFolder,
	FiHardDrive,
	FiHome,
	FiX,
} from "react-icons/fi";
import type { DirBrowse } from "../types";
import { useT } from "../i18n";

/**
 * Workspace picker. The browser can never hand the server a real absolute
 * path — `<input webkitdirectory>` only yields relative names and the File
 * System Access API only yields opaque handles — so a native OS dialog is
 * off the table. Instead the *server* lists its own directories
 * (`browse_dirs`) and this walks them, which also works when the server runs
 * somewhere other than the browser. The manual path field stays as the
 * escape hatch for pasting a path or reaching a hidden/unlisted directory.
 */
export function FolderPickerModal({
	dirBrowse,
	onBrowse,
	onPick,
	onClose,
	busy = false,
	error,
	pickLabel,
}: {
	dirBrowse: DirBrowse | null;
	onBrowse: (path?: string) => void;
	onPick: (path: string) => void;
	onClose: () => void;
	busy?: boolean;
	error?: string;
	pickLabel?: string;
}) {
	const t = useT();
	const dialogRef = useDialogFocus();
	const [manual, setManual] = useState("");

	// Open on the home directory (server decides what that is).
	useEffect(() => {
		onBrowse(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const here = dirBrowse?.path ?? "";
	// Join with the separator the server's own path uses: on Windows `here`
	// comes back as C:\Users\me, and appending "/" would build a mixed
	// C:\Users\me/foo. (resolve() would normalize it, but the path is shown
	// to the user.)
	const sep = here.includes("\\") && !here.includes("/") ? "\\" : "/";
	const join = (name: string) =>
		here.endsWith(sep) ? `${here}${name}` : `${here}${sep}${name}`;
	const drives = dirBrowse?.drives ?? [];

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled on window
		<div className="modal-backdrop" onClick={onClose}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop-only affordance */}
			<div
				className="fpk-modal" ref={dialogRef} tabIndex={-1}
				role="dialog"
				aria-modal="true"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="fpk-modal-head">
					<FiFolder className="modal-head-icon" />
					<h2>{pickLabel ?? t("openFolder")}</h2>
					<span className="toolcall-spacer" />
					<button
						type="button"
						className="toolcall-zoom-close"
						title={t("cancel")}
						onClick={onClose}
					>
						<FiX />
					</button>
				</div>

				<div className="fpk-modal-bar">
					<button
						type="button"
						className="fpk-nav-btn"
						title={t("home")}
						onClick={() => onBrowse(undefined)}
					>
						<FiHome />
					</button>
					<button
						type="button"
						className="fpk-nav-btn"
						title={t("parentFolder")}
						disabled={!dirBrowse?.parent}
						onClick={() => dirBrowse?.parent && onBrowse(dirBrowse.parent)}
					>
						<FiCornerLeftUp />
					</button>
					<code className="fpk-path" title={here}>
						{here || "…"}
					</code>
				</div>

				{drives.length > 0 && (
					<div className="fpk-drives">
						{drives.map((d) => (
							<button
								type="button"
								key={d}
								className={`fpk-drive ${here.toUpperCase().startsWith(d.toUpperCase()) ? "active" : ""}`}
								onClick={() => onBrowse(d)}
							>
								<FiHardDrive />
								<span>{d.replace(/\\$/, "")}</span>
							</button>
						))}
					</div>
				)}

				<div className="fpk-list">
					{dirBrowse && dirBrowse.dirs.length === 0 && (
						<div className="panel-empty">{t("noSubfolders")}</div>
					)}
					{dirBrowse?.dirs.map((name) => (
						<button
							type="button"
							key={name}
							className="fpk-item"
							onClick={() => onBrowse(join(name))}
						>
							<FiFolder className="fpk-item-icon" />
							<span className="fpk-item-name">{name}</span>
							<FiChevronRight className="fpk-item-go" />
						</button>
					))}
					{dirBrowse?.truncated && (
						<div className="panel-empty">{t("listTruncated")}</div>
					)}
				</div>

				{error && <p className="workspace-group-error" role="alert">{error}</p>}
				<form
					className="fpk-modal-foot"
					onSubmit={(e) => {
						e.preventDefault();
						const path = manual.trim() || here;
						if (path && !busy) onPick(path);
					}}
				>
					<input
						className="lp-inline-input"
						placeholder={t("openFolderPlaceholder")}
						value={manual}
						onChange={(e) => setManual(e.target.value)}
					/>
					<button type="submit" className="fpk-open-btn" disabled={busy || (!here && !manual.trim())}>
						<FiCheck />
						<span>{pickLabel ?? (manual.trim() ? t("openTypedPath") : t("openThisFolder"))}</span>
					</button>
				</form>
			</div>
		</div>
	);
}
