import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChangedFile } from "./changes";

export type ChangesScope = "turn" | "branch" | "work";
interface ChangesState { open: boolean; list: boolean; scope: ChangesScope; selected: string; base: string; }
interface ChangesContextValue extends ChangesState {
	files: ChangedFile[];
	focusRequest: number;
	set: (patch: Partial<ChangesState>) => void;
	show: (files: ChangedFile[], path?: string) => void;
}
const Context = createContext<ChangesContextValue | null>(null);
export const useChanges = () => useContext(Context);
const Availability = createContext(false);
const Links = createContext<Pick<ChangesContextValue, "files" | "show"> | null>(null);
export const useChangesAvailable = () => useContext(Availability);
export const useChangeLinks = () => useContext(Links);

export function ChangesProvider({ conversationId, files, active, onOpenChange, children }: { conversationId: string; files: ChangedFile[]; active: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
	const key = `pi-harness:changes:${conversationId}`;
	const load = (): ChangesState => {
		try { const saved = JSON.parse(sessionStorage.getItem(key) ?? "null"); if (saved) return { open: saved.open === true, list: saved.list === true, scope: ["branch", "work"].includes(saved.scope) ? saved.scope : "turn", selected: "", base: "" }; } catch { /* Optional preference storage. */ }
		return { open: false, list: false, scope: "turn", selected: "", base: "" };
	};
	const [owner, setOwner] = useState(key);
	const [state, setState] = useState<ChangesState>(load);
	const [historical, setHistorical] = useState<ChangedFile[] | null>(null);
	const [focusRequest, setFocusRequest] = useState(0);
	if (owner !== key) { setOwner(key); setState(load()); setHistorical(null); setFocusRequest(0); }
	useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(state)); } catch { /* Optional preference storage. */ } }, [key, state]);
	useEffect(() => { onOpenChange(active && state.open); return () => onOpenChange(false); }, [active, state.open, onOpenChange, conversationId]);
	useEffect(() => {
		const keydown = (event: KeyboardEvent) => {
			if (!active || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "d") return;
			event.preventDefault(); setState(previous => ({ ...previous, open: !previous.open }));
		};
		window.addEventListener("keydown", keydown);
		return () => window.removeEventListener("keydown", keydown);
	}, [active]);
	const set = useCallback((patch: Partial<ChangesState>) => { if (patch.scope === "turn") setHistorical(null); setState(previous => ({ ...previous, ...patch })); }, []);
	const show = useCallback((target: ChangedFile[], path?: string) => {
		setHistorical(target.length === files.length && target.every((file, index) => file.path === files[index].path && file.toolIds?.join() === files[index].toolIds?.join()) ? null : target);
		setState(previous => ({ ...previous, open: true, scope: "turn", selected: path ?? "" })); setFocusRequest(n => n + 1);
	}, [files]);
	const shown = historical ?? files;
	const value = useMemo<ChangesContextValue>(() => ({ ...state, files: shown, focusRequest, set, show }), [state, shown, focusRequest, set, show]);
	const links = useMemo(() => ({ files: shown, show }), [shown, show]);
	return <Availability.Provider value={true}><Links.Provider value={links}><Context.Provider value={value}>{children}</Context.Provider></Links.Provider></Availability.Provider>;
}
