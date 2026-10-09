import { LuSearch, LuBug, LuFlaskConical, LuBrush, LuPaperclip, LuImage, LuFileText, LuFolder, LuLink, LuKeyRound, LuPuzzle, LuEye, LuTerminal, LuPencil, LuCompass, LuWrench } from "react-icons/lu";

const icons = { search: LuSearch, bug: LuBug, flask: LuFlaskConical, brush: LuBrush, paperclip: LuPaperclip, image: LuImage, file: LuFileText, folder: LuFolder, link: LuLink, key: LuKeyRound, puzzle: LuPuzzle, eye: LuEye, terminal: LuTerminal, edit: LuPencil, compass: LuCompass, tool: LuWrench };
export type UiIconName = keyof typeof icons;
export function UiIcon({ name }: { name: UiIconName }) {
	const Icon = icons[name];
	return <Icon className="ui-icon" size={16} strokeWidth={1.5} aria-hidden="true" focusable="false" />;
}
