import { createContext } from "react";
import type { SubagentListItem } from "./types";
export const SubagentContext = createContext<SubagentListItem[]>([]);
