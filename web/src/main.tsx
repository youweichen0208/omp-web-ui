import { initAppearance } from "./appearance";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageProvider } from "./i18n";
import "./styles.css";
import "highlight.js/styles/github-dark.css";
import { initAuthToken } from "./auth-token";
import { desktopAPI } from "./desktop";

document.documentElement.dataset.platform = desktopAPI?.platform ?? (/Windows/i.test(navigator.userAgent) ? "win32" : /Mac/i.test(navigator.userAgent) ? "darwin" : "linux");

if (desktopAPI) {
	document.documentElement.classList.add("pi-desktop", `pi-desktop-${desktopAPI.platform}`);
}

// 吸收地址栏 ?token=（PI_WEB_TOKEN 鉴权入口）并持久化，须在首次请求前执行
initAuthToken();
initAppearance();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<LanguageProvider>
			<App />
		</LanguageProvider>
	</StrictMode>,
);
