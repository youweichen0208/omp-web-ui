export interface DesktopWindowState {
	maximized: boolean;
	fullscreen: boolean;
}

export interface DesktopAPI {
	platform: string;
	openExtensionPath?: (request: { clientId: string; cwd: string; id: string }) => Promise<void>;
	openWikiFile?: (request: { clientId: string; cwd: string; path: string }) => Promise<void>;
	windowAction: (action: "minimize" | "toggle-maximize" | "close") => void;
	onWindowState: (callback: (state: DesktopWindowState) => void) => () => void;
}

declare global {
	interface Window {
		electronAPI?: DesktopAPI;
	}
}

export const desktopAPI = window.electronAPI;
